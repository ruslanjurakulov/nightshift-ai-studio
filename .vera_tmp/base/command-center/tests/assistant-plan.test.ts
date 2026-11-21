/**
 * The Assistant's planner (lib/assistant/plan.ts): one goal → steps, each
 * with what it makes, for which channel, in which shape and language — and
 * one total that is only ever the database's prices added up.
 *
 * What would break without these: "for my next video" read as one more video
 * to pay for; "10-minute" read as ten videos; a step nobody could price
 * counted as 0 in the total; two items sharing one idempotency key (one is
 * silently dropped) or a key that changes on reload (one is paid twice).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_COUNT,
  MAX_STEPS,
  SHORT_S,
  addStep,
  itemBody,
  itemKey,
  nearestRunLength,
  parseLanguage,
  parseTheme,
  planFromGoal,
  planItems,
  planTotal,
  priceKey,
  removeStep,
  stepBlocker,
  stepRequest,
  updateStep,
  type PlanStep,
  type PlannerContext,
  type StepEnv,
  type StepPrice,
} from "@/lib/assistant/plan";
import { IDEMPOTENCY_KEY_RE } from "@/lib/creative/operations";
import type { StudioModel } from "@/lib/creative/studio";

const ORG = "11111111-1111-4111-8111-111111111111";
const channels = [
  { id: "UC_space", slug: "space", name: "Space Daily", language: "English" },
  { id: "UC_tarix", slug: "tarix", name: "Tarix Kanali", language: "Uzbek" },
];
const ctx: PlannerContext = { locale: "en", channels, currentSlug: "space" };
const models: StudioModel[] = [
  { id: "img-a", displayName: "A", capabilities: ["t2i"], beta: false },
  { id: "vid-a", displayName: "B", capabilities: ["t2v"], beta: false },
  { id: "tts-a", displayName: "C", capabilities: ["tts"], beta: false },
];
const env: StepEnv = { orgId: ORG, models, channels, canRun: true, runConfigured: true };
const plan = (goal: string, c: PlannerContext = ctx) => planFromGoal(goal, c, "plan-1");
const shape = (goal: string, c?: PlannerContext) =>
  plan(goal, c).steps.map((s) => ({ kind: s.kind, count: s.count, ...(s.kind === "video" ? { durationS: s.durationS } : { aspect: s.aspect }) }));

describe("reading the goal", () => {
  it("5 Shorts about space facts: five one-minute videos for the open channel, the theme kept", () => {
    const p = plan("Make 5 Shorts for my channel about space facts");
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ kind: "video", count: 5, durationS: SHORT_S, channelSlug: "space", language: "English", text: "space facts" });
    expect(p.theme).toBe("space facts");
    expect(p.guessed).toBe(false);
  });

  it("each thing takes its own subject when the goal gives one, else the goal's", () => {
    const p = plan("Make 5 Shorts about space facts and 3 thumbnails about black holes");
    expect(p.steps[0].text).toBe("space facts");
    expect(p.steps[1].text).toContain("black holes");
    expect(p.steps[1].text).not.toContain("space facts");
    const shared = plan("5 shorts and 3 thumbnails about black holes");
    expect(shared.steps[0].text).toBe("black holes");
    expect(shared.steps[1].text).toContain("black holes");
  });

  it("'for my next video' is context, not a video to pay for", () => {
    expect(shape("3 thumbnails and a voice intro for my next video")).toEqual([
      { kind: "thumbnail", count: 3, aspect: "16:9" },
      { kind: "voice", count: 1, aspect: "16:9" },
    ]);
  });

  it("a length is not a count: 'two 10-minute videos' is two videos of the 10–20 min length", () => {
    expect(shape("two 10-minute videos about volcanoes")).toEqual([{ kind: "video", count: 2, durationS: 600 }]);
    expect(shape("a 15 minute video")).toEqual([{ kind: "video", count: 1, durationS: 1200 }]);
  });

  it("the run length offered is the smallest that is at least as long", () => {
    expect([1, 3, 5, 8, 10, 20, 45].map((m) => nearestRunLength(m * 60))).toEqual([60, 300, 300, 600, 600, 1200, 1200]);
  });

  it("several kinds in one goal, with shape words applied to pictures and clips", () => {
    expect(shape("2 vertical clips, 4 images and a video about the Aral Sea")).toEqual([
      { kind: "clip", count: 2, aspect: "9:16" },
      { kind: "image", count: 4, aspect: "9:16" },
      { kind: "video", count: 1, durationS: 600 },
    ]);
    expect(parseTheme("2 vertical clips, 4 images and a video about the Aral Sea")).toBe("the Aral Sea");
  });

  it("Russian: count words, 'для видео' as context, theme after 'про'", () => {
    const p = plan("Сделай пять шортсов про космос и 3 превью для следующего видео", { ...ctx, locale: "ru" });
    expect(p.steps.map((s) => [s.kind, s.count])).toEqual([
      ["video", 5],
      ["thumbnail", 3],
    ]);
    expect(p.theme).toBe("космос");
  });

  it("Uzbek: '5 ta shorts', theme before 'haqida', 'video uchun' as context", () => {
    const p = plan("Kosmos haqida 5 ta shorts va keyingi video uchun 2 ta muqova", { ...ctx, locale: "uz" });
    expect(p.steps.map((s) => [s.kind, s.count])).toEqual([
      ["video", 5],
      ["thumbnail", 2],
    ]);
    expect(p.theme).toBe("Kosmos");
  });

  it("the language comes from an explicit phrase, else the channel's, else the viewer's", () => {
    expect(plan("a video about Russian history").steps[0].language).toBe("English");
    expect(plan("a video about history in Russian").steps[0].language).toBe("Russian");
    expect(parseLanguage("o'zbekcha video")).toBe("Uzbek");
    expect(parseLanguage("видео на английском")).toBe("English");
    // Named channel: its own language.
    expect(plan("a video for Tarix Kanali").steps[0]).toMatchObject({ channelSlug: "tarix", language: "Uzbek" });
    // No channel language on record: the viewer's.
    const bare = { ...ctx, channels: [{ ...channels[0], language: "" }] };
    expect(plan("a video", { ...bare, locale: "ru" }).steps[0].language).toBe("Russian");
  });

  it("nothing to make named: one video about what was written, marked as a guess", () => {
    const p = plan("the history of tea");
    expect(p.guessed).toBe(true);
    expect(p.steps).toEqual([expect.objectContaining({ kind: "video", count: 1, text: "the history of tea" })]);
    expect(plan("   ").steps).toEqual([]);
  });

  it("counts and steps are capped", () => {
    expect(plan("50 thumbnails about cats").steps[0].count).toBe(MAX_COUNT);
    const many = plan("a video, an image, a clip, a thumbnail, a cover, a voice intro, a short, another video");
    expect(many.steps).toHaveLength(MAX_STEPS);
  });

  it("the same words make the same plan", () => {
    expect(plan("5 Shorts about space facts")).toEqual(plan("5 Shorts about space facts"));
  });

  it("pictures start from the Studio template with the theme in the brackets; no theme keeps the brackets", () => {
    const withTheme = plan("a thumbnail about black holes").steps[0];
    expect(withTheme.text).toContain("black holes");
    expect(withTheme.text).not.toMatch(/\[/);
    const without = plan("3 thumbnails for my next video").steps[0];
    expect(without.text).toMatch(/\[[^\]]+\]/);
    expect(stepBlocker(without, env)).toBe("need_words");
  });

  it("a voice intro speaks the step's language", () => {
    const p = plan("a voice intro about the Moon in Russian");
    expect(p.steps[0].text).toMatch(/Луна|the Moon/);
    expect(p.steps[0].text).toMatch(/С возвращением/);
  });
});

describe("editing the plan", () => {
  const base = plan("5 Shorts about space facts and 2 thumbnails");

  it("count, length, shape and words change; values a step doesn't offer are ignored", () => {
    let p = updateStep(base, "s1", { count: 3, durationS: 300 });
    expect(p.steps[0]).toMatchObject({ count: 3, durationS: 300 });
    p = updateStep(p, "s1", { count: 0, durationS: 999 });
    expect(p.steps[0]).toMatchObject({ count: 1, durationS: 300 });
    p = updateStep(p, "s2", { aspect: "1:1" });
    expect(p.steps[1].aspect).toBe("1:1");
    p = updateStep(p, "s2", { aspect: "4:3" as never });
    expect(p.steps[1].aspect).toBe("1:1");
  });

  it("a voice's untouched words follow its language; words the person wrote stay", () => {
    let p = plan("a voice intro about tea");
    p = updateStep(p, "s1", { language: "Uzbek" });
    expect(p.steps[0].text).toMatch(/Kanalga xush kelibsiz/);
    p = updateStep(p, "s1", { text: "My own words" });
    p = updateStep(p, "s1", { language: "Russian" });
    expect(p.steps[0].text).toBe("My own words");
  });

  it("a removed step's id is never reused, so its keys are never reused", () => {
    let p = removeStep(base, "s2");
    p = addStep(p, "voice", ctx);
    expect(p.steps.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(p.steps[1]).toMatchObject({ kind: "voice", count: 1 });
  });
});

describe("what a step asks for", () => {
  it("one video: its topic; several: the theme as a niche, so each picks its own topic", () => {
    const one = stepRequest(plan("a video about tea").steps[0], env);
    expect(one).toMatchObject({ type: "run", channelId: "UC_space", duration: 600, topic: "tea" });
    expect(one).not.toHaveProperty("niche");
    const five = stepRequest(plan("5 shorts about tea").steps[0], env);
    expect(five).toMatchObject({ type: "run", duration: 60, niche: "tea" });
    expect(five).not.toHaveProperty("topic");
  });

  it("a picture asks the Studio's own params with the first model offered", () => {
    const req = stepRequest(plan("a vertical thumbnail about tea").steps[0], env);
    expect(req).toMatchObject({ type: "creative", capability: "t2i", model: "img-a", params: { aspect_ratio: "9:16" } });
  });

  it("blocked steps ask nothing", () => {
    const video = plan("a video about tea").steps[0];
    expect(stepBlocker(video, { ...env, canRun: false })).toBe("no_access");
    expect(stepBlocker(video, { ...env, runConfigured: false })).toBe("run_unavailable");
    expect(stepBlocker({ ...video, channelSlug: "gone" }, env)).toBe("no_channel");
    const img = plan("an image about tea").steps[0];
    expect(stepBlocker(img, { ...env, orgId: null })).toBe("no_org");
    expect(stepBlocker(img, { ...env, models: [] })).toBe("no_model");
    expect(stepRequest(img, { ...env, models: [] })).toBeNull();
  });
});

describe("the total", () => {
  const p = plan("5 shorts about tea and 2 thumbnails about tea");
  const prices = (m: Record<string, StepPrice>) => (s: PlanStep) => m[s.id];

  it("is the sum of each step's unit price × its count", () => {
    const total = planTotal(p.steps, env, prices({ s1: { status: "ready", unit: 12, free: false }, s2: { status: "ready", unit: 1.5, free: false } }));
    expect(total).toEqual({ status: "ready", total: 63, free: false });
    const edited = updateStep(p, "s1", { count: 2 });
    expect(planTotal(edited.steps, env, prices({ s1: { status: "ready", unit: 12, free: false }, s2: { status: "ready", unit: 1.5, free: false } }))).toMatchObject({ total: 27 });
  });

  it("an unpriceable step blocks the total with its reason — never counted as 0", () => {
    const total = planTotal(p.steps, env, prices({ s1: { status: "ready", unit: 12, free: false }, s2: { status: "error", message: "no price" } }));
    expect(total).toEqual({ status: "blocked", stepIndex: 1, reason: { message: "no price" } });
  });

  it("a blocked step blocks the total before any price is asked", () => {
    expect(planTotal(p.steps, { ...env, canRun: false }, () => undefined)).toEqual({ status: "blocked", stepIndex: 0, reason: { blocker: "no_access" } });
  });

  it("waits while a price is being asked; empty with no steps", () => {
    expect(planTotal(p.steps, env, prices({ s1: { status: "quoting" } }))).toEqual({ status: "pending" });
    expect(planTotal([], env, () => undefined)).toEqual({ status: "empty" });
  });

  it("an exempt organization's runs are no charge", () => {
    const v = plan("2 videos about tea");
    expect(planTotal(v.steps, env, () => ({ status: "ready", unit: 0, free: true }))).toEqual({ status: "ready", total: 0, free: true });
  });
});

describe("keys and bodies", () => {
  const p = plan("3 shorts about tea and 2 images about tea");

  it("one distinct key per item, valid for the creative route, stable for the plan", () => {
    const keys = planItems(p).map((i) => i.key);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    for (const k of keys) expect(k).toMatch(IDEMPOTENCY_KEY_RE);
    expect(planItems(plan("3 shorts about tea and 2 images about tea")).map((i) => i.key)).toEqual(keys);
    expect(itemKey("x", "s1", 0)).not.toBe(itemKey("y", "s1", 0));
  });

  it("a creative item carries its key and the confirmed price as the ceiling", () => {
    const img = p.steps[1];
    const req = stepRequest(img, env)!;
    expect(itemBody(req, "assistant:k", 2, false, ORG)).toEqual({
      org_id: ORG,
      capability: "t2i",
      model: "img-a",
      params: expect.objectContaining({ aspect_ratio: "16:9" }),
      idempotency_key: "assistant:k",
      max_credits: 2,
    });
  });

  it("a run item carries its key and the confirmed price; no price to cap when there is no charge", () => {
    const req = stepRequest(p.steps[0], env)!;
    expect(itemBody(req, "assistant:r", 12, false, ORG)).toEqual({
      channel_id: "UC_space",
      duration: 60,
      language: "English",
      niche: "tea",
      idempotency_key: "assistant:r",
      max_credits: 12,
    });
    expect(itemBody(req, "assistant:r", 0, true, ORG)).not.toHaveProperty("max_credits");
  });

  it("steps that ask the same thing share one price question", () => {
    const a = stepRequest(plan("2 images about tea").steps[0], env)!;
    const b = stepRequest(plan("5 images about tea").steps[0], env)!;
    expect(priceKey(a)).toBe(priceKey(b));
  });
});
