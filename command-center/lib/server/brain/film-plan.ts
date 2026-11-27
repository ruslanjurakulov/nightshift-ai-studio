import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FILM, buildBrief, filmFromBrief, plain, promptOverLimit, unsafeBrief, type BrainSlots, type Scenario } from "@/lib/brain/logic";
import { claimsAuthorship, planLimits, type PlanLimits } from "@/lib/brain/plan";
import { MODEL_ID, pickFilmModel, type OnSaleModel, type PickedModel } from "@/lib/brain/film-models";
import { FILM_PLAN_KEY, SOURCE_MAX, filmChapters, filmPlanTurns, filmSlots, readFilmOutline, unsafeFilm, type FilmPlanSource, type FilmPlanTurns } from "@/lib/brain/film-plan";
import { FILM_OUTLINE_SYSTEM_PROMPT, filmOutlineDataBlock } from "@/lib/brain/prompt";
import { callChatModel, type ChatModelId } from "@/lib/server/brain/llm";
import { chatModelGate } from "@/lib/server/brain/google-gate";
import { catalogueClaimNames, clipShapeOf, filmCatalogue, promptLimitOf, type FilmCatalogue } from "@/lib/server/brain/clip";
import { writeStoryboard } from "@/lib/server/brain/plan";
import { beginFilmLease } from "@/lib/server/brain/film-lease";
import { brainJson, chosenModelState, dbRefusal, machineReason, modelFromRef, vendorUser } from "@/lib/server/brain/session";

/**
 * The film editor's "Write the storyboard with AI" for ONE existing project (docs/studio/NIGHTSHIFT_AI.md, "Writing a project's
 * storyboard"): the chat's plan step, pointed at the project's own settings instead of a proposal. Everything that makes the chat's
 * plan safe is the same code or the same database function:
 *   - the owner's model and its gate (chosenModelState, chatModelGate), refused before any turn, never another model;
 *   - every model call a 0199 turn (ai_chat_reserve_turn before the vendor, ai_chat_finish_turn after), the chat's plan calls
 *     themselves (writeStoryboard) for the scenes;
 *   - 0211's lease, so one plan runs at a time per conversation; it is asked again before every write. A person has one
 *     conversation per project, but two first presses racing can make two (Breach BR-FILM-01): so once its lease is granted, a press
 *     also asks every other conversation of the person's marked with this project, and yields (`plan_running`, no turn) while any
 *     of them is running or cannot be read. Kept as defence in depth: on its own it is per person;
 *   - 0232's film lease (lib/server/brain/film-lease), right after: one plan per PROJECT in the database, whoever presses (two
 *     editors, the chat's draft and this button: BR-FILM-02), and the plan's worst case of turns reserved under the workspace's cap
 *     lock, so a plan that begins can finish (BR-FILM-03). Before 0232 is applied the function is missing and the press goes on as
 *     above, with the read-only cap check below and no `reserved` in its answer: per person, and a plan may stop halfway for the cap
 *     when other chats or plans use today's messages meanwhile;
 *   - the up-front cap check: begun only when today's turns cover the worst case (a read, said before the press; 0232 makes it a
 *     reservation);
 *   - G1 (the length is the project's target_seconds exactly), G3 (clip_params.audio for a scene with lines), G4 (shot counts from
 *     the clip model), the prompt limits of the models it is made with (UTF-16, never cut), no negative_prompt, no seed.
 * What is the film editor's own: the project must be EMPTY (a person's scenes are never replaced: refused before any turn, and
 * save_film at the version read first, so an edit made meanwhile wins as `plan_superseded`), and its own clip and key-frame models
 * are used when it has them (one that is no longer on sale is refused by name: never a silent swap).
 *
 * Nothing here holds credits, quotes, starts or publishes (CLAUDE.md rule 3). The person's Start is the project's own.
 */

type Rpc = { data: unknown; error: { code?: string; message?: string; details?: string } | null };

/** A project as this plan reads it (0166 film_json, as the person: another workspace's project reads as missing). */
export interface PlanFilm extends FilmPlanSource {
  id: string;
  orgId: string;
  channelId: string | null;
  version: number;
  status: string;
  editable: boolean;
  scenes: number;
  clipModel: string | null;
  keyframeModel: string | null;
  maxShots: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const modelOf = (v: unknown) => (typeof v === "string" && MODEL_ID.test(v) ? v : null);

export async function readPlanFilm(supabase: SupabaseClient, id: unknown): Promise<{ ok: true; film: PlanFilm } | { ok: false; res: Response }> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  const r = (await supabase.rpc("film_json", { p_film: id })) as Rpc;
  if (r.error) {
    // film_json answers P0002 for a project that is missing or another workspace's: the same 404 for both.
    if (r.error.code === "P0002" || r.error.message === "not_found") return { ok: false, res: brainJson({ error: "not_found" }, 404) };
    return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  }
  const d = (r.data ?? null) as { film?: Record<string, unknown>; editable?: unknown; scenes?: unknown; totals?: { scenes?: unknown }; limits?: { max_shots?: unknown } } | null;
  const f = d?.film;
  if (!f || typeof f.id !== "string" || typeof f.org_id !== "string" || typeof f.version !== "number" || typeof f.target_seconds !== "number") {
    return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  }
  const scenes = Array.isArray(d?.scenes) ? d!.scenes.length : typeof d?.totals?.scenes === "number" ? d.totals.scenes : null;
  // A count that could not be read is not "empty": nothing is planned over scenes that may be there.
  if (scenes === null) return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  const maxShots = d?.limits?.max_shots;
  return {
    ok: true,
    film: {
      id: f.id, orgId: f.org_id, channelId: typeof f.channel_id === "string" && f.channel_id ? f.channel_id : null,
      version: f.version, status: str(f.status), editable: d?.editable === true, scenes,
      title: str(f.title), sourceKind: str(f.source_kind), sourceText: str(f.source_text), language: str(f.language), aspect: str(f.aspect),
      targetSeconds: f.target_seconds, clipModel: modelOf(f.clip_model), keyframeModel: modelOf(f.keyframe_model),
      maxShots: typeof maxShots === "number" && Number.isInteger(maxShots) && maxShots >= 1 ? maxShots : null,
    },
  };
}

/** The models the storyboard is written for, and which of them the plan sets on the project (only where it has none). */
export interface PlanModels {
  clip: PickedModel | null;
  keyframe: PickedModel | null;
  /** The project had no model for that role; the server's pick (lib/brain/film-models order) is saved with the storyboard. */
  setClip: boolean;
  setKeyframe: boolean;
}

function asPicked(list: OnSaleModel[], id: string): PickedModel | null {
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  const d = (m.durations ?? []).filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b);
  return { id, name: m.name || null, durations: d.length ? d : null };
}

/**
 * The project's own models when it has them and they are on sale; the server's documented order (FILM_MODEL_PREFERENCE) where it
 * has none. A model the project names that is no longer on sale is refused by its role: the person chose it, and swapping it for
 * another in silence would be a quality decision nobody made (CLAUDE.md rule 4).
 */
export function planModels(film: Pick<PlanFilm, "clipModel" | "keyframeModel">, catalogue: Extract<FilmCatalogue, { ok: true }>):
  { ok: true; models: PlanModels } | { ok: false; role: "clip" | "keyframe" } {
  let clip: PickedModel | null = null;
  let keyframe: PickedModel | null = null;
  if (film.clipModel) {
    clip = asPicked(catalogue.clip, film.clipModel);
    if (!clip) return { ok: false, role: "clip" };
  } else clip = pickFilmModel("clip", catalogue.clip);
  if (film.keyframeModel) {
    // 0166 film_check_model takes a t2i OR an edit model as a project's key-frame model.
    keyframe = asPicked([...catalogue.keyframe, ...catalogue.keyframeEdit], film.keyframeModel);
    if (!keyframe) return { ok: false, role: "keyframe" };
  } else keyframe = pickFilmModel("keyframe", catalogue.keyframe);
  return { ok: true, models: { clip, keyframe, setClip: !film.clipModel && !!clip, setKeyframe: !film.keyframeModel && !!keyframe } };
}

/** What both the panel's read and the press need before anything is spent; a refusal says which and why. */
export interface PlanReady {
  slots: BrainSlots;
  models: PlanModels;
  limits: PlanLimits;
  turns: FilmPlanTurns;
  model: ChatModelId;
  /** Today's turns left: the plan's cap minus what is used, or the Free trial's; null when not known (said as "about", no total). */
  left: number | null;
  scope: "plan" | "trial";
  catalogue: Extract<FilmCatalogue, { ok: true }>;
}

/**
 * The project itself: editable, empty, its source text short enough to be read whole, its own words not something that is never
 * made here, and its title not a claim that an AI vendor made the film. Before anything else is read, on GET and POST alike.
 */
export function filmRefusal(film: PlanFilm): Response | null {
  if (!film.editable) return brainJson({ error: "film_not_editable", status: film.status }, 409);
  if (film.scenes > 0) return brainJson({ error: "film_has_scenes", scenes: film.scenes }, 409);
  // Sent whole or not at all (Lens H1): a script cut to its first pages would be planned as if that were all of it.
  if (Array.from(film.sourceText).length > SOURCE_MAX) return brainJson({ error: "source_too_long", limit: SOURCE_MAX }, 422);
  if (unsafeFilm(film)) return brainJson({ error: "content_refused" }, 422);
  // The title is kept as the storyboard's own (readFilmOutline): "Written by ChatGPT" would be on screen as the film's title, and
  // the plan's floor would refuse it only after the outline was paid for (Lens L2). The source text may say anything: it is read.
  if (claimsAuthorship(film.title)) return brainJson({ error: "title_claims_vendor" }, 422);
  return null;
}

/**
 * Everything checked before a turn is taken, in the chat's order: the length (not_plannable), the catalogue and the models, the
 * owner's model and its gate, and the cap against the plan's worst case. Shared by the panel's read (GET, which takes nothing) and
 * the press (POST), so what the button says beforehand is what the press does.
 */
export async function planPrecheck(supabase: SupabaseClient, film: PlanFilm): Promise<{ ok: true; ready: PlanReady } | { ok: false; res: Response }> {
  const slots = filmSlots(film);
  if (!slots.target_seconds || !slots.language) return { ok: false, res: brainJson({ error: "plan_failed", reason: "not_plannable", step: null }, 409) };
  const catalogue = await filmCatalogue(supabase);
  if (!catalogue.ok) return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  const picked = planModels(film, catalogue);
  if (!picked.ok) return { ok: false, res: brainJson({ error: "film_model_unavailable", role: picked.role }, 409) };
  const { models } = picked;
  const maxShots = film.maxShots ?? FILM.maxShots;
  const limits = planLimits(models.clip ? { durations: models.clip.durations, maxShots } : null,
                            promptLimitOf(catalogue, models.clip?.id, models.keyframe?.id));
  const turns = filmPlanTurns(slots.target_seconds, limits);
  if (!turns) return { ok: false, res: brainJson({ error: "plan_failed", reason: "not_plannable", step: null }, 409) };

  const q0 = (await supabase.rpc("ai_chat_quota", { p_org: film.orgId })) as Rpc;
  if (q0.error) return { ok: false, res: dbRefusal(q0.error) ?? brainJson({ error: "unavailable" }, 503) };
  const q = (q0.data ?? {}) as { used?: unknown; limit?: unknown; trial_left?: unknown; model_ref?: unknown; reserved?: unknown; reserved_until?: unknown };
  const state = await chosenModelState(supabase, modelFromRef(q.model_ref));
  if (!state.ok) return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  if (state.state !== "available" || !state.id) return { ok: false, res: brainJson({ error: "model_unavailable", reason: state.state }, 409) };
  const gate = await chatModelGate(state.id);
  if (gate) return { ok: false, res: brainJson({ error: gate.error }, gate.status) };

  const used = typeof q.used === "number" ? q.used : null;
  const limit = typeof q.limit === "number" ? q.limit : null;
  const trial = typeof q.trial_left === "number" ? q.trial_left : null;
  // No cap row for the plan and no trial left: the database refuses every turn (0199 chat_plan_required). Said before the press.
  if (limit === null && trial === 0) return { ok: false, res: brainJson({ error: "chat_plan_required" }, 402) };
  if (limit === 0) return { ok: false, res: brainJson({ error: "chat_plan_required" }, 402) };
  // What other plans hold (0232's ai_chat_quota `reserved`; absent before 0232, when nothing can be held): not used, and not free.
  const reserved = typeof q.reserved === "number" ? Math.max(0, q.reserved) : 0;
  const until = typeof q.reserved_until === "string" ? q.reserved_until : null;
  if (limit !== null && used !== null && used >= limit) return { ok: false, res: brainJson({ error: "chat_daily_cap", used, limit }, 429) };
  const left = limit !== null ? (used === null ? null : Math.max(0, limit - used - reserved)) : trial === null ? null : Math.max(0, trial - reserved);
  // Everything left is held by storyboards being written: back within minutes (`until`), never "come back in 24 hours".
  if (left === 0 && reserved > 0) return { ok: false, res: brainJson({ error: "chat_reserved", used, reserved, limit, until }, 429) };
  if (left !== null && left < turns.at_most) {
    return { ok: false, res: brainJson({ error: "plan_over_cap", needed: turns.at_most, about: turns.about, left,
                                          ...(limit === null ? { scope: "trial" } : {}) }, 429) };
  }
  return { ok: true, ready: { slots, models, limits, turns, model: state.id, left, scope: limit !== null ? "plan" : "trial", catalogue } };
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** How many of the person's conversations marked with one project are asked about: normally one, two after a race (BR-FILM-01). */
const MARKED_MAX = 5;

/**
 * The person's conversations marked with this project, oldest first: theirs (RLS: the author; pinned again here), in the project's
 * workspace, marked with this project (`brief->film_plan->>film_id`, the predicate /api/brain and the history list exclude by), not
 * handed off. A row that is not what was asked for fails the whole read: nothing is planned on a guess.
 */
async function markedConversations(supabase: SupabaseClient, film: PlanFilm, userId: string): Promise<{ ok: true; ids: string[] } | { ok: false }> {
  const r = await supabase.from("ai_chat_sessions").select("id,org_id,created_by,step,created_at")
    .eq("org_id", film.orgId).eq("created_by", userId).eq(`brief->${FILM_PLAN_KEY}->>film_id`, film.id).neq("step", "created")
    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(MARKED_MAX);
  if (r.error) return { ok: false };
  const rows = (r.data ?? []) as { id?: unknown; org_id?: unknown; created_by?: unknown }[];
  if (rows.some((row) => typeof row.id !== "string" || row.org_id !== film.orgId || row.created_by !== userId)) return { ok: false };
  return { ok: true, ids: rows.map((row) => row.id as string) };
}

/**
 * The person's conversation for this project, if there is one. The oldest wins, so two first presses that each made one agree on
 * the same one when both markers are written by then; when they are not, the lease check after ai_chat_plan_begin (planFilm) is what
 * keeps the second from planning too.
 */
export async function findFilmConversation(supabase: SupabaseClient, film: PlanFilm, userId: string):
  Promise<{ state: "ok"; id: string } | { state: "none" } | { state: "failed" }> {
  const marked = await markedConversations(supabase, film, userId);
  if (!marked.ok) return { state: "failed" };
  return marked.ids.length ? { state: "ok", id: marked.ids[0] } : { state: "none" };
}

/**
 * Whether any of these conversations holds a running 0211 lease. Fail closed: one whose state cannot be read counts as running, so
 * a press never plans beside a plan it could not see.
 */
async function runningAmong(supabase: SupabaseClient, ids: string[]):
  Promise<{ state: "running"; expires_at: string | null } | { state: "none" } | { state: "unreadable" }> {
  for (const id of ids) {
    const st = (await supabase.rpc("ai_chat_plan_state", { p_session: id })) as Rpc;
    if (st.error) return { state: "unreadable" };
    const d = (st.data ?? null) as { state?: unknown; expires_at?: unknown } | null;
    if (d && typeof d === "object" && d.state === "running") return { state: "running", expires_at: typeof d.expires_at === "string" ? d.expires_at : null };
  }
  return { state: "none" };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a conversation id the panel hands back (`retry_session`, after a marker write that failed: BR-FILM-06) may become this
 * project's: only the empty conversation this route made and could not mark. The person's own, in the project's workspace and
 * channel, not handed off, with nothing in it (no BRIEF, no message) and made within the last day. Anything else is never marked:
 * a new conversation is started instead, so a chat with words in it can never be taken over by a crafted id.
 */
async function adoptable(supabase: SupabaseClient, film: PlanFilm, userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const r = await supabase.from("ai_chat_sessions").select("id,org_id,channel_id,created_by,step,brief,created_at").eq("id", id).eq("created_by", userId).limit(1);
  if (r.error) return false;
  const row = ((r.data ?? []) as Record<string, unknown>[])[0];
  if (!row || row.id !== id || row.created_by !== userId || row.org_id !== film.orgId || (row.channel_id ?? null) !== film.channelId) return false;
  if (row.step === "created") return false;
  const brief = row.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief) || Object.keys(brief).length > 0) return false;
  const born = typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;
  if (!Number.isFinite(born) || Date.now() - born >= DAY_MS) return false;
  const m = await supabase.from("ai_chat_messages").select("id").eq("session_id", id).limit(1);
  return !m.error && ((m.data ?? []) as unknown[]).length === 0;
}

/** A BRIEF that names the project: the chat's own shape, plus the marker. */
function markedBrief(sessionId: string, slots: BrainSlots, chosen: Scenario | null, filmId: string) {
  return { ...buildBrief(sessionId, slots, chosen, chosen ? "ready" : "drafting"), [FILM_PLAN_KEY]: { film_id: filmId } };
}

/**
 * This project's conversation, made the first time (0199 ai_chat_start, the person's own, for the project's workspace and channel)
 * and marked with the project through ai_chat_save_brief. The chat panel never opens it by itself: /api/brain and the history list
 * leave marked conversations out, so the chat keeps the person's own conversations as before.
 */
export async function openFilmConversation(supabase: SupabaseClient, film: PlanFilm, userId: string, slots: BrainSlots,
                                           retrySession: string | null = null): Promise<{ ok: true; id: string } | { ok: false; res: Response }> {
  const found = await findFilmConversation(supabase, film, userId);
  if (found.state === "ok") return { ok: true, id: found.id };
  if (found.state === "failed") return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  // The empty conversation an earlier press made and could not mark (BR-FILM-06), when the panel hands its id back: used, rather
  // than one more conversation counted against 0199's sessions_per_user_daily on every press.
  let sid: string | null = retrySession && (await adoptable(supabase, film, userId, retrySession)) ? retrySession : null;
  if (!sid) {
    const started = (await supabase.rpc("ai_chat_start", { p_org: film.orgId, p_channel: film.channelId })) as Rpc;
    if (started.error) {
      // The project's channel left the workspace (or was deleted): the project's setting to fix, not "Nightshift AI is off" (L3).
      if (started.error.message === "channel_not_found") return { ok: false, res: brainJson({ error: "film_channel_missing" }, 409) };
      return { ok: false, res: dbRefusal(started.error) ?? brainJson({ error: "unavailable" }, 503) };
    }
    sid = String(started.data);
  }
  // Asked twice inside the request: a timeout on the marker leaves an unmarked conversation that the chat would resume as its own.
  let marked: Rpc | null = null;
  for (let i = 0; i < 2 && (!marked || marked.error); i++) {
    marked = (await Promise.resolve(supabase.rpc("ai_chat_save_brief", { p_session: sid, p_brief: markedBrief(sid, slots, null, film.id), p_step: "ready" }))
      .catch(() => ({ data: null, error: { message: "unavailable" } }))) as Rpc;
  }
  // Still not marked: its id goes back to the panel, which sends it with the next press (component state only), and only an empty
  // conversation of the person's own is ever taken back (adoptable).
  if (!marked || marked.error) return { ok: false, res: brainJson({ error: "unavailable", retry_session: sid }, 503) };
  // Read again rather than trusting our own: a second tab's first press may have made one too, and both must plan in the same one.
  const again = await findFilmConversation(supabase, film, userId);
  if (again.state !== "ok") return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  return { ok: true, id: again.id };
}

/**
 * What GET says about a plan of this project: running when ANY of the person's conversations marked with it holds a running lease
 * (the same rule a press yields by), else the oldest one's own lease (its last attempt failed, or it is done), or none yet.
 */
export async function filmLeaseView(supabase: SupabaseClient, film: PlanFilm, userId: string): Promise<{ ok: true; lease: LeaseView } | { ok: false; res: Response }> {
  const mine = await markedConversations(supabase, film, userId);
  if (!mine.ok) return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  const own = await leaseView(supabase, mine.ids[0] ?? null);
  if (!own.ok || own.lease?.state === "running") return own;
  const other = await runningAmong(supabase, mine.ids.slice(1));
  if (other.state === "unreadable") return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
  if (other.state === "running") return { ok: true, lease: { state: "running", reason: null, expires_at: other.expires_at } };
  return own;
}

/**
 * The client with every ai_chat_reserve_turn counted into `turns`: a reserve that answered is a turn taken; one refused by the
 * database (a creative_refuse NSxxx, any SQLSTATE: the transaction rolled back; a PGRSTxxx: never run) is none; one whose answer was lost (a thrown
 * call, a fetch error with no code, an answer without its call id) may or may not have been taken, and the count becomes unknown.
 */
function countingReserves(supabase: SupabaseClient, turns: { reserved: number; known: boolean }): SupabaseClient {
  return new Proxy(supabase, {
    get(target, prop, receiver) {
      if (prop !== "rpc") return Reflect.get(target, prop, receiver);
      return (fn: string, ...rest: unknown[]) => {
        const call = (target.rpc as (...a: unknown[]) => PromiseLike<Rpc>)(fn, ...rest);
        if (fn !== "ai_chat_reserve_turn") return call;
        return Promise.resolve(call).then((r) => {
          // An answer without its call id is a reservation nobody can read back: counted as unknown, not as one or none.
          if (!r.error) {
            if (typeof (r.data as { call_id?: unknown } | null)?.call_id === "string") turns.reserved += 1;
            else turns.known = false;
          } else if (!/^(?:NS\d{3}|PGRST\d{3}|[0-9A-Z]{5})$/.test(r.error.code ?? "")) turns.known = false;
          return r;
        }, (e: unknown) => {
          turns.known = false;
          throw e;
        });
      };
    },
  });
}

/** 0211's lease as the panel follows it (a refresh, a second tab): running until `expires_at`, failed with its reason, or done. */
export type LeaseView = { state: "running" | "failed" | "done" | "unknown"; reason: string | null; expires_at: string | null } | null;

const MISSING = new Set(["PGRST202", "42883", "PGRST205", "42P01"]);

export async function leaseView(supabase: SupabaseClient, sessionId: string | null): Promise<{ ok: true; lease: LeaseView } | { ok: false; res: Response }> {
  // Without a conversation yet, asked about one that cannot exist: 0211 answers session_not_found when it is there, and the
  // missing function when it is not, so the panel can say plan_unavailable before the first press too.
  const r = (await supabase.rpc("ai_chat_plan_state", { p_session: sessionId ?? "00000000-0000-0000-0000-000000000000" })) as Rpc;
  if (r.error) {
    if (MISSING.has(r.error.code ?? "")) return { ok: false, res: brainJson({ error: "plan_unavailable" }, 503) };
    if (!sessionId && r.error.message === "session_not_found") return { ok: true, lease: null };
    return { ok: true, lease: { state: "unknown", reason: null, expires_at: null } };
  }
  const d = (r.data ?? null) as { state?: unknown; reason?: unknown; expires_at?: unknown } | null;
  if (!d || typeof d !== "object") return { ok: true, lease: null };
  return {
    ok: true,
    lease: {
      state: d.state === "running" || d.state === "failed" || d.state === "done" ? d.state : "unknown",
      reason: typeof d.reason === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(d.reason) ? d.reason : null,
      expires_at: typeof d.expires_at === "string" ? d.expires_at : null,
    },
  };
}

type Quota = { used: number; limit: number | null; trial_left: number | null };
/** Outcomes the plan's cap forgives (0199 ai_chat_used): the quota shown is not charged for them. */
const UNCHARGED = new Set(["not_sent", "not_configured", "vendor_refused", "refused"]);

/**
 * The press: the outline call, then the chat's plan calls, then the storyboard saved into the project at the version read before
 * anything was spent. `film` and `ready` are the route's, read and checked this request; `said` is what the person's press is stored
 * as (the project's title, or the panel's own words when it has none).
 */
export async function planFilm(args: {
  supabase: SupabaseClient; film: PlanFilm; ready: PlanReady; userId: string; said: string;
  /** When the request began (the route's first line, Lens L1): the plan's 300 s include the precheck and the outline call. */
  startedAt: number;
  /** A conversation id from an earlier 503 `retry_session` (openFilmConversation). */
  retrySession?: string | null;
}): Promise<Response> {
  const { film, ready, userId } = args;
  const started = args.startedAt;
  // This press's own turns, counted as they are reserved (the outline's and every plan call's, writeStoryboard's included): what a
  // plan_superseded after them says was used. Unknown once a reserve's outcome cannot be told (rule 5: never 0, never a guess).
  const turns = { reserved: 0, known: true };
  const supabase = countingReserves(args.supabase, turns);
  const conv = await openFilmConversation(supabase, film, userId, ready.slots, args.retrySession ?? null);
  if (!conv.ok) return conv.res;
  const sid = conv.id;
  // Within 0199's smallest message limit (max_input_chars is at least 100).
  const said = plain(args.said, 100);
  if (!said) return brainJson({ error: "bad_request" }, 400);

  let lease: { attempt: number } | null = null;
  let ending: { state: "done" | "failed"; reason: string } = { state: "failed", reason: "unavailable" };
  let quota: Quota | null = null;
  const withQuota = (body: Record<string, unknown>) => (quota ? { ...body, quota } : body);
  const fail = (reason: string, body: Record<string, unknown>, status: number) => {
    ending = { state: "failed", reason };
    return brainJson(withQuota(body), status);
  };
  /** Whether this request's attempt still holds the lease (Breach BR-S1-08): asked before every write. */
  const stillOurs = async (): Promise<boolean> => {
    if (!lease) return false;
    const st = (await supabase.rpc("ai_chat_plan_state", { p_session: sid })) as Rpc;
    const d = (st.data ?? null) as { attempt?: unknown; state?: unknown } | null;
    return !st.error && !!d && d.attempt === lease.attempt && d.state === "running";
  };
  /** The project moved on. `before_turns`: nothing of this press was spent; `after_turns`: its reserved turns, or null if unknown. */
  const superseded = (stage: "before_turns" | "after_turns") => fail("plan_superseded", {
    error: "plan_superseded", film_id: film.id, stage, used: stage === "before_turns" ? 0 : turns.known ? turns.reserved : null,
  }, 409);

  // 1. One plan at a time (0211): the same lease the chat's plan holds. Proposal 0, outline 0: a project's conversation plans one
  // thing only, its project.
  const begun = (await supabase.rpc("ai_chat_plan_begin", { p_session: sid, p_proposal: 0, p_index: 0 })) as Rpc;
  if (begun.error) {
    if (MISSING.has(begun.error.code ?? "")) return brainJson({ error: "plan_unavailable" }, 503);
    if (begun.error.message === "plan_running") {
      return brainJson({ error: "plan_running", expires_at: typeof begun.error.details === "string" ? begun.error.details : null }, 409);
    }
    return dbRefusal(begun.error) ?? brainJson({ error: "unavailable" }, 503);
  }
  const b = (begun.data ?? {}) as { attempt?: unknown; user_left?: unknown };
  if (typeof b.attempt !== "number" || !Number.isInteger(b.attempt)) return brainJson({ error: "plan_unavailable" }, 503);
  lease = { attempt: b.attempt };
  try {
    // One plan of this project per person (BR-FILM-01): two first presses that raced can each hold a lease of their own
    // conversation. With ours granted, every other one marked with this project is asked; while any runs, or cannot be read, this
    // press yields before its first turn (ours is ended as failed, `plan_running`). Whichever asks second sees the other's lease.
    const mine = await markedConversations(supabase, film, userId);
    if (!mine.ok) return fail("unavailable", { error: "unavailable" }, 503);
    const other = await runningAmong(supabase, mine.ids.filter((id) => id !== sid));
    if (other.state !== "none") return fail("plan_running", { error: "plan_running", expires_at: other.state === "running" ? other.expires_at : null }, 409);
    // One plan per project, whoever presses, with its worst case reserved (0232): before the project is read again, so a plan that
    // held it and finished meanwhile has written its scenes by then. A refusal takes no turn; ending ours (finally) ends it too.
    const filmLease = await beginFilmLease(supabase, sid, film.id, ready.turns);
    if (!filmLease.ok) {
      ending = { state: "failed", reason: filmLease.reason };
      return filmLease.res;
    }
    // And the project again, now that no other plan of ours is running: one that finished meanwhile wrote its scenes (or an edit
    // moved the version). Said before any turn, never planned over.
    const fresh = await readPlanFilm(supabase, film.id);
    if (!fresh.ok) return fresh.res;
    if (fresh.film.scenes > 0) return fail("film_has_scenes", { error: "film_has_scenes", scenes: fresh.film.scenes }, 409);
    if (fresh.film.version !== film.version) return superseded("before_turns");
    // The person's own turns across every workspace (0199 per_user_daily), returned by the lease: the same up-front rule.
    if (typeof b.user_left === "number" && b.user_left < ready.turns.at_most) {
      return fail("plan_over_cap", { error: "plan_over_cap", needed: ready.turns.at_most, about: ready.turns.about, left: b.user_left, scope: "person" }, 429);
    }
    const endUser = await vendorUser(film.orgId);
    // Every model and provider the catalogue sells: a plan answer never claims one of them made the film (BR-FILM-04a).
    const claimNames = catalogueClaimNames(ready.catalogue);
    const chapters = filmChapters(ready.slots.target_seconds as number);
    if (!chapters) return fail("not_plannable", { error: "plan_failed", reason: "not_plannable", step: null }, 409);

    // 2. The outline: one turn. It stores the person's press as their message, unless that is already the conversation's last,
    // unanswered one (a Retry after a failed plan), and is finished with no text, so the conversation is not answered and every
    // plan call after it may be 0199's p_retry.
    const last = await supabase.from("ai_chat_messages").select("id,role,content").eq("session_id", sid).order("id", { ascending: false }).limit(1);
    if (last.error) return fail("unavailable", { error: "unavailable" }, 503);
    const lastRow = ((last.data ?? []) as { role?: string; content?: string }[])[0];
    const storesPress = !(lastRow?.role === "user" && lastRow.content === said);
    const reserve = (await supabase.rpc("ai_chat_reserve_turn", {
      p_session: sid, p_text: storesPress ? said : "", p_retry: !storesPress,
      p_request_id: `fo${digest(`film-outline:${sid}:${film.id}:${lease.attempt}`).slice(0, 40)}`,
    })) as Rpc;
    if (reserve.error) {
      const res = dbRefusal(reserve.error);
      const body = res ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : { error: "unavailable" };
      return fail(String(body.error ?? "unavailable").slice(0, 40), body, res?.status ?? 503);
    }
    const r = reserve.data as { call_id: string; used: number; limit: number | null; trial_left?: number | null };
    quota = { used: r.used, limit: r.limit, trial_left: typeof r.trial_left === "number" ? r.trial_left : null };
    const finish = (outcome: string, tokensIn: number | null, tokensOut: number | null) => {
      if (UNCHARGED.has(outcome) && quota) quota = { ...quota, used: Math.max(0, quota.used - 1) };
      return supabase.rpc("ai_chat_finish_turn", {
        p_call: r.call_id, p_outcome: outcome, p_tokens_in: tokensIn, p_tokens_out: tokensOut,
        // The project's settings as the conversation's slots; no text, BRIEF or card (see above).
        p_text: null, p_payload: null, p_slots: outcome === "ok" ? ready.slots : null, p_step: null, p_brief: null, p_card: null,
      }) as unknown as Promise<Rpc>;
    };
    let outline: Scenario;
    try {
      const llm = await callChatModel(ready.model, FILM_OUTLINE_SYSTEM_PROMPT, filmOutlineDataBlock({
        title: film.title, sourceKind: film.sourceKind, sourceText: plain(film.sourceText, SOURCE_MAX, true), language: ready.slots.language ?? null,
        aspect: ready.slots.aspect ?? null, targetSeconds: ready.slots.target_seconds as number, chapters,
      }), { endUser, size: "plan" });
      if (!llm.ok) {
        if (llm.error === "vendor_refused") {
          await finish("vendor_refused", llm.tokensIn, llm.tokensOut);
          return fail("content_refused", { error: "content_refused" }, 422);
        }
        const outcome = llm.error === "not_configured" ? "not_configured" : llm.error === "output_too_long" ? "output_too_long" : "vendor_error";
        await finish(outcome, outcome === "not_configured" ? null : llm.tokensIn, outcome === "not_configured" ? null : llm.tokensOut);
        return fail(llm.error, { error: "plan_failed", reason: llm.error, step: null }, 502);
      }
      const read = readFilmOutline(llm.text, film, chapters, ready.slots, claimNames);
      if (!read.ok) {
        await finish(read.why === "refused" ? "refused" : "invalid_output", llm.tokensIn, llm.tokensOut);
        return read.why === "refused" ? fail("content_refused", { error: "content_refused" }, 422)
          : fail("invalid_output", { error: "plan_failed", reason: "invalid_output", step: null }, 502);
      }
      const done = await finish("ok", llm.tokensIn, llm.tokensOut);
      if (done.error) return fail("unavailable", { error: "plan_failed", reason: "unavailable", step: null }, 502);
      outline = read.outline;
    } catch {
      // The vendor may or may not have been paid: a failure with unknown tokens, never "pending" or "ok".
      await Promise.resolve(finish("vendor_error", null, null)).then(() => undefined, () => undefined);
      return fail("unavailable", { error: "plan_failed", reason: "unavailable", step: null }, 502);
    }
    // The floor under the prompt's and the vendors' safety rules, over the outline before a scene is asked for (the chat's step 1).
    if (unsafeBrief(buildBrief(sid, ready.slots, outline, "ready"))) return fail("content_refused", { error: "content_refused" }, 422);

    // 3. The scenes: the chat's own plan calls, every one a p_retry turn after the press stored above, their budget counted from
    // this request's start (the outline call already ran inside it).
    const run = await writeStoryboard({
      supabase, sessionId: sid, model: ready.model, endUser,
      requestBase: `pl${digest(`film-plan:${sid}:${film.id}:${lease.attempt}`).slice(0, 40)}`,
      choiceStored: true, choiceText: said, outline, slots: ready.slots, limits: ready.limits, startedAt: started, claimNames,
    });
    if (!run.ok) {
      ending = { state: "failed", reason: run.reason };
      // The plan's own answer carries the quota after its calls; without one (none was reserved), the outline call's.
      const body = (await run.res.json().catch(() => ({}))) as Record<string, unknown>;
      return brainJson(body.quota ? body : withQuota(body), run.res.status);
    }
    if (run.quota) quota = run.quota;
    const { clip, keyframe } = ready.models;
    const planned: Scenario = { ...run.scenario, scenes: run.scenario.scenes.map((sc) => ({ ...sc, clip_model: clip?.id ?? null, keyframe_model: keyframe?.id ?? null })) };
    const brief = buildBrief(sid, ready.slots, planned, "ready");
    // The whole storyboard through the same floor: a chapter's own words could carry what the outline did not.
    if (unsafeBrief(brief)) return fail("content_refused", { error: "content_refused" }, 422);
    // Every scene's whole prompt, as the models it is made with read it (UTF-16): one over is refused by number, never cut.
    const tooLong = promptOverLimit(brief, ready.limits.promptMax);
    if (tooLong) return fail("prompt_too_long", { error: "prompt_too_long", scene: tooLong.scene, limit: tooLong.limit }, 422);
    const shaped = filmFromBrief(brief, clipShapeOf(ready.catalogue.clip, clip?.id ?? null, film.maxShots ?? FILM.maxShots), ready.limits.promptMax);
    if (!shaped) return fail("plan_failed", { error: "plan_failed", reason: "unavailable", step: null }, 502);

    // 4. Saved into the project at the version read before anything was spent, only while this attempt holds the lease. An edit made
    // meanwhile moved the version on: their edit wins, and nothing is written (`plan_superseded`).
    if (!(await stillOurs())) return superseded("after_turns");
    const patch: Record<string, unknown> = {
      scenes: shaped.scenes,
      ...(ready.models.setClip && clip ? { clip_model: clip.id } : {}),
      ...(ready.models.setKeyframe && keyframe ? { keyframe_model: keyframe.id } : {}),
    };
    const saved = (await supabase.rpc("save_film", { p_film: film.id, p_version: film.version, p_patch: patch })) as Rpc;
    if (saved.error) {
      if (saved.error.message === "film_changed") return superseded("after_turns");
      return fail("film_refused", { error: "film_refused", reason: machineReason(saved.error.message), film_id: film.id }, 409);
    }
    const version = (saved.data as { film?: { version?: unknown } } | null)?.film?.version;
    ending = { state: "done", reason: "" };
    // The conversation's record of what was written (the chat's BRIEF shape, unpriced: the project's own Start quotes). The project
    // is already saved; a record that fails to write changes nothing the person sees.
    if (await stillOurs()) {
      await Promise.resolve(supabase.rpc("ai_chat_save_brief", { p_session: sid, p_brief: markedBrief(sid, ready.slots, planned, film.id), p_step: "ready" }))
        .then(() => undefined, () => undefined);
    }
    return brainJson(withQuota({
      film: { id: film.id, version: typeof version === "number" ? version : film.version + 1 },
      scenes: shaped.scenes.length,
      seconds: planned.scenes.reduce((a, s) => a + s.duration_s, 0),
      models: { clip: clip?.name ?? null, keyframe: keyframe?.name ?? null },
      // The turns the database reserved for this plan (0232); absent when it is not applied: no reservation is claimed.
      ...(filmLease.held ? { reserved: filmLease.reserved } : {}),
    }));
  } finally {
    const held = lease as { attempt: number } | null;
    if (held) {
      const reason = ending.state === "done" ? null : /^[a-z][a-z0-9_]{0,39}$/.test(ending.reason) ? ending.reason : "unavailable";
      await Promise.resolve(supabase.rpc("ai_chat_plan_end", { p_session: sid, p_attempt: held.attempt, p_state: ending.state, p_reason: reason }))
        .then(() => undefined, () => undefined);
    }
  }
}

