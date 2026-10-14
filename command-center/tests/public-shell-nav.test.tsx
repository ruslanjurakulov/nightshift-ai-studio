// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PublicShell, publicNavLinks } from "@/components/legal/PublicShell";

afterEach(cleanup);

// The theme key asks the media query for the system theme; jsdom has none.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

function renderShell(locale: "en" | "ru" | "uz") {
  const t = dictionaries[locale];
  return render(
    <PublicI18nProvider locale={locale} t={publicDictionary(t)}>
      <PublicShell t={t}>
        <p>Behind the header</p>
      </PublicShell>
    </PublicI18nProvider>,
  );
}

// There is no menu on the public pages: the links, language, theme, Sign in and Start free are all in the header,
// at every width (the layout under 1024px is CSS: tests/public-header-fit.test.ts, tools/visual-qa/public-header.mjs).
describe("the public header has no menu", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    it(`${locale}: every destination is a visible link or control in the header, in reading order`, () => {
      const t = dictionaries[locale];
      renderShell(locale);
      const header = document.querySelector("header.st-header") as HTMLElement;
      // No disclosure button and no dialog/menu panel.
      expect(header.querySelector("[aria-expanded][aria-controls]")).toBeNull();
      expect(header.querySelector(".st-menu, .st-menu-btn")).toBeNull();

      const nav = within(header).getByRole("navigation", { name: t.landing.nav.label });
      const links = publicNavLinks(t);
      expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(links.map((l) => l.href));

      // Tab order: wordmark, the links, language, theme, (view switch), Sign in, Start free.
      const order = [...header.querySelectorAll<HTMLElement>("a[href], button")].map((el) => el.getAttribute("href") ?? el.getAttribute("data-view-toggle") ?? el.getAttribute("aria-label") ?? "");
      expect(order[0]).toBe("/");
      expect(order.slice(1, 1 + links.length)).toEqual(links.map((l) => l.href));
      expect(order.slice(-2)).toEqual(["/login", "/signup"]);
      expect(within(header).getByRole("button", { name: t.common.language })).toBeTruthy();
      expect(within(header).getByRole("button", { name: new RegExp(`^${t.common.theme}`) })).toBeTruthy();
    });
  }

  it("the language and theme controls come before Sign in, which comes before Start free", () => {
    renderShell("en");
    const header = document.querySelector("header.st-header") as HTMLElement;
    const all = [...header.querySelectorAll<HTMLElement>("a[href], button")];
    const at = (pred: (el: HTMLElement) => boolean) => all.findIndex(pred);
    const lang = at((e) => e.getAttribute("aria-haspopup") === "listbox");
    const signin = at((e) => e.getAttribute("href") === "/login");
    const start = at((e) => e.getAttribute("href") === "/signup");
    expect(lang).toBeGreaterThan(0);
    expect(signin).toBeGreaterThan(lang);
    expect(start).toBeGreaterThan(signin);
    expect(screen.getByText("Behind the header")).toBeTruthy();
  });
});
