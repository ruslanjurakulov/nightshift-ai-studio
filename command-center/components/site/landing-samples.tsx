import type { Dictionary, Locale } from "@/lib/i18n";
import { siteCarouselCopy } from "@/lib/i18n/site-carousel";
import { FORMATS } from "@/lib/site/formats";
import { PROMPT_TOOLS, promptHref, type PromptTool } from "@/lib/site/prompt-link";
import { SHOWCASE_ENTRIES, modelLeftOut, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { beforeAfterPairs, carouselOrder, slideTitle, type SampleSlide } from "@/lib/site/carousel";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { showcaseItems } from "@/components/site/ShowcaseGallery";
import { landingExcludedJobs } from "@/components/site/slots";
import { ShowcaseCarousel } from "@/components/site/ShowcaseCarousel";
import { BeforeAfter } from "@/components/site/BeforeAfter";
import { PromptTicker } from "@/components/site/PromptTicker";

/**
 * The landing's three moving pieces, as Server Components that build their plain props from the data file and hand them to the
 * client pieces: the carousel (ShowcaseCarousel), picture → video (BeforeAfter) and prompt → result (PromptTicker). Each renders
 * nothing when the data file has nothing for it, so the page never shows an empty frame or a placeholder sample. Each root carries
 * `data-sample-section`: like the gallery, it is one of the places a sample (and so its model) is shown, inside its own box.
 *
 * "Use this prompt" is lib/site/prompt-link.ts promptHref, the same link as the prompt bar's: the Studio form with the tool and the
 * words, through sign-up when signed out. It names no model and starts nothing (CLAUDE.md #3); a tool the bar has no form for
 * (an animation needs its picture) gets no button.
 */
type Item = { e: ShowcaseEntry; f: ShowcaseFiles };

/** The format names in this language, by the job that shows each (lib/site/formats.ts). */
function formatTitles(t: Dictionary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FORMATS) {
    const copy = t.site.formats.items.find((i) => i.id === f.id);
    if (copy) out[f.job] = copy.title;
  }
  return out;
}

/** Builds the client pieces' plain props for one sample. */
function slideMaker(t: Dictionary, locale: Locale, signedIn: boolean, now: Date): (it: Item) => SampleSlide {
  const c = siteCarouselCopy(locale).carousel;
  const titles = formatTitles(t);
  return (it) => slide(it, c, titles, signedIn, now);
}

function slide(it: Item, c: ReturnType<typeof siteCarouselCopy>["carousel"], titles: Record<string, string>, signedIn: boolean, now: Date): SampleSlide {
  const { e, f } = it;
  const tool = (PROMPT_TOOLS as readonly string[]).includes(e.capability) ? (e.capability as PromptTool) : null;
  return {
    job: e.jobId,
    kind: e.kind,
    capability: e.capability,
    title: slideTitle(e, titles, c.titles, c.kinds),
    prompt: e.prompt,
    modelName: e.modelName,
    leftOut: modelLeftOut(e, now),
    href: tool && e.prompt.trim() ? promptHref(tool, e.prompt, signedIn) : null,
    width: e.width,
    height: e.height,
    poster: f.poster,
    posterSm: f.posterSm,
    clip: e.kind === "video" ? f.clip : null,
  };
}

/** The samples whose files are here, less the ones the page shows elsewhere or not at all (`exclude`). */
function items(entries: readonly ShowcaseEntry[], files: Readonly<Record<string, ShowcaseFiles>>, exclude: readonly string[]): Item[] {
  return showcaseItems(entries, files).filter(({ e }) => !exclude.includes(e.jobId));
}

/** The ticker's samples: wide (its box is 16:9) text-to-video clips with words. */
function tickerItems(list: readonly Item[]): Item[] {
  return list.filter(({ e, f }) => e.kind === "video" && e.capability === "t2v" && f.clip !== null && e.prompt.trim() !== "" && e.width > e.height);
}

/**
 * The jobs picture → video and the ticker show, given the same `exclude`: the carousel leaves them out, so within these pieces no
 * clip is shown twice.
 */
export function sampleSectionJobs(exclude: readonly string[], entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES, files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES): string[] {
  const list = items(entries, files, exclude);
  return [...beforeAfterPairs(list).flatMap(({ clip, picture }) => [clip.e.jobId, picture.e.jobId]), ...tickerItems(list).map(({ e }) => e.jobId)];
}

type Props = {
  t: Dictionary;
  locale: Locale;
  signedIn?: boolean;
  entries?: readonly ShowcaseEntry[];
  files?: Readonly<Record<string, ShowcaseFiles>>;
  now?: Date;
  /**
   * The samples this piece must not show: the same list the landing gives its gallery (components/site/slots.ts
   * landingExcludedJobs: the ones its places show, and the ones the owner keeps off the landing), so no clip is on the page
   * twice and the sea samples never come back. That list is the default.
   */
  exclude?: readonly string[];
};

/** The coverflow of the samples, under the facts: every one not left out, and not shown by picture → video or the ticker. */
export function SampleCarousel({ t, locale, signedIn = false, entries = SHOWCASE_ENTRIES, files = SHOWCASE_FILES, now = new Date(), exclude = landingExcludedJobs() }: Props) {
  const elsewhere = [...exclude, ...sampleSectionJobs(exclude, entries, files)];
  const slides = carouselOrder(items(entries, files, elsewhere).map(slideMaker(t, locale, signedIn, now)));
  if (slides.length === 0) return null;
  const c = siteCarouselCopy(locale).carousel;
  const g = t.site.gallery;
  return (
    <section id="watch" aria-labelledby="watch-title" className="nx-section nxc-section" data-sample-section>
      <div className="nx-wrap">
        <p className="nx-label">{c.label}</p>
        <h2 id="watch-title" className="nx-h2">
          {c.title}
        </h2>
        <p className="nx-sub">{c.lead}</p>
      </div>
      <ShowcaseCarousel
        slides={slides}
        copy={c}
        g={{ badge: g.badge, model: g.model, altClip: g.altClip, altImage: g.altImage, use: g.use, notInStudio: g.notInStudio, gone: g.gone, noPrompt: g.noPrompt }}
      />
    </section>
  );
}

/** Picture → video, for every clip made from another sample's picture (a pair with either side left out is not shown). */
export function SampleCompare({ t, locale, signedIn = false, entries = SHOWCASE_ENTRIES, files = SHOWCASE_FILES, now = new Date(), exclude = landingExcludedJobs() }: Props) {
  const pairs = beforeAfterPairs(items(entries, files, exclude));
  if (pairs.length === 0) return null;
  const c = siteCarouselCopy(locale).compare;
  const g = t.site.gallery;
  const make = slideMaker(t, locale, signedIn, now);
  return (
    <section id="picture-to-video" aria-labelledby="compare-title" className="nx-section" data-tone="raised" data-sample-section>
      <div className="nx-wrap">
        <p className="nx-label">{c.label}</p>
        <h2 id="compare-title" className="nx-h2">
          {c.title}
        </h2>
        <p className="nx-sub">{c.lead}</p>
        <ul className="nxb-list">
          {pairs.map(({ clip, picture }) => {
            const s = make(clip);
            return (
              <li key={clip.e.jobId}>
                <BeforeAfter
                  clip={s}
                  picture={make(picture)}
                  title={s.title}
                  copy={c}
                  g={{ badge: g.badge, model: g.model, altClip: g.altClip, altImage: g.altImage }}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * Prompt → result, right under the first screen: the wide text-to-video samples (the box is 16:9) not left out, so the clip under
 * the hero is never the hero's (its slot is in landingExcludedJobs).
 */
export function SampleTicker({ t, locale, signedIn = false, entries = SHOWCASE_ENTRIES, files = SHOWCASE_FILES, now = new Date(), exclude = landingExcludedJobs() }: Props) {
  const list = tickerItems(items(entries, files, exclude)).map(slideMaker(t, locale, signedIn, now));
  if (list.length === 0) return null;
  const c = siteCarouselCopy(locale).ticker;
  const g = t.site.gallery;
  return (
    <section aria-labelledby="ticker-title" className="nxt-section" data-sample-section>
      <div className="nx-wrap">
        <div className="nxt-head">
          <h2 id="ticker-title" className="nxt-title">
            {c.label}
          </h2>
          <p className="nxt-note">{c.note}</p>
        </div>
        <PromptTicker items={list} copy={c} g={{ badge: g.badge, model: g.model, altClip: g.altClip }} />
      </div>
    </section>
  );
}
