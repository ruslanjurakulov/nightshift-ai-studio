import { describe, expect, it, vi } from "vitest";

/**
 * The customer chat's Gemini Flash call (owner, 2026-11-22). What would break: the key leaving its header (a query string is what
 * logs keep); a safety block or an empty candidate read as an answer, or as "the vendor is down"; a missing Gemini key quietly
 * answered by Claude (rule 4); a bad key and an empty allowance given the same remedy (rule 6).
 */

vi.mock("server-only", () => ({}));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callChatModel, chatModelConfigured, CHAT_MODELS, GEMINI_THINKING_LEVEL, OWNER_CHAT_MODEL } from "@/lib/server/brain/llm";

const KEY = "AIza-test-secret-value-1234567890";
const GEMINI = "gemini-3.6-flash" as const;
type Call = [string, RequestInit];
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const callsOf = (f: typeof fetch) => (f as unknown as { mock: { calls: Call[] } }).mock.calls;
const ok = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 60 },
  ...extra,
});

describe("Gemini Flash in the chat's model table", () => {
  it("is the registry's own row, on Google, and the owner's chat is not on it", () => {
    expect(CHAT_MODELS[GEMINI]).toEqual({ provider: "google", vendorModel: "gemini-3.6-flash" });
    expect(OWNER_CHAT_MODEL).toBe("anthropic-claude-sonnet-5-5");
  });

  it("the owner's chat stays on the model production runs today (0199's default), so a deploy does not move it to another vendor", () => {
    // ai_chat_settings.model in production is 0199's default; were the owner chat pinned to anything else, the deploy that moved the
    // customer chat to Gemini would also, silently, change the owner's vendor and its meter.
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0199_studio_ai_chat.sql"), "utf8");
    const dflt = /model\s+text not null default '([^']+)'/.exec(sql)?.[1];
    expect(dflt).toBe("anthropic-claude-sonnet-5-5");
    expect(OWNER_CHAT_MODEL).toBe(dflt);
    expect(CHAT_MODELS[OWNER_CHAT_MODEL].provider).toBe("anthropic");
  });

  it("is configured only by its own key: the Anthropic and OpenAI keys do not count", () => {
    expect(chatModelConfigured(GEMINI, { anthropic: KEY, openai: KEY })).toBe(false);
    expect(chatModelConfigured(GEMINI, { gemini: "   " })).toBe(false);
    expect(chatModelConfigured(GEMINI, { gemini: KEY })).toBe(true);
  });
});

describe("the Gemini request", () => {
  it("is the worker's verified generateContent shape, with the key only in x-goog-api-key", async () => {
    const f = reply(200, ok([{ text: '{"reply":"hi"}' }]));
    const r = await callChatModel(GEMINI, "SYS", "DATA", { fetchImpl: f, keys: { gemini: KEY }, endUser: "org-hash", size: "proposal" });
    expect(r).toMatchObject({ ok: true, text: '{"reply":"hi"}' });
    expect(callsOf(f)).toHaveLength(1);
    const [url, init] = callsOf(f)[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    expect(url).not.toContain(KEY);
    expect(url).not.toContain("key=");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [{ role: "user", parts: [{ text: "DATA" }] }],
      generationConfig: { maxOutputTokens: 8_000, thinkingConfig: { thinkingLevel: "LOW" } },
    });
    // No invented end-user field: the person's workspace hash is not sent to Google under a guessed name.
    expect(String(init.body)).not.toContain("org-hash");
    expect(String(init.body)).not.toContain(KEY);
  });

  it("pins thinking to LOW on every size, so thinking (Google's default is medium, and it counts against the ceiling) cannot eat the 8k", async () => {
    expect(GEMINI_THINKING_LEVEL).toBe("LOW");
    for (const opts of [{ size: "card" as const }, { size: "proposal" as const }, { maxOutputTokens: 300 }]) {
      const f = reply(200, ok([{ text: "{}" }]));
      await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY }, ...opts });
      const cfg = JSON.parse(String(callsOf(f)[0][1].body)).generationConfig;
      expect(cfg.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
      // A level, never also a budget: the two are different controls, and sending both is not what the docs describe for 3.x.
      expect(cfg.thinkingConfig).not.toHaveProperty("thinkingBudget");
      // Thoughts are not asked for back: they are never shown, only metered (thoughtsTokenCount).
      expect(cfg.thinkingConfig).not.toHaveProperty("includeThoughts");
    }
  });

  it("the other vendors' requests carry no Gemini thinking field", async () => {
    const f = reply(200, { content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: f, keys: { anthropic: KEY } });
    expect(String(callsOf(f)[0][1].body)).not.toContain("thinking");
  });

  it("without the Gemini key nothing is called, and no other vendor answers instead", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const r = await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { anthropic: KEY, openai: KEY } });
    expect(r).toEqual({ ok: false, error: "not_configured", tokensIn: null, tokensOut: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("a Gemini failure is that model's failure: one call, to Google, never retried on Claude or GPT", async () => {
    const f = reply(503, { error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded." } });
    const r = await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY, anthropic: KEY, openai: KEY } });
    expect(r).toMatchObject({ ok: false, error: "vendor_error" });
    expect(callsOf(f).map(([u]) => new URL(u).hostname)).toEqual(["generativelanguage.googleapis.com"]);
  });
});

describe("the Gemini answer", () => {
  it("is the candidate's text without its thought parts; tokens in, and answer plus thoughts out", async () => {
    const f = reply(200, ok([{ text: "planning…", thought: true }, { text: '{"reply":' }, { text: '"hi"}' }]));
    expect(await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY } }))
      .toEqual({ ok: true, text: '{"reply":"hi"}', tokensIn: 40, tokensOut: 20 });
  });

  it("tokens Google did not report stay unknown, never 0", async () => {
    const f = reply(200, { candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
    expect(await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY } }))
      .toEqual({ ok: true, text: "{}", tokensIn: null, tokensOut: null });
  });

  it("a blocked prompt is the vendor's refusal, not text and not an outage", async () => {
    const f = reply(200, { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 9 } });
    expect(await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY } }))
      .toEqual({ ok: false, error: "vendor_refused", tokensIn: 9, tokensOut: null });
  });

  it.each(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"])("a candidate stopped for %s is a refusal, even with text", async (reason) => {
    const f = reply(200, { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: reason }] });
    expect(await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY } })).toMatchObject({ ok: false, error: "vendor_refused" });
  });

  it("an answer cut at the token limit is output_too_long, never half a JSON shown", async () => {
    const f = reply(200, { candidates: [{ content: { parts: [{ text: '{"reply":"hal' }] }, finishReason: "MAX_TOKENS" }] });
    expect(await callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY } })).toMatchObject({ ok: false, error: "output_too_long" });
  });

  it.each([
    ["no candidates", {}],
    ["an empty candidate", { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }],
    ["only thoughts", { candidates: [{ content: { parts: [{ text: "hmm", thought: true }] }, finishReason: "STOP" }] }],
    ["blank text", { candidates: [{ content: { parts: [{ text: "  \n" }] }, finishReason: "STOP" }] }],
    ["not JSON", "<html>oops</html>"],
  ])("%s is an honest failure, never an empty reply", async (_n, body) => {
    expect(await callChatModel(GEMINI, "s", "u", { fetchImpl: reply(200, body), keys: { gemini: KEY } })).toMatchObject({ ok: false, error: "vendor_error" });
  });
});

describe("Gemini's errors, by their remedy", () => {
  const err = (status: number, name: string, message: string, details: unknown[] = []) =>
    reply(status, { error: { code: status, status: name, message, details } });
  const ask = (f: typeof fetch) => callChatModel(GEMINI, "s", "u", { fetchImpl: f, keys: { gemini: KEY } });

  it("a wrong key (Google's 400 'API key not valid') is vendor_auth, not a bad request", async () => {
    expect(await ask(err(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."))).toMatchObject({ error: "vendor_auth" });
    expect(await ask(err(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers."))).toMatchObject({ error: "vendor_auth" });
  });

  it("a per-day quota is an empty allowance; a per-minute one is a busy vendor", async () => {
    const perDay = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }];
    const perMinute = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }];
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", perDay))).toMatchObject({ error: "vendor_quota" });
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", perMinute))).toMatchObject({ error: "vendor_rate_limited" });
  });

  it("billing on the account is vendor_quota", async () => {
    expect(await ask(err(400, "FAILED_PRECONDITION", "Gemini API free tier is not available; enable billing."))).toMatchObject({ error: "vendor_quota" });
  });

  it("'User location is not supported' is the server's region (vendor_region), not a key a replacement would fix", async () => {
    expect(await ask(err(400, "FAILED_PRECONDITION", "User location is not supported for the API use."))).toMatchObject({ error: "vendor_region" });
  });

  it("a model Google does not know (404 NOT_FOUND) is model_not_found, not an outage to wait out", async () => {
    const f = err(404, "NOT_FOUND", "models/gemini-3.6-flash is not found for API version v1beta, or is not supported for generateContent.");
    expect(await ask(f)).toMatchObject({ ok: false, error: "model_not_found" });
    expect(callsOf(f)).toHaveLength(1);
    // A key Google cannot find is still the key's remedy, even when it comes back as a 404's words.
    expect(await ask(err(400, "INVALID_ARGUMENT", "API key not found. Please pass a valid API key."))).toMatchObject({ error: "vendor_auth" });
  });

  it("a 429 with an allowance of zero, or billing off or used up, is the billing remedy; Google's ordinary 429 is still a busy vendor", async () => {
    const perMinute = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }];
    const generic = "You exceeded your current quota, please check your plan and billing details.";
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", `${generic} Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.6-flash`, perMinute)))
      .toMatchObject({ error: "vendor_quota" });
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", "Billing is not enabled for this project."))).toMatchObject({ error: "vendor_quota" });
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", "Your prepayment credits are depleted."))).toMatchObject({ error: "vendor_quota" });
    // The bare words "billing details" ride on every per-minute 429: reading them as an empty account would send the owner to top up
    // for a limit that clears in a minute. "limit: 10" is a ceiling, not zero.
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", generic, perMinute))).toMatchObject({ error: "vendor_rate_limited" });
    expect(await ask(err(429, "RESOURCE_EXHAUSTED", `${generic} limit: 10, model: gemini-3.6-flash`, perMinute))).toMatchObject({ error: "vendor_rate_limited" });
  });

  it("an error never carries the key", async () => {
    const r = await ask(reply(500, `echo ${KEY}`));
    expect(r).toMatchObject({ ok: false, error: "vendor_error" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
