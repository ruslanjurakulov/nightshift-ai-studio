// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
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

// From 768px the links, language, theme, Sign in and Start free are all in the bar (the layout is CSS:
// tests/public-header-fit.test.ts). Below 768px the bar is the wordmark, Start free and a menu button, and the same
// destinations open in a sheet (components/legal/PublicMenu.tsx): at 390px the wrapped rows were 209px of the screen.
const bar = (header: HTMLElement) => [...header.querySelectorAll<HTMLElement>("a[href], button")].filter((el) => !el.closest(".st-menu-root"));

describe("the public header", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    it(`${locale}: every destination is a link or control in the bar, in reading order, then the phone's menu button`, () => {
      const t = dictionaries[locale];
      renderShell(locale);
      const header = document.querySelector("header.st-header") as HTMLElement;

      const nav = within(header).getByRole("navigation", { name: t.landing.nav.label });
      const links = publicNavLinks(t);
      expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(links.map((l) => l.href));

      // Tab order: wordmark, the links, language, theme, (view switch), Sign in, Start free, and the menu button last.
      const order = bar(header).map((el) => el.getAttribute("href") ?? el.getAttribute("data-view-toggle") ?? el.getAttribute("aria-label") ?? "");
      expect(order[0]).toBe("/");
      expect(order.slice(1, 1 + links.length)).toEqual(links.map((l) => l.href));
      expect(order.slice(-3)).toEqual(["/login", "/signup", t.site.nav.menu]);
      expect(within(header).getByRole("button", { name: t.common.language })).toBeTruthy();
      expect(within(header).getByRole("button", { name: new RegExp(`^${t.common.theme}`) })).toBeTruthy();
    });

    it(`${locale}: the menu button names itself, says it is closed, and controls a sheet that holds every destination but Start free`, () => {
      const t = dictionaries[locale];
      renderShell(locale);
      const header = document.querySelector("header.st-header") as HTMLElement;
      const button = header.querySelector<HTMLButtonElement>(".st-menu-btn")!;
      expect(button.getAttribute("aria-label")).toBe(t.site.nav.menu);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      const sheet = document.getElementById(button.getAttribute("aria-controls")!)!;
      expect(sheet.getAttribute("role")).toBe("dialog");
      expect(sheet.getAttribute("aria-modal")).toBe("true");
      expect(sheet.closest(".st-menu-root")?.hasAttribute("hidden")).toBe(true);
      const links = publicNavLinks(t);
      expect([...sheet.querySelectorAll("nav a")].map((a) => a.getAttribute("href"))).toEqual(links.map((l) => l.href));
      expect(sheet.querySelector('a[href="/login"]')?.textContent).toBe(t.site.nav.signIn);
      // One key in the header: Start free stays in the bar, the sheet's Sign in is not a second one.
      expect(header.querySelectorAll("a.st-key")).toHaveLength(1);
    });
  }

  it("opens on a press: aria-expanded, focus moves in and is trapped, Escape closes and returns focus to the button", () => {
    renderShell("en");
    const button = document.querySelector<HTMLButtonElement>(".st-menu-btn")!;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const sheet = screen.getByRole("dialog", { name: "Menu" });
    expect(sheet.closest(".st-menu-root")?.hasAttribute("hidden")).toBe(false);
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Close menu" }));
    expect(document.documentElement.style.overflow).toBe("hidden");

    const items = [...sheet.querySelectorAll<HTMLElement>("a[href], button")];
    // Tab on the last item wraps to the first, Shift+Tab on the first to the last.
    items.at(-1)!.focus();
    fireEvent.keyDown(sheet, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(sheet, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items.at(-1));

    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(sheet.closest(".st-menu-root")?.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("the close button and following a link close it", () => {
    renderShell("en");
    const button = document.querySelector<HTMLButtonElement>(".st-menu-btn")!;
    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Menu" })).getByRole("button", { name: "Close menu" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: "How it works" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("the language and theme controls come before Sign in, which comes before Start free", () => {
    renderShell("en");
    const header = document.querySelector("header.st-header") as HTMLElement;
    const all = bar(header);
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

// Lens review of the phone header (PR 733): each pins a failure seen in the audit build.
describe("the phone header, reviewed", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  // Without JavaScript the rows under the wordmark come back, but the phone bar is nowrap: .st-header-sub (flex 1 0
  // 100%) then sat on the wordmark's line, squeezed it to 0 width and pushed the row past a 390px screen.
  it("without JavaScript the phone bar wraps again, so the restored rows go under the wordmark instead of beside it", () => {
    const t = dictionaries.en;
    const html = renderToStaticMarkup(
      <PublicI18nProvider locale="en" t={publicDictionary(t)}>
        <PublicShell t={t}>
          <p>Behind the header</p>
        </PublicShell>
      </PublicI18nProvider>,
    );
    const css = /<noscript><style>([\s\S]*?)<\/style><\/noscript>/.exec(html)?.[1] ?? "";
    const phone = /^@media \(max-width:767px\)\{([\s\S]*)\}$/.exec(css)?.[1] ?? "";
    expect(phone).toContain(".st-header-row{flex-wrap:wrap!important}");
    expect(phone).toContain(".st-header-sub{display:flex!important}");
    expect(phone).toContain(".st-menu-btn{display:none!important}");
  });

  // Picking a language unmounts its list with focus on the option, and focus falls to <body>: a handler on the sheet
  // then heard neither Escape (the sheet stayed open) nor Tab (it walked into the page behind the scrim).
  it("keeps focus and Escape in the sheet after a language is picked and focus falls to the page", () => {
    renderShell("en");
    const button = document.querySelector<HTMLButtonElement>(".st-menu-btn")!;
    fireEvent.click(button);
    const sheet = screen.getByRole("dialog", { name: "Menu" });
    const items = () => [...sheet.querySelectorAll<HTMLElement>("a[href], button")];

    const lang = within(sheet).getByRole("button", { name: dictionaries.en.common.language });
    fireEvent.click(lang);
    const option = within(sheet).getByRole("option", { name: /Русский/ });
    option.focus();
    // The list is open: Escape belongs to it, and the sheet stays.
    fireEvent.keyDown(option, { key: "Escape" });
    expect(within(sheet).queryByRole("listbox")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(lang);
    const pick = within(sheet).getByRole("option", { name: /Русский/ });
    pick.focus();
    fireEvent.click(pick);
    expect(within(sheet).queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(document.body);

    // Tab from the page goes to the sheet's first item, Shift+Tab to its last.
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.activeElement).toBe(items()[0]);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items().at(-1));

    // Focus that lands behind the sheet is brought back.
    const behind = document.querySelector<HTMLElement>("header.st-header .st-nav a")!;
    behind.focus();
    expect(sheet.contains(document.activeElement)).toBe(true);

    // And Escape from the page closes it, returning focus to the button.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);

    // Closed, the page's own focus is its own again.
    behind.focus();
    expect(document.activeElement).toBe(behind);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(behind);
  });

  // The bar and the sheet each draw a theme toggle; each read the theme once on mount, so a press on one left the other
  // showing the old theme.
  it("the bar's and the sheet's theme toggles agree after either is pressed, and follow a change made elsewhere", async () => {
    const t = dictionaries.en;
    renderShell("en");
    const toggles = () => [...document.querySelectorAll<HTMLButtonElement>("header.st-header button")].filter((b) => b.getAttribute("aria-label")?.startsWith(`${t.common.theme}:`));
    const names = () => toggles().map((b) => b.getAttribute("aria-label"));
    const dark = `${t.common.theme}: ${t.common.dark}`;
    const light = `${t.common.theme}: ${t.common.light}`;
    expect(toggles()).toHaveLength(2);
    // jsdom's media query says light.
    expect(names()).toEqual([light, light]);

    fireEvent.click(toggles()[0]);
    await waitFor(() => expect(names()).toEqual([dark, dark]));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    fireEvent.click(toggles()[1]);
    await waitFor(() => expect(names()).toEqual([light, light]));

    // Set from outside (another tab's choice, through ViewFrame): both follow.
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() => expect(names()).toEqual([dark, dark]));
  });
});
