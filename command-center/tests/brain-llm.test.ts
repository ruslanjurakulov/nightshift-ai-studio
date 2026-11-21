import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { callChatModel, chatModelConfigured } from "@/lib/server/brain/llm";

const KEY = "sk-test-secret-value-1234567890";
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("Nightshift AI's vendor calls", () => {
  it("without a key nothing is called and the answer says not_configured (no fallback to the other model)", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const r = await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: f, keys: {} });
    expect(r).toMatchObject({ ok: false, error: "not_configured" });
    expect(f).not.toHaveBeenCalled();
    expect(chatModelConfigured("openai-gpt-6-luna", { openai: "  " })).toBe(false);
  });

  it("Anthropic: the verified Messages shape, the key only in its header, tokens read from usage", async () => {
    const f = reply(200, { content: [{ type: "text", text: '{"reply":"hi"}' }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 7 } });
    const r = await callChatModel("anthropic-claude-sonnet-5-5", "SYS", "DATA", { fetchImpl: f, keys: { anthropic: KEY }, endUser: "u-1" });
    expect(r).toEqual({ ok: true, text: '{"reply":"hi"}', tokensIn: 12, tokensOut: 7 });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(init.redirect).toBe("error");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", system: "SYS", messages: [{ role: "user", content: "DATA" }], metadata: { user_id: "u-1" } });
    expect(String(init.body)).not.toContain(KEY);
  });

  it("OpenAI: the Responses API, store:false, Bearer header", async () => {
    const f = reply(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 3, output_tokens: 4 } });
    const r = await callChatModel("openai-gpt-6-luna", "SYS", "DATA", { fetchImpl: f, keys: { openai: KEY } });
    expect(r).toMatchObject({ ok: true, tokensIn: 3, tokensOut: 4 });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-6-luna", instructions: "SYS", store: false });
  });

  it("names the remedy: a bad key, an empty balance and a busy vendor are three different answers", async () => {
    const keys = { anthropic: KEY, openai: KEY };
    expect(await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: reply(401, "{}"), keys })).toMatchObject({ error: "vendor_auth" });
    expect(await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: reply(400, '{"error":{"type":"billing_error"}}'), keys })).toMatchObject({ error: "vendor_quota" });
    expect(await callChatModel("openai-gpt-6-luna", "s", "u", { fetchImpl: reply(429, '{"error":{"code":"insufficient_quota"}}'), keys })).toMatchObject({ error: "vendor_quota" });
    expect(await callChatModel("openai-gpt-6-luna", "s", "u", { fetchImpl: reply(429, '{"error":{"code":"rate_limit"}}'), keys })).toMatchObject({ error: "vendor_rate_limited" });
  });

  it("a refusal, a cut-off answer or garbage is a failure, never text to show", async () => {
    const keys = { anthropic: KEY, openai: KEY };
    expect(await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: reply(200, { stop_reason: "refusal", content: [] }), keys })).toMatchObject({ error: "vendor_refused" });
    expect(await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: reply(200, { stop_reason: "max_tokens", content: [{ type: "text", text: "half" }] }), keys })).toMatchObject({ ok: false });
    expect(await callChatModel("openai-gpt-6-luna", "s", "u", { fetchImpl: reply(200, { status: "incomplete", incomplete_details: { reason: "content_filter" } }), keys })).toMatchObject({ error: "vendor_refused" });
    expect(await callChatModel("openai-gpt-6-luna", "s", "u", { fetchImpl: reply(200, "not json"), keys })).toMatchObject({ error: "vendor_error" });
  });

  it("an error never carries the key", async () => {
    const r = await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: reply(500, `echo ${KEY}`), keys: { anthropic: KEY } });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
