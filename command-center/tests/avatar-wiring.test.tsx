// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

/**
 * Profile photo, step 2: the photo (or, without one, the initial) wherever the initial circle was drawn, the uploader in
 * Settings → Account, and the phone's shortcut to the invite card. The photo route is never reached: an <img> only
 * has a src here, and a load failure is simulated with the error event.
 */

const push = vi.fn();
const refresh = vi.fn();
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
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: vi.fn(), updateUser: vi.fn() } }) }));
vi.mock("@/components/navigation/NavigationProvider", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), channelName: () => null, showChannel: false }),
}));
vi.mock("@/components/NotificationsCenter", () => ({ NotificationsCenter: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { SideNav } from "@/components/SideNav";
import { Header } from "@/components/Header";
import { AccountSection } from "@/components/account/AccountSection";
import { AccountMenu } from "@/components/account/AccountMenu";
import { avatarVersionFromMetadata } from "@/lib/avatar";
import { inviteCardShown } from "@/lib/credits";
import { DEFAULT_ORG_ID } from "@/lib/orgs";
import { Avatar } from "@/components/account/Avatar";
import { ScrollToHash } from "@/components/navigation/ScrollToHash";

const en = dictionaries.en;
const EMAIL = "ana.k@example.com";
const V = 1760000000000;
const PHOTO = `/api/avatar?v=${V}`;

const summary = (plan: unknown) => ({
  email: EMAIL,
  plan,
  credits: { available: 1240, reserved: 0, spent: 10, fromPlan: 1240, fromTopups: 0 },
  accounts: [],
  connectable: { instagram: false, tiktok: false },
});
const PAID = { kind: "plan", id: "creator", name: "Creator", isDefault: false, status: "active", periodEnd: null, cancelAtPeriodEnd: false };

const wrap = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

beforeEach(() => {
  pathname = "/chronos/home";
  refresh.mockClear();
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => summary(PAID) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = () => document.querySelector("nav.ns-tabbar") as HTMLElement;
const settingsTab = () => within(bar()).getByRole("link", { name: en.nav.settings });

describe("the version marker", () => {
  it("is read from the auth user's metadata, and only a positive safe integer counts", () => {
    expect(avatarVersionFromMetadata({ avatar_v: V })).toBe(V);
    for (const bad of ["1", 1.5, 0, -3, null, undefined, {}, [], Number.MAX_SAFE_INTEGER + 2]) {
      expect(avatarVersionFromMetadata({ avatar_v: bad })).toBeNull();
    }
    expect(avatarVersionFromMetadata(undefined)).toBeNull();
  });

  it("is read from the user the layout and the Settings page already fetch, not from a new request", () => {
    const layout = readFileSync(path.join(process.cwd(), "app/(app)/layout.tsx"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "app/(app)/[channel]/organization/page.tsx"), "utf8");
    expect(layout).toContain("avatarVersionFromMetadata(user?.user_metadata)");
    expect(page).toContain("avatarVersionFromMetadata(user?.user_metadata)");
    expect(layout.match(/getUser\(\)/g)).toHaveLength(1);
    expect(layout).toContain("avatarV={avatarV}");
  });
});

describe("the bottom bar's Settings tab", () => {
  it("shows the photo, still named only 'Settings', with the photo hidden from assistive tech", () => {
    render(wrap(<SideNav email={EMAIL} avatarV={V} plan={null} />));
    const link = settingsTab();
    const img = link.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(PHOTO);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(link.querySelector(".ns-tab-avatar")?.getAttribute("aria-hidden")).toBe("true");
    expect(link.getAttribute("aria-label")).toBeNull();
    expect(link.getAttribute("title")).toBeNull();
    // getByRole matched on the exact name "Settings": the aria-hidden circle adds nothing to it.
    expect(link.querySelector("span.truncate")?.textContent).toBe(en.nav.settings);
    // Neither the e-mail nor a derived string is anywhere in the bar.
    expect(bar().innerHTML).not.toContain(EMAIL);
    expect(bar().innerHTML).not.toContain("ana.k");
  });

  it("draws the initial when there is no photo", () => {
    render(wrap(<SideNav email={EMAIL} avatarV={null} plan={null} />));
    const circle = settingsTab().querySelector(".ns-tab-avatar") as HTMLElement;
    expect(circle.textContent).toBe("A");
    expect(circle.querySelector("img")).toBeNull();
  });

  it("falls back to the initial when the photo does not load (no bucket, a lapsed session, a gone file)", () => {
    render(wrap(<SideNav email={EMAIL} avatarV={V} plan={null} />));
    const img = settingsTab().querySelector("img") as HTMLImageElement;
    fireEvent.error(img);
    const circle = settingsTab().querySelector(".ns-tab-avatar") as HTMLElement;
    expect(circle.querySelector("img")).toBeNull();
    expect(circle.textContent).toBe("A");
    expect(settingsTab()).toBeTruthy(); // still found by the exact name "Settings"
  });

  it("keeps the selected state on the circle with a photo", () => {
    pathname = "/chronos/organization";
    render(wrap(<SideNav email={EMAIL} avatarV={V} plan={null} />));
    expect(settingsTab().getAttribute("aria-current")).toBe("page");
    expect(settingsTab().querySelector(".ns-tab-avatar")?.classList.contains("is-current")).toBe(true);
    expect(settingsTab().querySelector("img")).not.toBeNull();
  });

  it("ignores a wrong marker: a bad version means the initial", () => {
    render(wrap(<SideNav email={EMAIL} avatarV={avatarVersionFromMetadata({ avatar_v: "../x" })} plan={null} />));
    expect(settingsTab().querySelector("img")).toBeNull();
    expect(settingsTab().querySelector(".ns-tab-avatar")?.textContent).toBe("A");
  });
});

describe("the account menu", () => {
  it("the sidebar card shows the photo, and the open panel's header shows it too, never in a name or title", async () => {
    render(wrap(<AccountMenu email={EMAIL} avatarV={V} variant="card" plan={null} />));
    const trigger = screen.getByRole("button", { name: en.account.open });
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe(PHOTO);
    expect(trigger.querySelector("img")?.getAttribute("alt")).toBe("");
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog");
    expect(panel.querySelector("img")?.getAttribute("src")).toBe(PHOTO);
    for (const img of Array.from(document.querySelectorAll("img"))) {
      expect(img.getAttribute("alt")).toBe("");
      expect(img.getAttribute("title")).toBeNull();
    }
  });

  it("the card falls back to the initial when the photo fails, and without a photo", () => {
    const { unmount } = render(wrap(<AccountMenu email={EMAIL} avatarV={V} variant="card" plan={null} />));
    const trigger = screen.getByRole("button", { name: en.account.open });
    fireEvent.error(trigger.querySelector("img") as HTMLImageElement);
    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger.querySelector("[data-avatar]")?.textContent).toBe("A");
    unmount();
    render(wrap(<AccountMenu email={EMAIL} avatarV={null} variant="card" plan={null} />));
    expect(screen.getByRole("button", { name: en.account.open }).querySelector("img")).toBeNull();
  });

  it("the operator's bar button shows the photo", () => {
    render(wrap(<Header operator credits={null} email={EMAIL} avatarV={V} />));
    const button = screen.getByRole("button", { name: en.account.open });
    expect(button.querySelector("img")?.getAttribute("src")).toBe(PHOTO);
  });

  it("the customer's top bar still has no account button, with or without a photo", () => {
    render(wrap(<Header operator={false} credits={null} email={EMAIL} avatarV={V} />));
    expect(screen.queryByRole("button", { name: en.account.open })).toBeNull();
  });

  it("the sidebar (from lg) hands the card the same version", () => {
    render(wrap(<SideNav email={EMAIL} avatarV={V} plan={null} />));
    const card = document.querySelector("[data-shell-usercard]") as HTMLElement;
    expect(card.querySelector("img")?.getAttribute("src")).toBe(PHOTO);
  });
});

describe("Settings → Your account", () => {
  it("mounts the photo uploader above the e-mail row, showing the photo and offering to change or remove it", async () => {
    render(wrap(<AccountSection email={EMAIL} avatarV={V} />));
    const section = screen.getByRole("region", { name: en.account.title });
    const uploader = within(section).getByTestId("avatar-uploader");
    const email = within(section).getByTestId("account-email");
    expect(uploader.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(uploader.querySelector("img")?.getAttribute("src")).toBe(PHOTO);
    expect(within(uploader).getByRole("button", { name: en.avatar.change })).toBeTruthy();
    expect(within(uploader).getByRole("button", { name: en.avatar.remove })).toBeTruthy();
    await waitFor(() => expect(within(section).getByTestId("account-plan").textContent).toContain("Creator"));
  });

  it("without a photo it offers to add one and shows the initial", () => {
    render(wrap(<AccountSection email={EMAIL} avatarV={null} />));
    const uploader = screen.getByTestId("avatar-uploader");
    expect(uploader.querySelector("img")).toBeNull();
    expect(uploader.querySelector("[data-avatar]")?.textContent).toBe("A");
    expect(within(uploader).getByRole("button", { name: en.avatar.add })).toBeTruthy();
    expect(within(uploader).queryByRole("button", { name: en.avatar.remove })).toBeNull();
  });

  it("shows the initial, not a broken image, when the photo cannot be loaded", () => {
    render(wrap(<AccountSection email={EMAIL} avatarV={V} />));
    const uploader = screen.getByTestId("avatar-uploader");
    fireEvent.error(uploader.querySelector("img") as HTMLImageElement);
    expect(uploader.querySelector("img")).toBeNull();
    expect(uploader.querySelector("[data-avatar]")?.textContent).toBe("A");
  });

  it("follows the version the page hands down after an upload or removal (router.refresh), with no reload", () => {
    const { rerender } = render(wrap(<AccountSection email={EMAIL} avatarV={null} />));
    expect(screen.getByTestId("avatar-uploader").querySelector("img")).toBeNull();
    rerender(wrap(<AccountSection email={EMAIL} avatarV={V + 5} />));
    expect(screen.getByTestId("avatar-uploader").querySelector("img")?.getAttribute("src")).toBe(`/api/avatar?v=${V + 5}`);
    rerender(wrap(<AccountSection email={EMAIL} avatarV={null} />));
    expect(screen.getByTestId("avatar-uploader").querySelector("img")).toBeNull();
  });

  it("a failed removal says it could not be removed, not that it could not be saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) =>
      init?.method === "DELETE" ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => summary(PAID) },
    ));
    render(wrap(<AccountSection email={EMAIL} avatarV={V} />));
    fireEvent.click(screen.getByRole("button", { name: en.avatar.remove }));
    const alert = await screen.findByTestId("avatar-error");
    expect(alert.textContent).toBe(en.avatar.errors.remove_failed);
    for (const l of ["en", "ru", "uz"] as const) {
      expect(dictionaries[l].avatar.errors.remove_failed.length).toBeGreaterThan(5);
      expect(dictionaries[l].avatar.errors.remove_failed).not.toBe(dictionaries[l].avatar.errors.failed);
    }
  });

  it("an uploader that changes the photo asks the app to refresh, so every circle updates", () => {
    const src = readFileSync(path.join(process.cwd(), "components/account/AvatarUploader.tsx"), "utf8");
    expect(src.match(/router\.refresh\(\)/g)?.length).toBe(2); // after save and after remove
    expect(src).toContain("auth.updateUser");
  });
});

describe("the invite shortcut", () => {
  it("is one row in Settings → Your account that links to the invite card on Credits", () => {
    render(wrap(<AccountSection email={EMAIL} showInvite />));
    const link = screen.getByRole("link", { name: en.account.inviteFriends });
    expect(link.getAttribute("href")).toBe("/chronos/credits#invite");
    expect(screen.getAllByRole("link", { name: en.account.inviteFriends })).toHaveLength(1);
  });

  it("is not drawn unless the page says the invite card exists, and never waits on the account read", () => {
    render(wrap(<AccountSection email={EMAIL} />));
    expect(screen.queryByRole("link", { name: en.account.inviteFriends })).toBeNull();
  });

  it("is decided by the same predicate as the Credits page's card", () => {
    const ORG = "11111111-2222-3333-4444-555555555555";
    expect(inviteCardShown({ id: ORG, is_default: false }, "ok")).toBe(true);
    expect(inviteCardShown({ id: ORG }, "failed")).toBe(true);
    expect(inviteCardShown({ id: ORG, is_default: false }, "unsupported")).toBe(false);
    expect(inviteCardShown({ id: ORG, is_default: true }, "ok")).toBe(false);
    expect(inviteCardShown({ id: DEFAULT_ORG_ID, is_default: false }, "ok")).toBe(false);
    expect(inviteCardShown(null, "ok")).toBe(false);
    const credits = readFileSync(path.join(process.cwd(), "app/(app)/[channel]/credits/page.tsx"), "utf8");
    const settings = readFileSync(path.join(process.cwd(), "app/(app)/[channel]/organization/page.tsx"), "utf8");
    expect(credits).toContain("inviteCardShown(org.current, inviteRead.state)");
    expect(credits).toMatch(/showInvite && inviteRead\.state === "ok"/);
    expect(credits).toMatch(/showInvite && inviteRead\.state === "failed"/);
    expect(settings).toContain("inviteCardShown(org.current,");
    expect(settings.match(/showInvite=\{showInvite\}/g)).toHaveLength(3);
  });

  it("lands on a card the Credits page draws with that id, clear of the sticky bar", () => {
    const card = readFileSync(path.join(process.cwd(), "components/credits/InviteFriendsCard.tsx"), "utf8");
    expect(card).toMatch(/<section id="invite" className="[^"]*scroll-mt-7/);
    const page = readFileSync(path.join(process.cwd(), "app/(app)/[channel]/credits/page.tsx"), "utf8");
    expect(page).toMatch(/<section id="invite" className="[^"]*scroll-mt-7/);
  });

  it("has a label in every language", () => {
    for (const l of ["en", "ru", "uz"] as const) {
      expect(dictionaries[l].account.inviteFriends.length).toBeGreaterThan(3);
    }
  });
});

describe("Avatar is used where the initial circle was", () => {
  it("none of the four places draws its own circle any more", () => {
    for (const f of ["components/SideNav.tsx", "components/account/AccountMenu.tsx"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src).not.toContain("accountInitial");
      expect(src).toContain("<Avatar");
    }
  });

  it("an act() round trip leaves no leftover requests for the photo (it is the browser's, once per view)", async () => {
    render(wrap(<SideNav email={EMAIL} avatarV={V} plan={null} />));
    await act(async () => {});
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(PHOTO, expect.anything());
  });
});

describe("a photo that failed before the page was interactive", () => {
  it("is replaced by the initial: the server-rendered image finished with no pixels before onError existed", () => {
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const width = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 0 });
    try {
      const { container } = render(<Avatar email={EMAIL} version={V} />);
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe("A");
    } finally {
      if (complete) Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
      else delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).complete;
      if (width) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", width);
      else delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalWidth;
    }
  });
});

describe("ScrollToHash", () => {
  it("scrolls to the section the address names once it is drawn, and ignores an address that names nothing", async () => {
    const section = document.createElement("section");
    section.id = "invite";
    section.scrollIntoView = vi.fn();
    document.body.append(section);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 1));
    try {
      window.location.hash = "#invite";
      render(<ScrollToHash />);
      expect(section.scrollIntoView).toHaveBeenCalledTimes(1);
      cleanup();
      // The section streams in after the component mounted: it scrolls when the section appears, once.
      section.remove();
      (section.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
      render(<ScrollToHash />);
      expect(section.scrollIntoView).not.toHaveBeenCalled();
      document.body.append(section);
      await waitFor(() => expect(section.scrollIntoView).toHaveBeenCalledTimes(1));
      cleanup();
      (section.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
      window.location.hash = "#nothing-here";
      expect(() => render(<ScrollToHash />)).not.toThrow();
      cleanup();
      window.location.hash = "";
      const observe = vi.spyOn(MutationObserver.prototype, "observe");
      render(<ScrollToHash />);
      expect(section.scrollIntoView).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled(); // no hash: no body observer
      observe.mockRestore();
    } finally {
      section.remove();
      window.location.hash = "";
    }
  });
});
