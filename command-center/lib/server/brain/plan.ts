import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrainSlots, SceneParts, Scenario } from "@/lib/brain/logic";
import { PLAN, mergePlan, planRequestId, planWindows, readWindow, refsOf, type PlanLimits, type PlanWindow } from "@/lib/brain/plan";
import { PLAN_SYSTEM_PROMPT, planDataBlock } from "@/lib/brain/prompt";
import { callChatModel, type ChatModelId } from "@/lib/server/brain/llm";
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
 * One request id per call, derived from the press's id: a repeated press (a network retry, a second tab) is refused as a duplicate
 * by the database before any vendor call, never a second turn.
 */

/** The route's maxDuration is 300 s: a window is started (or asked again) only while a whole call still fits before then. */
export const PLAN_BUDGET_MS = 280_000;
const CALL_MS = 110_000;

type Quota = { used: number; limit: number | null; trial_left: number | null };

export interface PlanRun {
  supabase: SupabaseClient;
  sessionId: string;
  model: ChatModelId;
  endUser: string;
  /** The press's request id; each call's id is derived from it. */
  requestBase: string;
  /** The person's choice is already the conversation's last, unanswered message (a Retry of this plan): it is not stored twice. */
  choiceStored: boolean;
  /** What the person's choice is stored as: the outline's title. */
  choiceText: string;
  outline: Scenario;
  slots: BrainSlots;
  limits: PlanLimits;
  now?: () => number;
}

export type PlanResult = { ok: true; scenario: Scenario; quota: Quota | null } | { ok: false; res: Response };

type Step =
  | { ok: true; parts: SceneParts[][] }
  | { ok: false; kind: "length"; problem: string }
  | { ok: false; kind: "mismatch" }
  | { ok: false; kind: "failed"; reason: string }
  | { ok: false; kind: "content_refused" }
  | { ok: false; kind: "refusal"; res: Response }
  | { ok: false; kind: "skipped" };

/** Outcomes the paid plan's cap forgives (0199 ai_chat_used): the quota the panel shows is not charged for them. */
const UNCHARGED = new Set(["not_sent", "not_configured", "vendor_refused", "refused"]);

export async function writeStoryboard(run: PlanRun): Promise<PlanResult> {
  const windows = planWindows(run.outline, run.limits);
  if (!windows) return { ok: false, res: brainJson({ error: "nothing_to_choose" }, 409) };
  const now = run.now ?? Date.now;
  const started = now();
  const refs = refsOf(run.outline);
  let quota: Quota | null = null;
  let forgiven = 0;
  const quotaNow = (): Quota | null => quota
    ? { used: Math.max(0, quota.used - forgiven), limit: quota.limit, trial_left: quota.trial_left === null ? null : quota.trial_left + forgiven }
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
    if (!reserve) return { ok: false, kind: "refusal", res: brainJson({ error: "unavailable", quota: quotaNow() }, 503) };
    if (reserve.error) return { ok: false, kind: "refusal", res: dbRefusal(reserve.error) ?? brainJson({ error: "unavailable" }, 503) };
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
        limits: { sceneMin: run.limits.sceneMin, sceneMax: run.limits.sceneMax, maxScenes: w.maxScenes },
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
      const read = readWindow(llm.text, w, refs, run.limits);
      if (!read.ok && read.why === "refused") {
        await finish("refused", llm.tokensIn, llm.tokensOut);
        return { ok: false, kind: "content_refused" };
      }
      const done = await finish(read.ok ? "ok" : "invalid_output", llm.tokensIn, llm.tokensOut);
      if (done.error) return { ok: false, kind: "failed", reason: "unavailable" };
      if (read.ok) return { ok: true, parts: read.parts };
      return read.why === "length" ? { ok: false, kind: "length", problem: read.problem } : { ok: false, kind: "failed", reason: "invalid_output" };
    } catch {
      // The vendor may or may not have been paid: a failure with unknown tokens, never "pending" or "ok".
      await finish("vendor_error", null, null).then(() => undefined, () => undefined);
      return { ok: false, kind: "failed", reason: "unavailable" };
    }
  };

  const late = () => now() - started > PLAN_BUDGET_MS - CALL_MS;
  const runWindow = async (w: PlanWindow): Promise<Step> => {
    const first = await call(w, false);
    if (first.ok || first.kind !== "length") return first;
    // Once, with the reason in the data block (G1). A second wrong answer fails the plan: never stretched or cut to fit.
    if (late()) return { ok: false, kind: "failed", reason: "timeout" };
    const again = await call(w, true, first.problem);
    if (again.ok || again.kind !== "length") return again;
    return { ok: false, kind: "mismatch" };
  };

  const answers: SceneParts[][][] = new Array(windows.length);
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

  if (failures.length || answers.some((a) => !a) || answers.length !== windows.length) {
    const f = failures.sort((a, b) => a.w.n - b.w.n)[0];
    const step = f ? { window: f.w.n, windows: windows.length, chapter: f.w.parts[0].chapter_n, chapters: run.outline.chapters.length } : null;
    if (!f) return { ok: false, res: brainJson({ error: "plan_failed", reason: "unavailable", step, quota: quotaNow() }, 502) };
    const s = f.step;
    if (s.kind === "refusal") return { ok: false, res: s.res };
    if (s.kind === "content_refused") return { ok: false, res: brainJson({ error: "content_refused", quota: quotaNow() }, 422) };
    if (s.kind === "mismatch") return { ok: false, res: brainJson({ error: "plan_length_mismatch", step, quota: quotaNow() }, 502) };
    return { ok: false, res: brainJson({ error: "plan_failed", reason: s.kind === "failed" ? s.reason : "unavailable", step, quota: quotaNow() }, 502) };
  }
  const merged = mergePlan(run.outline, windows, answers);
  if (!merged.ok) {
    return { ok: false, res: brainJson(merged.why === "length"
      ? { error: "plan_length_mismatch", step: null, quota: quotaNow() }
      : { error: "plan_failed", reason: merged.why, step: null, quota: quotaNow() }, 502) };
  }
  return { ok: true, scenario: merged.scenario, quota: quotaNow() };
}
