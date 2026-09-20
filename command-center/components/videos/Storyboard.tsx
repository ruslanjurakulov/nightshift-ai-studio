import { buildStoryboard, formatClock, type VideoScene } from "@/lib/storyboard";
import { EmptyState } from "@/components/ui";

/**
 * The scene-by-scene storyboard of a video, parsed from its stored narration
 * (see lib/storyboard). Read-only: this pipeline renders autonomously on GitHub
 * Actions, so the storyboard is a lens on what a video does beat by beat — the
 * ordered scenes, each with an estimated on-screen length and its point on the
 * running timeline — not an interactive shot editor.
 *
 * Server component: pure text in, no state, no client JS.
 */
export function Storyboard({
  scenes: sceneRows,
  scriptText,
  labels,
}: {
  /** The video's structured scene plan (migration 0011), when stored. */
  scenes: VideoScene[] | null;
  /** The video's narration — the fallback when no structured scenes exist. */
  scriptText: string | null;
  labels: {
    empty: string;
    scene: string;
    scenes: string;
    runtime: string;
    approx: string;
    keywords: string;
  };
}) {
  const { scenes, totalSeconds } = buildStoryboard(sceneRows, scriptText);

  if (scenes.length === 0) {
    return <EmptyState>{labels.empty}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Summary strip: how many scenes and the estimated runtime. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="mono text-lg text-[var(--color-fg)]">{scenes.length}</span>
          <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {labels.scenes}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="mono text-lg text-[var(--color-fg)]">{formatClock(totalSeconds)}</span>
          <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {labels.runtime}
          </span>
        </div>
      </div>

      {/* The scenes, in narration order, as a vertical timeline. */}
      <ol className="flex flex-col gap-3">
        {scenes.map((s) => (
          <li
            key={s.index}
            className="flex gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
          >
            <div className="flex shrink-0 flex-col items-center gap-1">
              <span
                className="mono flex size-7 items-center justify-center rounded-full border border-[var(--color-border)] text-[12px] text-[var(--color-primary)]"
                aria-hidden
              >
                {s.index}
              </span>
              <span className="mono text-[9px] text-[var(--color-muted)]">
                {formatClock(s.cumulativeSeconds)}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                    {s.name ?? `${labels.scene} ${s.index}`}
                  </span>
                  {s.sceneType && (
                    <span className="pill border border-[var(--color-border)] px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] text-[var(--color-primary)]">
                      {s.sceneType}
                    </span>
                  )}
                </span>
                <span className="mono text-[10px] text-[var(--color-muted)]">
                  {s.durationExact ? "" : `${labels.approx} `}
                  {s.estSeconds}s · {s.words}w
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-[var(--color-fg)]">
                {s.text}
              </p>
              {s.keywords && s.keywords.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                    {labels.keywords}
                  </span>
                  {s.keywords.map((k) => (
                    <span
                      key={k}
                      className="pill border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
