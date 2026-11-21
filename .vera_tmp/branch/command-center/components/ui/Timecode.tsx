import { formatCredits } from "@/lib/credits";
import { formatNumber } from "@/lib/number-format";

/**
 * The counter face (IDENTITY.md §Signature devices): credits, prices,
 * durations and frame numbers read like timecode on a master-control monitor —
 * tabular figures, slashed zero, a narrowed monospace. Columns of numbers
 * never jitter and a price looks like a measurement.
 *
 * An unknown value is never drawn as 0 (CLAUDE.md #5): pass null and the
 * `unknown` words are shown instead, in the body face, so it does not even
 * look like a reading.
 */
export type TimecodeFormat = "credits" | "duration" | "frames" | "count";

export function Timecode({
  value,
  format = "credits",
  fps = 25,
  locale = "en",
  unit,
  unknown = "—",
  label,
  className,
}: {
  value: number | null | undefined;
  format?: TimecodeFormat;
  /** Frames per second, for `frames`. */
  fps?: number;
  /** Number formatting for `credits` and `count`. */
  locale?: string;
  /** A word after the figure ("credits"), set smaller in the body face. */
  unit?: string;
  /** What an unknown reads as. */
  unknown?: string;
  /** A spoken name when the figure alone would be read oddly ("1:05" → "1 minute 5 seconds"). */
  label?: string;
  className?: string;
}) {
  const known = typeof value === "number" && Number.isFinite(value);
  const text = known ? formatTimecode(value, format, { fps, locale }) : unknown;
  return (
    <span className={`ns-tc${className ? ` ${className}` : ""}`} data-format={format} data-unknown={known ? undefined : "true"}>
      {/* A span's aria-label is not reliably read, so a spoken form is real text. */}
      <span aria-hidden={label ? true : undefined}>{text}</span>
      {known && unit && (
        <span className="ns-tc-unit" aria-hidden={label ? true : undefined}>
          {unit}
        </span>
      )}
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");

/**
 * The figure for a value, by format. Pure, so it is tested directly.
 * - credits: locale grouping, up to two decimals ("1,250", "2.5")
 * - count: whole number with grouping
 * - duration: m:ss, or h:mm:ss from an hour ("0:05", "12:40", "1:02:07");
 *   seconds round down, as a clock does
 * - frames: hh:mm:ss:ff at `fps` ("00:00:05:12")
 */
export function formatTimecode(
  value: number,
  format: TimecodeFormat,
  { fps = 25, locale = "en" }: { fps?: number; locale?: string } = {},
): string {
  if (!Number.isFinite(value)) return "—";
  if (format === "credits") return formatCredits(value, locale);
  if (format === "count") return formatNumber(Math.round(value), locale, 0);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (format === "frames") {
    const rate = fps > 0 ? fps : 25;
    const total = Math.floor(abs * rate + 1e-9);
    const ff = total % rate;
    const secs = Math.floor(total / rate);
    return `${sign}${pad(secs / 3600)}:${pad((secs % 3600) / 60)}:${pad(secs % 60)}:${pad(ff)}`;
  }
  const secs = Math.floor(abs + 1e-9);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${sign}${h}:${pad(m)}:${pad(s)}` : `${sign}${m}:${pad(s)}`;
}
