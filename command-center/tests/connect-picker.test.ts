import { describe, expect, it } from "vitest";
import {
  CONNECT_WORDS,
  candidateAction,
  coerceYoutubeChannels,
  connectBackPath,
  formatCount,
  parseConnectWord,
  pickedChannelSlug,
  safeImageUrl,
} from "../lib/connect-picker";
import { isValidChannelId } from "../lib/channels";
import { dictionaries } from "../lib/i18n";

const item = (over: Record<string, unknown> = {}) => ({
  id: "UC1234567890abcdefghijkl",
  snippet: { title: "Extinct World", customUrl: "@extinctworld", thumbnails: { default: { url: "https://yt3.ggpht.com/a.jpg" } } },
  statistics: { subscriberCount: "1200", videoCount: "48" },
  ...over,
});

describe("coerceYoutubeChannels", () => {
  it("keeps the public facts channels.list returned", () => {
    const [c] = coerceYoutubeChannels({ items: [item()] });
    expect(c).toEqual({
      id: "UC1234567890abcdefghijkl",
      title: "Extinct World",
      handle: "@extinctworld",
      thumbnail: "https://yt3.ggpht.com/a.jpg",
      subscribers: "1200",
      videos: "48",
    });
  });
  it("reads a hidden subscriber count as unknown, never as a number", () => {
    const [c] = coerceYoutubeChannels({
      items: [item({ statistics: { subscriberCount: "0", hiddenSubscriberCount: true, videoCount: "3" } })],
    });
    expect(c.subscribers).toBeNull();
    expect(c.videos).toBe("3");
  });
  it("drops an item with a malformed id, a duplicate, and anything that is not an object", () => {
    const out = coerceYoutubeChannels({ items: [item({ id: "bad id!" }), item(), item(), null, "x", item({ id: 7 })] });
    expect(out.map((c) => c.id)).toEqual(["UC1234567890abcdefghijkl"]);
  });
  it("refuses a picture that is not https and caps the list", () => {
    const [c] = coerceYoutubeChannels({
      items: [item({ snippet: { title: "T", thumbnails: { default: { url: "http://x.test/a.jpg" } } } })],
    });
    expect(c.thumbnail).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    const many = Array.from({ length: 80 }, (_, i) => item({ id: `UC${String(i).padStart(22, "0")}` }));
    expect(coerceYoutubeChannels({ items: many })).toHaveLength(50);
  });
  it("answers an empty list for a body without items", () => {
    expect(coerceYoutubeChannels({})).toEqual([]);
    expect(coerceYoutubeChannels(null)).toEqual([]);
    expect(coerceYoutubeChannels({ items: "x" })).toEqual([]);
  });
});

describe("pickedChannelSlug", () => {
  const base = { id: "UC1234567890abcdefghijkl", title: "Extinct World", handle: "@extinctworld" };
  it("prefers the handle, then the title, then the YouTube id, and always passes the id rule", () => {
    expect(pickedChannelSlug(base)).toBe("extinctworld");
    expect(pickedChannelSlug({ ...base, handle: null })).toBe("extinct-world");
    const cyrillic = pickedChannelSlug({ ...base, handle: null, title: "Мир динозавров" });
    expect(cyrillic).toBe("channel-uc1234567890");
    for (const s of [pickedChannelSlug(base), cyrillic, pickedChannelSlug(base, 3)]) expect(isValidChannelId(s ?? "")).toBe(true);
  });
  it("adds a suffix for a taken id and never names a reserved word", () => {
    expect(pickedChannelSlug(base, 2)).toBe("extinctworld-2");
    expect(pickedChannelSlug({ ...base, handle: "@atelier" })).not.toBe("atelier");
    expect(pickedChannelSlug({ ...base, handle: "@a" })).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it("keeps a long handle inside the database's 39 characters, suffix included", () => {
    const long = { ...base, handle: `@${"x".repeat(80)}` };
    expect(pickedChannelSlug(long)?.length).toBeLessThanOrEqual(39);
    expect(pickedChannelSlug(long, 5)?.length).toBeLessThanOrEqual(39);
    expect(pickedChannelSlug(long, 5)).toMatch(/-5$/);
  });
});

describe("words, paths and counts", () => {
  it("echoes only a known word", () => {
    expect(parseConnectWord("denied")).toBe("denied");
    expect(parseConnectWord("<script>")).toBeNull();
    expect(parseConnectWord(undefined)).toBeNull();
  });
  it("sends a failed connect to one fixed same-origin path", () => {
    expect(connectBackPath("youtube", "denied")).toBe("/all-channels/channels/new?connect=denied&platform=youtube");
  });
  it("prints an unknown count as unknown, a known one with grouping", () => {
    expect(formatCount(null, "en")).toBeNull();
    expect(formatCount("1234567", "en")).toBe("1,234,567");
    expect(formatCount("abc", "en")).toBeNull();
  });
  it("offers 'connected' for a channel already linked, 'pick' otherwise", () => {
    expect(candidateAction({ linkedTo: null })).toBe("pick");
    expect(candidateAction({ linkedTo: { channelId: "x", name: "X" } })).toBe("connected");
  });
});

describe("copy is complete in every language and uses no brand or role words", () => {
  const langs = Object.entries(dictionaries).map(([code, d]) => [code, d.connectPicker] as const);
  const flat = (o: unknown, p = ""): [string, string][] =>
    typeof o === "string" ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k));
  it("has the same keys and a result line for every word the flow can come back with", () => {
    const en = flat(dictionaries.en.connectPicker).map(([k]) => k).sort();
    for (const [code, d] of langs) expect(flat(d).map(([k]) => k).sort(), code).toEqual(en);
    for (const [code, d] of langs) for (const w of CONNECT_WORDS) expect(d.results[w], `${code}.${w}`).toBeTruthy();
  });
  it("keeps the same placeholders in every language", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    const en = new Map(flat(dictionaries.en.connectPicker));
    for (const [code, d] of langs) for (const [k, v] of flat(d)) expect(ph(v), `${code}.${k}`).toBe(ph(en.get(k) ?? ""));
  });
  it("names no provider, store or role", () => {
    for (const [code, d] of langs)
      for (const [k, v] of flat(d)) expect(v, `${code}.${k}`).not.toMatch(/supabase|vault|github|gemini|eleven|paddle|\bowner\b|\beditor\b|\bviewer\b|\badmin/i);
  });
});
