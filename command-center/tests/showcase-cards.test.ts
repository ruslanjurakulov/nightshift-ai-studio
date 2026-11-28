import { describe, expect, it } from "vitest";
import { SHOWCASE_CARDS, SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { SHOWCASE_ENTRIES, showcaseCard } from "@/lib/site/showcase";
import { EFFECTS } from "@/lib/effects/catalog";
import { effectSample } from "@/components/effects/effect-sample";
import { TOOL_SAMPLES, toolSource } from "@/lib/site/tool-samples";

/**
 * The client-safe slice of the showcase (components/site/showcase-assets.ts SHOWCASE_CARDS, written by tools/export_showcase.py)
 * against the server-only manifest it is cut from (lib/site/showcase.ts). The whole data file used to ship in public JavaScript
 * because client code read it; the slice is what client code reads now, so it must say the same thing the manifest says, and
 * nothing more.
 */
describe("the showcase's client slice", () => {
  it("is exactly the manifest's entries cut to cards, in the same order (the Python and TypeScript parsers agree)", () => {
    expect(SHOWCASE_CARDS).toEqual(SHOWCASE_ENTRIES.map(showcaseCard));
    expect(SHOWCASE_CARDS.length).toBeGreaterThan(0);
  });

  it("carries no vendor, vendor model, model name, cost, maker credit, preview flag, prompt or hash", () => {
    const allowed = ["capability", "height", "input", "jobId", "kind", "modelId", "slot", "width"];
    for (const c of SHOWCASE_CARDS) {
      expect(Object.keys(c).sort(), c.jobId).toEqual(allowed);
      expect(Object.keys(c.input).every((k) => k === "kind" || k === "jobId"), c.jobId).toBe(true);
    }
    const text = JSON.stringify(SHOWCASE_CARDS);
    for (const field of ["provider", "vendorModel", "modelName", "operatorPreview", "sha256", "attribution", "cost", "prompt", "assetId"]) {
      expect(text, field).not.toContain(`"${field}"`);
    }
  });

  it("gives every effect the same sample as the full entries do, the words check included", () => {
    // The browser's effectSample reads cards, which have no prompt; the full entries do. Both are constants of the build, so this is
    // the "never a borrowed preview" guard (components/effects/effect-sample.ts) for every effect the catalog ships.
    for (const e of EFFECTS) {
      const client = effectSample(e);
      const full = effectSample(e, SHOWCASE_ENTRIES, SHOWCASE_FILES);
      expect(client?.entry.jobId ?? null, e.id).toBe(full?.entry.jobId ?? null);
    }
    expect(EFFECTS.some((e) => effectSample(e) !== null)).toBe(true);
  });

  it("names the same source picture for every tool on the wall as the full entry's recorded input", () => {
    for (const s of Object.values(TOOL_SAMPLES)) {
      const e = SHOWCASE_ENTRIES.find((x) => x.jobId === s.job);
      const want = e && e.kind === "video" && e.input.kind === "operator_job" ? e.input.jobId : null;
      expect(toolSource(s.job), String(s.job)).toBe(want);
    }
  });
});
