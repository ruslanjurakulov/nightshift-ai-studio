import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { readAgeState } from "@/lib/server/age";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import { brainJson, dbRefusal, notFound } from "@/lib/server/brain/session";
import { readPlanFilm, type PlanFilm } from "@/lib/server/brain/film-plan";
import { filmGateFor } from "@/lib/server/films";
import { creativeDb } from "@/lib/server/creative";
import { createGeneration, quote, type CreativeDb, type GenerationInput } from "@/lib/creative/operations";
import { geoRefusal } from "@/lib/server/geo";
import { geoClaimHeaders } from "@/lib/server/geo-claim";
import { logAudit } from "@/lib/server/audit";
import { FILM_MODEL_PREFERENCE, MODEL_ID } from "@/lib/brain/film-models";
import type { Brief } from "@/lib/brain/logic";
import {
  makeable, mergeSheets, planSheets, readSheets, refGate, selectRefs, type AssetFacts, type GateModel, type RefGate, type RefSheet, type RefView,
  type SheetView,
} from "@/lib/brain/ref-sheets";

/**
 * The server side of character sheets (/api/brain/sheets; docs/studio/NIGHTSHIFT_AI.md "Character sheets").
 *
 * Money: nothing new. Every picture is ONE creative job through the existing path, under the person's own session (anon key):
 * quote_creative_job prices it (0192), create_creative_job checks the spender, refuses a price above the confirmed one and holds
 * it (0231), the worker makes it, finish_creative_job captures or refunds. This file only decides which views to ask for, in which
 * order, with which idempotency key, and keeps the job ids on the BRIEF so a refresh reads their states again.
 */

type Rpc = { data: unknown; error: { code?: string; message?: string; details?: string } | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SheetCtx {
  supabase: SupabaseClient;
  db: CreativeDb;
  userId: string;
  session: { id: string; orgId: string; step: string; brief: Brief };
  film: PlanFilm | null;
  age: "adult" | "minor" | "none" | "unknown";
}

/**
 * Who may: signed in, Nightshift AI on for the workspace, the conversation's own author (another person's or another workspace's
 * reads as missing), still an editor there, not under 18. A film, when named, must be the SAME workspace's (another one's is a 404,
 * exactly like a film that does not exist). Spending is the database's question on every create (is_org_spender).
 */
export async function sheetContext(sessionId: unknown, filmId: unknown): Promise<{ ok: true; c: SheetCtx } | { ok: false; res: Response }> {
  if (aiChatMode(aiChatEnv()) === "off") return { ok: false, res: notFound() };
  const user = await getUser();
  if (!user) return { ok: false, res: brainJson({ error: "unauthorized" }, 401) };
  const supabase = (await createClient()) as unknown as SupabaseClient | null;
  if (!supabase) return { ok: false, res: notFound() };
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  if (filmId !== undefined && filmId !== null && (typeof filmId !== "string" || !UUID.test(filmId))) {
    return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  }
  const r = await supabase.from("ai_chat_sessions").select("id,org_id,step,brief").eq("id", sessionId).eq("created_by", user.id).maybeSingle();
  if (r.error) return { ok: false, res: dbRefusal(r.error) ?? brainJson({ error: "unavailable" }, 503) };
  const row = r.data as { id?: unknown; org_id?: unknown; step?: unknown; brief?: unknown } | null;
  if (!row || typeof row.org_id !== "string" || !aiChatOpenFor(row.org_id, aiChatEnv())) return { ok: false, res: notFound() };
  const access = await requireOrgRole({ orgId: row.org_id }, "editor");
  if (!access.ok) return { ok: false, res: access.status === 404 ? notFound() : brainJson({ error: "forbidden" }, 403) };
  const age = await readAgeState();
  if (age === "minor") return { ok: false, res: brainJson({ error: "adult_only_service" }, 403) };
  const brief = (row.brief && typeof row.brief === "object" ? row.brief : null) as Brief | null;
  if (!brief || brief.kind !== "short" || !(brief.characters ?? []).length) return { ok: false, res: brainJson({ error: "no_characters" }, 409) };
  let film: PlanFilm | null = null;
  if (typeof filmId === "string") {
    // Film Studio's own switches, the project's workspace included (as /api/brain/film): a project the editor cannot open is not
    // read, priced or given references from here either.
    const gate = await filmGateFor(filmId);
    if (!gate.ok) return { ok: false, res: gate.response };
    const f = await readPlanFilm(supabase, filmId);
    if (!f.ok) return f;
    if (f.film.orgId !== row.org_id) return { ok: false, res: notFound() };
    film = f.film;
  }
  return { ok: true, c: { supabase, db: creativeDb(supabase), userId: user.id,
    session: { id: String(row.id), orgId: row.org_id, step: typeof row.step === "string" ? row.step : "", brief }, film, age } };
}

type Sellable = { id: string; name: string; spec: unknown };
async function onSale(supabase: SupabaseClient, capability: "t2i" | "edit"): Promise<Sellable[] | null> {
  const r = (await supabase.rpc("sellable_models", { p_capability: capability, p_surface: "web" })) as Rpc;
  if (r.error || !Array.isArray(r.data)) return null;
  return (r.data as Record<string, unknown>[]).filter((x) => typeof x.id === "string" && MODEL_ID.test(x.id))
    .map((x) => ({ id: x.id as string, name: typeof x.display_name === "string" ? x.display_name : "", spec: x.spec ?? null }));
}

/** The film's key-frame model: the project's own when one is named, else the one the BRIEF's storyboard was drafted with. */
export function filmKeyframeModel(c: Pick<SheetCtx, "film" | "session">): string | null {
  if (c.film) return c.film.keyframeModel;
  const m = (c.session.brief.scenes ?? []).map((s) => s.keyframe_model).find((x) => typeof x === "string" && MODEL_ID.test(x));
  return m ?? null;
}

/** `imageSize`: the smallest size the model is sold by, when it is sold by size (Nano Banana needs one; the quote prices it). */
export interface SheetModel { id: string; name: string | null; filmOwn: boolean; imageSize: string | null }
const SIZES = ["512", "1K", "2K", "4K"];

/**
 * The model the sheets are drawn with: the film's own key-frame model when it is on sale for both t2i (the front) and edit (the
 * side and back from the front), else the first of FILM_MODEL_PREFERENCE.keyframe that is. The same fixed list the film's own model
 * came from, never another model of the catalogue (rule 4), and said by name, with whether it is the film's own.
 */
export async function sheetModel(c: SheetCtx): Promise<{ ok: true; model: SheetModel; t2i: Sellable[] } | { ok: false; error: "unavailable" | "no_sheet_model"; res: Response }> {
  const [t2i, edit] = await Promise.all([onSale(c.supabase, "t2i"), onSale(c.supabase, "edit")]);
  if (!t2i || !edit) return { ok: false, error: "unavailable", res: brainJson({ error: "unavailable" }, 503) };
  const both = (id: string | null) => !!id && t2i.some((m) => m.id === id) && edit.some((m) => m.id === id);
  const own = filmKeyframeModel(c);
  const id = both(own) ? own! : FILM_MODEL_PREFERENCE.keyframe.find((x) => both(x)) ?? null;
  if (!id) return { ok: false, error: "no_sheet_model", res: brainJson({ error: "no_sheet_model" }, 409) };
  const spec = (t2i.find((m) => m.id === id)?.spec ?? {}) as { image_sizes?: unknown };
  const sizes = Array.isArray(spec.image_sizes) ? SIZES.filter((x) => (spec.image_sizes as unknown[]).includes(x)) : [];
  // A reference is a white-background figure, not a frame of the film: the smallest size the model sells is enough, and the
  // person sees its price before anything is held.
  return { ok: true, model: { id, name: t2i.find((m) => m.id === id)?.name || null, filmOwn: id === own, imageSize: sizes[0] ?? null }, t2i };
}

/** The gate for the film's key-frame model, from the registry facts sellable_models returns (lib/brain/ref-sheets refGate). */
export function gateFor(c: SheetCtx, t2i: readonly GateModel[]): RefGate {
  return refGate(filmKeyframeModel(c), t2i, c.age);
}

/** The sheets as stored, merged with the BRIEF's current plan, each job's state read again (a refresh mid-job loses nothing). */
export async function currentSheets(c: SheetCtx): Promise<RefSheet[]> {
  const sheets = mergeSheets(readSheets(c.session.brief.ref_sheets), planSheets(c.session.brief));
  const ids = [...new Set(sheets.flatMap((s) => s.views).filter((v) => v.status === "making" && v.job_id).map((v) => v.job_id!))];
  if (!ids.length) return sheets;
  const jobs = new Map<string, { status?: unknown; result_asset_ids?: unknown; error_code?: unknown }>();
  await Promise.all(ids.map(async (id) => {
    const j = await c.db.readJob(id);
    if (!j.error && j.data && typeof j.data === "object") jobs.set(id, j.data as Record<string, unknown>);
  }));
  return sheets.map((s) => ({ ...s, views: s.views.map((v): RefView => {
    const j = v.job_id ? jobs.get(v.job_id) : undefined;
    // A job that could not be read stays "making": never shown as made, never as failed, on a guess (rule 5).
    if (v.status !== "making" || !j) return v;
    const asset = Array.isArray(j.result_asset_ids) ? j.result_asset_ids.find((x): x is string => typeof x === "string" && UUID.test(x)) : undefined;
    if (j.status === "completed" && asset) return { ...v, status: "ready", asset_id: asset, error: null };
    if (j.status === "completed" || j.status === "failed" || j.status === "cancelled" || j.status === "expired") {
      const code = typeof j.error_code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(j.error_code) ? j.error_code : j.status === "completed" ? "no_result" : String(j.status);
      // The next try is the next attempt: the failed job's own key would only replay the failure (its hold was refunded).
      return { ...v, status: "failed", error: code, attempt: (v.attempt ?? 0) + 1 };
    }
    return v;
  }) }));
}

/** The creative request one view is: the front from words (t2i), the side and back as an edit OF the front's picture. */
function viewInput(c: SheetCtx, m: SheetModel, sheet: RefSheet, v: RefView, maxCredits: number | null): GenerationInput {
  const model = m.id;
  const front = sheet.views.find((x) => x.view === "front");
  const params: Record<string, unknown> = { prompt: v.prompt, aspect_ratio: "16:9" };
  if (v.view !== "front") params.source_asset_id = front?.asset_id;
  if (m.imageSize) params.image_size = m.imageSize;
  return {
    orgId: c.session.orgId, capability: v.view === "front" ? "t2i" : "edit", model, params,
    // exact: never failed over to another model by the router (0088), so the sheet is drawn by the model the person was told.
    mode: "exact", idempotencyKey: viewKey(c.session.id, sheet, v.view, v.attempt ?? 0), maxCredits,
  };
}

/** One key per view and attempt: a double press, a retried request or a second tab replays the first job, never a second hold. */
export function viewKey(session: string, sheet: Pick<RefSheet, "character_id" | "stage">, view: SheetView, attempt: number): string {
  const h = createHash("sha256").update(`nightshift-sheet:${session}:${sheet.character_id}:${sheet.stage ?? ""}:${view}:${attempt}`).digest("hex");
  return `sheet:${h.slice(0, 48)}`;
}

export interface ViewQuote { character_id: string; stage: string | null; view: SheetView; credits: number }
export type SheetQuote =
  | { ok: true; total: number; views: ViewQuote[]; waiting: number }
  | { ok: false; status: number; body: Record<string, unknown> };

/** The database's price for every view that can be made now, summed here; nothing held. `waiting`: side/back views whose front is
 *  not made yet, which no quote can price (an edit needs its picture) and are said as such, never as a number. */
export async function quoteSheets(c: SheetCtx, model: SheetModel, sheets: readonly RefSheet[]): Promise<SheetQuote> {
  const todo = sheets.flatMap((s) => s.views.filter((v) => makeable(s, v)).map((v) => ({ s, v })));
  const waiting = sheets.flatMap((s) => s.views.filter((v) => (v.status === "planned" || v.status === "failed") && !makeable(s, v))).length;
  const out: ViewQuote[] = [];
  for (const { s, v } of todo) {
    const q = await quote(c.db, viewInput(c, model, s, v, null));
    if (q.status !== 200) return { ok: false, status: q.status, body: { ...q.body, view: { character_id: s.character_id, stage: s.stage, view: v.view } } };
    const credits = (q.body.quote as { credits?: unknown }).credits;
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return { ok: false, status: 502, body: { error: "failed" } };
    out.push({ character_id: s.character_id, stage: s.stage, view: v.view, credits });
  }
  return { ok: true, total: out.reduce((a, b) => a + b.credits, 0), views: out, waiting };
}

/** The BRIEF with its sheets, saved through 0199's own guard (author, editor, not handed off). */
export async function saveSheets(c: SheetCtx, sheets: RefSheet[]): Promise<Response | null> {
  if (c.session.step !== "ready") return brainJson({ error: "session_closed" }, 409);
  const saved = (await c.supabase.rpc("ai_chat_save_brief", { p_session: c.session.id, p_brief: { ...c.session.brief, ref_sheets: sheets }, p_step: "ready" })) as Rpc;
  return saved.error ? dbRefusal(saved.error) ?? brainJson({ error: "unavailable" }, 503) : null;
}

/**
 * The person's confirm: the price read again, refused as price_changed above what they confirmed (before anything is held), then
 * one create_creative_job per view, each capped at its own fresh quote. A refusal part-way (insufficient credits, a spender check)
 * stops there and is passed on by name; the views already queued keep their jobs, saved with the refusal.
 */
export async function makeSheets(c: SheetCtx, m: SheetModel, confirmed: number, headers: Headers): Promise<Response> {
  const model = m.id;
  const blocked = geoRefusal(model, headers);
  if (blocked) return brainJson(blocked.body, blocked.status);
  let sheets = await currentSheets(c);
  const q = await quoteSheets(c, m, sheets);
  if (!q.ok) return brainJson(q.body, q.status);
  if (!q.views.length) return brainJson({ error: "nothing_to_make", sheets }, 409);
  if (q.total > confirmed) return brainJson({ error: "price_changed", quote: { total: q.total, views: q.views, waiting: q.waiting } }, 409);
  const claim = geoClaimHeaders([model], headers, c.userId);
  let refusal: { status: number; body: Record<string, unknown> } | null = null;
  for (const vq of q.views) {
    const s = sheets.find((x) => x.character_id === vq.character_id && x.stage === vq.stage)!;
    const v = s.views.find((x) => x.view === vq.view)!;
    const out = await createGeneration(c.db, viewInput(c, m, s, v, vq.credits), claim);
    if (out.status !== 201 && out.status !== 200) { refusal = out; break; }
    const job = out.body.job as { id: string; quoted_credits?: number };
    if (out.status === 201) {
      await logAudit({ action: "creative.generate", target: job.id,
        detail: { org_id: c.session.orgId, capability: vq.view === "front" ? "t2i" : "edit", model, quoted_credits: job.quoted_credits ?? null,
                  source_asset_id: vq.view === "front" ? null : s.views.find((x) => x.view === "front")?.asset_id ?? null, via: "brain.sheets" } });
    }
    sheets = sheets.map((x) => x !== s ? x : { ...x, views: x.views.map((w) => w.view !== v.view ? w : { ...w, status: "making", job_id: job.id, error: null }) });
  }
  const failed = await saveSheets(c, sheets);
  // The jobs exist whatever the save answers: their ids come back so the panel follows them, and the same press replays them.
  if (failed && !refusal) return failed;
  if (refusal) return brainJson({ ...refusal.body, sheets }, refusal.status);
  return brainJson({ sheets }, 200);
}

/** Approve a made view, or ask for it again (a redo is the next attempt: a new job, quoted again before anything is held). */
export async function markView(c: SheetCtx, ref: { character_id: unknown; stage: unknown; view: unknown }, act: "approve" | "redo"): Promise<Response> {
  const sheets = await currentSheets(c);
  const s = sheets.find((x) => x.character_id === ref.character_id && x.stage === (ref.stage ?? null));
  const v = s?.views.find((x) => x.view === ref.view);
  // A character, stage or view this conversation's BRIEF does not have reads as missing (never another conversation's).
  if (!s || !v) return notFound();
  if (act === "approve" && v.status !== "ready") return brainJson({ error: "not_ready" }, 409);
  if (act === "redo" && (v.status === "making" || v.status === "planned")) return brainJson({ error: "not_ready" }, 409);
  const next = sheets.map((x) => x !== s ? x : { ...x, views: x.views.map((w) => w !== v ? w
    : act === "approve" ? { ...w, status: "approved" as const }
    : { ...w, status: "planned" as const, asset_id: null, job_id: null, error: null, attempt: (w.attempt ?? 0) + 1 }) });
  const failed = await saveSheets(c, next);
  return failed ?? brainJson({ sheets: next });
}

/**
 * The approved views as each scene's references (save_film scene refs, 0166 film_save_refs), only through an open gate. A scene that
 * already has references of its own is left as it is (they are the person's), and so is a scene whose own key-frame model's gate is
 * closed. The key-frame prompt gains the "Image N" line, measured against the model's limit and refused by scene, never cut.
 */
export async function attachSheets(c: SheetCtx, t2i: readonly GateModel[]): Promise<Response> {
  if (!c.film) return brainJson({ error: "bad_request" }, 400);
  const gate = gateFor(c, t2i);
  if (!gate.open) return brainJson({ error: "refs_not_supported", reason: gate.reason }, 409);
  if (!c.film.editable) return brainJson({ error: "film_not_editable" }, 409);
  const raw = (await c.supabase.rpc("film_json", { p_film: c.film.id })) as Rpc;
  if (raw.error) return brainJson({ error: "unavailable" }, 503);
  const d = (raw.data ?? {}) as { refs?: { character_id?: unknown; asset_id?: unknown }[]; scenes?: Record<string, unknown>[] };
  const filmRefs = Array.isArray(d.refs) ? d.refs : [];
  // A film-wide character reference expands to every picture of that character (0198), a count this route cannot read: the "Image
  // N" numbers would be wrong, so nothing is attached and the remedy is said.
  if (filmRefs.some((r) => typeof r.character_id === "string")) return brainJson({ error: "film_character_refs" }, 409);
  const offset = filmRefs.length;
  const sheets = await currentSheets(c);
  // Every picture's stored size and type (0038 media_assets, under the person's session: another workspace's reads as missing):
  // the film's own and every approved view. One that cannot be read is unknown, and the selector refuses its scene by name.
  const ids = [...new Set([...filmRefs.map((r) => r.asset_id), ...sheets.flatMap((x) => x.views).filter((v) => v.status === "approved").map((v) => v.asset_id)]
    .filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  const assets = new Map<string, AssetFacts>();
  if (ids.length) {
    const a = await c.supabase.from("media_assets").select("id,bytes,mime").eq("org_id", c.session.orgId).in("id", ids);
    if (a.error) return brainJson({ error: "unavailable" }, 503);
    for (const r of (a.data ?? []) as { id?: unknown; bytes?: unknown; mime?: unknown }[]) {
      if (typeof r.id === "string") assets.set(r.id, { bytes: typeof r.bytes === "number" ? r.bytes : r.bytes != null && Number.isFinite(Number(r.bytes)) ? Number(r.bytes) : null, mime: typeof r.mime === "string" ? r.mime : null });
    }
  }
  let offsetBytes = 0;
  for (const r of filmRefs) {
    const f = typeof r.asset_id === "string" ? assets.get(r.asset_id) : undefined;
    if (!f || f.bytes === null) return brainJson({ error: "ref_size_unknown", scene: null }, 409);
    offsetBytes += f.bytes;
  }
  const scenes = Array.isArray(d.scenes) ? d.scenes : [];
  const brief = c.session.brief.scenes ?? [];
  const limit = (id: string) => {
    const spec = (t2i.find((m) => m.id === id)?.spec ?? {}) as { limits?: { max_prompt_chars?: unknown } };
    return typeof spec.limits?.max_prompt_chars === "number" ? spec.limits.max_prompt_chars : null;
  };
  let attached = 0;
  const patch: Record<string, unknown>[] = [];
  for (const [i, fs] of scenes.entries()) {
    const id = String(fs.id);
    const own = Array.isArray(fs.refs) && fs.refs.length > 0;
    const bs = brief[i];
    const model = typeof fs.keyframe_model === "string" ? fs.keyframe_model : c.film.keyframeModel;
    const g = refGate(model, t2i, c.age);
    if (own || !bs || !g.open) { patch.push({ id }); continue; }
    // 16: the worker's own cap on one key frame's pictures (0198 film_take_job), whatever the model's.
    const sel = selectRefs(c.session.brief, sheets, bs, { offset, offsetBytes, maxPictures: Math.min(g.imageRefsMax, 16) }, assets);
    if (sel.refused) return brainJson({ error: sel.refused, scene: i + 1 }, 409);
    if (!sel.refs.length) { patch.push({ id }); continue; }
    const prompt = `${String(fs.visual_prompt ?? "")}\n${sel.line}`;
    const max = model ? limit(model) : null;
    // A limit that cannot be read is not "no limit": nothing is saved that the quote might refuse.
    if (max === null) return brainJson({ error: "unavailable" }, 503);
    if (prompt.length > max) return brainJson({ error: "prompt_too_long", scene: i + 1, limit: max }, 422);
    patch.push({ id, refs: sel.refs, visual_prompt: prompt });
    attached += 1;
  }
  if (!attached) return brainJson({ error: "nothing_to_attach" }, 409);
  const saved = (await c.supabase.rpc("save_film", { p_film: c.film.id, p_version: c.film.version, p_patch: { scenes: patch } })) as Rpc;
  if (saved.error) {
    const code = saved.error.message ?? "";
    return brainJson({ error: /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : "unavailable" }, code === "film_changed" ? 409 : 422);
  }
  const version = (saved.data as { film?: { version?: number } } | null)?.film?.version ?? c.film.version + 1;
  // The film changed, so its old quote is gone: priced again here, the panel's Create reads this one.
  const q = (await c.supabase.rpc("quote_film", { p_film: c.film.id, p_version: version })) as Rpc;
  return brainJson({ attached, film: { id: c.film.id, version }, film_quote: q.error ? null : q.data });
}
