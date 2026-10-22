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

/** The fixed words of hold_detail.cause (modules/held_video.HOLD_CAUSES): the cut is finished and passed the gate,
 *  but the YouTube upload did not happen. They need different responses, so they are different words:
 *  upload_failed (anything else), quota_exceeded (the day's API quota is used up; it comes back by itself),
 *  upload_limit_exceeded (the channel hit its own upload limit), token_expired (the connection is broken). */
export const HELD_CAUSES = ["upload_failed", "quota_exceeded", "upload_limit_exceeded", "token_expired"] as const;
export type HeldCause = (typeof HELD_CAUSES)[number];

/** Why a gate-passed run is held anyway (hold_detail.cause, a fixed word from modules/held_video.py). Anything
 *  that is not one of HELD_CAUSES reads null: free text is never rendered. */
export function heldCause(v: { hold_detail?: unknown } | null | undefined): HeldCause | null {
  const cause = (v?.hold_detail as { cause?: unknown } | null | undefined)?.cause;
  return typeof cause === "string" && (HELD_CAUSES as readonly string[]).includes(cause) ? (cause as HeldCause) : null;
}

/** The sentence that says what to do about a hold cause (dictionary section `held`), or null when there is none. */
export function heldCauseNote(
  cause: HeldCause | null | undefined,
  h: { uploadFailedNote: string; quotaExceededNote: string; uploadLimitExceededNote: string; tokenExpiredNote: string },
): string | null {
  switch (cause) {
    case "upload_failed":
      return h.uploadFailedNote;
    case "quota_exceeded":
      return h.quotaExceededNote;
    case "upload_limit_exceeded":
      return h.uploadLimitExceededNote;
    case "token_expired":
      return h.tokenExpiredNote;
    default:
      return null;
  }
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

/** What the online source check (modules/grounding.py: the English Wikipedia) did for one video. */
export type EvidenceSource = { title: string; url: string; claims: number };
export type EvidenceInfo = {
  /** False when the check was switched off for the run; null when the record does not say. */
  enabled: boolean | null;
  /** A fixed reason word (http_429, timeout, ...) when the lookup could not run; null when it ran. */
  unavailable: string | null;
  upgraded: number;
  flaggedByEvidence: number;
  sources: EvidenceSource[];
};

const WIKIPEDIA_PAGE = /^https:\/\/en\.wikipedia\.org\/wiki\/[^\s"'<>]+$/;

function count(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
}

/** Parses a `grounding` record (hold_detail.grounding, or fact_check.grounding in the gate event), defensively: the
 *  column and the event are free-form. Only links to the English Wikipedia are kept, so a record can never make the
 *  page link anywhere else; titles are rendered as text. Null when there is no record: an older video, or none. */
export function parseEvidence(raw: unknown): EvidenceInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { enabled?: unknown; unavailable?: unknown; upgraded?: unknown; flagged_by_evidence?: unknown; sources?: unknown };
  const sources: EvidenceSource[] = [];
  if (Array.isArray(r.sources)) {
    for (const item of r.sources) {
      const s = item as { title?: unknown; url?: unknown; claims?: unknown } | null;
      if (!s || typeof s !== "object" || typeof s.url !== "string" || !WIKIPEDIA_PAGE.test(s.url)) continue;
      sources.push({
        title: typeof s.title === "string" && s.title.trim() ? s.title.slice(0, 200) : s.url,
        url: s.url.slice(0, 500),
        claims: count(s.claims),
      });
      if (sources.length >= 30) break;
    }
  }
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : null,
    unavailable: typeof r.unavailable === "string" && /^[\w:.-]{1,40}$/.test(r.unavailable) ? r.unavailable : null,
    upgraded: count(r.upgraded),
    flaggedByEvidence: count(r.flagged_by_evidence),
    sources,
  };
}

/** The online source check of a held run (hold_detail.grounding), or null. */
export function heldEvidence(v: { hold_detail?: unknown } | null | undefined): EvidenceInfo | null {
  return parseEvidence((v?.hold_detail as { grounding?: unknown } | null | undefined)?.grounding);
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
    stateQuotaExceeded?: string;
    stateUploadLimitExceeded?: string;
    stateTokenExpired?: string;
    stateBlocked: string;
    stateAwaitingApproval: string;
    stateHeld: string;
    stateRepaired: string;
    stateUnknown: string;
  },
  cause?: HeldCause | null,
): string {
  // The upload failing is the real reason, whatever the state column says.
  const byCause: Record<HeldCause, string | undefined> = {
    upload_failed: h.stateUploadFailed,
    quota_exceeded: h.stateQuotaExceeded,
    upload_limit_exceeded: h.stateUploadLimitExceeded,
    token_expired: h.stateTokenExpired,
  };
  const causeLabel = cause ? byCause[cause] : undefined;
  if (causeLabel) return causeLabel;
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
