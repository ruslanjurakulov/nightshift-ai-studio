// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

const push = vi.fn();
const refresh = vi.fn();
const signOut = vi.fn(async () => ({ error: null }));
let pathname = "/chronos/home";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push, refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut } }) }));
vi.mock("@/components/navigation/NavigationProvider", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), channelName: () => null, showChannel: false }),
}));
// The operator bar's event feed reads Supabase; this test is about the account button beside it.
vi.mock("@/components/NotificationsCenter", () => ({ NotificationsCenter: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}`, useChannelSlug: () => "chronos" }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { SideNav } from "@/components/SideNav";
import { Header } from "@/components/Header";
import { AccountSection } from "@/components/account/AccountSection";

const en = dictionaries.en;
const EMAIL = "ana.k@example.com";

const SUMMARY = {
  email: EMAIL,
  plan: { kind: "plan", id: "creator", name: "Creator", isDefault: false, status: "active", periodEnd: null, cancelAtPeriodEnd: false },
  credits: { available: 1240, reserved: 0, spent: 10, fromPlan: 1240, fromTopups: 0 },
  accounts: [{ platform: "youtube", id: "UC1", name: "Night Owl", avatarUrl: null, connected: true }],
  connectable: { instagram: false, tiktok: false },
};

const wrap = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

beforeEach(() => {
  pathname = "/chronos/home";
  push.mockClear();
  refresh.mockClear();
  signOut.mockClear();
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => SUMMARY })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the account is the customer's top-bar avatar below lg", () => {
  it("has one account button, named by what it does, wrapped so it hides from lg where the sidebar card is the account", () => {
    render(wrap(<Header operator={false} credits={null} email={EMAIL} />));
    const button = screen.getByRole("button", { name: en.account.open });
    expect(button.closest(".lg\\:hidden")).not.toBeNull();
    // The e-mail is a tooltip at most, never the button's name.
    expect(button.getAttribute("aria-label")).toBe(en.account.open);
  });

  it("is still the operator's last control on the console bar", () => {
    render(wrap(<Header operator credits={null} email={EMAIL} />));
    expect(screen.getByRole("button", { name: en.account.open })).toBeTruthy();
  });

  it("puts + New project on the bar as a link to the projects shelf: nothing is made or spent by it", () => {
    render(wrap(<Header operator={false} credits={null} email={EMAIL} />));
    const link = screen.getByTestId("topbar-new-project");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/chronos/studio?shelf=projects");
    expect(link.textContent).toContain(en.customerApp.shell.newProject);
  });
});

describe("the bottom bar is the rail's five, with no account tab", () => {
  it("has five tabs, Create in the centre, and draws no avatar", () => {
    render(wrap(<SideNav email={EMAIL} plan={null} />));
    const bar = document.querySelector("nav.ns-tabbar") as HTMLElement;
    expect(bar.querySelectorAll("li")).toHaveLength(5);
    expect(bar.querySelectorAll(".ns-tab-avatar")).toHaveLength(0);
    expect(bar.querySelectorAll("li")[2].textContent).toBe(en.nav.create);
    expect(bar.innerHTML).not.toContain(EMAIL);
  });
});

describe("Settings → Account", () => {
  it("shows the e-mail, the plan, the connected accounts, language, theme and sign out", async () => {
    render(wrap(<AccountSection email={EMAIL} />));
    const section = screen.getByRole("region", { name: en.account.title });
    expect(within(section).getByTestId("account-email").textContent).toBe(EMAIL);
    await waitFor(() => expect(within(section).getByTestId("account-plan").textContent).toContain("Creator"));
    expect(within(section).getByText("Night Owl")).toBeTruthy();
    expect(within(section).getByRole("button", { name: en.common.language })).toBeTruthy();
    expect(within(section).getByRole("button", { name: new RegExp(`^${en.common.theme}`) })).toBeTruthy();
    expect(within(section).getByRole("button", { name: en.common.signOut })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/account", { cache: "no-store" });
  });

  it("reads '—' for what did not come back, never a guess", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(wrap(<AccountSection email={null} />));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.account.loadFailed));
    expect(screen.getByTestId("account-email").textContent).toBe(en.common.dash);
    expect(screen.getByTestId("account-plan").textContent).toBe(en.common.dash);
  });

  it("signs out and goes to /login", async () => {
    render(wrap(<AccountSection email={EMAIL} />));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.common.signOut }));
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/login");
    expect(refresh).toHaveBeenCalled();
  });

  it("is on the Settings page above Account and security, which is above Developers", () => {
    const src = readFileSync(path.join(process.cwd(), "app/(app)/[channel]/organization/page.tsx"), "utf8");
    const a = src.indexOf("<AccountSection");
    const b = src.indexOf("<AccountSecurity");
    const c = src.indexOf("developersTitle");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
