import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scenePrompt, type BrainSlots, type SceneParts, type Scenario } from "@/lib/brain/logic";
import { PLAN, mergePlan, outlineText, planRequestId, planWindows, readWindow, refsOf, type PlanLimits, type PlanWindow } from "@/lib/brain/plan";
import { PLAN_SYSTEM_PROMPT, planDataBlock } from "@/lib/brain/prompt";
import { PLAN_CALL_TIMEOUT_MS, callChatModel, type ChatModelId } from "@/lib/server/brain/llm";
import { brainJson, dbRefusal } from "@/lib/server/brain/session";

/**
 * The plan step's calls (S1_GAPS G2): a chosen short outline's storyboard, written window by window by the owner's model, each call
 * an ordinary 0199 turn — reserved under the plan's daily cap, the person's and the platform's BEFORE the vendor is called, and
 * finished with its outcome and tokens. The person is not charged credits for it (the owner's decision for the Brain); nothing here
 * prices, holds, starts or publishes.
 *
 * How the turns are accounted without a message nobody said:
 *   - the first call stores the person's own act as their message: the title of the outline they chose (as answering a card stores
 *     the option they clicked);
 *   - every other call, and a Retry of the same choice, is ai_chat_reserve_turn's p_retry: a turn taken, no message added — 0199
 *     allows it only while the conversation's last message is the person's, unanswered;
 *   - every call is finished with no text, so no assistant message is written and the proposal stays the conversation's last
 *     answer (choosing again reads it, and the draft's idempotency key stays the same).
 *
 * One plan at a time is the database's, not this file's: the route holds 0211's lease (ai_chat_plan_begin) before calling this, and
 * a second tab or a refreshed one is refused `plan_running` there (Breach BR-S1-02: two press ids used to write the storyboard twice).
 * Each call's request id is derived from the lease's attempt (the route's requestBase), so a repeat inside one attempt is 0199's
 * duplicate, and a Retry after a failure is a new attempt with new ids.
 */

/**
 * The plan's own time, inside the route's 300 s: a window is started (or asked again) only while a whole call AND the work after the
 * plan (the draft's save, the quote, the BRIEF: POST_PLAN_MS, Lens L2) still fit.
 */
export const PLAN_BUDGET_MS = 280_000;
const POST_PLAN_MS = 15_000;

type Quota = { used: number; limit: number | null; trial_left: number | null };

export interface PlanRun {
  supabase: SupabaseClient;
  sessionId: string;
  model: ChatModelId;
  endUser: string;
  /** The lease attempt's id base (`pl` + a hash of the conversation, proposal, outline and attempt); each call's id derives from it. */
  requestBase: string;
  /** The person's choice is already the conversation's last, unanswered message (a Retry of this plan): it is not stored twice. */
  choiceStored: boolean;
  /** What the person's choice is stored as: the outline's title. */
  choiceText: string;
  outline: Scenario;
  slots: BrainSlots;
  limits: PlanLimits;
  now?: () => number;
  /** When the request's plan began, when calls were made before this one (the film editor's outline call): the budget counts
   *  from there, so a window is never started that could not finish inside the route's 300 s. */
  startedAt?: number;
}

export type PlanResult = { ok: true; scenario: Scenario; quota: Quota | null } | { ok: false; res: Response; reason: string };

type Step =
  | { ok: true; parts: SceneParts[][] }
  | { ok: false; kind: "length"; problem: string }
  | { ok: false; kind: "prompt"; problem: string; chapter: number; scene: number }
  | { ok: false; kind: "mismatch" }
  | { ok: false; kind: "prompt_too_long"; chapter: number; scene: number }
  | { ok: false; kind: "failed"; reason: string }
  | { ok: false; kind: "content_refused" }
  | { ok: false; kind: "refusal"; error: { code?: string; message?: string; details?: string } | null }
  | { ok: false; kind: "skipped" };

/** Outcomes the paid plan's cap forgives (0199 ai_chat_used): the quota the panel shows is not charged for them. */
const UNCHARGED = new Set(["not_sent", "not_configured", "vendor_refused", "refused"]);

export async function writeStoryboard(run: PlanRun): Promise<PlanResult> {
  const windows = planWindows(run.outline, run.limits);
  if (!windows) return { ok: false, res: brainJson({ error: "plan_failed", reason: "not_plannable", step: null }, 409), reason: "not_plannable" };
  const now = run.now ?? Date.now;
  const started = run.startedAt ?? now();
  const refs = refsOf(run.outline);
  const echo = outlineText(run.outline);
  // Each scene's whole prompt, as filmFromBrief will send it (the outline's characters, locations and the film's style appended).
  const promptOf = (sc: SceneParts) => scenePrompt({ characters: run.outline.characters, locations: run.outline.locations, style: run.slots.style ?? null }, sc);
  let quota: Quota | null = null;
  let forgiven = 0;
  // The plan's cap forgives what was not the person's doing; the Free trial counts every outcome (0199 ai_chat_trial_left), so a
  // forgiven call is never handed back to the trial (Lens M4).
  const quotaNow = (): Quota | null => quota
    ? { used: Math.max(0, quota.used - forgiven), limit: quota.limit, trial_left: quota.trial_left }
    : null;

  // The first call stores the person's choice; the others need it stored first (0199's p_retry wants the last message theirs).
  let opened = run.choiceStored;
  let open: (ok: boolean) => void = () => undefined;
  const gate: Promise<boolean> = run.choiceStored ? Promise.resolve(true) : new Promise<boolean>((r) => { open = r; });

  const call = async (w: PlanWindow, reask: boolean, problem?: string): Promise<Step> => {
    const storesChoice = w.n === 1 && !reask && !run.choiceStored;
    if (!storesChoice && !(await gate)) return { ok: false, kind: "skipped" };
    let reserve: { data: unknown; error: { code?: string; message?: string; details?: string } | null } | null = null;
    try {
      reserve = await run.supabase.rpc("ai_chat_reserve_turn", {
        p_session: run.sessionId, p_text: storesChoice ? run.choiceText : "", p_retry: !storesChoice,
        p_request_id: planRequestId(run.requestBase, w.n, reask),
      });
    } catch {
      reserve = null;
    }
    if (storesChoice) { opened = !!reserve && !reserve.error; open(opened); }
    if (!reserve || reserve.error) return { ok: false, kind: "refusal", error: reserve?.error ?? null };
    const r = reserve.data as { call_id: string; used: number; limit: number | null; trial_left?: number | null };
    if (!quota || r.used > quota.used) quota = { used: r.used, limit: r.limit, trial_left: typeof r.trial_left === "number" ? r.trial_left : null };
    // No text, slots, step, BRIEF or card: the turn is metered, the conversation is not answered (see the header).
    const finish = async (outcome: string, tokensIn: number | null, tokensOut: number | null) => {
      if (UNCHARGED.has(outcome)) forgiven += 1;
      return run.supabase.rpc("ai_chat_finish_turn", {
        p_call: r.call_id, p_outcome: outcome, p_tokens_in: tokensIn, p_tokens_out: tokensOut,
        p_text: null, p_payload: null, p_slots: null, p_step: null, p_brief: null, p_card: null,
      });
    };
    try {
      const llm = await callChatModel(run.model, PLAN_SYSTEM_PROMPT, planDataBlock({
        outline: run.outline, parts: w.parts, window: { n: w.n, of: windows.length },
        limits: { sceneMin: run.limits.sceneMin, sceneMax: run.limits.sceneMax, maxScenes: w.maxScenes, promptMax: run.limits.promptMax },
        style: run.slots.style ?? null, language: run.slots.language ?? null, aspect: run.slots.aspect ?? null, problem,
      }), { endUser: run.endUser, size: "plan" });
      if (!llm.ok) {
        if (llm.error === "vendor_refused") {
          await finish("vendor_refused", llm.tokensIn, llm.tokensOut);
          return { ok: false, kind: "content_refused" };
        }
        await finish(llm.error === "not_configured" ? "not_configured" : llm.error === "output_too_long" ? "output_too_long" : "vendor_error",
                     llm.error === "not_configured" ? null : llm.tokensIn, llm.error === "not_configured" ? null : llm.tokensOut);
        return { ok: false, kind: "failed", reason: llm.error };
      }
      const read = readWindow(llm.text, w, refs, run.limits, echo, promptOf);
      if (!read.ok && read.why === "refused") {
        await finish("refused", llm.tokensIn, llm.tokensOut);
        return { ok: false, kind: "content_refused" };
      }
      const done = await finish(read.ok ? "ok" : "invalid_output", llm.tokensIn, llm.tokensOut);
      if (done.error) return { ok: false, kind: "failed", reason: "unavailable" };
      if (read.ok) return { ok: true, parts: read.parts };
      if (read.why === "length") return { ok: false, kind: "length", problem: read.problem };
      if (read.why === "prompt") return { ok: false, kind: "prompt", problem: read.problem, chapter: read.chapter, scene: read.scene };
      return { ok: false, kind: "failed", reason: "invalid_output" };
    } catch {
      // The vendor may or may not have been paid: a failure with unknown tokens, never "pending" or "ok".
      await finish("vendor_error", null, null).then(() => undefined, () => undefined);
      return { ok: false, kind: "failed", reason: "unavailable" };
    }
  };

  const late = () => now() - started > PLAN_BUDGET_MS - PLAN_CALL_TIMEOUT_MS - POST_PLAN_MS;
  const runWindow = async (w: PlanWindow): Promise<Step> => {
    const first = await call(w, false);
    if (first.ok || (first.kind !== "length" && first.kind !== "prompt")) return first;
    // Once, with the reason in the data block (G1, and a prompt over the models' limit, S9). A second wrong answer fails the plan:
    // never stretched, cut or shortened to fit.
    if (late()) return { ok: false, kind: "failed", reason: "timeout" };
    const again = await call(w, true, first.problem);
    if (again.ok) return again;
    if (again.kind === "prompt") return { ok: false, kind: "prompt_too_long", chapter: again.chapter, scene: again.scene };
    if (again.kind !== "length") return again;
    return { ok: false, kind: "mismatch" };
  };

  // A dense array, filled by index: a window that did not answer is `undefined` there, never a hole `.some` would skip.
  const answers: (SceneParts[][] | undefined)[] = Array.from({ length: windows.length }, () => undefined);
  const failures: { w: PlanWindow; step: Exclude<Step, { ok: true }> }[] = [];
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < windows.length) {
      const w = windows[next++];
      if (late()) {
        failures.push({ w, step: { ok: false, kind: "failed", reason: "timeout" } });
        stop = true;
        break;
      }
      const step = await runWindow(w);
      if (step.ok) answers[w.n - 1] = step.parts;
      else {
        if (step.kind !== "skipped") failures.push({ w, step });
        // One failed chapter fails the plan: nothing more is reserved; calls already running finish and are recorded.
        stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLAN.concurrency, windows.length) }, worker));
  if (!opened && !run.choiceStored) open(false);

  const missing = answers.findIndex((a) => a === undefined) >= 0;
  if (failures.length || missing) {
    const f = failures.sort((a, b) => a.w.n - b.w.n)[0];
    const step = f ? { window: f.w.n, windows: windows.length, chapter: f.w.parts[0].chapter_n, chapters: run.outline.chapters.length } : null;
    const q = quotaNow();
    const withQuota = (body: Record<string, unknown>) => (q ? { ...body, quota: q } : body);
    if (!f) return { ok: false, res: brainJson(withQuota({ error: "plan_failed", reason: "unavailable", step }), 502), reason: "unavailable" };
    const s = f.step;
    if (s.kind === "refusal") {
      // The database's own refusal (a cap, a duplicate), said as it is, with the turns already taken by this plan (Lens M4).
      const res = s.error ? dbRefusal(s.error) : null;
      const body = res ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : { error: "unavailable" };
      return { ok: false, res: brainJson(withQuota(body), res?.status ?? 503), reason: String(body.error ?? "unavailable").slice(0, 40) };
    }
    if (s.kind === "content_refused") return { ok: false, res: brainJson(withQuota({ error: "content_refused" }), 422), reason: "content_refused" };
    if (s.kind === "mismatch") return { ok: false, res: brainJson(withQuota({ error: "plan_length_mismatch", step }), 502), reason: "plan_length_mismatch" };
    // A scene the models cannot take whole, asked again once with the limit: refused by name, never cut (0218 would refuse it too).
    // `scene` counts within its chapter here: the scenes before it in other windows are not known.
    if (s.kind === "prompt_too_long") {
      return { ok: false, reason: "prompt_too_long", res: brainJson(withQuota({ error: "prompt_too_long", scene: s.scene, chapter: s.chapter, limit: run.limits.promptMax, step }), 422) };
    }
    const reason = s.kind === "failed" ? s.reason : "unavailable";
    return { ok: false, res: brainJson(withQuota({ error: "plan_failed", reason, step }), 502), reason };
  }
  const merged = mergePlan(run.outline, windows, answers);
  if (!merged.ok) {
    const q = quotaNow();
    return { ok: false, reason: merged.why, res: brainJson({
      ...(merged.why === "length" ? { error: "plan_length_mismatch", step: null } : { error: "plan_failed", reason: merged.why, step: null }),
      ...(q ? { quota: q } : {}) }, 502) };
  }
  return { ok: true, scenario: merged.scenario, quota: quotaNow() };
}