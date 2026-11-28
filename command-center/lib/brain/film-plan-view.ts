import type { FilmStudioDictionary } from "@/lib/i18n/film-studio/en";
import { fmt } from "@/lib/i18n";

/**
 * What the film editor's "Write the storyboard with AI" button says, from /api/brain/film's answers (app/api/brain/film/route.ts).
 * Pure and client-safe: the panel in components/films/FilmCanvas.tsx draws it, tests read it directly.
 *
 * Every refusal has its own words and remedy (CLAUDE.md rule 6), and `retry` is true only where pressing again (or checking again)
 * can change the outcome: a model that is down, an answer that could not be read, a plan call that failed. A refusal of the
 * project's own text, a plan cap, a region or a missing plan is not retried: the same press would be refused the same way.
 */

export type AiWords = FilmStudioDictionary["canvas"]["ai"];

/** GET's answer when the plan can run: what it uses, of what is left, and what it would set on the project. */
export interface PlanReadyView {
  about: number;
  most: number;
  left: number | null;
  scope: "plan" | "trial";
  sets: { clip: string | null; keyframe: string | null };
  lastFailed: boolean;
}

export type PlanCheck =
  | { kind: "ready"; ready: PlanReadyView }
  | { kind: "running"; expiresAt: string | null }
  | ({ kind: "blocked" } & Refusal);

/**
 * A refusal as the panel says it. `retry`: pressing again (or checking again) can change it. `check`: it cannot be pressed past, but
 * it changes by itself in time (today's cap), so Check again is offered (Pixel 9). `signIn`: the remedy is signing in again.
 */
export interface Refusal { text: string; retry: boolean; check?: boolean; signIn?: boolean }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A refusal's words, by its error and, for a few, its reason. `via`: which request it answered. An error nobody named reads as
 * "could not check" after a GET and as "could not be written" after a press (Pixel 8), retryable either way.
 */
export function refusalText(w: AiWords, status: number, body: Record<string, unknown>, via: "get" | "post" = "get"): Refusal {
  const r = words(w, status, body, via);
  const e = typeof body.error === "string" ? body.error : "";
  if (status === 401 || e === "unauthorized" || e === "session_expired") return { ...r, signIn: true };
  if (e === "chat_daily_cap" || e === "plan_over_cap") return { ...r, check: true };
  return r;
}

function words(w: AiWords, status: number, body: Record<string, unknown>, via: "get" | "post"): { text: string; retry: boolean } {
  const e = typeof body.error === "string" ? body.error : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (status === 404) return { text: w.off, retry: false };
  if (status === 401 || e === "unauthorized" || e === "session_expired") return { text: w.session, retry: false };
  switch (e) {
    case "forbidden": return { text: w.viewer, retry: false };
    case "adult_only_service": return { text: w.minor, retry: false };
    case "adult_attestation_required": return { text: w.confirmAge, retry: false };
    case "age_unavailable": return { text: w.ageUnreadable, retry: true };
    case "country_blocked": return { text: w.region, retry: false };
    case "country_unverified": return { text: w.support, retry: false };
    case "film_not_editable": return { text: w.readOnly, retry: false };
    case "film_has_scenes": return { text: w.hasScenes, retry: false };
    case "content_refused": return { text: w.contentRefused, retry: false };
    case "film_model_unavailable": return { text: body.role === "keyframe" ? w.keyframeOff : w.clipOff, retry: false };
    case "model_unavailable": return { text: w.modelDown, retry: true };
    case "chat_plan_required": return { text: w.planRequired, retry: false };
    case "chat_daily_cap": return { text: w.dailyCap, retry: false };
    case "plan_over_cap": {
      const most = num(body.needed) ?? "?";
      const left = num(body.left);
      const person = body.scope === "person";
      // A count the server did not give is never drawn as 0 (rule 5): said without the number.
      if (left === null) return { text: fmt(person ? w.overCapPersonNoLeft : w.overCapNoLeft, { most }), retry: false };
      return { text: fmt(person ? w.overCapPerson : w.overCap, { most, left }), retry: false };
    }
    case "plan_unavailable":
    case "not_enabled": return { text: w.planUnavailable, retry: false };
    case "plan_superseded": {
      // Whether this press spent anything is the server's to say (rule 5): nothing before its first turn, its own count after, and
      // "unknown" when that count could not be told. An answer without the stage keeps the older words.
      if (body.stage === "before_turns") return { text: w.supersededBefore, retry: false };
      if (body.stage === "after_turns") {
        const used = num(body.used);
        return { text: used === null ? w.supersededAfterUnknown : fmt(w.supersededAfter, { n: used }), retry: false };
      }
      return { text: w.superseded, retry: false };
    }
    case "plan_length_mismatch": return { text: w.lengthMismatch, retry: true };
    case "prompt_too_long": return { text: fmt(w.promptTooLong, { limit: num(body.limit) ?? "?" }), retry: true };
    case "film_refused": return { text: w.filmRefused, retry: true };
    case "source_too_long": return { text: fmt(w.sourceTooLong, { limit: num(body.limit) ?? "?" }), retry: false };
    case "title_claims_vendor": return { text: w.titleClaimsVendor, retry: false };
    case "film_conversation": return { text: w.filmConversation, retry: false };
    case "film_channel_missing": return { text: w.filmChannelMissing, retry: false };
    // The conversation was handed off meanwhile, or the press it would retry is not its last message: a new press starts clean.
    case "session_closed":
    case "nothing_to_retry": return { text: w.planFailed, retry: true };
    // A request this panel never sends wrong: not the person's to fix, and pressing again sends the same one.
    case "message_too_long":
    case "invalid_params": return { text: w.supportError, retry: false };
    case "plan_failed":
      if (reason === "not_plannable") return { text: w.notPlannable, retry: false };
      // A key the vendor refused, or a model this server has no key for: the owner's fix, never a retry's (NIGHTSHIFT_AI.md).
      if (reason === "vendor_auth" || reason === "not_configured") return { text: w.planFailedFinal, retry: false };
      return { text: w.planFailed, retry: true };
    default: return { text: via === "post" ? w.planFailed : w.unavailable, retry: true };
  }
}

/** GET /api/brain/film's answer as the button's state. */
export function readCheck(w: AiWords, status: number, body: unknown): PlanCheck {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const plan = b.plan && typeof b.plan === "object" ? (b.plan as Record<string, unknown>) : null;
  if (status === 200 && plan?.state === "running") return { kind: "running", expiresAt: typeof plan.expires_at === "string" ? plan.expires_at : null };
  if (status === 200 && b.ready === true) {
    const turns = (b.turns ?? {}) as Record<string, unknown>;
    const about = num(turns.about);
    const most = num(turns.at_most);
    // A count the server did not give is not shown as a number (rule 5): the button cannot say what it uses, so it waits.
    if (about === null || most === null) return { kind: "blocked", text: w.unavailable, retry: true };
    const sets = (b.sets ?? {}) as Record<string, unknown>;
    return {
      kind: "ready",
      ready: {
        about, most, left: num(b.left), scope: b.scope === "trial" ? "trial" : "plan",
        // "" is a model the press sets that has no display name: said as "sets one" (setsText), never by an id.
        sets: { clip: typeof sets.clip === "string" ? sets.clip : null, keyframe: typeof sets.keyframe === "string" ? sets.keyframe : null },
        lastFailed: plan?.state === "failed",
      },
    };
  }
  if (status === 200) return { kind: "blocked", text: w.unavailable, retry: true };
  return { kind: "blocked", ...refusalText(w, status, b) };
}

/** What the press uses, said before it: "about N of your M left today", or without M when it is not known. */
export function costText(w: AiWords, r: PlanReadyView): string {
  if (r.left === null) return fmt(w.costUnknown, { about: r.about, most: r.most });
  return fmt(r.scope === "trial" ? w.costTrial : w.cost, { about: r.about, most: r.most, left: r.left });
}

/** What the press would set on the project, by the model's display name, or "sets one" when it has none. */
export function setsText(w: AiWords, r: PlanReadyView): string[] {
  const clip = r.sets.clip === null ? "" : r.sets.clip ? fmt(w.setsClip, { name: r.sets.clip }) : w.setsClipUnnamed;
  const keyframe = r.sets.keyframe === null ? "" : r.sets.keyframe ? fmt(w.setsKeyframe, { name: r.sets.keyframe }) : w.setsKeyframeUnnamed;
  return [clip, keyframe].filter(Boolean);
}
