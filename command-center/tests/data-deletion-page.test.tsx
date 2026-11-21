// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /data-deletion: the data deletion instructions Meta's App Settings require before the Instagram connect can go live.
 * It must open signed out in every language, say how to remove the app in Meta and how to disconnect in Nightshift,
 * name the contact address only through NEXT_PUBLIC_CONTACT_EMAIL (never an invented one), promise no deletion time the
 * Privacy Policy does not (30 days), and be linked from the Privacy Policy.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/data-deletion",
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
import { DATA_DELETION_PATH, RESERVED_ROOT_SEGMENTS, SITEMAP_PATHS, gateDecision, isAlwaysPublicPath, isLegalPath } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";
import { UNCOUNTED_PAGE_PATHS } from "@/lib/site-pages";
import { PUBLIC_PAGE_PATHS } from "../next.config";
import DataDeletionPage from "@/app/data-deletion/page";

afterEach(() => {
  cleanup();
  dict.locale = "en";
});

const LOCALES = ["en", "ru", "uz"] as const;

function strings(block: LegalBlock): string[] {
  if (typeof block === "string") return [block];
  if ("list" in block) return block.list;
  if ("note" in block) return [block.note];
  if ("creditExpiry" in block) return [block.creditExpiry.never, block.creditExpiry.after, block.creditExpiry.unknown];
  return [...block.table.head, ...block.table.rows.flat()];
}
const textOf = (doc: LegalDocument) => [doc.title, doc.summary, ...doc.sections.flatMap((s) => [s.heading, ...s.body.flatMap(strings)])].join("\n");

async function pageHtml(locale: (typeof LOCALES)[number]): Promise<string> {
  dict.locale = locale;
  const el = (await DataDeletionPage()) as ReactElement;
  return renderToStaticMarkup(
    <PublicI18nProvider locale={locale} t={publicDictionary(dictionaries[locale])}>
      {el}
    </PublicI18nProvider>,
  );
}

describe.each(LOCALES)("/data-deletion (%s)", (locale) => {
  it("renders every section, with the contact address from the operator settings, never an invented one", async () => {
    const doc = LEGAL_TEXTS[locale].dataDeletion;
    const html = await pageHtml(locale);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    for (const s of doc.sections) expect(html, s.id).toContain(`id="${s.id}"`);
    expect(textOf(doc)).toContain("{contactEmail}");
    expect(textOf(doc)).not.toMatch(/@nightshift|support@/);
    expect(html).not.toMatch(/NEXT_PUBLIC_/);
  });
  it("names where the app is removed in Meta, the disconnect in Nightshift, and only the Privacy Policy's 30 days", () => {
    const text = textOf(LEGAL_TEXTS[locale].dataDeletion);
    expect(text).toContain("https://business.facebook.com/settings");
    expect(text).toMatch(/Integrations|Интеграции/);
    expect(text).toMatch(/Supabase Vault/);
    expect(text).toContain("30");
    expect(text.match(/\d+/g)?.filter((n) => !["1", "2", "3", "4", "8", "30"].includes(n))).toEqual([]);
    expect(text).toContain("(/privacy)");
  });
  it("is linked from the Privacy Policy", () => {
    expect(textOf(LEGAL_TEXTS[locale].privacy)).toContain("(/data-deletion)");
  });
});

describe("/data-deletion is public, reserved and uncounted", () => {
  it("opens signed out and signed in, and no channel can take the word", () => {
    expect(DATA_DELETION_PATH).toBe("/data-deletion");
    expect(isLegalPath(DATA_DELETION_PATH)).toBe(true);
    expect(isAlwaysPublicPath(DATA_DELETION_PATH)).toBe(true);
    expect(gateDecision(DATA_DELETION_PATH, false)).toBe("pass");
    expect(gateDecision(DATA_DELETION_PATH, true)).toBe("pass");
    expect(RESERVED_ROOT_SEGMENTS).toContain("data-deletion");
    expect(isValidChannelId("data-deletion")).toBe(false);
    expect(SITEMAP_PATHS).not.toContain(DATA_DELETION_PATH);
    expect(UNCOUNTED_PAGE_PATHS).toContain(DATA_DELETION_PATH);
    expect(PUBLIC_PAGE_PATHS).toContain(DATA_DELETION_PATH);
  });
});
