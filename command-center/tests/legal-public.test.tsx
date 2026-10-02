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
    }
  });
});
