import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plan step's story grammar end to end inside writeStoryboard (fakes only: a scripted model, a database that meters turns). What
 * breaks if these fail: a voice-over that cannot be said in its seconds is priced; a storyboard whose chapters open on a close-up is
 * drafted; the third ask of the same window spends a turn the person was never told about.
 */
vi.mock("server-only", () => ({}));
const answers: string[] = [];
const llm = vi.fn();
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return { ...real, callChatModel: (...a: unknown[]) => { llm(...a); return Promise.resolve({ ok: true, text: answers.shift() ?? "{}", tokensIn: 1, tokensOut: 1 }); } };
});
const { writeStoryboard } = await import("@/lib/server/brain/plan");
const { readScenario } = await import("@/lib/brain/logic");
const { planLimits, planWindows } = await import("@/lib/brain/plan");
const { storyOutline, storyScene } = await import("./helpers/storyFixtures");

const rpc = vi.fn(async (fn: string) => {
  if (fn === "ai_chat_reserve_turn") return { data: { call_id: `c${rpc.mock.calls.length}`, used: rpc.mock.calls.length, limit: 30 }, error: null };
  return { data: null, error: null };
});
const slots = { kind: "short" as const, target_seconds: 40, aspect: "9:16" as const, style: "multfilm", language: "Uzbek" as const, audience: "oilalar" };
const outline = readScenario(storyOutline([10, 10, 10, 10]), slots, { outline: true })!;
const limits = planLimits(null, null, 40);
const windows = planWindows(outline, limits)!;
const answer = (o: (i: number, chapter: string) => Record<string, unknown> = () => ({})) => JSON.stringify({
  chapters: windows[0].parts.map((p) => ({ id: p.chapter_id, scenes: [5, 5].map((d, i) => storyScene(d, i, { ...(p.chapter_id === "ch1" && i === 0 ? { hook: true } : {}), ...o(i, p.chapter_id) })) })),
});
const run = (speechAllowed?: ("none" | "voice_over" | "in_clip")[]) => writeStoryboard({ supabase: { rpc } as never, sessionId: "s", model: "m" as never, endUser: "u",
                                    requestBase: "plxxxxxxxx", choiceStored: false, choiceText: "Far city", outline, slots, limits, speechAllowed });

beforeEach(() => { answers.length = 0; llm.mockReset(); rpc.mockClear(); });

describe("writeStoryboard with the story grammar", () => {
  it("is one window for 40 s, and a well-formed answer becomes scenes chained only inside their chapters", async () => {
    expect(windows).toHaveLength(1);
    answers.push(answer());
    const r = await run();
    expect(r.ok).toBe(true);
    const scenes = (r as { scenario: { scenes: { chain_from?: string | null; chapter_id?: string }[] } }).scenario.scenes;
    expect(scenes.map((s) => s.chain_from)).toEqual([null, "s1", null, "s3", null, "s5", null, "s7"]);
  });

  it("a voice-over too long for its seconds is asked again once, then refused as narration_too_long by chapter and scene", async () => {
    const long = { speech: "voice_over", narration: "Ota har kuni ertalab uzoq shaharga ketadi va qizi uni kutadi" };
    answers.push(answer(() => long), answer(() => long));
    // As for a film with a quotable voice (speechAllowed(true)): none has one today.
    const r = await run(["none", "voice_over"]);
    expect(r.ok).toBe(false);
    const res = (r as { res: Response }).res;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "narration_too_long", chapter: 1, scene: 1 });
    expect(llm).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String((llm.mock.calls[1] as unknown[])[2]).split("\n")[1]);
    expect(second.previous_answer_problem).toMatch(/narration takes about/);
  });

  it("a chapter opened by a close-up twice is plan_failed shot_rules; a fixed second answer is used", async () => {
    answers.push(answer(() => ({ shot: "close" })), answer(() => ({ shot: "close" })));
    const r = await run();
    expect(await (r as { res: Response }).res.json()).toMatchObject({ error: "plan_failed", reason: "shot_rules" });
    answers.push(answer(() => ({ shot: "close" })), answer());
    expect((await run()).ok).toBe(true);
  });

  it("a speaking answer where only a wordless film can be made is asked again once, then refused as speech_not_available", async () => {
    const talk = { speech: "in_clip", dialogue: [{ character_id: "c1", line: "Salom" }] };
    answers.push(answer(() => talk), answer(() => ({ speech: "voice_over", narration: "Ota ketdi" })));
    const r = await run();
    expect(await (r as { res: Response }).res.json()).toMatchObject({ error: "plan_failed", reason: "speech_not_available" });
    expect(llm).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((llm.mock.calls[0] as unknown[])[2]).split("\n")[1]);
    expect(first.speech_allowed).toEqual(["none"]);
    const second = JSON.parse(String((llm.mock.calls[1] as unknown[])[2]).split("\n")[1]);
    expect(second.previous_answer_problem).toMatch(/can only be planned with "speech" in \["none"\]/);
    // A second answer that keeps the intent and plans it wordless is used.
    answers.push(answer(() => talk), answer(() => ({ speech: "none", speech_intent: "in_clip" })));
    const ok = await run();
    expect(ok.ok).toBe(true);
    expect((ok as { scenario: { scenes: { speech_intent?: string }[] } }).scenario.scenes[0].speech_intent).toBe("in_clip");
  });

  it("a scene not spoken in its clip loses any line the model wrote (it would never be heard)", async () => {
    answers.push(answer(() => ({ speech: "none", dialogue: [{ character_id: "c1", line: "Salom" }] })));
    const r = await run();
    const scenes = (r as { scenario: { scenes: { dialogue: unknown[] }[] } }).scenario.scenes;
    expect(scenes.every((s) => s.dialogue.length === 0)).toBe(true);
  });
});
