// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), signOut: vi.fn(async () => ({ error: null })), reload: vi.fn() }));
let pathname = "/chronos/home";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: mocks.signOut } }) }));
vi.mock("@/lib/credits-live", () => ({ useLiveCreditsState: () => ({ account: null, stale: false }) }));
vi.mock("@/components/view-mode/frame-nav", () => ({ reloadTop: mocks.reload }));
// These siblings have their own remote subscriptions; they are not the account interaction under test.
vi.mock("@/components/NotificationsCenter", () => ({ NotificationsCenter: () => null }));
vi.mock("@/components/shell/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/UtcClock", () => ({ UtcClock: () => null }));

import { AccountMenu } from "@/components/account/AccountMenu";
import { Header } from "@/components/Header";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Wordmark } from "@/components/site/Wordmark";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, LOCALES } from "@/lib/i18n";
import { THEME_KEY } from "@/lib/theme";

const en = dictionaries.en;
const EMAIL = "premium-owner@example.test";
const summary = {
  email: EMAIL,
  plan: { kind: "plan", id: "creator", name: "Creator", isDefault: false, status: "active", periodEnd: null, cancelAtPeriodEnd: false },
  credits: { available: 60, reserved: 4, spent: 12, fromPlan: 60, fromTopups: 0 },
  accounts: [{ platform: "youtube", id: "synthetic-channel", name: "Synthetic channel", avatarUrl: null, connected: true }],
  connectable: { instagram: false, tiktok: false },
};
const wrap = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const open = () => {
  const trigger = screen.getByRole("button", { name: en.account.open });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: en.account.title }) };
};

beforeEach(() => {
  vi.clearAllMocks();
  pathname = "/chronos/home";
  document.documentElement.setAttribute("data-theme", "dark");
  localStorage.clear();
  document.cookie = "ns_view=; max-age=0; path=/";
  window.matchMedia = vi.fn((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  Object.defineProperty(window.screen, "width", { configurable: true, value: 390 });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 844 });
  Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => false });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => summary })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-theme"); });

describe("D1 shared account entry", () => {
  it("gives ordinary customers the top-bar account entry while keeping it read-only", async () => {
    render(wrap(<Header operator={false} email={EMAIL} />));
    const { dialog } = open();
    await within(dialog).findByText("Synthetic channel");
    expect(within(dialog).getByRole("link", { name: en.account.settings }).getAttribute("href")).toBe("/chronos/organization");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/account", { cache: "no-store" });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each([
    { operator: false, route: "/home" },
    { operator: true, route: "/command-center" },
    { operator: false, route: "/studio" },
    { operator: true, route: "/studio" },
  ])("keeps the account last in the $route header (operator=$operator) without duplicate preferences", ({ operator, route }) => {
    pathname = `/chronos${route}`;
    render(wrap(<Header operator={operator} email={EMAIL} />));
    const header = screen.getByRole("banner");
    const trigger = within(header).getByRole("button", { name: en.account.open });
    const controls = header.querySelectorAll("a[href],button");
    expect(controls.item(controls.length - 1)).toBe(trigger);
    expect(within(header).queryByRole("button", { name: en.common.language })).toBeNull();
    expect(within(header).queryByRole("button", { name: new RegExp(`^${en.common.theme}`) })).toBeNull();
    expect(within(header).queryByRole("button", { name: /Mobile.*Desktop|Desktop.*Mobile/ })).toBeNull();
    expect(within(header).queryByRole("link", { name: /Owner Command/i })).toBeNull();
  });

  it("uses the owner's unchanged N drawing for the trigger and preserves the private profile photo in the panel", () => {
    const art = render(<Wordmark mark />);
    const expectedPaths = [...art.container.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    art.unmount();
    render(wrap(<AccountMenu email={EMAIL} avatarV={7} />));
    const trigger = screen.getByRole("button", { name: en.account.open });
    const mark = trigger.querySelector('svg[data-wordmark="mark"]');
    expect(mark, "Account entry must use the existing brand N, not an email initial or a new logo").not.toBeNull();
    expect([...mark!.querySelectorAll("path")].map((p) => p.getAttribute("d"))).toEqual(expectedPaths);
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(trigger);
    const photo = screen.getByRole("dialog").querySelector("img");
    expect(photo, "Changing the trigger must not remove the user's profile photo").not.toBeNull();
    expect(photo!.getAttribute("src")).toBe("/api/avatar?v=7");
    expect(photo!.getAttribute("alt")).toBe("");
  });

  it("keeps language, device and theme actions in the panel rather than hiding them above a breakpoint", () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    const language = within(dialog).getByRole("group", { name: en.common.language });
    // jsdom has no media layout: assert that the actionable section has no responsive hide ancestor.
    for (let e: Element | null = language; e && e !== dialog; e = e.parentElement) {
      expect(e.className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):hidden(?:\s|$)/);
    }
    for (const l of LOCALES) expect(within(language).getByRole("button", { name: l.label })).toBeTruthy();
    const theme = within(dialog).getByRole("group", { name: en.common.theme });
    expect(within(theme).getByRole("button", { name: en.common.light })).toBeTruthy();
    expect(within(theme).getByRole("button", { name: en.common.dark })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Mobile|Desktop/ })).toBeTruthy();
  });

  it("changes language through the existing provider and keeps the menu usable", () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    expect(within(dialog).queryByRole("banner")).toBeNull();
    expect(within(dialog).getByRole("navigation", { name: en.account.title })).toBeTruthy();
    const uz = LOCALES.find((l) => l.code === "uz")!;
    fireEvent.click(within(dialog).getByRole("button", { name: uz.label }));
    expect(screen.getByRole("dialog", { name: dictionaries.uz.account.title })).toBeTruthy();
    expect(screen.getByRole("link", { name: dictionaries.uz.account.settings }).getAttribute("href")).toBe("/chronos/organization");
    expect(mocks.refresh).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("wraps keyboard focus, closes with Escape and returns focus to its trigger", () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { trigger, dialog } = open();
    expect(document.activeElement).toBe(dialog);
    const first = within(dialog).getByRole("button", { name: en.account.close });
    const last = within(dialog).getByRole("button", { name: en.common.signOut });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps settings and sign-out available when the read fails instead of guessing a balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    await within(dialog).findByText(en.account.loadFailed);
    expect(within(dialog).getByRole("link", { name: en.account.settings })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: en.common.signOut })).toBeTruthy();
    expect(dialog.textContent).not.toContain("60");
    fireEvent.keyDown(document, { key: "Escape" });
    open();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("keeps device switching on the existing local preference path with no paid request", () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    fireEvent.click(within(dialog).getByRole("button", { name: /Mobile.*Desktop/ }));
    expect(document.cookie).toContain("ns_view=");
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves the public default theme toggle as one reversible control", () => {
    render(wrap(<ThemeToggle />));
    expect(screen.queryByRole("group", { name: en.common.theme })).toBeNull();
    const button = screen.getByRole("button", { name: `${en.common.theme}: ${en.common.dark}` });
    fireEvent.click(button);
    expect(button.getAttribute("aria-label")).toBe(`${en.common.theme}: ${en.common.light}`);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    fireEvent.click(button);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("chooses either theme without touching account data or adding visible theme text", async () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    const group = within(dialog).getByRole("group", { name: en.common.theme });
    const light = within(group).getByRole("button", { name: en.common.light });
    const dark = within(group).getByRole("button", { name: en.common.dark });
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(light);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(light.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(dark);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(group.textContent).toBe("");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("links Personal Studio to the existing scoped route and offers no premature Owner Command mode", () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    expect(within(dialog).getByRole("link", { name: en.account.personalStudio }).getAttribute("href")).toBe("/chronos/studio");
    expect(within(dialog).queryByRole("link", { name: /Owner Command/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Owner Command/i })).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("signs out through the shared handler and returns to login", async () => {
    render(wrap(<AccountMenu email={EMAIL} />));
    const { dialog } = open();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: en.common.signOut })); });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith("/login");
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
