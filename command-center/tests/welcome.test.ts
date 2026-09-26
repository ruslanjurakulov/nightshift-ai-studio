import { describe, expect, it } from "vitest";
import { WELCOME_LANGUAGE_MAX, newChannelHref, readChannelPrefill } from "@/lib/welcome";

describe("welcome → channel wizard pre-fill", () => {
  it("links to the wizard with only what was answered", () => {
    expect(newChannelHref("all-channels", {})).toBe("/all-channels/channels/new");
    expect(newChannelHref("all-channels", { niche: "  Ancient   history ", language: "" })).toBe(
      "/all-channels/channels/new?niche=Ancient+history",
    );
  });

  it("round-trips through the wizard's search params", () => {
    const href = newChannelHref("all-channels", { niche: "Space & stars", language: "Uzbek" });
    const params = Object.fromEntries(new URL(href, "https://x.test").searchParams);
    expect(readChannelPrefill(params)).toEqual({ niche: "Space & stars", language: "Uzbek" });
  });

  it("treats the URL as untrusted input: capped, first value only, blanks dropped", () => {
    const p = readChannelPrefill({ language: ["x".repeat(500), "second"], niche: "   " });
    expect(p.language).toHaveLength(WELCOME_LANGUAGE_MAX);
    expect(p.niche).toBeNull();
    expect(readChannelPrefill({})).toEqual({ niche: null, language: null });
  });
});
