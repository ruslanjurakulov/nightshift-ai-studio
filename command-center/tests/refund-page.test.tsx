// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /refund: the Refund Policy the merchant of record's review (Dodo Payments)
 * reads as a public page of its own, beside the Terms and the Privacy Policy.
 * It must open signed out, in every language, be linked from the public footer
 * and from Terms 8.6, and say nothing the Terms do not: Dodo decides refunds
 * under its Buyer Terms and the law, a refund removes unused credits, a failed
 * run's hold comes back on its own, and a plan can be cancelled any time.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/refund",
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
import { LEGAL_TEXTS, type LegalBlock, type LegalDocument } from "@/lib/legal-docs";
import { tokenizeInline } from "@/lib/legal-docs/inline";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { REFUND_PATH, RESERVED_ROOT_SEGMENTS, SITEMAP_PATHS, gateDecision, isAlwaysPublicPath, isLegalPath } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";
import { UNCOUNTED_PAGE_PATHS, listedPagePaths } from "@/lib/site-pages";
import { llmsTxt } from "@/lib/llms";
import { PUBLIC_PAGE_PATHS } from "../next.config";
import sitemap from "@/app/sitemap";
import RefundPage, { generateMetadata } from "@/app/refund/page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  dict.locale = "en";
});

const LOCALES = ["en", "ru", "uz"] as const;
const BUYER_TERMS = "https://dodopayments.com/legal/buyer-terms";
const ORIGIN = "https://nightshift.example";

function strings(block: LegalBlock): string[] {
  if (typeof block === "string") return [block];
  if ("list" in block) return block.list;
  if ("note" in block) return [block.note];
  if ("creditExpiry" in block) return [block.creditExpiry.never, block.creditExpiry.after, block.creditExpiry.unknown];
  return [...block.table.head, ...block.table.rows.flat()];
}
const textOf = (doc: LegalDocument) => [doc.title, doc.summary, ...doc.sections.flatMap((s) => [s.heading, ...s.body.flatMap(strings)])].join("\n");
const hrefsOf = (doc: LegalDocument) =>
  textOf(doc)
    .split("\n")
    .flatMap(tokenizeInline)
    .flatMap((tok) => (tok.kind === "link" ? [tok.href] : []));

async function pageHtml(locale: (typeof LOCALES)[number]): Promise<string> {
  dict.locale = locale;
  const el = (await RefundPage()) as ReactElement;
  return renderToStaticMarkup(createElement(PublicI18nProvider, { locale, t: publicDictionary(dictionaries[locale]), children: el }));
}
const bodyText = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

describe.each(LOCALES)("/refund renders (%s)", (locale) => {
  it("shows the policy's title, every section and the operator facts card, with no env var named", async () => {
    const doc = LEGAL_TEXTS[locale].refund;
    const t = dictionaries[locale];
    const html = await pageHtml(locale);
    const text = bodyText(html);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(text).toContain(doc.title);
    expect(text).toContain(doc.summary);
    for (const s of doc.sections) {
      expect(text, s.id).toContain(s.heading);
      expect(html, s.id).toContain(`id="${s.id}"`);
    }
    // The same NOT CONFIGURED handling as /terms and /privacy: a gap reads "not published yet", never the variable.
    expect(html).not.toMatch(/NEXT_PUBLIC_|NOT CONFIGURED|НЕ НАСТРОЕНО|SOZLANMAGAN/);
    expect(text).toContain(t.legal.effectiveDate);
    expect(text).toContain(t.legal.placeholder.contactEmail);
  });

  it("links Dodo's Buyer Terms and the Terms' credits section, no Paddle page, and the footer links back to /refund", async () => {
    const html = await pageHtml(locale);
    expect(html).toContain(`href="${BUYER_TERMS}"`);
    expect(html).not.toMatch(/href="https:\/\/[^"]*paddle/);
    expect(html).toContain('href="/terms#credits"');
    expect(html).toContain('href="/refund"');
  });
});

describe("the public footer links the Refund Policy beside Terms and Privacy", () => {
  it.each(LOCALES)("%s", (locale) => {
    const t = dictionaries[locale];
    render(<PublicFooter t={t} />);
    const legal = screen.getByRole("navigation", { name: t.site.footer.legal });
    const links = [...legal.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]);
    expect(links).toContainEqual(["/refund", t.legal.refund]);
    const order = links.map(([href]) => href);
    expect(order.indexOf("/refund")).toBe(order.indexOf("/terms") + 1);
  });
});

describe.each(LOCALES)("what the Refund Policy says (%s)", (locale) => {
  const { refund, terms } = LEGAL_TEXTS[locale];
  const text = textOf(refund);

  it("has the same sections and links as English", () => {
    expect(refund.sections.map((s) => s.id)).toEqual(LEGAL_TEXTS.en.refund.sections.map((s) => s.id));
    expect(hrefsOf(refund).sort()).toEqual(hrefsOf(LEGAL_TEXTS.en.refund).sort());
  });

  it("names Dodo Payments as Merchant of Record, links its Buyer Terms, and offers both ways to ask", () => {
    expect(text).toContain("Merchant of Record");
    expect(text).toContain("Dodo Payments");
    expect(hrefsOf(refund)).toContain(BUYER_TERMS);
    expect(hrefsOf(refund).filter((h) => h.includes("paddle"))).toEqual([]);
    const ask = refund.sections.find((s) => s.id === "how-to-ask")!;
    const list = ask.body.find((b): b is { list: string[] } => typeof b === "object" && "list" in b)!;
    expect(list.list).toHaveLength(2);
    expect(list.list[0]).toContain("{contactEmail}");
    expect(list.list[1]).toContain("Dodo Payments");
  });

  // The Terms define no refund window, so the policy must not invent one: no "14 days", "14 дней", "14 kun".
  it("sets no refund period of its own (the Terms define none)", () => {
    expect(text).not.toMatch(/\d+\s*(?:-?\s*)(?:days?|дн|день|kun)/i);
  });

  it("covers the statutory rights, credits on refund or chargeback, failed runs and cancelling a plan", () => {
    const ids = refund.sections.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["when", "credits", "failed-runs", "subscriptions"]));
    expect(text).toMatch(/chargeback|чарджбэк/i);
  });

  it("is linked from Terms 8.6", () => {
    const s86 = terms.sections.find((s) => s.id === "credits")!.body.flatMap(strings).find((s) => s.startsWith("8.6."))!;
    expect(tokenizeInline(s86).some((tok) => tok.kind === "link" && tok.href === REFUND_PATH)).toBe(true);
  });
});

it("the English policy makes no superlative claim", () => {
  expect(textOf(LEGAL_TEXTS.en.refund)).not.toMatch(/\b(?:best|fastest|easiest|guaranteed?|always|instantly|hassle-free|no questions asked)\b/i);
});

describe("/refund is public, listed and reserved", () => {
  it("passes the gate signed out and signed in, exactly", () => {
    expect(isLegalPath("/refund")).toBe(true);
    expect(isAlwaysPublicPath("/refund")).toBe(true);
    expect(gateDecision("/refund", false)).toBe("pass");
    expect(gateDecision("/refund/", false)).toBe("pass");
    expect(gateDecision("/refund", true)).toBe("pass");
    expect(gateDecision("/refund/x", false)).toBe("to-login");
  });

  it("is a reserved word: no channel may take it as its id", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("refund");
    expect(isValidChannelId("refund")).toBe(false);
  });

  it("is in the sitemap, llms.txt (Legal) and next.config's .rsc list, but not counted (SITEMAP_PATHS is the 0104 SQL list)", () => {
    expect(SITEMAP_PATHS).not.toContain("/refund");
    expect(UNCOUNTED_PAGE_PATHS).toContain("/refund");
    expect(listedPagePaths(false)).toContain("/refund");
    expect(PUBLIC_PAGE_PATHS).toContain("/refund");
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    expect(sitemap().filter((e) => e.url === `${ORIGIN}/refund`)).toHaveLength(1);
    const llms = llmsTxt(ORIGIN, false);
    const legal = llms.slice(llms.indexOf("## Legal"));
    expect(legal).toContain(`(${ORIGIN}/refund): ${LEGAL_TEXTS.en.refund.summary}`);
  });

  it.each(LOCALES)("%s: title, description and canonical", async (locale) => {
    dict.locale = locale;
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    const meta = await generateMetadata();
    const doc = LEGAL_TEXTS[locale].refund;
    expect(meta.title).toBe(`${doc.title} · ${dictionaries[locale].brand.name}`);
    expect(meta.description).toBe(doc.summary);
    expect(new URL(String(meta.alternates?.canonical), meta.metadataBase ?? undefined).toString()).toBe(`${ORIGIN}/refund`);
  });
});
