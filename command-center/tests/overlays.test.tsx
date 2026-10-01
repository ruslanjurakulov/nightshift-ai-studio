// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const push = vi.fn();
let pathname = "/chronos/videos";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// No Supabase in a unit test: the components degrade to "no data".
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/components/navigation/NavigationProvider", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), channelName: () => null, showChannel: false }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { SideNav } from "@/components/SideNav";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationsCenter } from "@/components/NotificationsCenter";
import { SectionShell } from "@/components/SectionShell";
import { unscopedScope } from "@/lib/channels";

function withI18n(ui: ReactNode, locale: Locale = "en") {
  return <I18nProvider locale={locale}>{ui}</I18nProvider>;
}

beforeEach(() => {
  pathname = "/chronos/videos";
  push.mockClear();
  // jsdom has no matchMedia; nothing here depends on it beyond existing.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(cleanup);

describe("mobile navigation drawer", () => {
  it("is a labelled modal dialog, and Escape closes it and returns focus to Menu", () => {
    render(withI18n(<SideNav operator />));
    const menu = screen.getByRole("button", { name: "Menu" });
    menu.focus();
    fireEvent.click(menu);

    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("names its close button 'close', not 'Menu' — the trigger and the ✕ must not sound the same", () => {
    render(withI18n(<SideNav operator />));
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const dialog = screen.getByRole("dialog");
    const close = dialog.querySelector("button");
    expect(close?.getAttribute("aria-label")).toBe(dictionaries.en.ops.shortcutsClose);
  });

  it("gives a customer a bottom tab bar with Studio in the centre and no drawer", () => {
    render(withI18n(<SideNav />));
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    const bar = screen.getAllByRole("navigation", { name: "Menu" }).at(-1)!;
    const labels = Array.from(bar.querySelectorAll("a")).map((a) => a.textContent);
    expect(labels).toEqual(["Videos", "Channels", "Studio", "Credits", "Settings"]);
  });

  it("keeps Tab inside the open drawer", () => {
    render(withI18n(<SideNav operator />));
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const dialog = screen.getByRole("dialog");
    const items = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button"));
    const last = items[items.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("command palette", () => {
  function open() {
    act(() => {
      window.dispatchEvent(new CustomEvent("chronos:palette-open"));
    });
  }

  it("is a labelled modal dialog that opens on the search field", () => {
    render(withI18n(<CommandPalette scope={unscopedScope()} />));
    open();
    const dialog = screen.getByRole("dialog", { name: dictionaries.en.ops.shortcutsPalette });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape from the search field and from a button inside, and returns focus to the opener", () => {
    render(
      withI18n(
        <>
          <button type="button">opener</button>
          <CommandPalette scope={unscopedScope()} />
        </>,
      ),
    );
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    open();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    // Focus on a result button, not the input: Escape used to do nothing there.
    open();
    const dialog = screen.getByRole("dialog");
    dialog.querySelectorAll("button")[1].focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the shortcuts help is a dialog named by its heading, and Escape closes it", () => {
    render(withI18n(<CommandPalette scope={unscopedScope()} />));
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = screen.getByRole("dialog", { name: dictionaries.en.ops.shortcutsTitle });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("notifications panel", () => {
  it("is a labelled dialog, Escape closes it, and focus returns to the bell", () => {
    render(withI18n(<NotificationsCenter scope={unscopedScope()} />));
    const bell = screen.getByRole("button", { name: dictionaries.en.ops.notifTitle });
    bell.focus();
    fireEvent.click(bell);

    const dialog = screen.getByRole("dialog", { name: dictionaries.en.ops.notifTitle });
    expect(bell.getAttribute("aria-expanded")).toBe("true");
    expect(bell.getAttribute("aria-controls")).toBe(dialog.id);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(bell);
  });

  it("spans the screen on a phone instead of hanging off the left edge", () => {
    render(withI18n(<NotificationsCenter scope={unscopedScope()} />));
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.ops.notifTitle }));
    const cls = screen.getByRole("dialog").className.split(/\s+/);
    // `absolute right-0 w-80` started at x = -92px at 360px wide.
    expect(cls).toContain("fixed");
    expect(cls).toContain("inset-x-3");
    expect(cls).toContain("sm:absolute");
    expect(cls).not.toContain("w-80");
  });

  it("does not leave the page when Escape is pressed with the panel open", () => {
    pathname = "/chronos/agents";
    render(
      withI18n(
        <>
          <NotificationsCenter scope={unscopedScope()} />
          <SectionShell>
            <p>page</p>
          </SectionShell>
        </>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.ops.notifTitle }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("section panel shell", () => {
  it("has one way out for the keyboard: the scrim is not a tab stop or announced", () => {
    pathname = "/chronos/agents";
    render(
      withI18n(
        <SectionShell>
          <p>page</p>
        </SectionShell>,
      ),
    );
    const closers = screen.getAllByRole("button", { name: dictionaries.en.ops.shortcutsClose });
    // The scrim is aria-hidden, so only the ✕ is exposed — and only it is tabbable.
    expect(closers).toHaveLength(1);
    const scrim = document.querySelector<HTMLButtonElement>('button[aria-hidden="true"]');
    expect(scrim?.tabIndex).toBe(-1);
  });

  it("Escape still returns to the Command Center when no dialog is open", () => {
    pathname = "/chronos/agents";
    render(
      withI18n(
        <SectionShell>
          <p>page</p>
        </SectionShell>,
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(push).toHaveBeenCalledWith("/chronos/command-center");
  });
});
