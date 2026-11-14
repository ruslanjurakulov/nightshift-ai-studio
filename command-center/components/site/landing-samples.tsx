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
import { EFFECTS } from "@/lib/effects/catalog";
import { bestLevelCost, gridSpan } from "@/lib/site/gallery-plan";

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

/**
 * The samples whose files are here, less the ones the page shows elsewhere or not at all (`exclude`), and less the effects'
 * previews: the Effects section shows each of those as its effect's result, so none of these pieces shows it again.
 */
function items(entries: readonly ShowcaseEntry[], files: Readonly<Record<string, ShowcaseFiles>>, exclude: readonly string[]): Item[] {
  const previews = effectPreviewJobs();
  return showcaseItems(entries, files).filter(({ e }) => !exclude.includes(e.jobId) && !previews.includes(e.jobId));
}

/** The ticker's samples: wide (its box is 16:9) text-to-video clips with words. */
function tickerItems(list: readonly Item[]): Item[] {
  return list.filter(({ e, f }) => e.kind === "video" && e.capability === "t2v" && f.clip !== null && e.prompt.trim() !== "" && e.width > e.height);
}


/** The samples the Effects section shows as its effects' previews (lib/effects/catalog.ts): no other landing surface shows them. */
export function effectPreviewJobs(): string[] {
  return EFFECTS.flatMap((x) => (x.previewJobId ? [x.previewJobId] : []));
}

/**
 * How many samples the landing's explore grid shows besides the ones the model tiles link to: two rows on a wide screen (four
 * columns), four on a phone (two). The grid was every sample, 8,000 px at 1440 and 23,000 px (27 screens) on a phone, with the
 * same clips as the carousel above it.
 */
export const LANDING_GALLERY_MAX = 8;

/**
 * The sample each model tile on the landing links to (`#sample-<job>`, components/landing/Landing.tsx ModelTiles): per model, the
 * first of the landing's samples (not in `exclude`) in the data file's order. Its box must be on the page, once.
 */
export function landingTileJobs(exclude: readonly string[], entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES, files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES): string[] {
  const models = new Set<string>();
  const out: string[] = [];
  for (const { e } of showcaseItems(entries, files)) {
    if (exclude.includes(e.jobId) || models.has(e.modelId)) continue;
    models.add(e.modelId);
    out.push(e.jobId);
  }
  return out;
}

/**
 * How the landing shares its samples out, so each is shown once (tests/site-landing-dedupe.test.tsx). In this order:
 * - picture → video takes every pair (its clip's box carries the `#sample-` anchor a model tile may point at);
 * - the explore grid takes the samples the model tiles link to (their anchors are its cards), except a pair's clip;
 * - the ticker takes the wide text-to-video clips with words that are left;
 * - the grid fills up to LANDING_GALLERY_MAX with what is left, picking what leaves its columns most level (gallery-plan.ts);
 * - the carousel takes the rest.
 * None takes an effect's preview (the Effects section shows it), except the grid when a model tile links to it: the Effects
 * section's frames carry no anchor, so that one sample is in both until they do.
 */
function landingSplit(exclude: readonly string[], entries: readonly ShowcaseEntry[], files: Readonly<Record<string, ShowcaseFiles>>) {
  const pairs = beforeAfterPairs(items(entries, files, exclude));
  const pairJobs = pairs.flatMap(({ clip, picture }) => [clip.e.jobId, picture.e.jobId]);
  const pairClips = new Set(pairs.map(({ clip }) => clip.e.jobId));
  const tiles = landingTileJobs(exclude, entries, files).filter((j) => !pairClips.has(j));
  const ticker = tickerItems(items(entries, files, [...exclude, ...pairJobs, ...tiles])).map(({ e }) => e.jobId);
  const sections = [...pairJobs, ...ticker];
  // The grid's other places go, one at a time, to the free sample that leaves the columns most level (lib/site/gallery-plan.ts);
  // the first in the data file's order of equally good ones.
  const pool = items(entries, files, [...exclude, ...sections, ...tiles]);
  const spanOf = new Map(showcaseItems(entries, files).map(({ e }) => [e.jobId, gridSpan(e.width, e.height)]));
  const fill: string[] = [];
  while (fill.length < LANDING_GALLERY_MAX - tiles.length) {
    const taken = [...tiles, ...fill].map((j) => spanOf.get(j) ?? 0);
    let pick: string | null = null;
    let best = Infinity;
    for (const { e } of pool) {
      if (fill.includes(e.jobId)) continue;
      const c = bestLevelCost([...taken, spanOf.get(e.jobId) ?? 0]);
      if (c < best - 1e-9) [pick, best] = [e.jobId, c];
    }
    if (!pick) break;
    fill.push(pick);
  }
  const grid = new Set([...tiles, ...fill]);
  const gallery = showcaseItems(entries, files)
    .map(({ e }) => e.jobId)
    .filter((j) => grid.has(j));
  return { pairs, ticker, sections, gallery };
}

/**
 * The jobs picture → video and the ticker show, given the same `exclude`: the carousel and the grid leave them out, so within these
 * pieces no clip is shown twice.
 */
export function sampleSectionJobs(exclude: readonly string[], entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES, files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES): string[] {
  return landingSplit(exclude, entries, files).sections;
}

/** The landing's explore grid's share of the samples (landingSplit), in the data file's order. */
export function landingGalleryJobs(exclude: readonly string[], entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES, files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES): string[] {
  return landingSplit(exclude, entries, files).gallery;
}

/** What the landing's grid leaves out: every sample that is not its share (ShowcaseGallery takes an exclusion list). */
export function landingGalleryExclude(exclude: readonly string[], entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES, files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES): string[] {
  const share = new Set(landingGalleryJobs(exclude, entries, files));
  return showcaseItems(entries, files)
    .map(({ e }) => e.jobId)
    .filter((j) => !share.has(j));
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

/**
 * The coverflow of the samples, under the facts: every one not left out, and not shown by picture → video, the ticker, the
 * Effects section or the explore grid (landingGalleryJobs).
 */
export function SampleCarousel({ t, locale, signedIn = false, entries = SHOWCASE_ENTRIES, files = SHOWCASE_FILES, now = new Date(), exclude = landingExcludedJobs() }: Props) {
  const split = landingSplit(exclude, entries, files);
  const elsewhere = [...exclude, ...split.sections, ...split.gallery];
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
  // The ticker's share (landingSplit): not a sample the explore grid holds for a model tile's link.
  const share = new Set(landingSplit(exclude, entries, files).ticker);
  const list = tickerItems(items(entries, files, exclude))
    .filter(({ e }) => share.has(e.jobId))
    .map(slideMaker(t, locale, signedIn, now));
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
