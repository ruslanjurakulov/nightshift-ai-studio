/**
 * The "altered or synthetic content" label a video went out with — read back from the `video.ai_disclosure` event the
 * pipeline records after an upload (modules/ai_disclosure.py). Client-safe and pure.
 *
 * The event, not a column: no migration was needed, and the panel reads it the way it reads the gate's own event. It
 * only says what was recorded. A video with no readable record has an UNKNOWN label (it may predate the feature, or
 * the event has not synced yet), which the panel says — never "not labelled".
 */

export const AI_DISCLOSURE_EVENT = "video.ai_disclosure";

/** The closed words of modules/ai_disclosure.REASONS. */
export const AI_REASONS = [
  "generated_video",
  "generated_images",
  "ai_presenter",
  "real_person_voice",
  "provenance_unknown",
  "mode_always",
  "mode_never",
  "no_synthetic_media",
] as const;
export type AiReason = (typeof AI_REASONS)[number];

export const AI_MODES = ["auto", "always", "never"] as const;
export type AiMode = (typeof AI_MODES)[number];

export interface AiDisclosureView {
  /** True: sent to the platform as "contains altered or synthetic content". */
  label: boolean;
  mode: AiMode;
  reasons: AiReason[];
  /** A disclosure line was added to the description / caption. */
  line: boolean;
}

interface EventLike {
  event: string;
  ts: string;
  metadata: Record<string, unknown> | null;
}

/** The newest readable record, or null. A record with an unknown mode or reason word, or a label that contradicts
 *  its own mode, is not trusted. */
export function aiDisclosureFromEvents(events: readonly EventLike[] | null | undefined): AiDisclosureView | null {
  let best: { ts: string; view: AiDisclosureView } | null = null;
  for (const e of events ?? []) {
    if (!e || e.event !== AI_DISCLOSURE_EVENT) continue;
    const view = parse(e.metadata);
    if (!view) continue;
    if (!best || String(e.ts) >= best.ts) best = { ts: String(e.ts), view };
  }
  return best ? best.view : null;
}

function parse(meta: Record<string, unknown> | null): AiDisclosureView | null {
  if (!meta || typeof meta !== "object") return null;
  const { label, mode, reasons, line } = meta as Record<string, unknown>;
  if (typeof label !== "boolean" || typeof line !== "boolean") return null;
  if (!(AI_MODES as readonly unknown[]).includes(mode)) return null;
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  if (!reasons.every((r) => (AI_REASONS as readonly unknown[]).includes(r))) return null;
  if ((mode === "never" && label) || (mode === "always" && !label)) return null;
  return { label, mode: mode as AiMode, reasons: reasons as AiReason[], line };
}
