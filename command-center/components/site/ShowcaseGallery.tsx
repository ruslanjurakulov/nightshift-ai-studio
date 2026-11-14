import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { SHOWCASE_ENTRIES, modelLeftOut, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { ClipPause } from "@/components/site/ClipPause";
import { posterSrcSet } from "@/lib/site/renditions";
import { ShortsFeed } from "@/components/site/ShortsFeed";
import { shortsItems } from "@/components/site/shorts";
import { SampleDetail, type SampleDetailCopy } from "@/components/site/SampleDetail";

/** The day a sample was made, in the page's language (UTC, so the server and every visitor read the same day). */
function madeOn(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * How many of the grid's rows a card spans (site-next.css .nx-gallery): a row is a hundredth of a column's width, so a card of
 * width w and height h spans 100·h/w rows, plus four for the gutter under it. The grid then places the cards in their order,
 * each in the column that frees first (a masonry whose reading and Tab order is the page's order, row by row), and two cards
 * whose files differ by a few pixels (1280×718 and 1280×720) span the same rows, so a row's tops and bottoms line up.
 */
export const GRID_GUTTER_ROWS = 4;
export function gridSpan(width: number, height: number): number {
  return Math.round((100 * height) / width) + GRID_GUTTER_ROWS;
}

/** The entries the page can show: those whose files are here (an entry without its files is never shown as a gap). */
export function showcaseItems(
  entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES,
  files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES,
): { e: ShowcaseEntry; f: ShowcaseFiles }[] {
  return entries.flatMap((e) => (files[e.jobId] ? [{ e, f: files[e.jobId] }] : []));
}

/** A format card's words (lib/site/formats.ts and site.formats.items), on the card of the sample that shows it. */
export type LandingFormat = { id: string; job: string; title: string; body: string; entry: ShowcaseEntry };

/**
 * The model samples (lib/site/showcase.ts): real generations from the operator's Studio, laid out media first, as the AI studios'
 * explore grids are (Higgsfield, Krea, Midjourney: the picture fills the card, tight gutters, no text under it). A card at rest is
 * its picture or clip and the "AI-generated" badge on it, nothing else. With a fine pointer on it, or keyboard focus in it, the
 * first two lines of its words and a compact "Use this prompt" show over the bottom of the picture. Pressing the card opens the
 * sample (components/site/SampleDetail.tsx): the whole picture or clip, the whole prompt, the model, the day, the picture it was
 * made from, and "Try this prompt" / "Use this prompt" with its note. The owner has not decided whether model names show on the
 * public cards (2026-11-14), so a card names none (not even in its picture's description); only its dialog does.
 *
 * Nothing claims the model is on sale: a model only the operator can try yet (registry `operator_preview`) is left out of the link
 * and its dialog says it is not in the Studio yet; a model whose announced shutdown day has come is left out the same way, and its
 * dialog says it is no longer in the Studio. Every link fills the Studio form with the tool and the words (lib/site/showcase-link.ts).
 *
 * With no entry, or none whose files are here, it renders nothing: never a placeholder that looks like ours. A model is named
 * only inside its own box (data-showcase-entry: the card, and its dialog); tests/site-showcase.test.tsx pins it.
 *
 * Each card keeps its clip's own shape (the box's aspect ratio is the file's, so nothing shifts as it loads), in a masonry of two
 * columns on a phone, three from 760 px and four from 1240 px. On a wide screen every clip in view plays (LoopClip `together`); on
 * a phone only the one most in view. A card whose sample shows a format (lib/site/formats.ts) names the format over its picture on
 * hover and in its dialog. `exclude` leaves out the samples the page already shows in a slot, so no clip is on a page twice.
 */
export function ShowcaseGallery({
  t,
  locale,
  signedIn = false,
  entries = SHOWCASE_ENTRIES,
  files = SHOWCASE_FILES,
  now = new Date(),
  exclude = [],
  formats = [],
}: {
  t: Dictionary;
  locale: Locale;
  signedIn?: boolean;
  entries?: readonly ShowcaseEntry[];
  files?: Readonly<Record<string, ShowcaseFiles>>;
  /** Today, for a shutdown day that has come (tests pass a fixed day). */
  now?: Date;
  /** Jobs the page shows elsewhere (its slots). */
  exclude?: readonly string[];
  formats?: readonly LandingFormat[];
}) {
  const all = showcaseItems(entries, files);
  const items = all.filter(({ e }) => !exclude.includes(e.jobId));
  if (items.length === 0) return null;
  const g = t.site.gallery;
  // An animation of one of our own pictures reads as a trick without the picture it started from. Shown only when that picture is
  // itself a sample here (its file is in the repository and its own card names its model); any other input is not shown.
  // Looked up among every sample, so a picture the page shows in a slot (and leaves out of the grid) still credits the clip made from it.
  const byJob = new Map(all.map((it) => [it.e.jobId, it]));
  const sourceOf = (e: ShowcaseEntry) => (e.kind === "video" && e.input.kind === "operator_job" ? byJob.get(e.input.jobId) ?? null : null);
  // The dialog's words (a Client Component takes these, never the whole dictionary).
  const copy: SampleDetailCopy = {
    open: g.open,
    close: g.close,
    detail: g.detail,
    badge: g.badge,
    model: g.model,
    prompt: g.prompt,
    notInStudio: g.notInStudio,
    gone: g.gone,
    try: g.try,
    tryAria: g.tryAria,
    use: g.use,
    useNote: g.useNote,
    source: g.source,
    pause: t.site.fx.pause,
  };
  return (
    <section id="samples" aria-labelledby="samples-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{g.label}</p>
        <h2 id="samples-title" className="nx-h2">
          {g.title}
        </h2>
        <p className="nx-sub">{g.lead}</p>
        {/* Phones only (CSS): the vertical clips as a full-screen feed (components/site/ShortsFeed.tsx). */}
        <ShortsFeed items={shortsItems(items, signedIn, now)} copy={t.site.autopilot.shorts} g={{ badge: g.badge, try: g.try, tryAria: g.tryAria, use: g.use, useNote: g.useNote, noPrompt: g.noPrompt }} />
        <div className="nx-gallery-box">
          {/* One pause key for the whole grid, for a keyboard (hidden until focused; a pointer pauses by tapping a clip elsewhere or in
              a sample's dialog): one Tab stop, not one per card. */}
          {items.some(({ e, f }) => e.kind === "video" && f.clip !== null) && <ClipPause label={t.site.fx.pause} />}
          <ul className="nx-gallery">
            {items.map(({ e, f }) => {
              const href = tryHref(e, signedIn, now);
              const leftOut = modelLeftOut(e, now);
              const promptId = `sample-prompt-${e.jobId}`;
              const clip = e.kind === "video" && f.clip !== null;
              const format = formats.find((x) => x.job === e.jobId);
              const shape = e.height > e.width * 1.15 ? "tall" : e.width > e.height * 1.15 ? "wide" : "square";
              const source = sourceOf(e);
              const words = e.prompt.trim() ? e.prompt : g.noPrompt;
              return (
                <li key={e.jobId} id={`sample-${e.jobId}`} className="nx-gallery-card" data-showcase-entry={e.jobId} data-model={e.modelId} data-shape={shape} style={{ "--span": gridSpan(e.width, e.height) } as CSSProperties}>
                  <div className="nx-gallery-pic" data-clip={clip ? "sample" : undefined} style={{ aspectRatio: `${e.width} / ${e.height}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={f.poster}
                      srcSet={posterSrcSet(f)}
                      sizes="(min-width: 1240px) 300px, (min-width: 760px) 33vw, 50vw"
                      width={e.width}
                      height={e.height}
                      alt={clip ? g.bgClip : g.bgImage}
                      className="nx-art nx-drift-pic"
                      loading="lazy"
                      decoding="async"
                    />
                    {clip && <ShowcaseClip jobId={e.jobId} together />}
                    <span className="nx-result-badge">{g.badge}</span>
                  </div>
                  {/* The whole card opens the sample (a button stretched over it); the words and the link below sit above it. */}
                  <SampleDetail
                    copy={copy}
                    d={{
                      jobId: e.jobId,
                      modelName: e.modelName,
                      prompt: words,
                      cardPromptId: promptId,
                      made: fmt(g.made, { date: madeOn(e.createdAt, locale) }),
                      createdAt: e.createdAt,
                      width: e.width,
                      height: e.height,
                      poster: f.poster,
                      srcSet: posterSrcSet(f),
                      clip: clip ? f.clip : null,
                      alt: fmt(clip ? g.altClip : g.altImage, { model: e.modelName }),
                      leftOut,
                      href,
                      format: format ? { id: format.id, title: format.title, body: format.body } : null,
                      source: source
                        ? { jobId: source.e.jobId, src: source.f.posterSm, width: source.e.width, height: source.e.height, alt: fmt(g.altSource, { model: source.e.modelName }), modelName: source.e.modelName }
                        : null,
                    }}
                  />
                  {/* On hover (a fine pointer) or keyboard focus: the first two lines of the words and a compact link, over the picture.
                      At rest it is hidden (the card is the picture); its words stay in the page and describe the card's button. */}
                  <div className="nx-gallery-over">
                    {format && (
                      <p className="nx-gallery-over-format" data-format={format.id}>
                        {format.title}
                      </p>
                    )}
                    <p id={promptId} className="nx-gallery-prompt">
                      {words}
                    </p>
                    {href && (
                      // "Use this prompt" on every card: the card does not name the model, so its link never says "try" it. The dialog
                      // says "Try this prompt" where the link opens that model, and why not where it does not.
                      <Link href={href} prefetch={false} className="nx-gallery-try" aria-describedby={promptId}>
                        {g.use}
                        <ArrowRight aria-hidden />
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        {/* Said once for every card, not under each one: what the links do and that nothing starts until the Studio's own button. */}
        <p className="nx-show-note">{signedIn ? g.tryNote : g.tryNoteSignedOut}</p>
      </div>
    </section>
  );
}
