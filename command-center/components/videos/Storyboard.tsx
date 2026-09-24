import {
  buildStoryboard,
  claimCounts,
  formatClock,
  type ClaimStatus,
  type VideoScene,
} from "@/lib/storyboard";
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
    claims: string;
    claimsNeedReview: string;
    claimsAdvisory: string;
    claimStatus: Record<ClaimStatus, string>;
  };
}) {
  const { scenes, totalSeconds } = buildStoryboard(sceneRows, scriptText);
  const counts = claimCounts(scenes);

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
        {counts.total > 0 && (
          <div className="flex items-baseline gap-2">
            <span
              className={`mono text-lg ${
                counts.needsReview > 0 ? "text-[var(--color-warn)]" : "text-[var(--color-fg)]"
              }`}
            >
              {counts.needsReview}/{counts.total}
            </span>
            <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
              {labels.claimsNeedReview}
            </span>
          </div>
        )}
      </div>
      {counts.total > 0 && (
        <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">{labels.claimsAdvisory}</p>
      )}

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
              {s.claims && s.claims.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                    {labels.claims}
                  </span>
                  <ul className="flex flex-col gap-1.5">
                    {s.claims.map((c, i) => (
                      <li key={c.id || i} className="flex items-start gap-2 text-[12px] leading-snug">
                        <span
                          className={`pill shrink-0 border border-[var(--color-border)] px-2 py-0.5 text-[9px] uppercase tracking-[0.12em] ${STATUS_TONE[c.status]}`}
                        >
                          {labels.claimStatus[c.status]}
                        </span>
                        <span className="min-w-0 text-[var(--color-fg)]">
                          {c.text}
                          {c.reasoning && (
                            <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">
                              {c.reasoning}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Status colour. "not_checked" is neutral, never green: an unchecked claim is
 *  not an accurate one. */
const STATUS_TONE: Record<ClaimStatus, string> = {
  likely_accurate: "text-[var(--color-ok)]",
  likely_inaccurate: "text-[var(--color-fail)]",
  unverifiable: "text-[var(--color-warn)]",
  not_checked: "text-[var(--color-idle)]",
};
