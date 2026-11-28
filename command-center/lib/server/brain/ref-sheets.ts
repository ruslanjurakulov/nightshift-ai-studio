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
import { FILM_PLAN_KEY } from "@/lib/brain/film-plan";
import {
  REF_LINE, SHEETS_MAX, makeable, mergeConcurrent, mergeSheets, planSheets, readSheetBrief, readSheets, refGate, selectRefs, withRefLine,
  type AssetFacts, type FilmLink, type GateModel, type RefGate, type RefSheet, type RefView, type SheetBrief, type SheetView,
} from "@/lib/brain/ref-sheets";

/**
 * The server side of character sheets (/api/brain/sheets; docs/studio/NIGHTSHIFT_AI.md "Character sheets").
 *
 * Money: nothing new. Every picture is ONE creative job through the existing path, under the person's own session (anon key):
 * quote_creative_job prices it (0192), create_creative_job checks the spender, refuses a price above the confirmed one and holds
 * it (0231), the worker makes it, finish_creative_job captures or refunds. This file only decides which views to ask for, in which
 * order, with which idempotency key, and keeps the keys and job ids on the BRIEF so a refresh reads their states again.
 */

type Rpc = { data: unknown; error: { code?: string; message?: string; details?: string } | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SheetCtx {
  supabase: SupabaseClient;
  db: CreativeDb;
  userId: string;
  session: { id: string; orgId: string; step: string; brief: SheetBrief };
  film: PlanFilm | null;
  age: "adult" | "minor" | "none" | "unknown";
}

/** A step in which the sheets may be written: only a chosen, priced plan (0199 refuses every write once it is handed off). */
function stepRefusal(step: string): Response | null {
  if (step === "ready") return null;
  // Step-accurate (L5): "handed off" is said only of a handed-off plan; a plan being changed in the chat is told to choose again.
  return step === "created" ? brainJson({ error: "session_closed" }, 409) : brainJson({ error: "plan_not_ready", step }, 409);
}

/**
 * Who may: signed in, Nightshift AI on for the workspace, the conversation's own author (another person's or another workspace's
 * reads as missing), still an editor there, not under 18. A film, when named, must pass Film Studio's own switches and be the SAME
 * workspace's (another one's is a 404, exactly like a film that does not exist). Spending is the database's question on every create
 * (is_org_spender). `write`: make, approve, redo and attach are refused before any quote or create unless the plan is writable.
 */
export async function sheetContext(sessionId: unknown, filmId: unknown, write: boolean): Promise<{ ok: true; c: SheetCtx } | { ok: false; res: Response }> {
  if (aiChatMode(aiChatEnv()) === "off") return { ok: false, res: notFound() };
  const user = await getUser();
  if (!user) return { ok: false, res: brainJson({ error: "unauthorized" }, 401) };
  const supabase = (await createClient()) as unknown as SupabaseClient | null;
  if (!supabase) return { ok: false, res: notFound() };
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  if (filmId !== undefined && filmId !== null && (typeof filmId !== "string" || !UUID.test(filmId))) {
    return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  }
  const row = await readSession(supabase, sessionId, user.id);
  if (!row.ok) return { ok: false, res: row.res };
  const { orgId, step, raw } = row;
  if (!aiChatOpenFor(orgId, aiChatEnv())) return { ok: false, res: notFound() };
  // A project's own storyboard conversation (lib/server/brain/film-plan) is the project's, never a chat's: no sheets there.
  if (raw[FILM_PLAN_KEY] !== undefined) return { ok: false, res: brainJson({ error: "film_conversation" }, 409) };
  const access = await requireOrgRole({ orgId }, "editor");
  if (!access.ok) return { ok: false, res: access.status === 404 ? notFound() : brainJson({ error: "forbidden" }, 403) };
  const age = await readAgeState();
  if (age === "minor") return { ok: false, res: brainJson({ error: "adult_only_service" }, 403) };
  // Rule 6: a plan the sheets cannot be saved on is refused before anything is quoted or held (Breach BR-RS-02).
  if (write) {
    const refused = stepRefusal(step);
    if (refused) return { ok: false, res: refused };
  }
  // Re-read through the BRIEF's own caps (BR-RS-03): never the stored jsonb cast as a Brief.
  const brief = readSheetBrief(raw);
  if (brief.kind !== "short" || !(brief.characters ?? []).length) return { ok: false, res: brainJson({ error: "no_characters" }, 409) };
  let film: PlanFilm | null = null;
  if (typeof filmId === "string") {
    const gate = await filmGateFor(filmId);
    if (!gate.ok) return { ok: false, res: gate.response };
    const f = await readPlanFilm(supabase, filmId);
    if (!f.ok) return f;
    if (f.film.orgId !== orgId) return { ok: false, res: notFound() };
    film = f.film;
  }
  return { ok: true, c: { supabase, db: creativeDb(supabase), userId: user.id, session: { id: sessionId, orgId, step, brief }, film, age } };
}

async function readSession(supabase: SupabaseClient, id: string, userId: string)
  : Promise<{ ok: true; orgId: string; step: string; raw: Record<string, unknown> } | { ok: false; res: Response }> {
  const r = await supabase.from("ai_chat_sessions").select("id,org_id,step,brief").eq("id", id).eq("created_by", userId).maybeSingle();
  if (r.error) return { ok: false, res: dbRefusal(r.error) ?? brainJson({ error: "unavailable" }, 503) };
  const row = r.data as { org_id?: unknown; step?: unknown; brief?: unknown } | null;
  if (!row || typeof row.org_id !== "string") return { ok: false, res: notFound() };
  const raw = row.brief && typeof row.brief === "object" && !Array.isArray(row.brief) ? (row.brief as Record<string, unknown>) : {};
  return { ok: true, orgId: row.org_id, step: typeof row.step === "string" ? row.step : "", raw };
}

type Sellable = { id: string; name: string; spec: unknown };
export async function onSale(supabase: SupabaseClient, capability: "t2i" | "edit"): Promise<Sellable[] | null> {
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

/**
 * `imageSize`: the smallest size the model is sold by, when it is sold by size (Nano Banana needs one; the quote prices it).
 * `filmOwn`: "same" = the film's own key-frame model; "none" = the film has none set; "unable" = it has one that cannot make sheets.
 */
export interface SheetModel { id: string; name: string | null; filmOwn: "same" | "none" | "unable"; imageSize: string | null }
const SIZES = ["512", "1K", "2K", "4K"];

/**
 * The model the sheets are drawn with: the film's own key-frame model when it is on sale for both t2i (the front) and edit (the
 * side and back from the front), else the first of FILM_MODEL_PREFERENCE.keyframe that is. The same fixed list the film's own model
 * came from, never another model of the catalogue (rule 4), and said by name, with why it is not the film's own.
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
  return { ok: true, t2i, model: { id, name: t2i.find((m) => m.id === id)?.name || null,
    filmOwn: id === own ? "same" : own === null ? "none" : "unable", imageSize: sizes[0] ?? null } };
}

/** The gate for the film's key-frame model, from the registry facts sellable_models returns (lib/brain/ref-sheets refGate). */
export function gateFor(c: SheetCtx, t2i: readonly GateModel[]): RefGate {
  return refGate(filmKeyframeModel(c), t2i, c.age);
}

type JobRow = { id?: unknown; status?: unknown; result_asset_ids?: unknown; error_code?: unknown; idempotency_key?: unknown };

/**
 * The sheets as stored, merged with the BRIEF's current plan, each running view's job read again: by its id, or by the key saved
 * before its create when the id could not be saved after it. Both reads are filtered to the conversation's own workspace (and RLS).
 */
export async function currentSheets(c: SheetCtx): Promise<RefSheet[]> {
  const sheets = mergeSheets(c.session.brief.ref_sheets, planSheets(c.session.brief));
  const running = sheets.flatMap((s) => s.views).filter((v) => v.status === "making");
  const ids = [...new Set(running.map((v) => v.job_id).filter((x): x is string => !!x))];
  const keys = [...new Set(running.filter((v) => !v.job_id && v.key).map((v) => v.key!))];
  if (!ids.length && !keys.length) return sheets;
  const byId = new Map<string, JobRow>();
  const byKey = new Map<string, JobRow>();
  let keysRead = false;
  const cols = "id,status,result_asset_ids,error_code,idempotency_key";
  if (ids.length) {
    const r = await c.supabase.from("creative_jobs").select(cols).eq("org_id", c.session.orgId).in("id", ids);
    if (!r.error) for (const j of (r.data ?? []) as JobRow[]) if (typeof j.id === "string") byId.set(j.id, j);
  }
  if (keys.length) {
    const r = await c.supabase.from("creative_jobs").select(cols).eq("org_id", c.session.orgId).in("idempotency_key", keys);
    if (!r.error) {
      keysRead = true;
      for (const j of (r.data ?? []) as JobRow[]) if (typeof j.idempotency_key === "string") byKey.set(j.idempotency_key, j);
    }
  }
  return sheets.map((s) => ({ ...s, views: s.views.map((v): RefView => {
    if (v.status !== "making") return v;
    const j = v.job_id ? byId.get(v.job_id) : v.key ? byKey.get(v.key) : undefined;
    if (!j) {
      // A create that was intended and never reached the database (refused, or the request died first): nothing is held, so the
      // view is to make again, under the same key. Only when the key lookup itself answered; a failed read stays "making" (rule 5).
      return !v.job_id && v.key && keysRead ? { ...v, status: "planned", key: null } : v;
    }
    const withId = { ...v, job_id: typeof j.id === "string" ? j.id : v.job_id };
    const asset = Array.isArray(j.result_asset_ids) ? j.result_asset_ids.find((x): x is string => typeof x === "string" && UUID.test(x)) : undefined;
    if (j.status === "completed" && asset) return { ...withId, status: "ready", asset_id: asset, error: null };
    if (j.status === "completed" || j.status === "failed" || j.status === "cancelled" || j.status === "expired") {
      const code = typeof j.error_code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(j.error_code) ? j.error_code : j.status === "completed" ? "no_result" : String(j.status);
      // The next try is the next attempt: the failed job's own key would only replay the failure (its hold was refunded).
      return { ...withId, status: "failed", error: code, attempt: (v.attempt ?? 0) + 1, key: null };
    }
    return withId;
  }) }));
}

/** The creative request one view is: the front from words (t2i), the side and back as an edit OF the front's picture. */
export function viewInput(c: Pick<SheetCtx, "session">, m: SheetModel, sheet: RefSheet, v: RefView, maxCredits: number | null): GenerationInput & { idempotencyKey: string } {
  const front = sheet.views.find((x) => x.view === "front");
  const params: Record<string, unknown> = { prompt: v.prompt, aspect_ratio: "16:9" };
  if (v.view !== "front") params.source_asset_id = front?.asset_id;
  if (m.imageSize) params.image_size = m.imageSize;
  const capability = v.view === "front" ? "t2i" as const : "edit" as const;
  // exact: never failed over to another model by the router (0088), so the sheet is drawn by the model the person was told.
  const mode = "exact";
  return { orgId: c.session.orgId, capability, model: m.id, params, mode,
    idempotencyKey: viewKey(c.session.id, sheet, v.view, v.attempt ?? 0, requestDigest(m.id, capability, mode, params)), maxCredits };
}

/** The request a view's job makes, as a digest: a changed model, prompt, front picture, size or mode is a different request. */
export function requestDigest(model: string, capability: string, mode: string, params: Record<string, unknown>): string {
  return sha(JSON.stringify([model, capability, mode, params.prompt ?? null, params.source_asset_id ?? null, params.image_size ?? null, params.aspect_ratio ?? null]));
}

/**
 * One key per view, attempt AND request (Lens H1): a double press, a retried request or a second tab with the same request replays
 * the first job, never a second hold; a changed request (a new look after a chat turn, a redone front) never reuses an old key,
 * which 0036 would answer with the old job, or refuse as an idempotency conflict.
 */
export function viewKey(session: string, sheet: Pick<RefSheet, "character_id" | "stage">, view: SheetView, attempt: number, request: string): string {
  return `sheet:${sha(`nightshift-sheet:${session}:${sheet.character_id}:${sheet.stage ?? ""}:${view}:${attempt}:${request}`).slice(0, 48)}`;
}

export interface ViewQuote { character_id: string; stage: string | null; view: SheetView; credits: number }
export type SheetQuote =
  | { ok: true; total: number; views: ViewQuote[]; waiting: number; token: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * The database's price for every view that can be made now, summed here; nothing held. `waiting`: side/back views whose front is
 * not made yet, which no quote can price (an edit needs its picture), said as such, never as a number. `token`: a digest of exactly
 * this set (each view, its attempt, its request and its price); a make is refused unless the person confirmed this very set.
 */
export async function quoteSheets(c: SheetCtx, model: SheetModel, sheets: readonly RefSheet[]): Promise<SheetQuote> {
  const todo = sheets.flatMap((s) => s.views.filter((v) => makeable(s, v)).map((v) => ({ s, v })));
  const waiting = sheets.flatMap((s) => s.views.filter((v) => (v.status === "planned" || v.status === "failed") && !makeable(s, v))).length;
  const out: (ViewQuote & { key: string })[] = [];
  for (const { s, v } of todo) {
    const input = viewInput(c, model, s, v, null);
    const q = await quote(c.db, input);
    if (q.status !== 200) return { ok: false, status: q.status, body: { ...q.body, view: { character_id: s.character_id, stage: s.stage, view: v.view } } };
    const credits = (q.body.quote as { credits?: unknown }).credits;
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return { ok: false, status: 502, body: { error: "failed" } };
    out.push({ character_id: s.character_id, stage: s.stage, view: v.view, credits, key: input.idempotencyKey });
  }
  const token = sha(out.map((x) => `${x.character_id}|${x.stage ?? ""}|${x.view}|${x.key}|${x.credits}`).sort().join("\n")).slice(0, 32);
  return { ok: true, total: out.reduce((a, b) => a + b.credits, 0), views: out.map((x) => ({ character_id: x.character_id, stage: x.stage, view: x.view, credits: x.credits })), waiting, token };
}

/** 0249's refusals of a list out of shape: an app bug, said by its name rather than as "unavailable". */
const SHEET_SHAPE = new Set(["too_many_sheets", "invalid_stored_sheets", "sheets_too_large", "too_many_views", "sheet_prompt_too_long", "invalid_sheet", "invalid_film_link", "brief_too_large"]);
const notApplied = (e: { code?: string } | null) => e?.code === "PGRST202" || e?.code === "42883";

/** A refusal of 0249's ai_chat_save_sheets, by name; anything else as 0199's refusals are read (dbRefusal). */
export function sheetsRefusal(error: { code?: string; message?: string; details?: string }): Response {
  const code = error.message ?? "";
  if (code === "plan_not_ready") {
    const step = /^(asking|proposing)$/.test(error.details ?? "") ? error.details : undefined;
    return brainJson({ error: "plan_not_ready", ...(step ? { step } : {}) }, 409);
  }
  if (code === "film_conversation") return brainJson({ error: "film_conversation" }, 409);
  if (SHEET_SHAPE.has(code)) return brainJson({ error: code }, 422);
  return dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503);
}

/**
 * The BRIEF with its sheets. With 0249 the database writes them (ai_chat_save_sheets): under the conversation's row lock, view by
 * view by the same rule as mergeConcurrent, only brief.ref_sheets, and every other BRIEF writer keeps them (its trigger), so a chat
 * turn's or another tab's write can no longer put an older list back. Before 0249 (the function missing: PGRST202 / 42883), #980's
 * path: the session read again right before the write, merged here, and written whole through 0199; its window between the re-read
 * and the write remains on such a database.
 */
export async function saveSheets(c: SheetCtx, sheets: RefSheet[], base: readonly RefSheet[]): Promise<{ ok: true; sheets: RefSheet[] } | { ok: false; res: Response }> {
  const r = (await c.supabase.rpc("ai_chat_save_sheets", { p_session: c.session.id, p_sheets: sheets, p_base: base, p_film_link: null })) as Rpc;
  if (!r.error) {
    // What the row holds after the merge, read through the same caps as any stored list (never the answer cast as sheets).
    const data = r.data && typeof r.data === "object" ? (r.data as { ref_sheets?: unknown }) : {};
    return { ok: true, sheets: readSheets(data.ref_sheets) };
  }
  if (!notApplied(r.error)) return { ok: false, res: sheetsRefusal(r.error) };
  const fresh = await readSession(c.supabase, c.session.id, c.userId);
  if (!fresh.ok) return fresh;
  const refused = stepRefusal(fresh.step);
  if (refused) return { ok: false, res: refused };
  const merged = mergeConcurrent(readSheets(fresh.raw.ref_sheets), sheets, base);
  // The same refusal 0249 makes: more than 40 sheets is said, never cut (a sheet past the 40th may hold a paid job's id).
  if (merged.length > SHEETS_MAX) return { ok: false, res: brainJson({ error: "too_many_sheets" }, 422) };
  const saved = (await c.supabase.rpc("ai_chat_save_brief", { p_session: c.session.id, p_brief: { ...fresh.raw, ref_sheets: merged }, p_step: "ready" })) as Rpc;
  if (saved.error) return { ok: false, res: dbRefusal(saved.error) ?? brainJson({ error: "unavailable" }, 503) };
  return { ok: true, sheets: merged };
}

/**
 * The person's confirm. Refused as price_changed, before anything is held, unless the fresh quote is the very set the person was
 * shown (its token) and within the total they confirmed (Breach BR-RS-01). Then two phases, so a paid picture is never lost from the
 * sheet (Lens M1): 1) every view to make is saved as "making" with the key its job will have; 2) one create_creative_job per view,
 * each capped at its own fresh quote; 3) the job ids saved. If phase 3 fails, the keys find the jobs on the next read.
 */
export async function makeSheets(c: SheetCtx, m: SheetModel, confirmed: number, token: unknown, headers: Headers): Promise<Response> {
  const blocked = geoRefusal(m.id, headers);
  if (blocked) return brainJson(blocked.body, blocked.status);
  const before = await currentSheets(c);
  const q = await quoteSheets(c, m, before);
  if (!q.ok) return brainJson(q.body, q.status);
  if (!q.views.length) return brainJson({ error: "nothing_to_make", sheets: before }, 409);
  const fresh = { total: q.total, views: q.views, waiting: q.waiting, token: q.token };
  if (typeof token !== "string" || token !== q.token || q.total > confirmed) return brainJson({ error: "price_changed", quote: fresh, sheets: before }, 409);
  const at = (sheets: RefSheet[], vq: ViewQuote) => {
    const s = sheets.find((x) => x.character_id === vq.character_id && x.stage === vq.stage)!;
    return { s, v: s.views.find((x) => x.view === vq.view)! };
  };
  const set = (sheets: RefSheet[], vq: ViewQuote, patch: Partial<RefView>) => sheets.map((s) => s.character_id !== vq.character_id || s.stage !== vq.stage ? s
    : { ...s, views: s.views.map((w) => w.view !== vq.view ? w : { ...w, ...patch }) });
  // 1. The intent, with each job's key: nothing is held unless this save went through.
  let sheets = before;
  for (const vq of q.views) {
    const { s, v } = at(sheets, vq);
    sheets = set(sheets, vq, { status: "making", job_id: null, error: null, key: viewInput(c, m, s, v, null).idempotencyKey });
  }
  const intent = await saveSheets(c, sheets, before);
  if (!intent.ok) return intent.res;
  // 2. The creates.
  const claim = geoClaimHeaders([m.id], headers, c.userId);
  let refusal: { status: number; body: Record<string, unknown> } | null = null;
  let started = 0;
  for (const vq of q.views) {
    const { s, v } = at(before, vq);
    const input = viewInput(c, m, s, v, vq.credits);
    if (refusal) { sheets = set(sheets, vq, { status: v.status, key: null }); continue; }
    const out = await createGeneration(c.db, input, claim);
    if (out.status !== 201 && out.status !== 200) {
      refusal = out;
      sheets = set(sheets, vq, { status: v.status, key: null });
      continue;
    }
    started += 1;
    const job = out.body.job as { id: string; quoted_credits?: number };
    if (out.status === 201) {
      await logAudit({ action: "creative.generate", target: job.id,
        detail: { org_id: c.session.orgId, capability: input.capability, model: m.id, quoted_credits: job.quoted_credits ?? null,
                  source_asset_id: typeof input.params.source_asset_id === "string" ? input.params.source_asset_id : null, via: "brain.sheets" } });
    }
    sheets = set(sheets, vq, { status: "making", job_id: job.id });
  }
  // 3. The job ids. Always answered with the sheets as they now are, after any create.
  const saved = await saveSheets(c, sheets, before);
  const shown = saved.ok ? saved.sheets : sheets;
  if (!saved.ok && started > 0) {
    // Pictures were started (credits held for them) and the sheet could not be saved: never "nothing held"; their keys find them.
    return brainJson({ error: "sheets_not_saved", started, sheets: shown, ...(refusal ? { refusal: refusal.body.error } : {}) }, 503);
  }
  if (refusal) return brainJson({ ...refusal.body, started, sheets: shown }, refusal.status);
  if (!saved.ok) return saved.res;
  return brainJson({ sheets: shown, started });
}

/**
 * Approve a made view, or ask for it again (a redo is the next attempt: a new job, quoted again before anything is held). A redone
 * front takes its side and back with it (Lens M5): they were drawn from the old front, so they start again too.
 */
export async function markView(c: SheetCtx, ref: { character_id: unknown; stage: unknown; view: unknown }, act: "approve" | "redo"): Promise<Response> {
  const sheets = await currentSheets(c);
  const s = sheets.find((x) => x.character_id === ref.character_id && x.stage === (ref.stage ?? null));
  const v = s?.views.find((x) => x.view === ref.view);
  // A character, stage or view this conversation's BRIEF does not have reads as missing (never another conversation's).
  if (!s || !v) return notFound();
  if (act === "approve" && v.status !== "ready") return brainJson({ error: "not_ready" }, 409);
  if (act === "redo" && (v.status === "making" || v.status === "planned")) return brainJson({ error: "not_ready" }, 409);
  const again = (w: RefView): RefView => ({ ...w, status: "planned", asset_id: null, job_id: null, error: null, key: null,
    attempt: (w.attempt ?? 0) + (w.job_id || w.asset_id || w.status === "failed" ? 1 : 0) });
  const next = sheets.map((x) => x !== s ? x : { ...x, views: x.views.map((w) => {
    if (act === "approve") return w === v ? { ...w, status: "approved" as const } : w;
    if (w === v) return again(w);
    // A side or back still being made from the old front keeps its job (it is paid for); every other one starts again.
    return v.view === "front" && w.status !== "making" && w.status !== "planned" ? again(w) : w;
  }) });
  const saved = await saveSheets(c, next, sheets);
  return saved.ok ? brainJson({ sheets: saved.sheets }) : saved.res;
}

/**
 * The approved views as each scene's references (save_film scene refs, 0166 film_save_refs), only through an open gate, only on the
 * conversation's own draft (its recorded film_link), each BRIEF scene matched to its film scene by that link (Lens M3). A scene
 * that already has references keeps them (they are the person's, or an earlier attach), and so is a scene whose own key-frame
 * model's gate is closed. The key-frame prompt gains the "Image N" line once, measured against the smaller of the film's and the
 * model's limit and refused by scene, never cut.
 */
export async function attachSheets(c: SheetCtx): Promise<Response> {
  if (!c.film) return brainJson({ error: "bad_request" }, 400);
  const link = c.session.brief.film_link;
  if (!link || link.film_id !== c.film.id) return brainJson({ error: "not_this_film" }, 409);
  // L4: the gate's facts read directly, whether or not a sheet model is on sale now.
  const t2i = await onSale(c.supabase, "t2i");
  if (!t2i) return brainJson({ error: "unavailable" }, 503);
  const gate = gateFor(c, t2i);
  if (!gate.open) return brainJson({ error: "refs_not_supported", reason: gate.reason }, 409);
  if (!c.film.editable) return brainJson({ error: "film_not_editable" }, 409);
  const raw = (await c.supabase.rpc("film_json", { p_film: c.film.id })) as Rpc;
  if (raw.error) return brainJson({ error: "unavailable" }, 503);
  const d = (raw.data ?? {}) as { refs?: { character_id?: unknown; asset_id?: unknown }[]; scenes?: Record<string, unknown>[]; limits?: { max_prompt_chars?: unknown } };
  const filmRefs = Array.isArray(d.refs) ? d.refs : [];
  // A film-wide character reference expands to every picture of that character (0198), a count this route cannot read: the "Image
  // N" numbers would be wrong, so nothing is attached and the remedy is said.
  if (filmRefs.some((r) => typeof r.character_id === "string")) return brainJson({ error: "film_character_refs" }, 409);
  const scenes = Array.isArray(d.scenes) ? d.scenes : [];
  const byId = new Map(scenes.map((fs) => [String(fs.id), fs]));
  const brief = c.session.brief.scenes ?? [];
  // The storyboard the link was recorded for, still there scene for scene; anything else is refused with the remedy (re-plan).
  const pairs = brief.map((bs) => ({ bs, fid: link.scenes.find((x) => x.brief === bs.id)?.film }));
  if (!brief.length || pairs.some((p) => !p.fid || !byId.has(p.fid))) return brainJson({ error: "storyboard_changed" }, 409);
  const sheets = await currentSheets(c);
  // Every picture's stored size and type (0038 media_assets, under the person's session: another workspace's reads as missing).
  const ids = [...new Set([...filmRefs.map((r) => r.asset_id), ...sheets.flatMap((x) => x.views).filter((v) => v.status === "approved").map((v) => v.asset_id)]
    .filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  const assets = new Map<string, AssetFacts>();
  if (ids.length) {
    const a = await c.supabase.from("media_assets").select("id,bytes,mime").eq("org_id", c.session.orgId).in("id", ids);
    if (a.error) return brainJson({ error: "unavailable" }, 503);
    for (const r of (a.data ?? []) as { id?: unknown; bytes?: unknown; mime?: unknown }[]) {
      if (typeof r.id !== "string") continue;
      const n = typeof r.bytes === "number" ? r.bytes : r.bytes != null && Number.isFinite(Number(r.bytes)) ? Number(r.bytes) : null;
      assets.set(r.id, { bytes: n, mime: typeof r.mime === "string" ? r.mime : null });
    }
  }
  let offsetBytes = 0;
  for (const r of filmRefs) {
    const f = typeof r.asset_id === "string" ? assets.get(r.asset_id) : undefined;
    if (!f || f.bytes === null) return brainJson({ error: "ref_size_unknown", scene: null }, 409);
    offsetBytes += f.bytes;
  }
  const offset = filmRefs.length;
  const filmMax = typeof d.limits?.max_prompt_chars === "number" ? d.limits.max_prompt_chars : null;
  const modelMax = (id: string) => {
    const spec = (t2i.find((m) => m.id === id)?.spec ?? {}) as { limits?: { max_prompt_chars?: unknown } };
    return typeof spec.limits?.max_prompt_chars === "number" ? spec.limits.max_prompt_chars : null;
  };
  let attached = 0;
  let already = 0;
  const changes = new Map<string, Record<string, unknown>>();
  for (const [i, { bs, fid }] of pairs.entries()) {
    const fs = byId.get(fid!)!;
    const prompt0 = String(fs.visual_prompt ?? "");
    if (Array.isArray(fs.refs) && fs.refs.length > 0) {
      if (prompt0.split("\n").some((l) => l.startsWith(REF_LINE))) already += 1;
      continue;
    }
    const model = typeof fs.keyframe_model === "string" ? fs.keyframe_model : c.film.keyframeModel;
    const g = refGate(model, t2i, c.age);
    if (!g.open) continue;
    // 16: the worker's own cap on one key frame's pictures (0198 film_take_job), whatever the model's.
    const sel = selectRefs(c.session.brief, sheets, bs, { offset, offsetBytes, maxPictures: Math.min(g.imageRefsMax, 16) }, assets);
    if (sel.refused) return brainJson({ error: sel.refused, scene: i + 1 }, 409);
    if (!sel.refs.length) continue;
    const prompt = withRefLine(prompt0, sel.line);
    const mm = model ? modelMax(model) : null;
    // L1/L2: the smaller of the film's limit (film_limits, 2000) and the model's; a limit that cannot be read is said by name.
    if (filmMax === null || mm === null) return brainJson({ error: "prompt_limit_unknown", scene: i + 1 }, 409);
    const limit = Math.min(filmMax, mm);
    if (prompt.length > limit) return brainJson({ error: "attach_prompt_too_long", scene: i + 1, limit, length: prompt.length }, 422);
    changes.set(fid!, { refs: sel.refs, visual_prompt: prompt });
    attached += 1;
  }
  if (!attached) return brainJson({ error: already ? "already_attached" : "nothing_to_attach" }, 409);
  // The whole scene list, in the film's order: a scene left out of a save_film patch is deleted (0166).
  const patch = scenes.map((fs) => ({ id: String(fs.id), ...(changes.get(String(fs.id)) ?? {}) }));
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

/**
 * The draft's film link, written by 0249's ai_chat_save_sheets alone (its trigger keeps the stored link from a whole-BRIEF write, so
 * the turn route's BRIEF cannot set it any more). Before 0249 the route's BRIEF already carried it through 0199, so a missing
 * function is that path, and nothing is left to do.
 */
export async function saveFilmLink(supabase: SupabaseClient, sessionId: string, link: FilmLink): Promise<{ ok: true } | { ok: false; res: Response }> {
  const r = (await supabase.rpc("ai_chat_save_sheets", { p_session: sessionId, p_sheets: null, p_base: null, p_film_link: link })) as Rpc;
  if (!r.error || notApplied(r.error)) return { ok: true };
  return { ok: false, res: sheetsRefusal(r.error) };
}

/**
 * The ref_sheets and film_link stored on a conversation right now: a route that writes the BRIEF anew carries THESE (Lens M2). With
 * 0249 the database keeps the stored ones whatever the BRIEF carries (its trigger); the carry remains for a database without it.
 */
export async function storedSheets(supabase: SupabaseClient, sessionId: string): Promise<unknown> {
  const r = await supabase.from("ai_chat_sessions").select("brief").eq("id", sessionId).maybeSingle();
  return r.error ? null : (r.data as { brief?: unknown } | null)?.brief ?? null;
}
