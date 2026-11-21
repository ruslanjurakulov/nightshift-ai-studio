/**
 * A run-state lamp in its bezel, with the state's word beside it
 * (IDENTITY.md §Signature devices). Off is an unlit ring; every other state
 * fills the lamp. The word is always there — visible, or for screen readers
 * only when `hideLabel` is set and the surrounding text already says it — so
 * colour is never the only signal.
 *
 * Tones match the older StatusPill (components/ui.tsx), so a status view
 * (lib/creative/studio.ts statusView) drives either one:
 *   idle → queued / cancelled (unlit) · run → working (lit amber, breathing
 *   while `live`) · ok → done (green) · fail → failed (tally red) ·
 *   warn → expired / attention (caution) · info → a cue (blue).
 */
export type LampTone = "idle" | "off" | "run" | "ok" | "fail" | "warn" | "info";

export function StatusLamp({
  tone,
  label,
  live = false,
  hideLabel = false,
  size = "sm",
  className,
}: {
  tone: LampTone;
  /** The state, in words. Required: a lamp without a word is a guess. */
  label: string;
  /** Breathe the lamp: only for a state that is genuinely in progress. */
  live?: boolean;
  hideLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={`ns-lamp-row${className ? ` ${className}` : ""}`} data-tone={tone}>
      <span aria-hidden className="ns-lamp" data-tone={tone} data-live={live ? "true" : undefined} data-size={size} />
      <span className={hideLabel ? "sr-only" : "ns-lamp-label"}>{label}</span>
    </span>
  );
}
