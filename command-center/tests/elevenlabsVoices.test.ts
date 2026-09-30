import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEVENLABS_VOICES_URL, MAX_PAGES, listAllVoices } from "../lib/elevenlabsVoices";

const KEY = "xi-test-key-do-not-leak";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function voice(id: string, name = id) {
  return { voice_id: id, name, category: "premade", preview_url: `https://cdn.test/${id}.mp3`, labels: { accent: "british" } };
}

describe("ElevenLabs voice list (v2, paginated)", () => {
  it("uses GET /v2/voices, not the v1 list that breaks past 500 voices", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return jsonResponse({ voices: [voice("a")], has_more: false, next_page_token: null });
    }) as unknown as typeof fetch;
    const res = await listAllVoices(KEY, fetchImpl);
    expect(res.ok).toBe(true);
    expect(calls[0].startsWith(ELEVENLABS_VOICES_URL)).toBe(true);
    expect(calls[0]).toContain("page_size=100");
    expect(calls[0]).not.toContain("/v1/voices");
    const route = readFileSync(join(__dirname, "..", "app/api/setup/voices/route.ts"), "utf8");
    expect(route).not.toContain("/v1/voices");
  });

  it("follows next_page_token until the last page", async () => {
    const pages = [
      { voices: [voice("a"), voice("b")], has_more: true, next_page_token: "t1" },
      { voices: [voice("c")], has_more: true, next_page_token: "t2" },
      { voices: [voice("d")], has_more: false, next_page_token: null },
    ];
    const tokens: (string | null)[] = [];
    const fetchImpl = (async (url: string) => {
      tokens.push(new URL(url).searchParams.get("next_page_token"));
      return jsonResponse(pages.shift());
    }) as unknown as typeof fetch;
    const res = await listAllVoices(KEY, fetchImpl);
    expect(tokens).toEqual([null, "t1", "t2"]);
    expect(res).toMatchObject({ ok: true, truncated: false });
    if (res.ok) expect(res.voices.map((v) => v.voiceId)).toEqual(["a", "b", "c", "d"]);
  });

  it("stops at the page cap and says the list is truncated", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return jsonResponse({ voices: [voice(`v${n}`)], has_more: true, next_page_token: `t${n}` });
    }) as unknown as typeof fetch;
    const res = await listAllVoices(KEY, fetchImpl);
    expect(n).toBe(MAX_PAGES);
    expect(res).toMatchObject({ ok: true, truncated: true });
  });

  it("does not loop on a token that repeats", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return jsonResponse({ voices: [voice("same")], has_more: true, next_page_token: "stuck" });
    }) as unknown as typeof fetch;
    const res = await listAllVoices(KEY, fetchImpl);
    expect(n).toBe(2);
    if (res.ok) expect(res.voices).toHaveLength(1);
  });

  it("passes ElevenLabs' own 401 reason through, and never the key", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ detail: { status: "quota_exceeded" } }, 401)) as unknown as typeof fetch;
    const res = await listAllVoices(KEY, fetchImpl);
    expect(res).toEqual({ ok: false, error: "key_rejected", reason: "quota_exceeded" });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("maps an outage and a network error to distinct errors", async () => {
    const down = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    expect(await listAllVoices(KEY, down)).toEqual({ ok: false, error: "elevenlabs_unavailable" });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await listAllVoices(KEY, offline)).toEqual({ ok: false, error: "elevenlabs_unreachable" });
  });

  it("sends the key only as the xi-api-key header", async () => {
    let seen: RequestInit | undefined;
    let seenUrl = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = init;
      seenUrl = url;
      return jsonResponse({ voices: [], has_more: false });
    }) as unknown as typeof fetch;
    await listAllVoices(KEY, fetchImpl);
    expect((seen?.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    expect(seenUrl).not.toContain(KEY);
  });
});
