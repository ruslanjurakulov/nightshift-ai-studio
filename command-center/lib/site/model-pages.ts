/**
 * The public model pages (/models and /models/<slug>, app/models): one page per model that made at least one of the site's real
 * samples (lib/site/showcase.ts), with what the Studio can ask it for, read from lib/site/model-facts.json (the public half of
 * schemas/model_registry.json, written by scripts/export-model-facts.mjs and held equal to the registry by
 * tests/model-pages.test.tsx).
 *
 * Why a model may be named on these pages when the rest of the public site names none (tests/helpers/brands.ts): the page exists
 * only because a real generation by that model is on it, so the name is a fact about those samples, not a promise. The page never
 * says the model is on sale, never prints a price (no public price exists per model: api_prices is per pipeline unit, and the
 * credit rates per model are signed-in only, 0084) and never prints a generation time (model_probe_runs is not public). What it
 * says about availability comes from the same two registry flags the sample cards use (modelLeftOut), because the database's
 * own answer (sellable_models, 0139) is not readable without a session.
 *
 * Kept free of file imports (those are in components/site/model-catalog.ts), so tests and the sitemap can read it.
 */
import data from "@/lib/site/model-facts.json";
import { MODELS_PATH } from "@/lib/public-paths";
import { modelLeftOut, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";

export interface ModelFacts {
  /** The registry id (also what the samples name as modelId). */
  id: string;
  /** The registry's display name. */
  name: string;
  output: "video" | "image";
  /** The Studio tools the adapter offers for it (t2v, i2v, t2i, edit …). */
  capabilities: string[];
  aspectRatios: string[];
  /** Where one tool takes fewer shapes than the model does (Gen-4.5's text-to-video takes two). */
  aspectRatiosByCapability: Record<string, string[]>;
  resolutions: string[];
  durationsS: number[];
  /** How many pictures it takes as input (0 = words only). */
  imageRefsMax: number;
  endFrame: boolean;
  audioOut: boolean;
  operatorPreview: boolean;
  shutdownOn: string | null;
}

const RATIO = /^\d{1,2}:\d{1,2}$/;
const RES = /^[0-9]{3,4}p$|^[0-9]k$/;
const CAP = /^[a-z][a-z0-9_]{0,31}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown, re: RegExp): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && re.test(x));

/** One model's facts, or null when anything is missing or malformed (it then has no page at all, rather than a page that guesses). */
export function parseModelFacts(v: unknown): ModelFacts | null {
  if (!isObj(v)) return null;
  const { id, name, output, capabilities, aspectRatios, aspectRatiosByCapability, resolutions, durationsS, imageRefsMax } = v;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9.-]{1,39}$/.test(id)) return null;
  if (typeof name !== "string" || !name.trim() || name.length > 80) return null;
  if (output !== "video" && output !== "image") return null;
  if (!strs(capabilities, CAP) || capabilities.length === 0 || !strs(aspectRatios, RATIO) || !strs(resolutions, RES)) return null;
  if (!Array.isArray(durationsS) || !durationsS.every((d) => typeof d === "number" && Number.isInteger(d) && d > 0 && d <= 600)) return null;
  if (typeof imageRefsMax !== "number" || !Number.isInteger(imageRefsMax) || imageRefsMax < 0) return null;
  if (!isObj(aspectRatiosByCapability) || !Object.entries(aspectRatiosByCapability).every(([k, r]) => CAP.test(k) && strs(r, RATIO))) return null;
  if (typeof v.endFrame !== "boolean" || typeof v.audioOut !== "boolean" || typeof v.operatorPreview !== "boolean") return null;
  const shutdownOn = v.shutdownOn;
  if (!(shutdownOn === null || (typeof shutdownOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(shutdownOn)))) return null;
  return {
    id, name, output, capabilities, aspectRatios, aspectRatiosByCapability: aspectRatiosByCapability as Record<string, string[]>,
    resolutions, durationsS: durationsS as number[], imageRefsMax, endFrame: v.endFrame, audioOut: v.audioOut, operatorPreview: v.operatorPreview,
    shutdownOn,
  };
}

export function parseModelFactsFile(raw: unknown): ModelFacts[] {
  const list = isObj(raw) && Array.isArray(raw.models) ? raw.models : [];
  const seen = new Set<string>();
  return list.flatMap((m) => {
    const f = parseModelFacts(m);
    if (!f || seen.has(f.id)) return [];
    seen.add(f.id);
    return [f];
  });
}

export const MODEL_FACTS: readonly ModelFacts[] = parseModelFactsFile(data);

/** A page's address segment: the registry id with its dots as dashes (runway-gen4.5 → runway-gen4-5), so the URL has no dot an `.rsc` or file rule could read. */
export function modelSlug(id: string): string | null {
  const slug = id.replace(/\./g, "-");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 40 ? slug : null;
}

export function modelPagePath(slug: string): string {
  return `${MODELS_PATH}/${slug}`;
}

export type ModelSample = { e: ShowcaseEntry; f: ShowcaseFiles };

export interface ModelPage {
  slug: string;
  path: string;
  facts: ModelFacts;
  /** Every sample of this model whose files are here, newest first (lib/site/showcase.ts order). */
  samples: ModelSample[];
  /** The one the page leads with (heroSample). */
  hero: ModelSample;
}

/**
 * The sample a page leads with: one that plays over one that is still, then one the owner placed on the site (a slot), then the
 * newest. There is no quality score to rank by, so the rule is what we can see, and it is stable from build to build.
 */
export function heroSample(samples: readonly ModelSample[]): ModelSample | null {
  const score = ({ e, f }: ModelSample) => (e.kind === "video" && f.clip ? 2 : 0) + (e.slot ? 1 : 0);
  let best: ModelSample | null = null;
  for (const s of samples) if (!best || score(s) > score(best)) best = s;
  return best;
}

/**
 * The pages: a model gets one only with at least one sample whose files are here AND its facts. A model whose slug would collide
 * with another's (two ids that differ only by a dot) gets none, rather than one page answering for two models.
 * Ordered by how many samples it has, then by name.
 */
export function buildModelPages(
  items: readonly ModelSample[],
  facts: readonly ModelFacts[] = MODEL_FACTS,
): ModelPage[] {
  const bySlug = new Map<string, ModelFacts[]>();
  for (const f of facts) {
    const slug = modelSlug(f.id);
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), f]);
  }
  const pages: ModelPage[] = [];
  for (const [slug, fs] of bySlug) {
    if (fs.length !== 1) continue;
    const samples = items.filter(({ e }) => e.modelId === fs[0].id);
    const hero = heroSample(samples);
    if (!hero) continue;
    pages.push({ slug, path: modelPagePath(slug), facts: fs[0], samples, hero });
  }
  return pages.sort((a, b) => b.samples.length - a.samples.length || a.facts.name.localeCompare(b.facts.name, "en"));
}

/** What the page says about the Studio: not in it yet (operator preview: only our team runs it), gone (its shutdown day has come), or not known here. */
export type ModelAvailability = "preview" | "shut_down" | "unknown";

/**
 * "unknown" is deliberate: without the preview flag the registry does not say whether customers can buy the model (that is the
 * database's availability row, which a signed-out page cannot read), so the page says the Studio shows it, and never "on sale".
 */
export function modelAvailability(f: Pick<ModelFacts, "operatorPreview" | "shutdownOn">, now: Date = new Date()): ModelAvailability {
  return modelLeftOut(f, now) ?? "unknown";
}

/** Lengths in seconds as the page shows them: a run with no gap as "min–max", anything else listed. */
export function durationText(ds: readonly number[], range: (min: string, max: string) => string, one: (n: string) => string): string | null {
  const s = [...new Set(ds)].sort((a, b) => a - b);
  if (s.length === 0) return null;
  if (s.length > 2 && s[s.length - 1] - s[0] === s.length - 1) return range(String(s[0]), String(s[s.length - 1]));
  return s.map((d) => one(String(d))).join(", ");
}

/** A same-origin file path made absolute, or null without an origin or a path (never a localhost URL, never a guess). */
function abs(path: unknown, origin: string | null): string | null {
  if (!origin || typeof path !== "string" || !path.startsWith("/")) return null;
  return new URL(path, origin).toString();
}

/**
 * The page's structured data: where it sits (BreadcrumbList) and what it holds (a CollectionPage of VideoObject / ImageObject,
 * one per sample, each with the words it was given as its description and the day it was made). Only what the page itself shows:
 * no rating, review, offer or price, and no author or publisher claim about who made the model. Without a known origin there are
 * no absolute URLs to give, so nothing is emitted.
 */
export function modelPageJsonLd(input: {
  page: ModelPage;
  origin: string | null;
  title: string;
  description: string;
  homeName: string;
  modelsName: string;
  noPrompt: string;
}): Record<string, unknown>[] {
  const { page, origin } = input;
  if (!origin) return [];
  const url = new URL(page.path, origin).toString();
  const parts = page.samples.flatMap(({ e, f }) => {
    const thumb = abs(f.poster, origin);
    if (!thumb) return [];
    const words = e.prompt.trim() ? e.prompt : input.noPrompt;
    const name = `${page.facts.name} · ${e.createdAt.slice(0, 10)}`;
    if (e.kind === "video" && f.clip) {
      const content = abs(f.clip.mp4, origin);
      if (!content) return [];
      return [{ "@type": "VideoObject", name, description: words, thumbnailUrl: thumb, contentUrl: content, uploadDate: e.createdAt, width: e.width, height: e.height }];
    }
    return [{ "@type": "ImageObject", name, description: words, contentUrl: thumb, uploadDate: e.createdAt, width: e.width, height: e.height }];
  });
  return [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: input.homeName, item: new URL("/", origin).toString() },
        { "@type": "ListItem", position: 2, name: input.modelsName, item: new URL(MODELS_PATH, origin).toString() },
        { "@type": "ListItem", position: 3, name: page.facts.name, item: url },
      ],
    },
    { "@context": "https://schema.org", "@type": "CollectionPage", name: input.title, description: input.description, url, hasPart: parts },
  ];
}

/** A resolution as its maker writes it: "768p" stays, "2k" reads "2K". */
export function resolutionText(r: string): string {
  return r.replace(/k$/, "K");
}
