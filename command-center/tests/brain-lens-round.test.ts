import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { modelText, unsafeText } from "@/lib/brain/logic";
import { modelFromRef } from "@/lib/server/brain/session";
import { callChatModel, OUTPUT_TOKENS } from "@/lib/server/brain/llm";

describe("a price in the model's words never reads as Nightshift's (Lens 9 on 0198)", () => {
  it.each([
    "It costs 150 ta kredit",
    "only 50 ming soʻm",
    "only 50 ming so‘m",
    "just 300 кредитов",
    "около 5 тыс. руб",
    "fifty credits",
    "free credits for you",
    "kreditlar bepul",
    "кредиты бесплатно",
    "$5 a month",
    "20% off today",
  ])("%s", (s) => {
    const out = modelText(s, 200);
    expect(out).toContain("…");
    expect(out).not.toMatch(/кредитов|ов\b|so.?m|руб|credits|free of charge|bepul|бесплатно|\$5|20%/i);
  });

  it("plain video words are untouched", () => {
    for (const s of ["A free-diving documentary", "Ten facts about owls", "Uchta sahna", "Пять лучших мест", "Living for free in Tokyo",
                     "Living on credit", "2024 credits roll", "5 сумок и сумерки", "3 рубашки", "bepul darslar"]) expect(modelText(s, 200)).toBe(s);
  });
});

describe("the safety floor under the prompt (B3 on 0198)", () => {
  it.each(["a naked woman", "голая модель", "yalangʻoch", "a celebrity cameo", "deepfake of a singer", "gory beheading", "Spider-Man swings", "porno"])(
    "refuses %s", (s) => expect(unsafeText(s)).toBe(true));
  it.each(["Sussex countryside", "a sextant on a ship", "owls at night", "a nervous intern", "Essex", "the celebration",
            "Лучшие голы Месси", "Al Gore", "jinsiy tenglik", "обнажённый меч", "a snake dance", "Claude Monet's garden", "Gemini season"])(
    "lets %s through", (s) => expect(unsafeText(s)).toBe(false));
});

describe("the owner's model reaches the server only as a reference (Lens 4 on 0198)", () => {
  const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");
  it("maps a known reference back, and anything else to no model (never another one)", () => {
    expect(modelFromRef(ref("anthropic-claude-sonnet-5-5"))).toBe("anthropic-claude-sonnet-5-5");
    expect(modelFromRef(ref("openai-gpt-6-luna"))).toBe("openai-gpt-6-luna");
    expect(modelFromRef(ref("someone-else"))).toBeNull();
    expect(modelFromRef("anthropic-claude-sonnet-5-5")).toBeNull();
    expect(modelFromRef(null)).toBeNull();
  });
});

describe("an answer cut off at the limit is its own failure (B2 on 0198)", () => {
  const keys = { anthropic: "k", openai: "k" };
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  it("Anthropic max_tokens and OpenAI max_output_tokens are output_too_long, not vendor_error", async () => {
    expect(await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { keys, fetchImpl: reply({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }) }))
      .toMatchObject({ ok: false, error: "output_too_long" });
    expect(await callChatModel("openai-gpt-6-luna", "s", "u", { keys, fetchImpl: reply({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) }))
      .toMatchObject({ ok: false, error: "output_too_long" });
  });
  it("a proposal asks for room for whole scenarios", async () => {
    let sent: Record<string, unknown> = {};
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] })); }) as unknown as typeof fetch;
    await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { keys, fetchImpl: f, size: "proposal" });
    expect(sent.max_tokens).toBe(OUTPUT_TOKENS.proposal);
    expect(OUTPUT_TOKENS.proposal).toBeGreaterThanOrEqual(8000);
  });
});
