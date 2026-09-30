// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiDocs } from "@/components/docs/ApiDocs";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";
import { dictionaries, type Locale } from "@/lib/i18n";
import { LEGAL_TEXTS } from "@/lib/legal-docs";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

describe("scrollable regions are keyboard-reachable and named", () => {
  // A box that scrolls sideways must be a tab stop (axe: scrollable-region-focusable)
  // and a focusable box needs a name. Without them a keyboard user cannot read
  // the part of a table or code sample that is off the edge of a phone.
  function scrollBoxes(html: string) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll("pre, table")).map((el) => {
      const box = el.tagName === "PRE" ? el : el.parentElement!;
      return { tag: el.tagName, tabindex: box.getAttribute("tabindex"), role: box.getAttribute("role"), label: box.getAttribute("aria-label") };
    });
  }

  it("API reference: every code block and table", () => {
    const t = dictionaries.en;
    const html = renderToStaticMarkup(
      <ApiDocs prices={null} origin="https://example.test" labels={{ table: t.common.scrollTable, code: t.common.scrollCode }} />,
    );
    const boxes = scrollBoxes(html);
    expect(boxes.filter((b) => b.tag === "PRE").length).toBeGreaterThan(5);
    expect(boxes.filter((b) => b.tag === "TABLE").length).toBeGreaterThan(2);
    for (const b of boxes) {
      expect(b.tabindex).toBe("0");
      expect(b.role).toBe("region");
      expect(b.label).toBe(b.tag === "PRE" ? t.common.scrollCode : t.common.scrollTable);
    }
  });

  it.each(LOCALES)("legal documents (%s): every table", (locale) => {
    const t = dictionaries[locale];
    const boxes = [LEGAL_TEXTS[locale].privacy, LEGAL_TEXTS[locale].terms].flatMap((doc) =>
      scrollBoxes(renderToStaticMarkup(<LegalDocumentView doc={doc} t={t} locale={locale} />)),
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b).toMatchObject({ tabindex: "0", role: "region", label: t.common.scrollTable });
    }
  });

  it("the not-configured badge may wrap: a nowrap badge made /privacy and /terms scroll sideways at 360px", () => {
    const t = dictionaries.en;
    const html = renderToStaticMarkup(<LegalDocumentView doc={LEGAL_TEXTS.en.privacy} t={t} locale="en" />);
    expect(html).not.toContain("whitespace-nowrap");
  });

  it("the new labels exist in every language and differ from English where they should", () => {
    for (const locale of LOCALES) {
      const c = dictionaries[locale].common;
      expect(c.scrollTable.length).toBeGreaterThan(3);
      expect(c.scrollCode.length).toBeGreaterThan(3);
    }
    expect(dictionaries.ru.common.scrollTable).not.toBe(dictionaries.en.common.scrollTable);
    expect(dictionaries.uz.common.scrollCode).not.toBe(dictionaries.en.common.scrollCode);
  });
});

describe("touch-target utility in globals.css", () => {
  const block = css.slice(css.indexOf("Touch targets"));

  it("applies on touch devices and on phone-width viewports, at 40px", () => {
    expect(block).toMatch(/@media \(pointer: coarse\), \(max-width: 40rem\)/);
    expect(block).toMatch(/\.tap-icon,[\s\S]*?\{ min-height: 2\.5rem; min-width: 2\.5rem; \}/);
    expect(block).toMatch(/\.tap-link \{[^}]*min-height: 2\.5rem/);
    expect(block).toMatch(/\.btn-sky,/);
    expect(block).toMatch(/\.sheet-close,\s*\.nav-back \{ width: 2\.5rem; height: 2\.5rem; \}/);
  });

  it("covers text fields and selects but not checkboxes (their label row is the target)", () => {
    expect(block).toMatch(/input:not\(\[type="checkbox"\]/);
    expect(block).toMatch(/\.tap-row \{[^}]*min-height: 2\.5rem/);
  });
});
