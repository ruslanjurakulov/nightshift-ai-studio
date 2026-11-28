/**
 * What the effects screens hand their Client Components, serialized as React would put it in the page's payload.
 *
 * Every app page is rendered per request, so no build file holds these payloads and scripts/vendor-bundle-check.mjs never
 * sees them (it says "0 app pages prerendered"). This is where they are checked: the public Effects gallery (a Server
 * Component on /) and the props /create and /studio build for the desk, the banner and the canvas.
 *
 * What would break without it: an effect's model order, its prompt, its preview job or its place in the order back in a
 * client prop (EffectsGallery handed EffectFrame the whole effect before #956, so the landing's payload carried them).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { EFFECTS, canvasEffects, effectChoice, effectDeskCards, effectFace, effectFromQuery, resolveEffect } from "@/lib/effects/catalog";
import { EffectFrame } from "@/components/effects/EffectFrame";
import { EffectsGallery } from "@/components/site/EffectsGallery";
import type { StudioModel } from "@/lib/creative/studio";

const ROOT = process.cwd();
const model = (id: string, name: string, caps: string[], extra: Partial<StudioModel> = {}): StudioModel => ({ id, displayName: name, capabilities: caps, beta: false, ...extra });
const OPERATOR: StudioModel[] = [
  model("minimax-h3", "MiniMax H3", ["t2v", "i2v"], { preview: true }),
  model("runway-gen4.5", "Runway Gen-4.5", ["t2v", "i2v"], { preview: true }),
  model("runway-gen4-turbo", "Runway Gen-4 Turbo", ["i2v"], { preview: true }),
];
const CUSTOMER: StudioModel[] = [model("minimax-hailuo-2.3", "MiniMax Hailuo 2.3", ["t2v", "i2v"], { fixedShape: true })];

/** Every element of `type` in a tree a Server Component returned (its children, as React would walk them). */
function find(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const n of node) find(n, type, out);
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    find((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

/** The fields that must never cross: the order itself, the words, the preview job, the place in the order. */
const FORBIDDEN = /"models"|"prompt"|"previewJobId"|"rank"|"slotHint"|"modelId":"[^"]*"\s*,\s*"capability"/;

function noPromptText(wire: string) {
  for (const e of EFFECTS) expect(wire, e.id).not.toContain(e.prompt.replace(/\{[^}]*\}[\s\S]*$/, "").slice(0, 30));
}

describe("the public Effects gallery hands EffectFrame the face only", () => {
  it("one frame per effect, and no frame prop carries models, prompt, preview job or rank", () => {
    const frames = find(EffectsGallery({ t: en }), EffectFrame);
    expect(frames).toHaveLength(EFFECTS.length);
    const wire = JSON.stringify(frames.map((f) => f.props));
    expect(wire).not.toMatch(FORBIDDEN);
    noPromptText(wire);
    // The face is what effectFace builds, for each effect in order.
    expect(frames.map((f) => (f.props as { effect: unknown }).effect)).toEqual(EFFECTS.map(effectFace));
  });
});

describe("the props /create and /studio build", () => {
  it("the pages hand the desk, the banner and the canvas the server-built slices", () => {
    const create = readFileSync(path.join(ROOT, "app/(app)/[channel]/create/page.tsx"), "utf8");
    expect(create).toContain("<EffectsDesk cards={effectDeskCards(panelModels)} />");
    expect(create).toContain("<EffectBanner effect={effectFace(effectAsk.effect)} availability={effectChoice(effectPick)}");
    const studio = readFileSync(path.join(ROOT, "app/(app)/[channel]/studio/page.tsx"), "utf8");
    expect(studio).toContain("effects: canvasEffects(panelModels),");
  });

  it.each([
    ["operator", OPERATOR],
    ["customer", CUSTOMER],
    ["nothing offered", [] as StudioModel[]],
  ])("desk cards (%s): no models, prompt, preview job or rank", (_, models) => {
    const wire = JSON.stringify(effectDeskCards(models));
    expect(wire).not.toMatch(FORBIDDEN);
    noPromptText(wire);
  });

  it("the banner on /create: the face and the choice, and the prompt only in the one prefill the composer is filled with", () => {
    const ask = effectFromQuery({ tool: "t2v", effect: "giant-in-the-city", subject: "a red fox" })!;
    const banner = { effect: effectFace(ask.effect), availability: effectChoice(resolveEffect(ask.effect, OPERATOR)), subject: ask.subject };
    const wire = JSON.stringify(banner);
    expect(wire).not.toMatch(FORBIDDEN);
    noPromptText(wire);
  });

  it("the canvas: each effect's prompt only inside its composer prefill (what the composer is filled with), never its order", () => {
    for (const models of [OPERATOR, CUSTOMER, []]) {
      const effects = canvasEffects(models);
      // Take the prefill's words out, and nothing of the effect's words, order or preview is left.
      const rest = JSON.stringify(
        effects.map((e) => {
          if (!e.prefill) return e;
          const { prompt: _words, ...prefill } = e.prefill;
          return { ...e, prefill };
        }),
      );
      expect(rest).not.toMatch(FORBIDDEN);
      noPromptText(rest);
      // The prefill names only the one model the workspace will use.
      for (const e of effects) if (e.prefill) expect(models.map((m) => m.id)).toContain(e.prefill.model);
    }
  });
});
