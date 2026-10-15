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
  it("is a 1200 x 630 PNG under 150 KB, drawn the same way every time", async () => {
    const { GET } = await import("@/app/og.png/route");
    const a = Buffer.from(await (await GET()).arrayBuffer());
    const res = await GET();
    const b = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(a.subarray(1, 4).toString()).toBe("PNG");
    expect([a.readUInt32BE(16), a.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(a.length).toBeLessThan(150 * 1024);
    expect(b.equals(a)).toBe(true);
  }, 30000);
});
