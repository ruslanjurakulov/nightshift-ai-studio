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
    stateBlocked: string;
    stateAwaitingApproval: string;
    stateHeld: string;
    stateRepaired: string;
    stateUnknown: string;
  },
): string {
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
