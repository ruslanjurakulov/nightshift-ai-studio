import {
  buildStoryboard,
  claimCounts,
  formatClock,
  type ClaimStatus,
  type VideoScene,
} from "@/lib/storyboard";
import {
  dropBarPercent,
  isWorstScene,
  pctText,
  pointsText,
  type SceneRetentionSummary,
} from "@/lib/sceneRetention";
import { EmptyState } from "@/components/ui";
import { fmt } from "@/lib/i18n";

/**
 * The scene-by-scene storyboard of a video, parsed from its stored narration
 * (see lib/storyboard). Read-only: this pipeline renders autonomously on GitHub
 * Actions, so the storyboard is a lens on what a video does beat by beat — the
 * ordered scenes, each with an estimated on-screen length and its point on the
 * running timeline — not an interactive shot editor.
 *
 * When the video has a measured retention curve and real scene times, each
 * scene also shows where its audience went (lib/sceneRetention): retention at
 * its start and end, the points lost, the loss per minute as a bar, and the
 * fastest-losing scenes highlighted. Otherwise one neutral note says why not —
 * an unmeasured scene is never drawn as a zero.
 *
 * Server component: pure text in, no state, no client JS.
 */
export function Storyboard({
  scenes: sceneRows,
  scriptText,
  retention = null,
  labels,
}: {
  /** The video's structured scene plan (migration 0011), when stored. */
  scenes: VideoScene[] | null;
  /** The video's narration — the fallback when no structured scenes exist. */
  scriptText: string | null;
  /** Scene-level retention (lib/sceneRetention), when the page computed it. */
  retention?: SceneRetentionSummary | null;
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
    retention?: {
      title: string;
      note: string;
      noCurve: string;
      noTiming: string;
      unknown: string;
      /** "{v} pts" */
      points: string;
      /** "{v} pts/min" */
      perMin: string;
      /** "Worst #{n}" */
      worst: string;
    };
  };
}) {
  const { scenes, totalSeconds } = buildStoryboard(sceneRows, scriptText);
  const counts = claimCounts(scenes);
  const rl = labels.retention;
  const showRetention = !!retention && !!rl && retention.status === "ok";

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
      {retention && rl && (
        <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
          {retention.status === "ok"
            ? rl.note
            : retention.status === "no_timing"
              ? rl.noTiming
              : rl.noCurve}
        </p>
      )}

      {/* The scenes, in narration order, as a vertical timeline. */}
      <ol className="flex flex-col gap-3">
        {scenes.map((s) => {
          const r = showRetention && s.sceneId ? (retention!.byId.get(s.sceneId) ?? null) : null;
          const worst = isWorstScene(r);
          const bar = r ? dropBarPercent(r, retention!.scenes) : null;
          return (
          <li
            key={s.index}
            className={`flex gap-3 rounded-[14px] border bg-[var(--color-panel-2)] p-3 ${
              worst ? "border-[var(--color-warn)]" : "border-[var(--color-border)]"
            }`}
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
              {showRetention && rl && (
                <div className="mt-2 flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                      {rl.title}
                    </span>
                    {r && r.dropPerMin !== null ? (
                      <>
                        <span className="mono text-[11px] text-[var(--color-fg)]">
                          {pctText(r.retentionStart)} → {pctText(r.retentionEnd)}
                        </span>
                        <span
                          className={`mono text-[11px] ${worst ? "text-[var(--color-warn)]" : "text-[var(--color-muted)]"}`}
                        >
                          {fmt(rl.points, { v: pointsText(r.drop) })} ·{" "}
                          {fmt(rl.perMin, { v: pointsText(r.dropPerMin) })}
                        </span>
                        {worst && (
                          <span className="pill border border-[var(--color-warn)] px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] text-[var(--color-warn)]">
                            {fmt(rl.worst, { n: r.rank ?? "" })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[11px] text-[var(--color-idle)]">{rl.unknown}</span>
                    )}
                  </div>
                  {bar !== null && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]" aria-hidden>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${bar}%`,
                          background: worst ? "var(--color-warn)" : "var(--color-muted)",
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
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
          );
        })}
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
