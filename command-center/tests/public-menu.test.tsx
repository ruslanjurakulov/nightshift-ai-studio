// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import { dictionaries, getDictionaryFor } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider, usePublicI18n } from "@/lib/i18n/public-context";
import { useI18n } from "@/lib/i18n/context";
import { PublicShell } from "@/components/legal/PublicShell";

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

// jsdom lays nothing out, so every element reads as hidden to `offsetParent`;
// the menu's focus order only needs "is it rendered", which it is here.
Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return this.parentNode; } });

function renderShell() {
  const t = dictionaries.en;
  return render(
    <PublicI18nProvider locale="en" t={publicDictionary(t)}>
      <PublicShell t={t}>
        <a href="/behind">Behind the menu</a>
      </PublicShell>
    </PublicI18nProvider>,
  );
}

describe("the public phone menu", () => {
  it("moves focus into the panel, keeps Tab inside it, and silences the page behind", () => {
    const n = dictionaries.en.landing.nav;
    renderShell();
    const button = screen.getByRole("button", { name: n.menu });
    act(() => button.click());
    const panelLinks = screen.getAllByRole("navigation", { name: n.label }).at(-1)!.querySelectorAll("a");
    expect(document.activeElement).toBe(panelLinks[0]);
    // The page behind the panel is inert: no Tab stop, no click reaches it.
    const main = document.getElementById("main")!;
    expect(main.inert).toBe(true);
    expect(document.querySelector("footer.st-footer")!.inert).toBe(true);

    // Tab from the last control in the panel wraps to the menu button, never into the page.
    const close = screen.getByRole("button", { name: n.close });
    const all = [close, ...document.getElementById(close.getAttribute("aria-controls")!)!.querySelectorAll<HTMLElement>("a[href], button")];
    all.at(-1)!.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(all.at(-1));
  });

  it("closes on Escape, hands focus back to its button and wakes the page", () => {
    const n = dictionaries.en.landing.nav;
    renderShell();
    act(() => screen.getByRole("button", { name: n.menu }).click());
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    const button = screen.getByRole("button", { name: n.menu });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    expect(document.getElementById("main")!.inert).toBe(false);
  });
});

describe("the public pages' dictionary", () => {
  it("carries only the public slice, not the app's screens", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const slice = publicDictionary(getDictionaryFor(locale));
      const json = JSON.stringify(slice);
      expect(json.length).toBeLessThan(JSON.stringify(getDictionaryFor(locale)).length / 5);
      expect(Object.keys(slice)).not.toContain("nav");
      // No setup copy (env-var names, the database vendor) rides along.
      expect(json).not.toMatch(/NEXT_PUBLIC_SUPABASE|Supabase/);
    }
  });

  it("refuses the full-dictionary hook under the public slice, so a misplaced app component fails loudly", () => {
    function NeedsApp() {
      useI18n();
      return null;
    }
    function NeedsPublic() {
      return <span>{usePublicI18n().t.landing.nav.menu}</span>;
    }
    const t = publicDictionary(dictionaries.en);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<PublicI18nProvider locale="en" t={t}><NeedsApp /></PublicI18nProvider>)).toThrow(/I18nProvider/);
    spy.mockRestore();
    render(<PublicI18nProvider locale="en" t={t}><NeedsPublic /></PublicI18nProvider>);
    expect(screen.getByText(dictionaries.en.landing.nav.menu)).toBeTruthy();
  });
});
