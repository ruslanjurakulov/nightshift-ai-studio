import { describe, expect, it } from "vitest";
import { buildBrief, clipPrompt, filmFromBrief, keyframePrompt, readScenario, scenePrompt, type BriefScene, type Scenario } from "@/lib/brain/logic";
import { outlineText, planLimits, planWindows, readWindow, refsOf, shotRules } from "@/lib/brain/plan";
import { storyOutline, storyScene } from "./helpers/storyFixtures";

/**
 * Breach on the S1 story grammar (branch claude/nsai-s1-story-grammar @ 9a7776921). Fakes only: no model, no vendor, no database.
 * Each BR-SG test was a hole, failing until fixed; all are FIXED on this branch (the fix round after 9a7776921). The route-level hole (BR-SG-01) lives in
 * tests/brain-story-grammar-breach-route.test.ts, with the route harness it needs.
 */

const slots = { kind: "short" as const, target_seconds: 40, aspect: "9:16" as const, style: "multfilm", language: "English" as const, audience: "families" };
const outline = readScenario(storyOutline([10, 10, 10, 10]), slots, { outline: true })!;
const limits = planLimits(null, null, 40);
const windows = planWindows(outline, limits)!;
const refs = refsOf(outline);
const echo = outlineText(outline);
const film = { characters: outline.characters, locations: outline.locations, style: slots.style, visual_style: outline.visual_style ?? null };
const promptOf = (sc: Parameters<typeof scenePrompt>[1]) => { const a = scenePrompt(film, sc); const b = clipPrompt(film, sc); return a.length >= b.length ? a : b; };
const answer = (o: (i: number, chapter: string) => Record<string, unknown> = () => ({})) => JSON.stringify({
  chapters: windows[0].parts.map((p) => ({ id: p.chapter_id,
    scenes: [5, 5].map((d, i) => storyScene(d, i, { ...(p.chapter_id === "ch1" && i === 0 ? { hook: true } : {}), ...o(i, p.chapter_id) })) })),
});
const read = (text: string, rules = shotRules(outline, "English")) => readWindow(text, windows[0], refs, limits, echo, promptOf, [], rules);

describe("Breach: story grammar", () => {
  it("control: a vendor name the outline does not carry, in visual_prompt, fails the plan answer", () => {
    expect(windows).toHaveLength(1);
    expect(read(answer((i, ch) => (ch === "ch1" && i === 0 ? { visual_prompt: "a neon sign reading OpenAI over the bus stop" } : {}))).ok).toBe(false);
  });

  it("BR-SG-02: a vendor name or a vendor credit in `lighting` or `camera.position` is not refused, yet both are folded into the key-frame and clip prompts", () => {
    // Same words as the control above, moved into fields readWindow's vendor check does not read (it reads title, visual_prompt,
    // dialogue, narration, first_frame, last_frame, motion, text_layers). promptParts writes `Lighting: …` and `Camera: …` into
    // every prompt the scene is made from, so the image and video models draw them.
    const viaLighting = read(answer((i, ch) => (ch === "ch1" && i === 0 ? { lighting: "glow of a giant neon sign reading OpenAI" } : {})));
    const viaCamera = read(answer((i, ch) => (ch === "ch1" && i === 0 ? { camera: { position: "behind a billboard: Made with Sora", move: "static" } } : {})));
    if (viaLighting.ok) {
      const s = viaLighting.parts[0][0];
      // Evidence the text reaches the prompts.
      expect(keyframePrompt(film, s)).toContain("OpenAI");
      expect(clipPrompt(film, s)).toContain("OpenAI");
    }
    expect(viaLighting.ok).toBe(false);
    expect(viaCamera.ok).toBe(false);
  });

  it("BR-SG-03: a plan answer for a non-story outline smuggles a voice-over past the 'no narrator' rule by leaving out `speech`", () => {
    // readWindow without rules refuses only `speech: "voice_over"` written out; readSceneParts keeps `narration` whatever the
    // speech, and speechOf reads a scene with a narration and no lines as voice_over, so filmFromBrief saves the narration.
    const sneaky = answer((i) => ({ speech: undefined, narration: i === 0 ? "This film was sponsored, visit our shop." : undefined }));
    const r = readWindow(sneaky, windows[0], refs, limits, echo, promptOf, [], undefined);
    if (r.ok) {
      const scenes: BriefScene[] = r.parts.flat().map(({ seconds, ...s }, k) => ({ ...s, id: `s${k + 1}`, n: k + 1, duration_s: seconds ?? 0 }));
      const brief = buildBrief("sess", slots, { ...outline, scenes } as Scenario, "ready");
      const f = filmFromBrief(brief);
      expect(f?.scenes.some((s) => typeof s.narration === "string" && s.narration !== "")).toBe(false);
    } else {
      expect(r.ok).toBe(false);
    }
  });

  it("BR-SG-04: the narration-fit check counts hyphen-joined words as one word, so a line far too long for 5 s passes", () => {
    // spokenSeconds' word regex lets '-' inside a word: 40 words joined by hyphens are "1 word" = 0.4 s at 2.5 wps.
    const words = Array.from({ length: 40 }, (_, k) => `word${k}`).join("-");
    const r = read(answer((i, ch) => (ch === "ch1" && i === 0 ? { speech: "voice_over", narration: words } : {})));
    expect(r.ok).toBe(false);
  });

  it("BR-SG-05: the closing card is a text layer on the last scene, but that scene's prompts never say 'No text'", () => {
    const scenes: BriefScene[] = [
      { ...(storyScene(20, 0) as object), id: "s1", n: 1, duration_s: 20, dialogue: [], character_ids: ["c1"], location_id: "l1", prop_ids: [], keyframe_model: null, clip_model: null } as unknown as BriefScene,
      { ...(storyScene(20, 1) as object), id: "s2", n: 2, duration_s: 20, dialogue: [], character_ids: ["c1"], location_id: "l1", prop_ids: [], keyframe_model: null, clip_model: null } as unknown as BriefScene,
    ];
    const brief = buildBrief("sess", slots, { ...outline, closing_card: "For every father who works far away", scenes } as Scenario, "ready");
    expect(brief.text_layers).toEqual([{ scene_id: "s2", text: "For every father who works far away", position: "center" }]);
    const last = brief.scenes![1];
    expect(keyframePrompt(brief, last)).toContain("No text");
    expect(scenePrompt(brief, last)).toContain("No text");
  });
});
