import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

/**
 * The landing's moving pictures, all of them real generations from our own Studio (lib/site/showcase.json, written only by
 * tools/export_showcase.py; docs/design/MEDIA_CREDITS.md "Model samples"). Never stock footage and never a competitor's output:
 * tests/home-page.test.tsx checks that every id here is a showcase entry with its own clip.
 *
 * The hero: Earth from orbit, its dark left third behind the headline.
 */
export const HERO_JOB = "4e85c7e4-fd1a-4771-97ee-66c1fb853367";

/** The reel under the hero: tall clips, the shape a phone plays. */
export const REEL_JOBS = [
  "a04d5d55-27ef-4cae-95a2-25488503829e",
  "bf349995-6836-47fe-9481-a433b4fccb04",
  "f3583fdc-25c4-42cb-96ce-1d92d80cbf68",
  "0e7b89cb-282b-43b8-8777-55001b398f67",
  "cf2af7b1-5433-4661-979b-f65f3f8a4dbf",
  "5778bf5a-f751-472b-bbc0-c59b10567d32",
  "d91578df-1084-4d2e-9273-bf52bd966118",
  "c2733488-980e-4a20-9a58-28401bbee8c4",
] as const;

export type ReelItem = { e: ShowcaseEntry; f: ShowcaseFiles };

/** An id with no entry or no clip is dropped, never shown as a broken frame. */
export function reelItem(jobId: string): ReelItem | null {
  const e = SHOWCASE_ENTRIES.find((x) => x.jobId === jobId);
  const f = SHOWCASE_FILES[jobId];
  if (!e || !f || e.kind !== "video" || !f.clip) return null;
  return { e, f };
}

export function reelItems(): ReelItem[] {
  return REEL_JOBS.map(reelItem).filter((x): x is ReelItem => x !== null);
}
