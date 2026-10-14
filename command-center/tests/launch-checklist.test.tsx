import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * docs/LAUNCH_CHECKLIST.md made executable. The 20-point "before you take the
 * site live" list is OUR standard, and everything about it that a machine can
 * check is pinned here so it cannot silently regress: robots.txt, the sitemap
 * and what it lists, llms.txt, each public page's title / description /
 * canonical / share card / single h1, the custom 404, alt text on every image,
 * the icon and share-image files, internal links, the cookie disclosure, and the
 * absence of any third-party tracker. Items a machine cannot judge (page speed
 * on real hardware, a lawyer's reading of the policy, whether a speed figure is good enough) are listed as owner items in the document.
 *
 * Extends, does not repeat: tests/crawler.test.ts (the public gate of the three
 * crawler files), tests/public-404.test.ts (the 404 with no backend) and
 * tests/app-icons.test.ts (the icon links) keep their own checks.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push() {}, refresh() {}, back() {}, replace() {}, prefetch() {} }),
  redirect: () => {
    throw new Error("redirect");
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  headers: async () => new Headers(),
}));
const dict = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ locale: dict.locale, t: dictionaries[dict.locale] }), getLocale: async () => dict.locale };
});

import { dictionaries, LOCALES as LOCALE_REGISTRY, type Locale } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { LEGAL_TEXTS, type LegalBlock } from "@/lib/legal-docs";
import { DEV_PAGE_PATHS } from "@/lib/dev-pages";
import { SITEMAP_PATHS, SOLUTION_PATHS, gateDecision, isPublicFontPath } from "@/lib/public-paths";
import { llmsEntries, llmsTxt, OPENAPI_PATH } from "@/lib/llms";
import { PROVIDER_BRANDS } from "./helpers/brands";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { GET as llmsGET } from "@/app/llms.txt/route";

const ROOT = join(__dirname, "..");
// From the one registry, so a language added later is tested with no edit here.
const LOCALES: Locale[] = LOCALE_REGISTRY.map((l) => l.code);
const ORIGIN = "https://nightshift.example";

afterEach(() => {
  vi.unstubAllEnvs();
  dict.locale = "en";
});

/** Every public page: its path, the module that renders it and the props that module needs. */
type PageSpec = { path: string; module: string; props: Record<string, unknown>; indexed: boolean };
const slug = (s: string) => ({ params: Promise.resolve({ slug: s }) });
const PAGES: PageSpec[] = [
  { path: "/", module: "@/app/page", props: {}, indexed: true },
  { path: "/studio", module: "@/app/studio/page", props: {}, indexed: true },
  { path: "/pricing", module: "@/app/pricing/page", props: {}, indexed: true },
  { path: "/solutions", module: "@/app/solutions/page", props: {}, indexed: true },
  { path: "/solutions/youtube-channels", module: "@/app/solutions/[slug]/page", props: slug("youtube-channels"), indexed: true },
  { path: "/solutions/creative-studio", module: "@/app/solutions/[slug]/page", props: slug("creative-studio"), indexed: true },
  { path: "/solutions/developers", module: "@/app/solutions/[slug]/page", props: slug("developers"), indexed: true },
  { path: "/docs/api", module: "@/app/docs/api/page", props: {}, indexed: true },
  { path: "/mcp", module: "@/app/mcp/page", props: { searchParams: Promise.resolve({}) }, indexed: true },
  { path: "/privacy", module: "@/app/privacy/page", props: {}, indexed: true },
  { path: "/terms", module: "@/app/terms/page", props: {}, indexed: true },
];
/** Public, with their own metadata (a layout, the page being client code), but not in the sitemap by design: forms, not content. */
const FORM_PAGES: { path: string; module: string }[] = [
  { path: "/login", module: "@/app/login/layout" },
  { path: "/signup", module: "@/app/signup/layout" },
  { path: "/forgot-password", module: "@/app/forgot-password/layout" },
];

type Meta = {
  title?: string | { absolute?: string };
  description?: string;
  alternates?: { canonical?: string; languages?: unknown };
  metadataBase?: URL;
  openGraph?: { url?: string; title?: string; description?: string; images?: { url: string; width?: number; height?: number; alt?: string }[] };
  twitter?: { card?: string; title?: string; description?: string; images?: { url: string }[] };
};
const titleOf = (m: Meta) => (typeof m.title === "string" ? m.title : m.title?.absolute ?? "");

async function metadataOf(module: string, props: Record<string, unknown>, locale: Locale): Promise<Meta> {
  dict.locale = locale;
  const mod = await import(/* @vite-ignore */ module);
  return (await mod.generateMetadata(props)) as Meta;
}

async function htmlOf(module: string, props: Record<string, unknown>, locale: Locale): Promise<string> {
  dict.locale = locale;
  const mod = await import(/* @vite-ignore */ module);
  const el = (await mod.default(props)) as ReactElement;
  return renderToStaticMarkup(createElement(PublicI18nProvider, { locale, t: publicDictionary(dictionaries[locale]), children: el }));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 13 robots.txt ───────────────────────────────────────────────────────────

describe("13 robots.txt", () => {
  it("allows the site, keeps crawlers off /api/ and names the sitemap on the site's own origin", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    expect(robots()).toEqual({
      rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
      sitemap: `${ORIGIN}/sitemap.xml`,
      host: ORIGIN,
    });
  });

  it("does not disallow a public page (that would hide it from search) and names no private path", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    const rule = (robots().rules as { disallow: string[] }[])[0];
    for (const path of [...SITEMAP_PATHS, "/llms.txt", "/sitemap.xml"]) {
      for (const d of rule.disallow) expect(path.startsWith(d)).toBe(false);
    }
    expect(JSON.stringify(robots())).not.toMatch(/atelier|welcome|oauth|auth/);
  });
});

// ── 12 sitemap.xml ──────────────────────────────────────────────────────────

describe("12 sitemap.xml", () => {
  it("lists exactly the public indexable pages, once each, on the site's own origin", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    vi.stubEnv("DEV_CLI_PAGE", "");
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual(PAGES.map((p) => new URL(p.path, ORIGIN).toString()).sort((a, b) => urls.indexOf(a) - urls.indexOf(b)));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("lists the two developer pages only while their flag is on", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    vi.stubEnv("DEV_CLI_PAGE", "1");
    const on = sitemap().map((e) => new URL(e.url).pathname);
    for (const p of DEV_PAGE_PATHS) expect(on).toContain(p);
    vi.stubEnv("DEV_CLI_PAGE", "");
    const off = sitemap().map((e) => new URL(e.url).pathname);
    for (const p of DEV_PAGE_PATHS) expect(off).not.toContain(p);
  });

  it("omits <lastmod> rather than invent one (no build date is available to the server)", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    for (const e of sitemap()) expect(e).not.toHaveProperty("lastModified");
  });

  it("misses no public page: every page route in app/ is in the sitemap or on the short list of form pages", () => {
    // app/(app), app/(concepts) and the non-page route groups are private, flag-gated or machine endpoints.
    const SKIP = ["(app)", "(concepts)", "api", "auth", "oauth", "welcome", "i", "reset-password", "invite", "docs/cli", "docs/skills"];
    const found = walk(join(ROOT, "app"))
      .filter((f) => /\/page\.tsx$/.test(f))
      .map((f) => relative(join(ROOT, "app"), f).replace(/\/?page\.tsx$/, ""))
      .filter((r) => !SKIP.some((s) => r === s || r.startsWith(s + "/")))
      .flatMap((r) => (r === "solutions/[slug]" ? SOLUTION_PATHS.slice(1) : ["/" + r]))
      .map((r) => (r === "/" || r === "" ? "/" : r));
    const listed = new Set<string>(SITEMAP_PATHS);
    const forms = new Set(FORM_PAGES.map((p) => p.path));
    for (const route of found) expect(listed.has(route) || forms.has(route), `${route} is public but neither in the sitemap nor a form page`).toBe(true);
    // And the other way round: a listed page has a page file.
    for (const p of SITEMAP_PATHS) expect(found, p).toContain(p);
  });
});

// Route-level 2xx: the page or file exists, and the gate lets a signed-out visitor, and a site with no backend, through.

describe("every URL the sitemap lists answers 2xx (route-level, no network)", () => {
  const ROUTE_FILES: Record<string, string> = {
    "/robots.txt": "app/robots.ts",
    "/sitemap.xml": "app/sitemap.ts",
    "/llms.txt": "app/llms.txt/route.ts",
    [OPENAPI_PATH]: "app/docs/api/openapi.json",
  };
  const pageFile = (p: string) => (p === "/" ? "app/page.tsx" : p.startsWith("/solutions/") ? "app/solutions/[slug]/page.tsx" : `app${p}/page.tsx`);

  it.each([...SITEMAP_PATHS, ...Object.keys(ROUTE_FILES)])("%s has a route and the gate passes it signed out", (path) => {
    expect(existsSync(join(ROOT, ROUTE_FILES[path] ?? pageFile(path))), path).toBe(true);
    expect(gateDecision(path, false)).toBe("pass");
  });

  it("the robots, sitemap and llms handlers answer 200 with a body", async () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    expect(sitemap().length).toBeGreaterThan(0);
    expect(robots().rules).toBeTruthy();
    const res = llmsGET();
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(100);
  });
});

// ── 20 llms.txt ─────────────────────────────────────────────────────────────

describe("20 llms.txt", () => {
  it("is served as text/plain, public, cached for an hour", () => {
    const res = llmsGET();
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("follows the llmstxt.org shape: one H1, a blockquote summary, then sections of '- [title](url): description' links", () => {
    const txt = llmsTxt(ORIGIN, false);
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# Nightshift");
    expect(lines.filter((l) => l.startsWith("# "))).toHaveLength(1);
    expect(lines[2]).toMatch(/^> .{40,}/);
    expect(lines.some((l) => /^## (Product|Solutions|Developers|Legal)$/.test(l))).toBe(true);
    for (const l of lines.filter((l) => l.startsWith("- "))) expect(l).toMatch(/^- \[[^\]]+\]\(https:\/\/nightshift\.example\/[^)\s]*\): \S.+/);
  });

  it("links every listed page and the OpenAPI spec, and nothing else: each URL is a real public route", () => {
    const txt = llmsTxt(ORIGIN, false);
    const paths = [...txt.matchAll(/\]\((https:\/\/nightshift\.example)([^)\s]*)\)/g)].map((m) => m[2] || "/");
    expect(paths.sort()).toEqual([...SITEMAP_PATHS, OPENAPI_PATH].sort());
    for (const p of paths) expect(gateDecision(p, false), p).toBe("pass");
  });

  it("is generated from the sitemap's own list: every sitemap page is in it, in every flag state", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    for (const flag of ["", "1"]) {
      vi.stubEnv("DEV_CLI_PAGE", flag);
      const inLlms = new Set(llmsEntries(flag === "1").map((e) => e.path));
      for (const e of sitemap()) expect(inLlms.has(new URL(e.url).pathname), e.url).toBe(true);
    }
  });

  it("uses root-relative links, never localhost, when the site has no origin", () => {
    const txt = llmsTxt(null, false);
    expect(txt).not.toMatch(/localhost|https?:\/\//);
    expect(txt).toContain("](/pricing)");
  });

  it("says nothing false or forbidden: no provider or model name, no price, no role word", () => {
    for (const devPages of [false, true]) {
      const txt = llmsTxt(ORIGIN, devPages);
      expect(txt).not.toMatch(PROVIDER_BRANDS);
      expect(txt).not.toMatch(/[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|so'm|сум)\b|\bper (?:minute|credit)\b.*\d/i);
      // "editor" is a product (the video editor); the role words are the team roles, as in tests/site-copy.test.ts.
      expect(txt).not.toMatch(/\b(?:owner|viewer)s?\b/i);
      expect(txt).not.toMatch(/localhost/);
    }
  });

  it("every description is the site's own English copy for that page (it cannot drift from the page)", () => {
    const t = dictionaries.en;
    const byPath = Object.fromEntries(llmsEntries(false).map((e) => [e.path, e.description]));
    expect(byPath["/"]).toBe(t.landing.meta.description);
    expect(byPath["/studio"]).toBe(t.site.studioPage.meta.description);
    expect(byPath["/pricing"]).toBe(t.pricing.metaDescription);
    for (const p of t.site.solutions.pages) expect(byPath[`/solutions/${p.id}`]).toBe(p.lead);
    expect(byPath["/privacy"]).toBe(LEGAL_TEXTS.en.privacy.summary);
  });

  it("the file is public to a signed-out crawler and /llms-full.txt is not claimed", () => {
    expect(gateDecision("/llms.txt", false)).toBe("pass");
    expect(gateDecision("/llms-full.txt", false)).not.toBe("pass");
  });
});

// ── 11, 14, 18 meta title and description, canonical, social share; 9/4 one h1; 15 alt ─

describe.each(LOCALES)("public pages (%s): title, description, canonical, share card, one h1, alt text", (locale) => {
  const titles = new Map<string, string>();

  it.each([...PAGES.map((p) => ({ path: p.path, module: p.module, props: p.props })), ...FORM_PAGES.map((p) => ({ ...p, props: {} }))])(
    "$path has a unique title, a description of 160 characters or fewer, a self-referencing canonical, Open Graph and Twitter tags",
    async ({ path, module, props }) => {
      vi.stubEnv("APP_ORIGIN", ORIGIN);
      const m = await metadataOf(module, props, locale);
      const title = titleOf(m);
      expect(title.length, "title").toBeGreaterThan(5);
      expect(title.length, "title length").toBeLessThanOrEqual(70);
      expect(titles.get(title), `title of ${path} repeats ${titles.get(title)}`).toBeUndefined();
      titles.set(title, path);
      expect(m.description, "description").toBeTruthy();
      expect(m.description!.length, "description length").toBeLessThanOrEqual(160);
      expect(m.description!.length, "description is not a stub").toBeGreaterThanOrEqual(40);
      expect(m.alternates?.canonical).toBe(path);
      expect(String(m.metadataBase)).toBe(`${ORIGIN}/`);
      const og = m.openGraph!;
      expect(og.url).toBe(new URL(path, ORIGIN).toString());
      expect(og.title).toBe(title);
      expect(og.description).toBe(m.description);
      expect(og.images?.[0]).toMatchObject({ url: `${ORIGIN}/og.png`, width: 1200, height: 630 });
      expect(og.images?.[0].alt).toBeTruthy();
      expect(m.twitter).toMatchObject({ card: "summary_large_image", title, description: m.description });
      expect(m.twitter?.images?.[0].url).toBe(`${ORIGIN}/og.png`);
    },
    60_000,
  );

  it("MCP's two descriptions (sign-in on and off) both fit a search result", async () => {
    const { devDictionaries } = await import("@/lib/i18n/dev");
    const d = devDictionaries[locale].mcp;
    expect(d.meta.description.length).toBeLessThanOrEqual(160);
    expect(d.signinOff.description.length).toBeLessThanOrEqual(160);
  });

  // One URL serves all three languages (the visitor's cookie, then Accept-Language), so there are no per-language
  // addresses to point hreflang at: declaring them would be three links to one URL. See docs/LAUNCH_CHECKLIST.md item 14.
  it("declares no hreflang: the language is not in the URL", async () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    for (const p of PAGES) expect((await metadataOf(p.module, p.props, locale)).alternates).not.toHaveProperty("languages");
  });

  it.each(PAGES)("$path renders exactly one h1 and every image has alt text", async ({ module, props }) => {
    const html = await htmlOf(module, props, locale);
    expect(html.match(/<h1[\s>]/g) ?? [], "h1 count").toHaveLength(1);
    for (const tag of html.match(/<img\b[^>]*>/g) ?? []) expect(tag, tag).toMatch(/\balt="/);
    expect(html).toMatch(new RegExp(`<html|<main id="main"`));
  }, 60_000);
});

describe("15 image alt text, in the source", () => {
  it("no <img> or next/image in a public component or page is without alt", () => {
    const dirs = ["components/site", "components/landing", "components/legal", "components/pricing", "components/docs", "components/developers", "app"];
    const offenders: string[] = [];
    for (const d of dirs) {
      for (const f of walk(join(ROOT, d)).filter((f) => /\.tsx$/.test(f))) {
        if (f.includes("/(app)/") || f.includes("/(concepts)/")) continue;
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/<(img|Image)\b[\s\S]*?\/>/g)) if (!/\balt=/.test(m[0]) && !/\{\.\.\.\w+\}/.test(m[0])) offenders.push(`${relative(ROOT, f)}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── 17 custom 404 ───────────────────────────────────────────────────────────

describe("17 custom 404 page", () => {
  it("is the site's own page in the public frame, not Next's default, and is not indexed", async () => {
    const src = readFileSync(join(ROOT, "app/not-found.tsx"), "utf8");
    expect(src).toContain("<PublicShell");
    expect(src).toMatch(/robots: \{ index: false \}/);
    for (const locale of LOCALES) {
      const html = await htmlOf("@/app/not-found", {}, locale);
      const n = dictionaries[locale].site.notFound;
      expect(html).toContain(n.title);
      expect(html).toContain('href="/"');
      expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    }
  });

  it("an unknown URL is the public 404 for a signed-out visitor too (the gate rewrites to /_not-found)", () => {
    const src = readFileSync(join(ROOT, "middleware.ts"), "utf8");
    expect(src).toContain("NOT_FOUND_PATH");
    expect(src).toMatch(/status: 404/);
    expect(existsSync(join(ROOT, "app/global-error.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "app/error.tsx"))).toBe(true);
  });
});

// ── 19 favicon, 18 share image ──────────────────────────────────────────────

describe("19 favicon and 18 share image files", () => {
  it.each(["app/favicon.ico", "app/icon.svg", "app/icon.png", "app/apple-icon.png", "app/og.png/route.tsx"])("%s exists and is not empty", (f) => {
    expect(existsSync(join(ROOT, f)), f).toBe(true);
    expect(statSync(join(ROOT, f)).size).toBeGreaterThan(100);
  });
});

// ── 7 broken links (internal, route-level) ──────────────────────────────────

describe("7 internal links on the public pages all resolve", () => {
  const SERVED_FILES = new Set(["/favicon.ico", "/icon.svg", "/icon.png", "/apple-icon.png", "/og.png", "/robots.txt", "/sitemap.xml", "/llms.txt", OPENAPI_PATH]);
  const isServed = (path: string) => gateDecision(path, false) === "pass" || SERVED_FILES.has(path) || isPublicFontPath(path);

  it.each(LOCALES)("%s: every href='/…' leads to a public route, and every #fragment to an id on the page it names", async (locale) => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    const htmls = new Map<string, string>();
    for (const p of PAGES) htmls.set(p.path, await htmlOf(p.module, p.props, locale));
    const broken: string[] = [];
    for (const [from, html] of htmls) {
      for (const m of html.matchAll(/\bhref="(\/[^"]*)"/g)) {
        const href = m[1].replace(/&amp;/g, "&");
        const [pathAndQuery, fragment] = href.split("#");
        const path = pathAndQuery.split("?")[0] || "/";
        if (path.startsWith("//")) continue;
        // /i/<token> and the app are not linked from public pages; anything else must be served signed out.
        if (!isServed(path)) broken.push(`${from} -> ${href} (not a public route)`);
        const target = htmls.get(path);
        if (fragment && target && !new RegExp(`\\bid="${fragment}"`).test(target)) broken.push(`${from} -> ${href} (no #${fragment} on ${path})`);
      }
    }
    expect(broken).toEqual([]);
  }, 120_000);
});

// ── 1, 2, 3 privacy, terms, cookies ─────────────────────────────────────────

function textOf(b: LegalBlock): string[] {
  if (typeof b === "string") return [b];
  if ("list" in b) return b.list;
  if ("note" in b) return [b.note];
  if ("creditExpiry" in b) return [b.creditExpiry.never, b.creditExpiry.after];
  return [...b.table.head, ...b.table.rows.flat()];
}

describe("1 privacy policy, 2 terms of use, 3 cookies and local storage", () => {
  it("both documents exist at /privacy and /terms, linked from every public footer, in every language", async () => {
    for (const locale of LOCALES) {
      const html = await htmlOf("@/app/pricing/page", {}, locale);
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/privacy#cookies"');
    }
  }, 60_000);

  // The disclosure must name every cookie and storage key the code uses; a new one that is not listed fails here.
  const NAMES = [
    "chronos_locale", "ns_view", "chronos_channel", "nightshift_org", "ns_sidebar", "ns_auth_pending", "ns_recovery", "ns_invite",
    "yt_oauth_nonce", "ig_oauth_nonce", "tt_oauth_nonce", "tt_oauth_pkce", "ns_connect_pending", "chronos_theme",
  ];

  it.each(LOCALES)("%s: the Cookies section lists every cookie and the theme key the code sets", (locale) => {
    const section = LEGAL_TEXTS[locale].privacy.sections.find((s) => s.id === "cookies")!;
    const text = section.body.flatMap(textOf).join("\n");
    for (const n of NAMES) expect(text, n).toContain(`\`${n}\``);
    // Nothing here counts visitors, so the policy must not say it does (page counts are a separate change).
    expect(text).not.toMatch(/Do Not Track|page statistics|Статистика страниц|Sahifa statistikasi/i);
    expect(text).toContain("Paddle");
  });

  it("the names above are exactly the cookie constants in the code (a new cookie must be added to the policy)", () => {
    const found = new Set<string>();
    for (const dir of ["lib", "app"]) {
      for (const f of walk(join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f))) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/\b(?:[A-Z]+_)*COOKIE\s*=\s*"([a-z_]+)"/g)) found.add(m[1]);
        for (const m of src.matchAll(/(?:instagram|tiktok):\s*"([a-z]{2}_oauth_nonce)"/g)) found.add(m[1]);
        const theme = src.match(/THEME_KEY\s*=\s*"([a-z_]+)"/);
        if (theme) found.add(theme[1]);
      }
    }
    expect([...found].sort()).toEqual([...NAMES].sort());
  });

  it("the site loads no third-party analytics, advertising or tracking script or pixel", () => {
    const TRACKERS =
      /google-analytics|googletagmanager|gtag\(|doubleclick|googlesyndication|facebook\.net|connect\.facebook|fbq\(|hotjar|clarity\.ms|mixpanel|segment\.(?:com|io)|plausible\.io|posthog|amplitude\.com|fullstory|heap-analytics|hubspot|tiktok\.com\/i18n\/pixel|analytics\.tiktok|snap(?:chat)?\.com\/scevent|linkedin\.com\/px|@vercel\/analytics|@vercel\/speed-insights|matomo|umami|cloudflareinsights/i;
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const f of walk(join(ROOT, dir)).filter((f) => /\.(tsx?|css)$/.test(f))) {
        const src = readFileSync(f, "utf8");
        if (TRACKERS.test(src)) offenders.push(relative(ROOT, f));
      }
    }
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /analytics|gtag|pixel|segment|mixpanel|posthog|hotjar/i.test(d))).toEqual([]);
  });

  it("the only third-party script origins the site may load are the payment provider's (the CSP names them)", () => {
    const csp = readFileSync(join(ROOT, "lib/security/csp.ts"), "utf8");
    const scriptHosts = [...csp.matchAll(/script: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"https:\/\/([^"]+)"/g)].map((x) => x[1]));
    expect(scriptHosts.sort()).toEqual(["cdn.paddle.com", "public.profitwell.com"]);
  });
});

// ── 4 one clear call to action, 16 FAQ ──────────────────────────────────────

describe.each(LOCALES)("4 one clear call to action and 16 FAQ (%s)", (locale) => {
  it.each(PAGES)("$path carries the one header call to action, Start free, to /signup", async ({ module, props }) => {
    const html = await htmlOf(module, props, locale);
    const start = dictionaries[locale].site.nav.start;
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    const keys = [...header.matchAll(/<a [^>]*class="[^"]*\bst-key\b[^"]*"[^>]*>/g)];
    expect(keys, "primary buttons in the header").toHaveLength(1);
    expect(keys[0][0]).toContain('href="/signup"');
    expect(header).toContain(start);
  }, 60_000);

  it("the home page answers questions on the page and says so to search engines (FAQPage JSON-LD), with the same answers", async () => {
    const html = await htmlOf("@/app/page", {}, locale);
    expect(html).toMatch(/id="faq"/);
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const faq = ld.find((d) => d["@type"] === "FAQPage");
    expect(faq, "FAQPage JSON-LD").toBeTruthy();
    // The questions the page shows (a question about plans or refunds appears only when that applies): a subset of the dictionary's, never a question the dictionary lacks.
    const all = dictionaries[locale].landing.faq.items.map((i) => i.q);
    const names: string[] = faq.mainEntity.map((q: { name: string }) => q.name);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const n of names) expect(all).toContain(n);
  }, 60_000);
});
