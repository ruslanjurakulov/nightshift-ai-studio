import { describe, expect, it, vi } from "vitest";

/**
 * The customer chat's Gemini Flash call (owner, 2026-11-22). What would break: the key leaving its header (a query string is what
 * logs keep); a safety block or an empty candidate read as an answer, or as "the vendor is down"; a missing Gemini key quietly
 * answered by Claude (rule 4); a bad key and an empty allowance given the same remedy (rule 6).
 */

vi.mock("server-only", () => ({}));
import { callChatModel, chatModelConfigured, CHAT_MODELS, OWNER_CHAT_MODEL } from "@/lib/server/brain/llm";

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
      generationConfig: { maxOutputTokens: 8_000 },
    });
    // No invented end-user field: the person's workspace hash is not sent to Google under a guessed name.
    expect(String(init.body)).not.toContain("org-hash");
    expect(String(init.body)).not.toContain(KEY);
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

  it("billing on the account is vendor_quota; the server's region is the key's remedy", async () => {
    expect(await ask(err(400, "FAILED_PRECONDITION", "Gemini API free tier is not available; enable billing."))).toMatchObject({ error: "vendor_quota" });
    expect(await ask(err(400, "FAILED_PRECONDITION", "User location is not supported for the API use."))).toMatchObject({ error: "vendor_auth" });
  });

  it("an error never carries the key", async () => {
    const r = await ask(reply(500, `echo ${KEY}`));
    expect(r).toMatchObject({ ok: false, error: "vendor_error" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
