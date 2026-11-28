import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { callChatModel, fakeVendorSeam } from "@/lib/server/brain/llm";
import { chosenModelState } from "@/lib/server/brain/session";

/**
 * The lab's fake-vendor seam (docs/studio/LIVE_CREATION_PLAN.md §3.11). What would break without these: a production server with a
 * stray NIGHTSHIFT_AI_FAKE_BASE_URL sending a person's plan (and the chat's key) to that address, or quietly ignoring it so a lab run
 * "works" against the real vendor and spends; a turn reserved (and charged) before that misconfiguration is said.
 */

const KEY = "sk-test-secret-value-1234567890";
const ok = () => vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: {} }), { status: 200 })) as unknown as typeof fetch;
const urlOf = (f: typeof fetch) => (f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];

afterEach(() => {
  delete process.env.NIGHTSHIFT_AI_LAB;
  delete process.env.NIGHTSHIFT_AI_FAKE_BASE_URL;
});

describe("the fake-vendor seam", () => {
  it("is honoured only on the lab server, and only as a plain http(s) base", () => {
    expect(fakeVendorSeam({})).toEqual({ state: "off" });
    expect(fakeVendorSeam({ NIGHTSHIFT_AI_LAB: "1" })).toEqual({ state: "off" });
    expect(fakeVendorSeam({ NIGHTSHIFT_AI_FAKE_BASE_URL: "http://127.0.0.1:9911" })).toEqual({ state: "refused" });
    expect(fakeVendorSeam({ NIGHTSHIFT_AI_FAKE_BASE_URL: "http://127.0.0.1:9911", NIGHTSHIFT_AI_LAB: "true" })).toEqual({ state: "refused" });
    expect(fakeVendorSeam({ NIGHTSHIFT_AI_FAKE_BASE_URL: "http://127.0.0.1:9911/fake/", NIGHTSHIFT_AI_LAB: "1" })).toEqual({ state: "lab", base: "http://127.0.0.1:9911/fake" });
    for (const bad of ["not a url", "file:///etc/passwd", "http://u:p@fake.test", "http://fake.test/?k=1"]) {
      expect(fakeVendorSeam({ NIGHTSHIFT_AI_FAKE_BASE_URL: bad, NIGHTSHIFT_AI_LAB: "1" })).toEqual({ state: "refused" });
    }
  });

  it("in the lab, each vendor's call goes to the fake at {base}/{provider}{path}", async () => {
    process.env.NIGHTSHIFT_AI_LAB = "1";
    process.env.NIGHTSHIFT_AI_FAKE_BASE_URL = "http://127.0.0.1:9911";
    const a = ok();
    await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: a, keys: { anthropic: KEY } });
    expect(urlOf(a)).toBe("http://127.0.0.1:9911/anthropic/v1/messages");
    const o = ok();
    await callChatModel("openai-gpt-6-luna", "s", "u", { fetchImpl: o, keys: { openai: KEY } });
    expect(urlOf(o)).toBe("http://127.0.0.1:9911/openai/v1/responses");
    const g = ok();
    await callChatModel("gemini-3.6-flash", "s", "u", { fetchImpl: g, keys: { gemini: KEY } });
    expect(urlOf(g)).toBe("http://127.0.0.1:9911/google/v1beta/models/gemini-3.6-flash:generateContent");
  });

  it("in production (no lab flag) every call is refused by name and nothing is sent anywhere", async () => {
    process.env.NIGHTSHIFT_AI_FAKE_BASE_URL = "http://127.0.0.1:9911";
    const f = ok();
    const r = await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: f, keys: { anthropic: KEY } });
    expect(r).toEqual({ ok: false, error: "fake_vendor_unflagged", tokensIn: null, tokensOut: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("in production the owner's model reads as fake_vendor_unflagged, before any cap or vendor is asked", async () => {
    process.env.NIGHTSHIFT_AI_FAKE_BASE_URL = "http://127.0.0.1:9911";
    const rpc = vi.fn(async () => ({ data: [{ id: "anthropic-claude-sonnet-5-5" }], error: null }));
    expect(await chosenModelState({ rpc } as never, "anthropic-claude-sonnet-5-5")).toEqual({ ok: true, id: null, state: "fake_vendor_unflagged" });
    expect(rpc).not.toHaveBeenCalled();
    delete process.env.NIGHTSHIFT_AI_FAKE_BASE_URL;
    const s = await chosenModelState({ rpc } as never, "anthropic-claude-sonnet-5-5");
    expect(s).toMatchObject({ ok: true, id: "anthropic-claude-sonnet-5-5" });
  });

  it("without the seam the real vendor URL is used, unchanged", async () => {
    const f = ok();
    await callChatModel("anthropic-claude-sonnet-5-5", "s", "u", { fetchImpl: f, keys: { anthropic: KEY } });
    expect(urlOf(f)).toBe("https://api.anthropic.com/v1/messages");
  });
});
