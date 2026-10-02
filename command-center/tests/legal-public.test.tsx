// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LegalDocumentView } from "@/components/legal/LegalDocumentView";
import { dictionaries, type Locale } from "@/lib/i18n";
import { LEGAL_TEXTS } from "@/lib/legal-docs";

/**
 * PIXEL-4 D2: with the operator's details unset, /terms and /privacy printed
 * "NOT CONFIGURED · NEXT_PUBLIC_LEGAL_NAME" (and three more) to the public, in
 * every language. An unset detail now reads "not published yet" in the
 * reader's language; the variable names stay in lib/legal.ts for the deployer.
 */
describe("public legal pages with the operator's details unset", () => {
  it.each(["en", "ru", "uz"] as Locale[])("name no env var and no marker (%s)", (locale) => {
    const t = dictionaries[locale];
    for (const doc of [LEGAL_TEXTS[locale].terms, LEGAL_TEXTS[locale].privacy]) {
      const html = renderToStaticMarkup(<LegalDocumentView doc={doc} t={t} locale={locale} />);
      expect(html).not.toMatch(/NEXT_PUBLIC_|NOT CONFIGURED|НЕ НАСТРОЕНО|SOZLANMAGAN/);
      expect(html).toContain(t.legal.pending);
      expect(html).toContain(t.legal.pendingNote);
      // PIXEL-5 N3: inside a sentence the gap names what is missing, never a bare "not published yet".
      const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
      expect(text).toContain(t.legal.placeholder.legalName);
      expect(text).toContain(t.legal.placeholder.contactEmail);
      expect(text).not.toMatch(new RegExp(`(?:and|и|—) ${t.legal.pending}`));
    }
  });
});

describe("/terms 8.5 states the same expiry as the pricing pages (BR-L-130)", () => {
  const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  const section = (locale: Locale) => {
    const block = LEGAL_TEXTS[locale].terms.sections.flatMap((s) => s.body).find((b) => typeof b === "object" && "creditExpiry" in b);
    if (!block || typeof block !== "object" || !("creditExpiry" in block)) throw new Error("no 8.5");
    return block.creditExpiry;
  };

  it.each(["en", "ru", "uz"] as Locale[])("the catalog's term, a real 'never', or — unknown — no claim at all (%s)", (locale) => {
    const t = dictionaries[locale];
    const doc = LEGAL_TEXTS[locale].terms;
    const ce = section(locale);
    const months = text(renderToStaticMarkup(<LegalDocumentView doc={doc} t={t} locale={locale} expiry={{ kind: "months", months: 12 }} />));
    expect(months).toContain(ce.after.replace("{months}", "12"));
    expect(months).not.toContain(ce.never);
    const unknown = text(renderToStaticMarkup(<LegalDocumentView doc={doc} t={t} locale={locale} expiry={{ kind: "unknown" }} />));
    expect(unknown).not.toContain(ce.never);
    expect(unknown).toContain(ce.unknown.split("{contactEmail}")[0]);
    const never = text(renderToStaticMarkup(<LegalDocumentView doc={doc} t={t} locale={locale} expiry={{ kind: "never" }} />));
    expect(never).toContain(ce.never);
  });
});
