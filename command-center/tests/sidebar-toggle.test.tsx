// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { CustomerSidebar } from "@/components/shell/CustomerSidebar";
import { SidebarProvider } from "@/components/shell/SidebarState";
import { SIDEBAR_COOKIE, SIDEBAR_KEY } from "@/lib/sidebar-pref";

function sidebar(locale: Locale = "en", initialCollapsed = false) {
  return render(
    <I18nProvider locale={locale}>
      <SidebarProvider initialCollapsed={initialCollapsed}>
        <CustomerSidebar email="me@example.com" plan={null} />
      </SidebarProvider>
    </I18nProvider>,
  );
}

const toggle = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  window.localStorage.clear();
  document.cookie = `${SIDEBAR_COOKIE}=; Path=/; Max-Age=0`;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the sidebar's collapse toggle", () => {
  it("is a named button that says what it does, and flips aria-expanded and the rail", () => {
    const { container } = sidebar();
    const aside = container.querySelector("aside")!;
    const button = toggle("Collapse sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("customer-sidebar-nav");
    expect(document.getElementById("customer-sidebar-nav")).not.toBeNull();
    expect(aside.getAttribute("data-collapsed")).toBe("false");

    fireEvent.click(button);
    const open = toggle("Expand sidebar");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(aside.getAttribute("data-collapsed")).toBe("true");
    // Labels stay reachable: the rail's links keep their names, and say them as tooltips.
    expect(screen.getByRole("link", { name: "Library" }).getAttribute("data-tip")).toBe("Library");

    fireEvent.click(open);
    expect(toggle("Collapse sidebar").getAttribute("aria-expanded")).toBe("true");
    expect(aside.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByRole("link", { name: "Library" }).getAttribute("data-tip")).toBeNull();
  });

  it("on the rail, a row's name shows beside it on hover and on keyboard focus, and goes away after", () => {
    const { container } = sidebar("en", true);
    const aside = container.querySelector("aside")!;
    const row = screen.getByRole("link", { name: "Library" });
    expect(screen.queryByTestId("sidebar-tip")).toBeNull();
    fireEvent.mouseOver(row);
    expect(screen.getByTestId("sidebar-tip").textContent).toBe("Library");
    fireEvent.mouseLeave(aside);
    expect(screen.queryByTestId("sidebar-tip")).toBeNull();

    // Keyboard: only a focus that matches :focus-visible shows it (jsdom does not know the selector, so say so).
    const real = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) {
      return sel === ":focus-visible" ? true : real.call(this, sel);
    });
    fireEvent.focus(row);
    expect(screen.getByTestId("sidebar-tip").textContent).toBe("Library");
    fireEvent.blur(row);
    expect(screen.queryByTestId("sidebar-tip")).toBeNull();
  });

  it("an open sidebar shows no tooltip (the names are written out)", () => {
    sidebar();
    fireEvent.mouseOver(screen.getByRole("link", { name: "Library" }));
    expect(screen.queryByTestId("sidebar-tip")).toBeNull();
  });

  it("remembers the choice: written to storage and the cookie, read back on the next visit", () => {
    sidebar();
    fireEvent.click(toggle("Collapse sidebar"));
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");
    expect(document.cookie).toContain(`${SIDEBAR_COOKIE}=collapsed`);
    cleanup();

    // A new visit whose server draw did not know (no cookie sent): the browser's own memory wins once mounted.
    sidebar();
    expect(toggle("Expand sidebar").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle("Expand sidebar"));
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("open");
  });

  it("draws the rail from the first frame when the server says collapsed", () => {
    const { container } = sidebar("en", true);
    expect(container.querySelector("aside")!.getAttribute("data-collapsed")).toBe("true");
    expect(toggle("Expand sidebar")).toBeTruthy();
  });

  it("still works when storage throws: the visit is toggled, nothing is remembered, nothing breaks", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { container } = sidebar();
    const aside = container.querySelector("aside")!;
    expect(aside.getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(toggle("Collapse sidebar"));
    expect(aside.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(toggle("Expand sidebar"));
    expect(aside.getAttribute("data-collapsed")).toBe("false");
  });

  it("says the same in Russian and Uzbek", () => {
    for (const locale of ["ru", "uz"] as const) {
      const d = dictionaries[locale].shell;
      expect(d.collapseSidebar).toBeTruthy();
      expect(d.expandSidebar).toBeTruthy();
      expect(d.collapseSidebar).not.toBe(d.expandSidebar);
      cleanup();
      sidebar(locale);
      expect(toggle(d.collapseSidebar).getAttribute("aria-expanded")).toBe("true");
    }
  });

  it("is a 44px key with a visible focus ring (the stylesheet says so)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(__dirname, "../app/(app)/app-redesign.css"), "utf8");
    const rule = css.match(/\.shell-sidebar-toggle \{([^}]*)\}/)![1];
    expect(rule).toMatch(/width: 44px/);
    expect(rule).toMatch(/height: 44px/);
    expect(readFileSync(join(__dirname, "../app/globals.css"), "utf8")).toMatch(/:focus-visible \{\s*outline: 3px solid var\(--ns-focus\);/);
  });
});
