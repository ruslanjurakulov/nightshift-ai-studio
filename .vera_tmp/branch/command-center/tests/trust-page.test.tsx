// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * /trust ("Trust and safety"). Every sentence on it is a claim about the code, so what would make one false is pinned
 * here: the YouTube permissions it lists ARE the ones the connect flow asks Google for (rendered from the constant, one
 * copy entry per scope, Google's own words), uploads are private by default in config.py and auto publish is off by
 * default in the schema, no code deletes anything on YouTube, the contact address is the configured one (never typed),
 * nothing names an AI provider or trips the banned-claims list, and the page is public, listed and linked from the footer.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/trust",
  useRouter: () => ({ push() {}, refresh() {}, back() {}, replace() {}, prefetch() {} }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const dict = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ locale: dict.locale, t: dictionaries[dict.locale] }), getLocale: async () => dict.locale };
});

import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { trustEn } from "@/lib/i18n/trust/en";
import { trustRu } from "@/lib/i18n/trust/ru";
import { trustUz } from "@/lib/i18n/trust/uz";
import { YOUTUBE_OAUTH_SCOPES } from "@/lib/server/google-oauth";
import { GOOGLE_PERMISSIONS_URL, shortScope } from "@/lib/channel-tokens";
import { CONTACT_HREF } from "@/lib/legal";
import { SOCIAL } from "@/lib/site/social";
import { SITE_DOMAIN, TRUST_LAST_REVIEWED, TRUST_SECTIONS } from "@/lib/trust";
import { TRUST_PATH, gateDecision, isAlwaysPublicPath } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";
import { UNCOUNTED_PAGE_PATHS, listedPagePaths } from "@/lib/site-pages";
import { llmsTxt } from "@/lib/llms";
import { docsOrigin } from "@/lib/api/docs-origin";
import { bannedHits } from "@/lib/marketing-banned";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { PUBLIC_PAGE_PATHS } from "../next.config";
import TrustRoute, { generateMetadata } from "@/app/trust/page";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  dict.locale = "en";
});

const LOCALES = ["en", "ru", "uz"] as const;
const COPY = { en: trustEn, ru: trustRu, uz: trustUz } as const;
const ROOT = join(__dirname, "..", "..");

async function pageHtml(locale: (typeof LOCALES)[number]): Promise<string> {
  dict.locale = locale;
  const el = (await TrustRoute()) as ReactElement;
  return renderToStaticMarkup(createElement(PublicI18nProvider, { locale, t: publicDictionary(dictionaries[locale]), children: el }));
}
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

type Node = string | number | boolean | null | Node[] | { [k: string]: Node };
const strings = (n: Node): string[] =>
  typeof n === "string" ? [n] : Array.isArray(n) ? n.flatMap(strings) : n && typeof n === "object" ? Object.values(n).flatMap(strings) : [];
const allText = (c: unknown) => strings(c as Node).join("\n");

describe("YouTube access: the permissions are the code's, in Google's own words", () => {
  it("the copy has exactly one entry per scope the connect flow requests, in the same order, in every language", () => {
    const ids = YOUTUBE_OAUTH_SCOPES.map(shortScope);
    expect(ids).toEqual(["youtube.upload", "youtube.readonly", "youtube.force-ssl", "yt-analytics.readonly"]);
    for (const locale of LOCALES) expect(COPY[locale].youtube.scopes.map((s) => s.id), locale).toEqual(ids);
  });

  it("quotes Google's descriptions as Google wrote them (developers.google.com/identity/protocols/oauth2/scopes, read 2026-11-14)", () => {
    expect(Object.fromEntries(trustEn.youtube.scopes.map((s) => [s.id, s.google]))).toEqual({
      "youtube.upload": "Manage your YouTube videos",
      "youtube.readonly": "View your YouTube account",
      "youtube.force-ssl": "See, edit, and permanently delete your YouTube videos, ratings, comments and captions",
      "yt-analytics.readonly": "View YouTube Analytics reports for your YouTube content",
    });
  });

  it.each(LOCALES)("%s: the page lists exactly YOUTUBE_OAUTH_SCOPES, nothing more, and links Google's permissions page", async (locale) => {
    const d = parse(await pageHtml(locale));
    expect([...d.querySelectorAll("[data-scope]")].map((x) => x.getAttribute("data-scope"))).toEqual([...YOUTUBE_OAUTH_SCOPES]);
    expect(d.querySelectorAll(".tr-scope code")).toHaveLength(YOUTUBE_OAUTH_SCOPES.length);
    expect(d.querySelector(`#youtube a[href="${GOOGLE_PERMISSIONS_URL}"]`)).not.toBeNull();
    for (const s of COPY[locale].youtube.scopes) expect(d.body.textContent).toContain(s.why);
  });

  it("never claims the revenue permission: the site does not request it, and the copy says so", () => {
    expect(YOUTUBE_OAUTH_SCOPES.some((s) => /monetary/.test(s))).toBe(false);
    expect(trustEn.youtube.scopes.find((s) => s.id === "yt-analytics.readonly")!.why).toMatch(/does not ask for the separate permission that shows revenue/);
  });

  it("'no code deletes a video, a comment or a caption' is true of the bot (modules/, tools/, main.py)", () => {
    const files: string[] = [join(ROOT, "main.py")];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".py")) files.push(p);
      }
    };
    walk(join(ROOT, "modules"));
    walk(join(ROOT, "tools"));
    expect(files.length).toBeGreaterThan(20);
    const DELETE = /\.(?:videos|comments|commentThreads|captions)\(\)\s*\.delete\(/;
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(DELETE);
    expect(trustEn.youtube.scopes.find((s) => s.id === "youtube.force-ssl")!.why).toMatch(/no code that deletes a video, a comment or a caption/);
  });
});

describe("Publishing: the defaults the page states are the code's defaults", () => {
  it("uploads are private unless YOUTUBE_PRIVACY is set (config.py), and the copy says private by default", () => {
    const config = readFileSync(join(ROOT, "config.py"), "utf8");
    expect(config).toMatch(/^YOUTUBE_PRIVACY = os\.getenv\("YOUTUBE_PRIVACY", "private"\)/m);
    expect(trustEn.publishing.items[0]).toMatch(/private by default/);
    expect(trustEn.youtube.privateTitle).toBe("Uploads are private by default");
    expect(trustEn.youtube.privateBody).toMatch(/each off by default/);
  });

  it("auto publish is off by default (migration 0004) and only a plainly-on switch lets anything but private through", () => {
    const m = readFileSync(join(ROOT, "supabase", "migrations", "0004_review.sql"), "utf8");
    expect(m).toMatch(/add column if not exists auto_publish boolean not null default false/);
    const channels = readFileSync(join(ROOT, "modules", "channels.py"), "utf8");
    expect(channels).toMatch(/if ui_auto_publish is True:\s*\n\s*return requested\s*\n\s*return "private"/);
    expect(trustEn.publishing.items[2]).toMatch(/off by default/);
  });

  it("publish when approved is off by default and the page says it acts only after a person approved, and reports only YouTube's read-back", () => {
    const item = trustEn.publishing.items[4];
    expect(item).toMatch(/off by default/);
    expect(item).toMatch(/Only a signed-in person of the channel’s own workspace can turn it on, never the bot itself/);
    expect(item).toMatch(/once a person approves one exact cut/);
    expect(item).toMatch(/only when YouTube itself reports it public/);
    expect(trustEn.publishing.items[3]).toMatch(/does not change the video’s privacy/);
  });
});

describe.each(LOCALES)("/trust renders (%s)", (locale) => {
  it("one h1, every section in order with its table-of-contents link, and the review date as a <time>", async () => {
    const html = await pageHtml(locale);
    const d = parse(html);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const ids = [...d.querySelectorAll("section.tr-sec")].map((s) => s.id);
    expect(ids).toEqual([...TRUST_SECTIONS]);
    expect([...d.querySelectorAll(".tr-toc a")].map((a) => a.getAttribute("href"))).toEqual(TRUST_SECTIONS.map((id) => `#${id}`));
    expect(d.querySelector(".tr-reviewed time")?.getAttribute("dateTime") ?? d.querySelector(".tr-reviewed time")?.getAttribute("datetime")).toBe(TRUST_LAST_REVIEWED);
    expect(d.body.textContent).not.toMatch(/\{(?:date|domain|link)\}/);
  });

  it("links the Refund Policy, our accounts elsewhere from the one social list, and names our one domain", async () => {
    const d = parse(await pageHtml(locale));
    expect(d.querySelector('#payments a[href="/refund"]')).not.toBeNull();
    expect([...d.querySelectorAll("#real .tr-accounts a")].map((a) => a.getAttribute("href"))).toEqual(SOCIAL.map((s) => s.href));
    expect(d.querySelector("#real")?.textContent).toContain(SITE_DOMAIN);
  });

  it("with no contact address configured, points at the Terms' contact details and prints no address", async () => {
    const d = parse(await pageHtml(locale));
    const contact = d.querySelector("#report .tr-contact");
    expect(contact?.querySelector(`a[href="${CONTACT_HREF}"]`)).not.toBeNull();
    expect(contact?.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("carries WebPage structured data with the review date (and the page's own URL when the site has an origin)", async () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const html = await pageHtml(locale);
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const page = ld.find((x) => x["@type"] === "WebPage");
    expect(page).toMatchObject({ "@context": "https://schema.org", name: COPY[locale].title, lastReviewed: TRUST_LAST_REVIEWED, inLanguage: locale, url: "https://nightshift.example/trust" });
  });

  it("has a title and a description that fit a search result", async () => {
    dict.locale = locale;
    const m = await generateMetadata();
    const title = typeof m.title === "string" ? m.title : (m.title as { absolute: string }).absolute;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(m.description!.length).toBeGreaterThanOrEqual(40);
    expect(m.description!.length).toBeLessThanOrEqual(160);
  });
});

describe("the contact address is the configured one, never typed into the copy", () => {
  it("no language's copy contains an e-mail address or a mailto link", () => {
    for (const locale of LOCALES) expect(allText(COPY[locale]), locale).not.toMatch(/@|mailto:/);
  });

  it("with NEXT_PUBLIC_CONTACT_EMAIL set, the page links exactly that address", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_EMAIL", "support@nightshift-ai.studio");
    // LEGAL is read once per module load: load the page's own module again under the new environment (the shell around it
    // is not needed here, and a fresh copy of the shell's context would not match the provider imported above).
    vi.resetModules();
    const { TrustPage } = await import("@/components/site/TrustPage");
    const d = parse(renderToStaticMarkup(<TrustPage t={dictionaries.en} locale="en" origin={null} />));
    const links = [...d.querySelectorAll('#report a[href^="mailto:"]')].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["mailto:support@nightshift-ai.studio"]);
  });
});

describe("the words: complete, honest, and in the site's own rules", () => {
  it.each(["ru", "uz"] as const)("%s has the same shape, ids and placeholders as English", (locale) => {
    const out: string[] = [];
    const walk = (a: Node, b: Node, path: string) => {
      if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return void out.push(`${path}: list`);
        a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
      } else if (a && typeof a === "object") {
        if (!b || typeof b !== "object" || Array.isArray(b)) return void out.push(`${path}: object`);
        if (Object.keys(a).sort().join() !== Object.keys(b).sort().join()) out.push(`${path}: keys`);
        for (const k of Object.keys(a)) {
          if (k === "id" && a[k] !== b[k]) out.push(`${path}.id`);
          if (k in b) walk(a[k], b[k], `${path}.${k}`);
        }
      } else if (typeof a === "string") {
        if (typeof b !== "string" || !b.trim()) return void out.push(`${path}: empty`);
        const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
        if (ph(a) !== ph(b)) out.push(`${path}: placeholders`);
      }
    };
    walk(trustEn as unknown as Node, COPY[locale] as unknown as Node, "trust");
    expect(out).toEqual([]);
  });

  it.each(LOCALES)("%s: passes the banned-claims and banned-names check, names no AI provider and no team-role word", (locale) => {
    const text = allText(COPY[locale]);
    expect(bannedHits({ [locale]: text })).toEqual([]);
    expect(text).not.toMatch(PROVIDER_BRANDS);
    expect(text).not.toMatch(/\b(?:owner|viewer)s?\b/i);
  });

  it("uz uses ʻ after o and g, never a quote mark", () => {
    const text = allText(trustUz);
    expect(text).not.toMatch(/[oOgG][‘’']/);
    expect(text).toContain("ʻ");
  });

  it("the review date is a real calendar date and the domain is the one the docs default to", () => {
    expect(TRUST_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${TRUST_LAST_REVIEWED}T00:00:00Z`).toISOString().slice(0, 10)).toBe(TRUST_LAST_REVIEWED);
    vi.stubEnv("APP_ORIGIN", "");
    expect(new URL(docsOrigin()).host).toBe(SITE_DOMAIN);
  });

  it("the stylesheet keeps the type rules: nothing below 13px, no tracking, no capitals, weights 400/500/600", () => {
    const css = readFileSync(join(__dirname, "..", "components", "site", "trust-page.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect([...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n < 13)).toEqual([]);
    expect([...css.matchAll(/letter-spacing:\s*(\d*\.?\d+)(?:em|px)/g)].map((m) => Number(m[1])).filter((n) => n > 0)).toEqual([]);
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect([...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => ![400, 500, 600].includes(w))).toEqual([]);
  });
});

describe("the page is public, listed and linked", () => {
  it("passes the gate signed out and in, is a reserved segment, and is in the sitemap list, llms.txt and next.config", () => {
    expect(TRUST_PATH).toBe("/trust");
    expect(gateDecision(TRUST_PATH, false)).toBe("pass");
    expect(gateDecision(TRUST_PATH, true)).toBe("pass");
    expect(isAlwaysPublicPath(TRUST_PATH)).toBe(true);
    expect(isValidChannelId("trust")).toBe(false);
    expect(UNCOUNTED_PAGE_PATHS as readonly string[]).toContain(TRUST_PATH);
    expect(listedPagePaths(false)).toContain(TRUST_PATH);
    expect(llmsTxt("https://nightshift.example", false)).toContain("](https://nightshift.example/trust)");
    expect(PUBLIC_PAGE_PATHS as readonly string[]).toContain(TRUST_PATH);
  });

  it.each(LOCALES)("%s: the public footer links it", (locale) => {
    const t = dictionaries[locale];
    render(<PublicFooter t={t} />);
    const company = screen.getByRole("navigation", { name: t.site.footer.company });
    expect([...company.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toContainEqual(["/trust", t.site.trust.footer]);
  });
});
