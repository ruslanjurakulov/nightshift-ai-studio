import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/number-format";
import { DEFAULT_LENGTH_S, fits, outputRange, youtubeVideoCredits, type OutputRange, type PlanFinderData } from "@/lib/plan-finder";
import { renderName, rowName, stampText } from "@/components/pricing/plan-finder-text";

/**
 * "What does this plan make?" under one plan card's credits: finished YouTube videos at the pipeline's default length,
 * then Studio images and clips as a range from the dearest setting to the cheapest, each end named. Every figure is
 * floor(credits ÷ the real quote) (lib/plan-finder.ts); the settings it was worked out for and the date of the rate are
 * printed under it. A rate that is missing reads "price unavailable", never a number. A Server Component: PlanMatrix
 * (client) receives it already rendered, so no pricing code reaches the browser for the cards.
 */
export function PlanOutputs({
  t,
  locale,
  credits,
  free = false,
  data,
}: {
  t: Dictionary;
  locale: Locale;
  credits: number;
  /** The free plan: its credits are the one-time welcome grant, said so under the figures. */
  free?: boolean;
  data: PlanFinderData;
}) {
  const c = t.planFinder.card;
  const n = (v: number) => formatNumber(v, locale, 0);
  const perVideo = youtubeVideoCredits(data.video, DEFAULT_LENGTH_S);
  const videos = fits(credits, perVideo);
  const youtube = videos === null ? c.unavailable : videos < 1 ? c.lessThanOne : fmt(c.approx, { n: n(videos) });
  const settings = fmt(c.youtubeSettings, { m: formatNumber(DEFAULT_LENGTH_S / 60, locale), res: renderName() });

  const studio = data.studio;
  const range = (r: OutputRange | null) =>
    r === null ? c.unavailable : r.low.count === r.high.count ? fmt(c.approx, { n: n(r.low.count) }) : fmt(c.range, { low: n(r.low.count), high: n(r.high.count) });
  const named = (r: OutputRange | null) =>
    r === null ? c.noneOnSale : r.low.row === r.high.row ? rowName(t, r.low.row) : fmt(c.fromTo, { low: rowName(t, r.low.row), high: rowName(t, r.high.row) });
  const images = studio.status === "ok" ? outputRange(credits, studio.rows, "image") : null;
  const clips = studio.status === "ok" ? outputRange(credits, studio.rows, "video") : null;
  const studioNote = studio.status === "signed_out" ? c.signedOut : studio.status === "ok" ? null : c.failed;

  return (
    <div className="pf-out" data-plan-outputs>
      <div className="pf-out-item" data-output="youtube">
        <div className="pf-out-row">
          <span className="pf-out-label">{c.youtube}</span>
          <span className="pf-out-fig" data-unavailable={videos === null || undefined}>
            {youtube}
          </span>
        </div>
        {/* The settings are printed only beside a figure they produced. */}
        {videos !== null && <p className="pf-out-sub">{settings}</p>}
        {videos !== null && data.videoStamp && <p className="pf-out-sub">{stampText(t, data.videoStamp, locale)}</p>}
      </div>
      {studio.status === "ok" ? (
        <>
          <div className="pf-out-item" data-output="images">
            <div className="pf-out-row">
              <span className="pf-out-label">{c.images}</span>
              <span className="pf-out-fig" data-unavailable={images === null || undefined}>
                {range(images)}
              </span>
            </div>
            <p className="pf-out-sub">{named(images)}</p>
          </div>
          <div className="pf-out-item" data-output="clips">
            <div className="pf-out-row">
              <span className="pf-out-label">{c.clips}</span>
              <span className="pf-out-fig" data-unavailable={clips === null || undefined}>
                {range(clips)}
              </span>
            </div>
            <p className="pf-out-sub">{named(clips)}</p>
          </div>
        </>
      ) : (
        // No Studio rate could be read here: one line says so, not one per kind of output.
        <div className="pf-out-item" data-output="studio">
          <div className="pf-out-row">
            <span className="pf-out-label">{c.studio}</span>
            <span className="pf-out-fig" data-unavailable>
              {c.unavailable}
            </span>
          </div>
        </div>
      )}
      {studio.status === "ok" && (images || clips) && <p className="pf-out-sub">{stampText(t, studio.stamp, locale)}</p>}
      {studioNote && <p className="pf-out-sub">{studioNote}</p>}
      {free && <p className="pf-out-sub">{c.welcome}</p>}
    </div>
  );
}
