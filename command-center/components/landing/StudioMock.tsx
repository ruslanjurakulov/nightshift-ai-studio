import { AudioLines, Coins, Film, Image as ImageIcon, Play, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

/** Bar heights of the voice card's waveform, in percent. Decorative. */
const WAVE = [28, 52, 74, 46, 90, 62, 38, 70, 96, 58, 34, 66, 84, 50, 30, 60, 78, 44, 26, 54, 72, 40];

/**
 * The hero's product picture: the Studio as a customer sees it — a feed of
 * results with their status, the prompt box with its price line and Generate
 * button, and a finished video waiting for approval. Built from HTML and CSS
 * only (globals.css, "Public landing page"): no image file, no external host.
 *
 * It is labelled an illustration and carries no figures — no price, count or
 * duration — so nothing in it can be read as a quote or a measurement. The
 * whole picture is one labelled image for assistive tech; the parts inside are
 * hidden from it and none of them is focusable.
 *
 * Motion (the caret, the waveform, the video's progress, the lighthouse beam)
 * runs only under prefers-reduced-motion: no-preference; the still frame is
 * the complete picture.
 */
export function StudioMock({ t }: { t: Dictionary }) {
  const m = t.landing.mock;
  return (
    <figure role="img" aria-label={m.label} className="lp-mock relative w-full min-w-0">
      <div aria-hidden className="glass-card overflow-hidden rounded-[22px] border border-[var(--color-border)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[var(--color-border)]" />
            <span className="size-2.5 rounded-full bg-[var(--color-border)]" />
            <span className="size-2.5 rounded-full bg-[var(--color-border)]" />
          </span>
          <span className="text-[13px] font-medium">{m.title}</span>
          <span className="mono pill whitespace-nowrap border border-[var(--color-border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
            {m.tag}
          </span>
        </div>

        <div className="p-3.5 sm:p-5">
          <div className="flex gap-1.5 overflow-hidden">
            {m.filters.map((f, i) => (
              <span
                key={f}
                className={`pill whitespace-nowrap border px-2.5 py-1 text-[11px] ${
                  i === 0
                    ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)]"
                }`}
              >
                {f}
              </span>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5 sm:gap-3">
            <Card kind={m.image} icon={<ImageIcon className="size-3.5" />} status={m.done} tone="ok">
              <span className="lp-art lp-art-night" />
            </Card>

            <Card kind={m.video} icon={<Film className="size-3.5" />} status={m.processing} tone="run">
              <span className="lp-art lp-art-sea">
                <span className="lp-beam" />
                <span className="lp-tower" />
                <span className="absolute inset-0 grid place-items-center">
                  <span className="grid size-9 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                    <Play className="ml-0.5 size-4" fill="currentColor" />
                  </span>
                </span>
                <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-white/20">
                  <span className="lp-progress block h-full rounded-full bg-[var(--color-primary)]" />
                </span>
              </span>
            </Card>

            <Card kind={m.voice} icon={<AudioLines className="size-3.5" />} status={m.done} tone="ok">
              <span className="lp-art flex items-center justify-center gap-[3px] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-panel))] px-3">
                {WAVE.map((h, i) => (
                  <span
                    key={i}
                    className="lp-wave w-[3px] rounded-full bg-[var(--color-primary)]"
                    style={{ height: `${h * 0.6}%`, animationDelay: `${(i % 7) * 0.12}s` }}
                  />
                ))}
              </span>
            </Card>

            <Card kind={m.video} icon={<Film className="size-3.5" />} status={m.failed} tone="fail">
              <span className="lp-art flex flex-col items-center justify-center gap-2 border border-dashed border-[color-mix(in_srgb,var(--color-fail)_55%,transparent)] px-2 text-center">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-ok)]">
                  <RotateCcw className="size-3.5 shrink-0" />
                  {m.returned}
                </span>
                <span className="pill border border-[var(--color-border)] px-2.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                  {m.retry}
                </span>
              </span>
            </Card>
          </div>

          <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:mt-4">
            <p className="text-[12.5px] leading-snug sm:text-[13px]">
              {m.prompt}
              <span className="lp-caret ml-0.5 inline-block h-[1.05em] w-px translate-y-[0.18em] bg-[var(--color-primary)]" />
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {m.chips.map((c) => (
                <span
                  key={c}
                  className="pill border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1 text-[11px]"
                >
                  {c}
                </span>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                <Coins className="size-3.5 shrink-0 text-[var(--color-primary)]" />
                {m.priceNote}
              </span>
              <span className="pill inline-flex items-center gap-1.5 bg-[var(--color-primary)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--color-on-accent)]">
                <Sparkles className="size-3.5" />
                {m.generate}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        aria-hidden
        className="lp-approval glass-card mt-3 flex items-center gap-3 rounded-2xl border border-[var(--color-border)] p-3.5 shadow-[var(--shadow-elevated)] lg:absolute lg:-bottom-9 lg:-left-10 lg:mt-0 lg:w-[19rem]"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-[var(--color-primary)]">
          <ShieldCheck className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{m.approvalTitle}</span>
          <span className="block text-[11.5px] text-[var(--color-muted)]">{m.approvalBody}</span>
        </span>
        <span className="pill border border-[var(--color-primary)] px-3 py-1 text-[12px] text-[var(--color-primary)]">
          {m.approve}
        </span>
      </div>
    </figure>
  );
}

function Card({
  kind,
  icon,
  status,
  tone,
  children,
}: {
  kind: string;
  icon: React.ReactNode;
  status: string;
  tone: "ok" | "run" | "fail";
  children: React.ReactNode;
}) {
  const color = tone === "ok" ? "var(--color-ok)" : tone === "fail" ? "var(--color-fail)" : "var(--color-primary)";
  return (
    <span className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2">
      {children}
      <span className="flex items-center justify-between gap-2 px-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
          {icon}
          <span className="truncate">{kind}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium" style={{ color }}>
          <span className={`size-1.5 rounded-full ${tone === "run" ? "lp-pulse" : ""}`} style={{ background: color }} />
          {status}
        </span>
      </span>
    </span>
  );
}
