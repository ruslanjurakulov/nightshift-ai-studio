import { describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/components/site/fonts", () => ({ preloadFonts: () => null }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const ROOT = join(__dirname, "..");
const { default: manifest } = await import("@/app/manifest");
const { config } = await import("@/middleware");
const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => { regexp: string }[];
};
const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
const runs = (path: string) => matchers.some((r) => r.test(path));

/** width and height from a PNG's IHDR */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("the web app manifest", () => {
  const m = manifest();

  it("has what an install needs: a name, a start URL, standalone display and a scope", () => {
    expect(m.name).toBe("Nightshift");
    expect(m.short_name).toBe("Nightshift");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect([m.lang, m.dir]).toEqual(["en", "ltr"]);
  });

  it("uses the page's own ground, the dark token the layout's theme-color already names", async () => {
    const { generateViewport } = await import("@/app/layout");
    const dark = (await generateViewport()).themeColor as { media: string; color: string }[];
    const ink = dark.find((t) => t.media.includes("dark"))!.color;
    expect(m.theme_color).toBe(ink);
    expect(m.background_color).toBe(ink);
  });

  it("lists 192 and 512 icons for any and for maskable, each a real PNG of exactly that size", () => {
    const icons = m.icons ?? [];
    for (const purpose of ["any", "maskable"] as const) {
      for (const size of [192, 512]) {
        const icon = icons.find((i) => i.purpose === purpose && i.sizes === `${size}x${size}`);
        expect(icon, `${purpose} ${size}`).toBeTruthy();
        expect(icon!.type).toBe("image/png");
        const file = join(ROOT, "public", icon!.src.replace(/^\//, ""));
        expect(existsSync(file), file).toBe(true);
        expect(pngSize(file)).toEqual([size, size]);
      }
    }
  });

  it("names no icon that is not served, and every icon is public (the sign-in gate never sees it)", () => {
    for (const i of m.icons ?? []) expect(runs(i.src), i.src).toBe(false);
    expect(runs("/manifest.webmanifest")).toBe(false);
  });

  it("makes the manifest and icons public by exact name only", () => {
    for (const p of ["/manifest.webmanifestx", "/manifest.webmanifest/x", "/a/manifest.webmanifest", "/pwa-192.pngx", "/pwa-192.png/x", "/pwa-maskable-512.png/providers", "/pwa-1024.png"]) {
      expect(runs(p), p).toBe(true);
    }
  });

  it("registers no service worker: nothing here may cache a signed-in person's private pages", () => {
    const files = readdirSync(join(ROOT, "public"));
    expect(files.some((f) => /^(sw|service-worker|serviceworker)/i.test(f))).toBe(false);
    for (const f of ["components/shell/InstallHint.tsx", "app/layout.tsx", "app/manifest.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(/serviceWorker\.register/);
    }
  });
});

describe("the root layout", () => {
  it("links the manifest and keeps the icons, title and description", async () => {
    const { metadata } = await import("@/app/layout");
    expect(metadata.manifest).toBe("/manifest.webmanifest");
    expect(metadata.title).toBe("Nightshift Command Center");
    expect(typeof metadata.description).toBe("string");
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: "Nightshift" });
    const icons = metadata.icons as { apple: { url: string }[] };
    expect(icons.apple[0].url).toBe("/apple-icon.png");
  });
});

describe("the social card", () => {
  // The owner-supplied picture, served as is. The limit is the smallest of the link-preview fetchers
  // (WhatsApp, Telegram, X) that we have a number for, with headroom.
  const LIMIT = 600 * 1024;
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("is a valid 1200 x 630 PNG under 600 KB served as image/png", async () => {
    const { GET } = await import("@/app/og.png/route");
    const res = await GET();
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(body.subarray(12, 16).toString()).toBe("IHDR");
    expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(body.length).toBeLessThan(LIMIT);
    expect(body.length).toBeGreaterThan(10 * 1024);
  });

  it("is the committed file brand/og/og-card.png, byte for byte", async () => {
    const { GET } = await import("@/app/og.png/route");
    const served = Buffer.from(await (await GET()).arrayBuffer());
    expect(served.equals(readFileSync(join(process.cwd(), "brand", "og", "og-card.png")))).toBe(true);
  });

  it("is not cached as immutable, so replacing the picture at the same URL reaches link previews", async () => {
    const { GET } = await import("@/app/og.png/route");
    const cc = (await GET()).headers.get("cache-control") ?? "";
    expect(cc).toMatch(/\bpublic\b/);
    expect(cc).not.toMatch(/immutable/);
    const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(24 * 3600);
  });
});
