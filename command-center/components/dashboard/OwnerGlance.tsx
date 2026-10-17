import Link from "next/link";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import type { GlanceTone } from "@/lib/owner-glance";

/**
 * The owner's first screen on a phone: one status line and six tall-enough-to-tap tiles, most urgent first
 * (money, failures, what waits for them, alerts, workers, then output). It replaces scrolling past a run card
 * to find out whether anything is wrong. Server-rendered from numbers the page already read; a tile whose
 * read failed says "unknown" rather than 0. Shown below `lg`; from `lg` the page's own figures and side
 * panels carry the same facts.
 */
export interface GlanceTile {
  key: string;
  href: string;
  label: string;
  /** The figure as text, or null when it could not be read (then `unknown` is shown). */
  value: string | null;
  sub?: string;
  tone: GlanceTone;
  /** Spans both columns: a line of names rather than a figure. */
  wide?: boolean;
}

const TONE_VAR: Record<GlanceTone, string | undefined> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  fail: "var(--color-fail)",
  idle: undefined,
};

export function OwnerGlance({
  label,
  health,
  tiles,
  unknown,
}: {
  /** The strip's accessible name. */
  label: string;
  health: { tone: LampTone; text: string; detail: string | null; live: boolean };
  tiles: GlanceTile[];
  /** What a null value reads as ("unknown"). */
  unknown: string;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-3 lg:hidden" data-owner-glance="">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <StatusLamp tone={health.tone} label={health.text} live={health.live} />
        {health.detail && <span className="tnum min-w-0 truncate text-xs text-[var(--color-muted)]">{health.detail}</span>}
      </div>
      <ul className="grid grid-cols-2 gap-2">
        {tiles.map((t) => {
          const known = t.value !== null;
          const flagged = known && (t.tone === "fail" || t.tone === "warn");
          return (
            <li key={t.key} className={t.wide ? "col-span-2 min-w-0" : "min-w-0"}>
              <Link
                href={t.href}
                className="flex min-h-[5.25rem] flex-col justify-between gap-1 rounded-xl border bg-[var(--color-panel)] p-3 transition-colors hover:bg-[var(--color-hover)]"
                style={{ borderColor: flagged ? TONE_VAR[t.tone] : "var(--color-border)" }}
              >
                <span className="text-xs leading-tight text-[var(--color-muted)]">{t.label}</span>
                <span
                  className="tnum text-2xl font-semibold leading-none"
                  style={{ color: known ? TONE_VAR[t.tone] : "var(--color-muted)" }}
                >
                  {known ? t.value : unknown}
                </span>
                {t.sub && <span className={`${t.wide ? "truncate" : "line-clamp-2"} text-xs leading-tight text-[var(--color-muted)]`}>{t.sub}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
