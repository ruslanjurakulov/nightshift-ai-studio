import { Check, Lock, Moon, Sunrise } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

/**
 * The hero's product picture: one run walking the real pipeline stages, in the
 * Command Center's own vocabulary. It is labelled an example and carries no
 * figures — no counts, durations or scores — so nothing in it can be read as a
 * measurement of anyone's channel.
 *
 * The motion is pure CSS (globals.css, "Public landing page"): each status
 * cell slides a three-slot strip — queued, running, done — and the rows step
 * through in order until the last one stops on "your call". With reduced
 * motion the static state is that finished frame: every stage done, the
 * publish step waiting on a human.
 */
export function LiveRun({ t }: { t: Dictionary }) {
  const r = t.landing.run;
  const last = r.stages.length - 1;

  return (
    <figure
      aria-label={r.label}
      className="glass-card relative w-full min-w-0 rounded-[22px] border border-[var(--color-border)] p-5 sm:p-6"
    >
      <figcaption className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span className="glow-dot pulse size-2 rounded-full bg-[var(--color-primary)] text-[var(--color-primary)]" aria-hidden />
          <span className="t-label">{r.example}</span>
        </span>
        <span className="mono pill border border-[var(--color-border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
          {r.mode}
        </span>
      </figcaption>

      <ol className="relative mt-5">
        {/* The rail: a hairline behind the status cells, filled as the run advances. */}
        <span
          className="absolute bottom-[26px] left-[15px] top-[26px] w-px bg-[var(--color-border)]"
          aria-hidden
        >
          <span className="lp-rail-fill absolute inset-0 bg-[var(--color-primary)] opacity-60" />
        </span>

        {r.stages.map((stage, i) => (
          <li key={stage.name} className="lp-step relative flex items-center gap-3.5 py-[7px]">
            <span className="lp-window relative z-10 size-8 shrink-0 rounded-full" aria-hidden>
              <span className="lp-strip">
                <span className="grid size-8 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]">
                  <span className="size-1.5 rounded-full bg-[var(--color-idle)]" />
                </span>
                <span className="grid size-8 place-items-center rounded-full border border-[var(--color-primary)] bg-[var(--color-panel)]">
                  <span className="glow-dot pulse size-2 rounded-full bg-[var(--color-primary)] text-[var(--color-primary)]" />
                </span>
                <span className="grid size-8 place-items-center rounded-full border border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-accent)]">
                  <Check className="size-4" strokeWidth={2.5} />
                </span>
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[14px] font-medium">{stage.name}</span>
                <span className="lp-window mono h-[14px] shrink-0 text-[10px] uppercase leading-[14px] tracking-[0.12em]" aria-hidden>
                  <span className="lp-strip text-right">
                    <span className="h-[14px] text-[var(--color-muted)]">{r.queued}</span>
                    <span className="h-[14px] text-[var(--color-primary)]">{i === last ? r.awaiting : r.running}</span>
                    <span className="h-[14px] text-[var(--color-muted)]">{r.done}</span>
                  </span>
                </span>
              </span>
              <span className="block text-[12px] font-light leading-snug text-[var(--color-muted)]">{stage.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex items-center gap-2.5 border-t border-[var(--color-border)] pt-4 text-[13px]">
        <Lock className="size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
        <span>{r.footer}</span>
      </div>

      {/* Dusk to dawn: the shift the run happens in. A motif, not a duration. */}
      <div className="mt-4 flex items-center gap-3 text-[var(--color-muted)]" aria-hidden>
        <Moon className="size-3.5 shrink-0" />
        <span className="mono text-[10px] uppercase tracking-[0.12em]">{r.dusk}</span>
        <span className="relative h-px min-w-6 flex-1 bg-[var(--color-border)]">
          <span className="lp-dawn-dot glow-dot absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-primary)] text-[var(--color-primary)]" />
        </span>
        <span className="mono text-[10px] uppercase tracking-[0.12em]">{r.dawn}</span>
        <Sunrise className="size-3.5 shrink-0" />
      </div>
    </figure>
  );
}
