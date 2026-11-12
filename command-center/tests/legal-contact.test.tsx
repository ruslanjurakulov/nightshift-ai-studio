// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * The contact address on /terms, /privacy and /refund, and the footer link that
 * leads to it.
 *
 * What would break without these: the address turning into an icon-only button
 * (Paddle's reviewer, and a reader with no mail client, must be able to read it
 * without clicking); the footer's Contact link pointing at an id that no longer
 * exists, or at one that exists twice; an unset or malformed address rendered as
 * a live mailto: link; and the label drifting between the card and the footer.
 */

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// LEGAL is read from the environment once, at import. The mock hands the
// components one object the tests refill through the real parser, so "unset"
// and "malformed" mean here exactly what they mean in production.
const legal = vi.hoisted(() => ({
  legalName: null as string | null,
  contactEmail: null as string | null,
  country: null as string | null,
  effectiveDate: null as string | null,
}));
vi.mock("@/lib/legal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/legal")>()), LEGAL: legal }));

import { LegalDocumentView } from "@/components/legal/LegalDocumentView";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { dictionaries, type Locale } from "@/lib/i18n";
import { CONTACT_BLOCK_ID, CONTACT_HREF, readLegalConfig } from "@/lib/legal";
import { LEGAL_TEXTS } from "@/lib/legal-docs";

const LOCALES: Locale[] = ["uz", "en", "ru"];
const DOCS = ["terms", "privacy", "refund"] as const;
const ADDRESS = "support@nightshift-ai.studio";

function configure(contact: string | undefined) {
  Object.assign(
    legal,
    readLegalConfig({
      NEXT_PUBLIC_LEGAL_NAME: "Ruslan Jurakulov (NIGHTSHIFT AI Studio)",
      NEXT_PUBLIC_LEGAL_COUNTRY: "Uzbekistan",
      NEXT_PUBLIC_CONTACT_EMAIL: contact,
    }),
  );
}

function renderDoc(locale: Locale, doc: (typeof DOCS)[number]) {
  const t = dictionaries[locale];
  const { container } = render(<LegalDocumentView doc={LEGAL_TEXTS[locale][doc]} t={t} locale={locale} />);
  const blocks = container.querySelectorAll<HTMLElement>(`[id="${CONTACT_BLOCK_ID}"]`);
  // The contact row: the <div> whose <dt> is the label.
  const row = [...blocks[0].querySelectorAll("dt")].find((dt) => dt.textContent === t.legal.contact)?.parentElement;
  if (!row) throw new Error(`no "${t.legal.contact}" row`);
  return { t, container, blocks, row };
}

afterEach(() => {
  cleanup();
  configure(undefined);
});

describe("the contact row of the operator-details card", () => {
  it("is labelled Aloqa / Contact / Контакты, the same word the footer uses", () => {
    expect(LOCALES.map((l) => dictionaries[l].legal.contact)).toEqual(["Aloqa", "Contact", "Контакты"]);
    for (const l of LOCALES) expect(dictionaries[l].site.footer.contact, l).toBe(dictionaries[l].legal.contact);
  });

  it.each(LOCALES.flatMap((l) => DOCS.map((d) => [l, d] as const)))(
    "%s /%s: a mailto: key whose visible text, and accessible name, is the address itself",
    (locale, doc) => {
      configure(ADDRESS);
      const { row } = renderDoc(locale, doc);
      const link = within(row).getByRole("link", { name: ADDRESS });
      expect(link.getAttribute("href")).toBe(`mailto:${ADDRESS}`);
      // The whole address, as text, with nothing hidden and nothing added: what a reader copies is what they can write to.
      expect(link.textContent).toBe(ADDRESS);
      // Named outright: the name computed from the wrapped pieces has a space after the @.
      expect(link.getAttribute("aria-label")).toBe(ADDRESS);
      expect(link.querySelector("[aria-hidden='true'], .sr-only, [hidden]")?.tagName.toLowerCase()).toBe("svg");
      // The envelope is decoration: it must not become the link's name or a second one.
      expect(link.querySelectorAll("svg")).toHaveLength(1);
      // The site's quiet key (components/site/site.css), which carries the 44px target and the focus ring.
      expect(link.classList.contains("st-key")).toBe(true);
      expect(link.getAttribute("data-tone")).toBe("quiet");
      // No new tab: a mailto: link has no page to open.
      expect(link.getAttribute("target")).toBeNull();
    },
  );

  it("lets a long address wrap instead of widening a 320px page", () => {
    configure(ADDRESS);
    const { row } = renderDoc("uz", "terms");
    const link = within(row).getByRole("link", { name: ADDRESS });
    expect(link.classList.contains("max-w-full")).toBe(true);
    expect(link.querySelector("span")?.className).toMatch(/whitespace-normal/);
    expect(link.outerHTML).not.toContain("whitespace-nowrap");
  });

  it.each(LOCALES.flatMap((l) => DOCS.map((d) => [l, d] as const)))("%s /%s: with no address set it says so, and links nothing", (locale, doc) => {
    configure(undefined);
    const { t, row, container } = renderDoc(locale, doc);
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.querySelector("dd")?.textContent).toBe(t.legal.pending);
    expect(container.querySelector("a[href^='mailto:']")).toBeNull();
    expect(container.textContent).toContain(t.legal.pendingNote);
  });

  it.each(["support@nightshift-ai.studio?cc=someone@example.com", "not an address", "a@b", "  "])(
    "treats a malformed address (%j) as unset rather than linking it",
    (bad) => {
      configure(bad);
      const { t, row, container } = renderDoc("en", "terms");
      expect(row.querySelector("dd")?.textContent).toBe(t.legal.pending);
      expect(container.querySelector("a[href^='mailto:']")).toBeNull();
    },
  );
});

describe("the anchor the footer's Contact link lands on", () => {
  it.each(LOCALES.flatMap((l) => DOCS.map((d) => [l, d] as const)))("%s /%s: one element carries the id, set or unset", (locale, doc) => {
    for (const contact of [ADDRESS, undefined]) {
      configure(contact);
      const { blocks, container } = renderDoc(locale, doc);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].tagName.toLowerCase()).toBe("dl");
      // Every id on the page is unique: a section called the same would win the anchor on some documents.
      const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      cleanup();
    }
  });

  it("is not an id a legal document's section uses, in any language", () => {
    for (const locale of LOCALES) {
      for (const doc of DOCS) {
        expect(LEGAL_TEXTS[locale][doc].sections.map((s) => s.id), `${locale} ${doc}`).not.toContain(CONTACT_BLOCK_ID);
      }
    }
  });

  it("is on /terms", () => {
    expect(CONTACT_HREF).toBe(`/terms#${CONTACT_BLOCK_ID}`);
    expect(CONTACT_HREF).toBe("/terms#contact-details");
  });
});

describe("the public footer's Contact link", () => {
  it.each(LOCALES)("%s: one link, named as the card's row, to the card: with an address set or not", (locale) => {
    const t = dictionaries[locale];
    for (const contact of [ADDRESS, undefined]) {
      configure(contact);
      render(<PublicFooter t={t} />);
      const links = screen.getAllByRole("link", { name: t.site.footer.contact });
      expect(links, String(contact)).toHaveLength(1);
      expect(links[0].getAttribute("href")).toBe(CONTACT_HREF);
      expect(links[0].getAttribute("target")).toBeNull();
      cleanup();
    }
  });

  it("still prints the address itself beside the wordmark when one is set, and nothing when none is", () => {
    configure(ADDRESS);
    render(<PublicFooter t={dictionaries.uz} />);
    expect(screen.getByRole("link", { name: ADDRESS }).getAttribute("href")).toBe(`mailto:${ADDRESS}`);
    cleanup();
    configure(undefined);
    const { container } = render(<PublicFooter t={dictionaries.uz} />);
    expect(container.querySelector("a[href^='mailto:']")).toBeNull();
  });
});
