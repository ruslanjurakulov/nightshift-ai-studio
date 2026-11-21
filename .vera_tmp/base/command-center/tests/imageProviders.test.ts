import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_GENERATORS, IMAGE_PROVIDERS, imageGeneratorById } from "../lib/imageProviders";
import { IMAGE_PROVIDERS as FROM_RUN_BACKEND } from "../lib/runBackend";

const ROOT = join(__dirname, "..", "..");

describe("image providers", () => {
  it("lists stock plus every generator, once", () => {
    expect(IMAGE_PROVIDERS[0]).toBe("pexels");
    expect([...IMAGE_PROVIDERS].slice(1).sort()).toEqual(IMAGE_GENERATORS.map((g) => g.id).sort());
    expect(new Set(IMAGE_PROVIDERS).size).toBe(IMAGE_PROVIDERS.length);
    expect(FROM_RUN_BACKEND).toBe(IMAGE_PROVIDERS);
  });

  it("matches the workflow's image_provider choice list", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/daily_video.yml"), "utf8");
    const m = wf.match(/image_provider:[\s\S]*?options: \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const options = m![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(options).toEqual([...IMAGE_PROVIDERS]);
  });

  it("names the key each generator needs", () => {
    expect(imageGeneratorById("gpt-image")?.secretName).toBe("OPENAI_API_KEY");
    expect(imageGeneratorById("nano-banana")?.secretName).toBe("GEMINI_API_KEY");
    expect(imageGeneratorById("flux")?.secretName).toBe("BFL_API_KEY");
    expect(imageGeneratorById("pexels")).toBeUndefined();
  });
});
