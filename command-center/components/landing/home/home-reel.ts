import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { SHOWCASE_ITEMS, showcasePoster, type ShowcaseItem } from "@/lib/showcase/items";
import { templateMediaUrl, type MediaManifest } from "@/lib/templates/trends";
import mediaManifest from "@/lib/templates/media-manifest.json";
import { REGISTRY_NAMES } from "@/lib/creative/model-names";

/**
 * The landing's moving pictures, all of them real generations from our own Studio. Never stock footage and never a competitor's
 * output: tests/home-page.test.tsx checks the hero is a showcase entry with its own clip, and every reel piece a
 * lib/showcase/items.ts item with its files in public/showcase/ and a model the registry names.
 *
 * The hero: Earth from orbit, its dark left third behind the headline (lib/site/showcase.json, written only by
 * tools/export_showcase.py; docs/design/MEDIA_CREDITS.md "Model samples").
 */
export { HERO_JOB } from "@/components/site/slots";

export type ReelItem = { e: ShowcaseEntry; f: ShowcaseFiles };

/** An id with no entry or no clip is dropped, never shown as a broken frame. */
export function reelItem(jobId: string): ReelItem | null {
  const e = SHOWCASE_ENTRIES.find((x) => x.jobId === jobId);
  const f = SHOWCASE_FILES[jobId];
  if (!e || !f || e.kind !== "video" || !f.clip) return null;
  return { e, f };
}

/**
 * The reel, strongest first (the owner asked for more pieces, the cinematic ones). Every piece is our own Studio's work, and each
 * source says how that is known:
 *  - "studio":   lib/showcase/items.ts (public/showcase/), made in the demo workspace's Studio;
 *  - "sample":   lib/site/showcase.json, a real Studio job (written only by tools/export_showcase.py: job id, sha256, model);
 *  - "template": a Trends template's preview (public/templates/<slug>/), made through the Studio API with the template's own
 *                prompt and model (commit fb7d58f8 / 97e85d0f); its model is the one the template seeds (0183/0186).
 * Never stock footage (components/site/clip-assets.ts is Pexels and is not reachable from here) and never another product's output.
 * No maker's "Powered by" line: the public site names the model only (owner decision 2026-11-13, lib/site/showcase.ts header).
 */
export type ReelRef =
  | { from: "studio"; slug: string }
  | { from: "sample"; jobId: string; key: string }
  | { from: "template"; slug: string; key: string; modelIds: readonly string[] };

export const REEL: readonly ReelRef[] = [
  { from: "sample", jobId: "de53f364-eaf7-4cd1-8d44-7b56b21b03b6", key: "whaleCity" },
  // The first cards a phone sees load with the page: these two have small (640) renditions; Registan's is one full-size file.
  { from: "sample", jobId: "ab7cc0e2-8040-4643-8e14-74219fc1d8e2", key: "lighthouse" },
  { from: "studio", slug: "registan-dusk" },
  { from: "sample", jobId: "01c9f1f0-d54b-4fd3-a88f-ddf459aece73", key: "snowGlobe" },
  { from: "studio", slug: "language-duo" },
  { from: "sample", jobId: "a04d5d55-27ef-4cae-95a2-25488503829e", key: "giantSneaker" },
  { from: "sample", jobId: "6a94865b-ac2f-4b1f-b273-fd4b10c8c477", key: "oldCity" },
  { from: "studio", slug: "neon-city-rain" },
  { from: "sample", jobId: "ab0bcba2-8374-465d-b505-8dac19977948", key: "coastRoad" },
  { from: "template", slug: "scale-shock", key: "scaleShock", modelIds: ["minimax-h3-max"] },
  { from: "sample", jobId: "dcb96246-9379-4c3a-aa33-a8ee6bb7f846", key: "drones" },
  { from: "studio", slug: "perfume-splash" },
  { from: "sample", jobId: "c62d40e7-b1b5-4ba4-8bc9-487f9ef7382e", key: "stormJar" },
  { from: "template", slug: "travel-montage", key: "samarkand", modelIds: ["minimax-h3"] },
  { from: "sample", jobId: "9a52ebf1-bbe3-473c-b77c-7553bc18e0d8", key: "aboveClouds" },
  { from: "studio", slug: "desert-silk" },
];

/** What the page draws for one piece. `titleKey` names a title in the dictionary (landingHome.reelTitles); a Studio item carries its own. */
export interface StudioPiece {
  id: string;
  kind: ShowcaseItem["kind"];
  aspect: ShowcaseItem["aspect"];
  models: string[];
  title?: ShowcaseItem["title"];
  titleKey?: string;
  poster: string;
  media: { type: "studio"; slug: string } | { type: "sample"; jobId: string } | { type: "template"; slug: string };
}

/** The shape of each piece's box (the posters are a few pixels off these; the box's aspect-ratio and object-fit cover decide). */
export const PIECE_SIZE: Readonly<Record<ShowcaseItem["aspect"], { width: number; height: number }>> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
};

const aspectOf = (w: number, h: number): ShowcaseItem["aspect"] => (h > w * 1.15 ? "9:16" : w > h * 1.15 ? "16:9" : "1:1");
const names = (ids: readonly string[]): string[] | null => {
  const out = ids.map((id) => REGISTRY_NAMES[id]);
  return ids.length > 0 && out.every(Boolean) ? out : null;
};

/**
 * The reel, in REEL's order. A piece is left out rather than drawn wrong: a model the registry does not name (it would be credited
 * to a raw id or to fewer models than made it), a sample that is not a video with its own clip files, or a Studio item no longer in
 * the list. tests/home-page.test.tsx fails on any such piece, so leaving one out never goes unnoticed.
 */
export function studioPieces(): StudioPiece[] {
  return REEL.flatMap((r): StudioPiece[] => {
    if (r.from === "studio") {
      const it = SHOWCASE_ITEMS.find((x) => x.slug === r.slug);
      const models = it && names(it.modelIds);
      if (!it || !models) return [];
      return [{ id: it.slug, kind: it.kind, aspect: it.aspect, models, title: it.title, poster: showcasePoster(it.slug), media: { type: "studio", slug: it.slug } }];
    }
    if (r.from === "sample") {
      const hit = reelItem(r.jobId);
      const models = hit && names([hit.e.modelId]);
      if (!hit || !models) return [];
      return [{ id: r.jobId, kind: "video", aspect: aspectOf(hit.e.width, hit.e.height), models, titleKey: r.key, poster: hit.f.posterSm, media: { type: "sample", jobId: r.jobId } }];
    }
    const models = names(r.modelIds);
    const poster = templateMediaUrl(mediaManifest as MediaManifest, r.slug, "poster");
    if (!models || !poster || !templateMediaUrl(mediaManifest as MediaManifest, r.slug, "preview")) return [];
    return [{ id: r.slug, kind: "video", aspect: "9:16", models, titleKey: r.key, poster, media: { type: "template", slug: r.slug } }];
  });
}
