/**
 * The effects a Client Component is handed (lib/effects/shared.ts slices, built by lib/effects/catalog.ts on the server).
 *
 * What would break without these: an effect's model preference order ("models":["runway-gen4.5","minimax-h3",…]) or its full
 * prompt back in a card's props, and so in the page payload and the chunk; the server-side resolution drifting from what the
 * browser computed before (a different model named, a different prompt in the composer, a picture not carried through), which
 * would change the landing, the Studio desk, the banner or the canvas without anyone deciding it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EFFECTS,
  canvasEffects,
  effectDeskCards,
  effectFace,
  effectPrefill,
  resolveEffect,
} from "@/lib/effects/catalog";
import { withEffectSource } from "@/lib/effects/shared";
import { effectSample } from "@/components/effects/effect-sample";
import { nodePrefill, toolsFor } from "@/components/studio-canvas/Inspector";
import type { StudioModel } from "@/lib/creative/studio";
import type { CanvasNode } from "@/lib/studio/canvas";

const ROOT = process.cwd();
const model = (id: string, name: string, caps: string[], extra: Partial<StudioModel> = {}): StudioModel => ({ id, displayName: name, capabilities: caps, beta: false, ...extra });
const OPERATOR: StudioModel[] = [
  model("minimax-h3", "MiniMax H3", ["t2v", "i2v"], { preview: true }),
  model("runway-gen4.5", "Runway Gen-4.5", ["t2v", "i2v"], { preview: true }),
  model("runway-gen4-turbo", "Runway Gen-4 Turbo", ["i2v"], { preview: true }),
];
const CUSTOMER: StudioModel[] = [model("minimax-hailuo-2.3", "MiniMax Hailuo 2.3", ["t2v", "i2v"], { fixedShape: true }), model("veo-3.1", "Veo 3.1", ["t2v", "i2v"])];
/** An import (static or dynamic) of the catalog or of the data file itself. */
const IMPORTS_DATA = /(?:from\s*|import\s*\(\s*)["'](?:@\/lib\/effects\/catalog|[^"']*effects\.json)["']/;
const PICTURE = "11111111-1111-4111-8111-111111111111";

describe("an effect's face carries what the card draws and nothing it does not", () => {
  it.each(EFFECTS.map((e) => [e.id, e] as const))("%s: no models, no prompt, no preview job id, no slot hint", (_, e) => {
    const face = effectFace(e);
    expect(Object.keys(face).sort()).toEqual(["aspect", "capability", "duration", "hues", "id", "input", "motif", "sample"]);
    const wire = JSON.stringify(face);
    expect(wire).not.toContain(e.prompt.slice(0, 40));
    expect(wire).not.toMatch(/"models"|"prompt"|"previewJobId"|"slotHint"/);
    // The sample is the one the browser found before (same function, same client-safe slice), cut to what the frame reads.
    const s = effectSample(e);
    expect(face.sample).toEqual(s ? { entry: { jobId: s.entry.jobId, width: s.entry.width, height: s.entry.height }, files: s.files } : null);
    if (face.sample) expect(Object.keys(face.sample.entry).sort()).toEqual(["height", "jobId", "width"]);
  });

  it("the desk's cards are resolveEffect's answer for the same list, in the gallery's order", () => {
    for (const models of [[], OPERATOR, CUSTOMER]) {
      const cards = effectDeskCards(models);
      expect(cards.map((c) => c.face.id)).toEqual(EFFECTS.map((e) => e.id));
      cards.forEach((c, i) => {
        const a = resolveEffect(EFFECTS[i], models);
        // The same model and the same "not the first choice" note, without the place in the order.
        expect(c.availability).toEqual(a.state === "ready" ? { state: "ready", modelId: a.modelId, modelName: a.modelName, nextChoice: a.rank > 0, preview: a.preview, fixedShape: a.fixedShape } : { state: "unavailable" });
      });
      expect(JSON.stringify(cards)).not.toMatch(/"models"|"prompt"|"previewJobId"|"rank"/);
    }
  });
});

describe("the Studio canvas fills its composer from the server's resolution exactly as it did itself", () => {
  const node = (effectId: string): CanvasNode => ({ id: "n1", kind: "effects", x: 0, y: 0, jobId: null, assetId: null, assetKind: null, draft: "", effectId });

  it.each([
    ["the operator's previews", OPERATOR],
    ["a customer's list", CUSTOMER],
    ["nothing offered", [] as StudioModel[]],
  ])("%s: the same prefill, the wired picture carried, the same tool", (_, models) => {
    const effects = canvasEffects(models);
    for (const e of EFFECTS) {
      const pick = resolveEffect(e, models);
      for (const source of [null, PICTURE]) {
        const before = pick.state === "ready" ? effectPrefill(e, pick.modelId, "", source) : null;
        const after = nodePrefill(node(e.id), source ? { type: "image", assetId: source } : null, effects);
        if (before) expect(after, `${e.id} ${source}`).toEqual(before);
        // Not open here: the node falls through to its tool's plain form, as before (never another model).
        else expect(after?.model ?? "", `${e.id} ${source}`).toBe("");
      }
      expect(toolsFor(node(e.id), null, effects)).toEqual([e.capability]);
    }
  });

  it("puts a picture only into a picture effect's prefill", () => {
    const words = EFFECTS.find((e) => e.input === "none")!;
    const pic = EFFECTS.find((e) => e.input === "picture")!;
    expect(withEffectSource(effectPrefill(words, "m", "", null), PICTURE)).not.toHaveProperty("sourceId");
    expect(withEffectSource(effectPrefill(pic, "m", "", null), PICTURE).sourceId).toBe(PICTURE);
  });
});

describe("the effects data is reachable from server code only", () => {
  it("catalog.ts, the one module that reads effects.json, is server-only", () => {
    expect(readFileSync(path.join(ROOT, "lib/effects/catalog.ts"), "utf8")).toMatch(/^import "server-only";$/m);
    expect(readFileSync(path.join(ROOT, "lib/effects/shared.ts"), "utf8")).not.toMatch(IMPORTS_DATA);
  });

  it("no Client Component imports the catalog", () => {
    for (const file of [
      "components/effects/EffectsDesk.tsx",
      "components/effects/EffectBanner.tsx",
      "components/effects/EffectFrame.tsx",
      "components/studio-canvas/Inspector.tsx",
      "components/studio-canvas/QuickAdd.tsx",
    ]) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      expect(src, file).not.toMatch(IMPORTS_DATA);
    }
  });
});
