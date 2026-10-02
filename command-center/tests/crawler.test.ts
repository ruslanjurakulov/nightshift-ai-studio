import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { gateDecision, isPublicPath } from "@/lib/public-paths";

afterEach(() => vi.unstubAllEnvs());

describe("robots.txt and sitemap.xml", () => {
  it("are public to a signed-out crawler, exactly", () => {
    for (const p of ["/robots.txt", "/sitemap.xml"]) {
      expect(isPublicPath(p)).toBe(true);
      expect(gateDecision(p, false)).toBe("pass");
    }
    for (const p of ["/robots.txt/x", "/sitemap.xml.bak", "/sitemaps.xml"]) expect(gateDecision(p, false)).not.toBe("pass");
  });

  it("list only the public pages, on the site's own origin", () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const urls = sitemap().map((e) => e.url);
    expect(urls[0]).toBe("https://nightshift.example/");
    for (const u of urls) {
      const path = new URL(u).pathname;
      expect(u.startsWith("https://nightshift.example/")).toBe(true);
      expect(isPublicPath(path)).toBe(true);
      expect(path).not.toMatch(/^\/(login|signup|auth|welcome|api)/);
    }
    expect(urls).toContain("https://nightshift.example/solutions/youtube-channels");
    expect(robots().sitemap).toBe("https://nightshift.example/sitemap.xml");
  });

  it("with no known origin list nothing rather than localhost addresses", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(sitemap()).toEqual([]);
    const r = robots();
    expect(r).not.toHaveProperty("sitemap");
    expect(JSON.stringify(r)).not.toMatch(/localhost/);
  });
});
