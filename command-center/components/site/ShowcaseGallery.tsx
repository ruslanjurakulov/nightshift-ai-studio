import Link from "next/link";
import type { CSSProperties } from "react";
import type { Dictionary, Locale } from "@/lib/i18n";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import { cardWords } from "@/lib/site/card-words";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { ClipPause } from "@/components/site/ClipPause";
import { posterSrcSet } from "@/lib/site/renditions";
import { GRID_GUTTER_ROWS, PLANNED_COLUMNS, gridSpan, level, levelOrder } from "@/lib/site/gallery-plan";
import { ShortsFeed } from "@/components/site/ShortsFeed";
import { shortsItems } from "@/components/site/shorts";
import { TapReveal } from "@/components/site/TapReveal";
import "@/components/site/media-card.css";

export { GRID_GUTTER_ROWS, gridSpan };

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
 * explore grids are (Kling, Higgsfield, Krea: the picture fills the card, tight gutters, no text under it).
 *
 * Owner decision 22 Nov: no model name on public cards; it travels only in the Studio link. At rest a card is its picture or
 * clip and one small AI mark (components/site/media-card.css). On hover (a fine pointer), keyboard focus or a first tap on a phone
 * (components/site/TapReveal.tsx), a caption shows over a dark foot: the format's title when the sample shows one, and the card's
 * one short line (the export's `cardLine` in this language, else the prompt's first sentence, lib/site/card-words.ts). The whole
 * card is one link to the Studio form with the sample's tool, model and whole prompt (lib/site/showcase-link.ts tryHref; signed
 * out, sign-up first), so the model becomes known only in the Studio, which says which model and price it will use before
 * anything runs. A model customers cannot choose (an operator preview, or past its shutdown day) is left out of that link.
 *
 * With no entry, or none whose files are here, it renders nothing: never a placeholder that looks like ours. No text, alt,
 * aria or data attribute on the card names the model (tests/site-showcase.test.tsx pins it; only the link's `model=` carries it).
 *
 * Each card keeps its clip's own shape (the box's aspect ratio is the file's, so nothing shifts as it loads), in a masonry of two
 * columns on a phone, three from 760 px and four from 1240 px. On a wide screen every clip in view plays (LoopClip `together`); on
 * a phone only the one most in view. `exclude` leaves out the samples the page already shows in a slot, so no clip is on a page twice.
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
  const shown = all.filter(({ e }) => !exclude.includes(e.jobId));
  if (shown.length === 0) return null;
  // The grid ends level at three and four columns (lib/site/gallery-plan.ts): the order that crops least, and each card's column,
  // first row and span for each, set inline (site-next.css reads them). A phone's two columns flow by themselves (--span).
  const spans0 = shown.map(({ e }) => gridSpan(e.width, e.height));
  const order = levelOrder(spans0);
  const items = order.map((i) => shown[i]);
  const spans = order.map((i) => spans0[i]);
  const plans = PLANNED_COLUMNS.map((cols) => ({ cols, cells: level(spans, cols).cells }));
  const place = (i: number): CSSProperties => {
    const style: Record<string, number> = { "--span": spans[i] };
    for (const { cols, cells } of plans) {
      style[`--c${cols}`] = cells[i].col;
      style[`--r${cols}`] = cells[i].row;
      style[`--s${cols}`] = cells[i].span;
    }
    return style as CSSProperties;
  };
  const g = t.site.gallery;
  return (
    <section id="samples" aria-labelledby="samples-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{g.label}</p>
        <h2 id="samples-title" className="nx-h2">
          {g.title}
        </h2>
        <p className="nx-sub">{g.lead}</p>
        {/* Phones only (CSS): the vertical clips as a full-screen feed (components/site/ShortsFeed.tsx). */}
        <ShortsFeed items={shortsItems(items, signedIn, now, locale)} copy={t.site.autopilot.shorts} g={{ badge: g.badge, use: g.use, useNote: g.useNote, noPrompt: g.noPrompt }} />
        <div className="nx-gallery-box">
          {/* One pause key for the whole grid, for a keyboard (hidden until focused; the page's pause switch stops them too): one Tab
              stop, not one per card. */}
          {items.some(({ e, f }) => e.kind === "video" && f.clip !== null) && <ClipPause label={t.site.fx.pause} />}
          <ul className="nx-gallery">
            {items.map(({ e, f }, i) => {
              const href = tryHref(e, signedIn, now);
              const clip = e.kind === "video" && f.clip !== null;
              const format = formats.find((x) => x.job === e.jobId);
              const shape = e.height > e.width * 1.15 ? "tall" : e.width > e.height * 1.15 ? "wide" : "square";
              const words = cardWords(e, locale);
              // A sample with no words of its own (made from a picture alone) says so, in the page's language.
              const line = words.text ? words : { text: g.noPrompt, lang: locale, source: "cardLine" as const };
              const aiId = `sample-ai-${e.jobId}`;
              const caption = (hidden: boolean) => (
                // aria-hidden on a link card: the link's own name says the same words once.
                <span className="mf-cap" data-title={format ? undefined : "none"} aria-hidden={hidden || undefined}>
                  {format && (
                    <span className="mf-title" data-format={format.id}>
                      {format.title}
                    </span>
                  )}
                  <span className="mf-desc" lang={line.lang} data-src={line.source === "prompt" ? "prompt" : undefined}>
                    {line.text}
                  </span>
                </span>
              );
              return (
                <li
                  key={e.jobId}
                  id={`sample-${e.jobId}`}
                  className="nx-gallery-card mf-card"
                  data-mf-card=""
                  data-showcase-entry={e.jobId}
                  data-shape={shape}
                  style={place(i)}
                >
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
                  </div>
                  {/* "AI" on screen in every language (owner decision 22 Nov); its meaning, "AI-generated", is read from aiId. */}
                  <span className="mf-ai" aria-hidden>
                    {g.mark}
                  </span>
                  <span id={aiId} className="sr-only">
                    {g.badge}
                  </span>
                  {href ? (
                    <>
                      {caption(true)}
                      {/* The stretched link over the whole card (media-card.css): its name is the caption's words and what it does,
                          described by the AI label and the note under the grid (sign-up, then the Studio form). */}
                      <Link href={href} prefetch={false} className="mf-card-link" aria-describedby={`${aiId} samples-note`}>
                        <span className="sr-only">
                          {format && <>{format.title}. </>}
                          <span lang={line.lang} data-src={line.source === "prompt" ? "prompt" : undefined}>
                            {line.text}
                          </span>{" "}
                          {g.use}
                        </span>
                      </Link>
                    </>
                  ) : (
                    // No Studio form for its tool: the same card and caption, and no link (a dead link would promise a form).
                    caption(false)
                  )}
                </li>
              );
            })}
          </ul>
          <TapReveal />
        </div>
        {/* Said once for every card, not under each one: what the links do and that nothing starts until the Studio's own button. */}
        <p id="samples-note" className="nx-show-note">
          {signedIn ? g.tryNote : g.tryNoteSignedOut}
        </p>
      </div>
    </section>
  );
}
