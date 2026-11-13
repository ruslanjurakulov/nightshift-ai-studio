/**
 * One model sample as tools/export_showcase.py writes it, for the tests only. The data file the site reads
 * (lib/site/showcase.json) ships EMPTY: no entry exists until a real job is exported and the owner merges it.
 */
import type { ShowcaseEntry, ShowcaseFiles } from "@/lib/site/showcase";

export const FIXTURE_JOB = "0b0b0b0b-1111-4222-8333-444455556666";

export const FIXTURE_ENTRY: ShowcaseEntry = {
  jobId: FIXTURE_JOB,
  assetId: "0c0c0c0c-1111-4222-8333-444455556666",
  sha256: "a".repeat(64),
  modelId: "runway-gen4.5",
  modelName: "Runway Gen-4.5",
  provider: "runway",
  // Runway's models are operator previews in the registry today (tests/site-showcase.test.tsx checks the flag matches).
  operatorPreview: true,
  attribution: { text: "Powered by Runway", url: "https://runway.com" },
  capability: "i2v",
  kind: "video",
  prompt: "Paper lanterns drift up over a dark lake, slow push in",
  createdAt: "2026-11-12T09:30:00Z",
  input: { kind: "site_art", file: "step-1.webp", sha256: "b".repeat(64) },
  endFrame: null,
  cost: { usdEstimate: null, priceSource: null, rows: 1, vendor: [{ provider: "runway", vendorModel: "gen4.5", unit: "credits", quantity: 60 }] },
  width: 1280,
  height: 720,
  slot: null,
  caption: null,
  exportedAt: "2026-11-13T08:00:00Z",
};

export const FIXTURE_FILES: Record<string, ShowcaseFiles> = {
  [FIXTURE_JOB]: {
    poster: "/_next/static/media/poster.test.webp",
    posterSm: "/_next/static/media/poster-sm.test.webp",
    clip: { mp4: "/c.mp4", webm: "/c.webm", smMp4: "/c-sm.mp4", smWebm: "/c-sm.webm" },
  },
};
