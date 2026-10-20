/**
 * Held videos: runs that finished but did NOT upload (migration 0016,
 * modules/held_video.py).
 *
 * A run the publish gate blocked, one waiting on two-person approval, one held
 * because auto-publish is off, and a scene repair's new cut now each have a
 * `videos` row, so they get a detail page — and the Storyboard's "Regenerate
 * scene" button, which only a not-uploaded run can act on. Such a row has no
 * YouTube id (its video_id is a stand-in, "run-…"), no published_at, no
 * privacy and no metrics; when the run later uploads, the pipeline re-keys the
 * SAME row to the YouTube id.
 *
 * The one rule every page applies: a row is uploaded when it has a publish time
 * or a privacy status (StateStore.record_video writes both, and only after a
 * real upload), and held otherwise. It is the same rule sceneRepairEligibility
 * uses, and it holds with or without migration 0016 — `publish_state` only
 * refines WHY a row is held. Aggregates (analytics, dashboards, portfolio,
 * accounts, learning) read uploaded rows only, so a held run never counts as
 * published, never reads as "0 views", and never pushes a real video out of a
 * limited list (Postgres sorts NULL published_at FIRST in a descending order).
 *
 * Pure, so it is unit-tested directly.
 */

export const HELD_STATES = ["blocked", "awaiting_approval", "held", "repaired_awaiting_review"] as const;
export type HeldState = (typeof HELD_STATES)[number];

/** PostgREST filter for "uploaded": published_at or privacy is set. */
export const UPLOADED_FILTER = "published_at.not.is.null,privacy.not.is.null";

function present(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

type Uploadable = { published_at?: string | null; privacy?: string | null; publish_state?: string | null };

/** Did this row reach YouTube? */
export function isUploadedVideo(v: Uploadable | null | undefined): boolean {
  if (!v) return false;
  return present(v.published_at) || present(v.privacy) || v.publish_state === "uploaded";
}

/** A row for a run that finished without uploading. */
export function isHeldVideo(v: Uploadable | null | undefined): boolean {
  return Boolean(v) && !isUploadedVideo(v);
}

/** Why it is held, or "unknown" for a held row written before migration 0016
 *  (or with a state this build does not know) — never guessed. */
export function heldState(v: Uploadable | null | undefined): HeldState | "unknown" {
  const s = v?.publish_state;
  return (HELD_STATES as readonly string[]).includes(s ?? "") ? (s as HeldState) : "unknown";
}

/** The gate's recorded verdict on a held row (hold_detail.gate), or null when
 *  none was recorded. Parsed defensively: the column is free-form jsonb. */
export function heldGate(
  v: { hold_detail?: unknown } | null | undefined,
): { allowed: boolean; blocks: string[]; warnings: string[] } | null {
  const gate = (v?.hold_detail as { gate?: unknown } | null | undefined)?.gate as
    | { allowed?: unknown; blocks?: unknown; warnings?: unknown }
    | null
    | undefined;
  if (!gate || typeof gate !== "object") return null;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return { allowed: gate.allowed === true, blocks: strings(gate.blocks), warnings: strings(gate.warnings) };
}

/** Why a gate-passed run is held anyway (hold_detail.cause, a fixed word from modules/held_video.py). Only
 *  "upload_failed" exists: the cut is finished but the YouTube upload raised. Anything else reads null. */
export function heldCause(v: { hold_detail?: unknown } | null | undefined): "upload_failed" | null {
  const cause = (v?.hold_detail as { cause?: unknown } | null | undefined)?.cause;
  return cause === "upload_failed" ? cause : null;
}

/** True when the run was held BEFORE its video was made (hold_detail.stage, a fixed word written by main.py's
 *  early fact-check stop): there is no cut, no preview and nothing to repair or approve. */
export function heldBeforeRender(v: { hold_detail?: unknown } | null | undefined): boolean {
  return (v?.hold_detail as { stage?: unknown } | null | undefined)?.stage === "before_render";
}

/** The sources a flagged text can ship in (hold_detail.flagged[].source), as modules/claim_extractor.py names them. */
export const FLAGGED_SOURCES = ["hook_ab", "hook_sentence", "title", "title_ab", "description", "thumbnail_text"] as const;
export type FlaggedSource = (typeof FLAGGED_SOURCES)[number];
export const FLAGGED_VERDICTS = ["likely_inaccurate", "unverifiable"] as const;
export type FlaggedVerdict = (typeof FLAGGED_VERDICTS)[number];
export type FlaggedText = { source: FlaggedSource; verdict: FlaggedVerdict; reasoning: string; text: string };

/** The texts outside the narration that the fact-check did not clear (hold_detail.flagged), parsed defensively: the
 *  column is free-form jsonb, so a source or verdict this build does not know is dropped, and the count and the
 *  lengths are capped again here. These are model-written strings, rendered as text only. */
export function heldFlagged(v: { hold_detail?: unknown } | null | undefined): FlaggedText[] {
  const raw = (v?.hold_detail as { flagged?: unknown } | null | undefined)?.flagged;
  if (!Array.isArray(raw)) return [];
  const out: FlaggedText[] = [];
  for (const item of raw) {
    const r = item as { source?: unknown; verdict?: unknown; reasoning?: unknown; text?: unknown } | null;
    if (!r || typeof r !== "object") continue;
    if (!(FLAGGED_SOURCES as readonly string[]).includes(r.source as string)) continue;
    if (!(FLAGGED_VERDICTS as readonly string[]).includes(r.verdict as string)) continue;
    out.push({
      source: r.source as FlaggedSource,
      verdict: r.verdict as FlaggedVerdict,
      reasoning: typeof r.reasoning === "string" ? r.reasoning.slice(0, 300) : "",
      text: typeof r.text === "string" ? r.text.slice(0, 200) : "",
    });
    if (out.length >= 20) break;
  }
  return out;
}

/** Restrict a `videos` query to uploaded rows. Structurally typed like
 *  scopeQuery, so it composes with it without TS2589. */
export function uploadedOnly<Q extends object>(query: Q): Q {
  return (query as unknown as { or: (filter: string) => Q }).or(UPLOADED_FILTER);
}

/** Restrict a `videos` query to held rows. */
export function heldOnly<Q extends object>(query: Q): Q {
  const q = query as unknown as { is: (column: string, value: null) => Q };
  const first = q.is("published_at", null) as unknown as { is: (column: string, value: null) => Q };
  return first.is("privacy", null);
}

/** The localized label for a held state (dictionary section `held`). */
export function heldStateLabel(
  state: HeldState | "unknown",
  h: {
    stateUploadFailed?: string;
    stateBlocked: string;
    stateAwaitingApproval: string;
    stateHeld: string;
    stateRepaired: string;
    stateUnknown: string;
  },
  cause?: "upload_failed" | null,
): string {
  // The upload failing is the real reason, whatever the state column says.
  if (cause === "upload_failed" && h.stateUploadFailed) return h.stateUploadFailed;
  switch (state) {
    case "blocked":
      return h.stateBlocked;
    case "awaiting_approval":
      return h.stateAwaitingApproval;
    case "held":
      return h.stateHeld;
    case "repaired_awaiting_review":
      return h.stateRepaired;
    default:
      return h.stateUnknown;
  }
}
