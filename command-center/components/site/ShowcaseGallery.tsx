import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { SHOWCASE_ENTRIES, modelLeftOut, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { ClipPause } from "@/components/site/ClipPause";
import { ShortsFeed } from "@/components/site/ShortsFeed";
import { shortsItems } from "@/components/site/shorts";

/** The day a sample was made, in the page's language (UTC, so the server and every visitor read the same day). */
function madeOn(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
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
 * The model samples (lib/site/showcase.ts): real generations from the operator's Studio, each in its own card with an
 * "AI-generated" badge, the model that made it and its maker's credit (a link, as the maker's terms ask), the words it was
 * given, the day, and "Try this prompt", which opens the Studio form with that tool and words (lib/site/showcase-link.ts). Nothing
 * claims the model is on sale: a model only the operator can try yet (registry `operator_preview`) is left out of the link and its
 * card says it is not in the Studio yet; a model whose announced shutdown day has come is left out the same way, and its card says
 * it is no longer in the Studio. Those buttons are named by their sample's prompt, not by the model.
 *
 * With no entry, or none whose files are here, it renders nothing: never a placeholder that looks like ours. A model is named
 * only inside its own card (data-showcase-entry), because that card is a generation by it; tests/site-showcase.test.tsx pins it.
 *
 * Laid out as an explore grid: each card keeps its clip's own shape (a 9:16 clip stands tall, a 16:9 one lies wide; the box's
 * aspect ratio is the file's, so nothing shifts as it loads), in one column on a phone and a two- or three-column masonry above
 * it. On a wide screen every clip in view plays (LoopClip `together`); on a phone only the one most in view. A card whose sample
 * shows a format (lib/site/formats.ts) carries the format's name and line above its model. `exclude` leaves out the samples the
 * page already shows in a slot, so no clip is on a page twice.
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
        <ul className="nx-gallery">
          {items.map(({ e, f }) => {
            const href = tryHref(e, signedIn, now);
            const leftOut = modelLeftOut(e, now);
            const promptId = `sample-prompt-${e.jobId}`;
            const clip = e.kind === "video" && f.clip !== null;
            const format = formats.find((x) => x.job === e.jobId);
            const shape = e.height > e.width * 1.15 ? "tall" : e.width > e.height * 1.15 ? "wide" : "square";
            const source = sourceOf(e);
            return (
              <li key={e.jobId} id={`sample-${e.jobId}`} className="nx-gallery-card" data-showcase-entry={e.jobId} data-model={e.modelId} data-shape={shape}>
                <div className="nx-gallery-pic" data-clip={clip ? "sample" : undefined} style={{ aspectRatio: `${e.width} / ${e.height}` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.poster}
                    srcSet={`${f.posterSm} 640w, ${f.poster} 1280w`}
                    sizes="(min-width: 1024px) 400px, (min-width: 600px) 50vw, 100vw"
                    width={e.width}
                    height={e.height}
                    alt={fmt(clip ? g.altClip : g.altImage, { model: e.modelName })}
                    className="nx-art nx-drift-pic"
                    loading="lazy"
                    decoding="async"
                  />
                  {clip && <ShowcaseClip jobId={e.jobId} together />}
                  <span className="nx-result-badge">{g.badge}</span>
                  {clip && <ClipPause label={t.site.fx.pause} />}
                </div>
                <div className="nx-gallery-body">
                  {format && (
                    <div className="nx-gallery-format" data-format={format.id}>
                      <h3 className="nx-gallery-format-t">{format.title}</h3>
                      <p className="nx-gallery-format-b">{format.body}</p>
                    </div>
                  )}
                  <p className="nx-gallery-model">
                    <span className="nx-gallery-key">{g.model}</span> <strong>{e.modelName}</strong>
                  </p>
                  {e.attribution && (
                    <a href={e.attribution.url} target="_blank" rel="noopener noreferrer" className="nx-gallery-attr">
                      {e.attribution.text}
                    </a>
                  )}
                  {leftOut && <p className="nx-gallery-unavailable">{leftOut === "shut_down" ? g.gone : g.notInStudio}</p>}
                  {source && (
                    <figure className="nx-gallery-source" data-source-entry={source.e.jobId}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={source.f.posterSm}
                        width={source.e.width}
                        height={source.e.height}
                        alt={fmt(g.altSource, { model: source.e.modelName })}
                        loading="lazy"
                        decoding="async"
                      />
                      <figcaption>
                        <span className="nx-gallery-key">{g.source}</span> <strong>{source.e.modelName}</strong>
                        {/* The picture is the other maker's output, shown here too, so its credit travels with it. */}
                        {source.e.attribution && (
                          <>
                            {" "}
                            <a href={source.e.attribution.url} target="_blank" rel="noopener noreferrer" className="nx-gallery-attr">
                              {source.e.attribution.text}
                            </a>
                          </>
                        )}
                      </figcaption>
                    </figure>
                  )}
                  <p className="nx-gallery-key">{g.prompt}</p>
                  <p id={promptId} className="nx-gallery-prompt">{e.prompt.trim() ? e.prompt : g.noPrompt}</p>
                  <p className="nx-gallery-date">
                    <time dateTime={e.createdAt}>{fmt(g.made, { date: madeOn(e.createdAt, locale) })}</time>
                  </p>
                  {href && (
                    // Named by the model only where the link opens that model. Where it does not (the model is not in the Studio),
                    // the button says "Use this prompt", not "try" a model the link will not open, and a note says which model runs it.
                    <Link
                      href={href}
                      prefetch={false}
                      className="nx-btn nx-gallery-try"
                      aria-label={leftOut ? undefined : fmt(g.tryAria, { model: e.modelName })}
                      aria-describedby={leftOut ? `${promptId} sample-use-${e.jobId}` : promptId}
                    >
                      {leftOut ? g.use : g.try}
                      <ArrowRight aria-hidden />
                    </Link>
                  )}
                  {href && leftOut && (
                    <p id={`sample-use-${e.jobId}`} className="nx-gallery-use">
                      {g.useNote}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="nx-show-note">{signedIn ? g.tryNote : g.tryNoteSignedOut}</p>
      </div>
    </section>
  );
}
