// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";
import type { MyInvite } from "../lib/friend-invites";

const h = vi.hoisted(() => ({ rpc: vi.fn(), refresh: vi.fn() }));

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: () => {} }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));

const { InviteFriendsCard } = await import("../components/credits/InviteFriendsCard");
const { InviteAdminPanel } = await import("../components/credits/InviteAdminPanel");
const { InvitedProvider } = await import("../components/auth/InvitedContext");

const TOKEN = "0123456789abcdef0123456789abcdef";
const invite = (over: Partial<MyInvite> = {}): MyInvite => ({
  enabled: true,
  required: 5,
  reward: 100,
  link: null,
  joined: 0,
  paid: false,
  creditsPaid: null,
  pending: false,
  ...over,
});
const withLink = (over: Partial<MyInvite> = {}) => invite({ link: { token: TOKEN, createdAt: "2026-10-01T00:00:00Z" }, ...over });
const dbShape = (i: MyInvite) => ({
  enabled: i.enabled, required: i.required, reward: i.reward, joined: i.joined, paid: i.paid, credits_paid: i.creditsPaid, pending: i.pending,
  link: i.link ? { token: i.link.token, created_at: i.link.createdAt, org_id: "o" } : null,
});

beforeEach(() => {
  h.rpc.mockReset();
  h.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

describe("Invite friends card", () => {
  it("shows the offer and a Create button; the new person is promised nothing here", () => {
    render(<InviteFriendsCard invite={invite()} orgId="org-1" />);
    expect(screen.getByText(en.invite.offer.replace("{required}", "5").replace("{credits}", "100"))).toBeTruthy();
    expect((screen.getByRole("button", { name: en.invite.create }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("with the switch off the button is disabled and says why in plain words", () => {
    render(<InviteFriendsCard invite={invite({ enabled: false })} orgId="org-1" />);
    expect((screen.getByRole("button", { name: en.invite.create }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(en.invite.closed)).toBeTruthy();
  });

  it("creates the link for this workspace and then shows it read-only with its progress", async () => {
    h.rpc.mockResolvedValue({ data: dbShape(withLink()), error: null });
    render(<InviteFriendsCard invite={invite()} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.invite.create }));
    const field = (await screen.findByLabelText(en.invite.linkLabel)) as HTMLInputElement;
    expect(h.rpc).toHaveBeenCalledWith("create_friend_invite", { p_org: "org-1" });
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe(`${window.location.origin}/i/${TOKEN}`);
    expect(screen.getByText("0 of 5 friends joined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.invite.create })).toBeNull();
  });

  it("says so when the link could not be made, and keeps the button", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS403" } });
    render(<InviteFriendsCard invite={invite()} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.invite.create }));
    expect(await screen.findByText(en.invite.createFailed)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.invite.create })).toBeTruthy();
  });

  it("shows 'X of 5 friends joined' as a five-step meter, counts only", () => {
    const { container } = render(<InviteFriendsCard invite={withLink({ joined: 3 })} orgId="org-1" />);
    expect(screen.getByText("3 of 5 friends joined")).toBeTruthy();
    const meter = container.querySelector('[role="meter"]')!;
    expect(meter.getAttribute("aria-valuenow")).toBe("3");
    expect(meter.getAttribute("aria-valuemax")).toBe("5");
    expect(container.querySelectorAll(".ns-meter-seg")).toHaveLength(5);
    expect(container.textContent).not.toMatch(/@/);
  });

  it("copies with the clipboard and shows 'Copied'", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<InviteFriendsCard invite={withLink()} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.invite.copy }));
    await waitFor(() => expect(screen.getAllByText(en.invite.copied).length).toBeGreaterThan(0));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/i/${TOKEN}`);
  });

  it("falls back to selecting the text when there is no clipboard, and says so when even that fails", async () => {
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    render(<InviteFriendsCard invite={withLink()} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.invite.copy }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    await waitFor(() => expect(screen.getAllByText(en.invite.copied).length).toBeGreaterThan(0));
    cleanup();
    (document as unknown as { execCommand: unknown }).execCommand = () => false;
    render(<InviteFriendsCard invite={withLink()} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.invite.copy }));
    expect(await screen.findByText(en.invite.copyFailed)).toBeTruthy();
  });

  it("shows what was earned once paid, and asks for nothing more", () => {
    render(<InviteFriendsCard invite={withLink({ joined: 5, paid: true, creditsPaid: 100 })} orgId="org-1" />);
    expect(screen.getByText(/You earned 100 credits\./)).toBeTruthy();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an earned reward that is waiting is claimed once on load, and the page refreshes when it is paid", async () => {
    h.rpc.mockResolvedValue({ data: dbShape(withLink({ joined: 5, paid: true, creditsPaid: 100 })), error: null });
    render(<InviteFriendsCard invite={withLink({ joined: 5, pending: true })} orgId="org-1" />);
    expect(screen.getByText(/being added/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/You earned 100 credits\./)).toBeTruthy());
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("claim_friend_invite_reward");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a paused programme says so beside an existing link", () => {
    render(<InviteFriendsCard invite={withLink({ enabled: false, joined: 1 })} orgId="org-1" />);
    expect(screen.getByText(en.invite.paused)).toBeTruthy();
    expect(screen.getByLabelText(en.invite.linkLabel)).toBeTruthy();
  });
});

describe("the operator's panel", () => {
  const admin = {
    enabled: false, requiredJoins: 5, rewardCredits: 100, dailyRewardCap: 20, linkHourlyCap: 10,
    links: 4, joins: 9, joinsUncounted: 0, rewards: 1, rewardsToday: 1, creditsToday: 100, creditsTotal: 100, pending: 0,
  };
  const dbAdmin = (over: Record<string, unknown> = {}) => ({
    enabled: false, required_joins: 5, reward_credits: 100, daily_reward_cap: 20, link_hourly_cap: 10,
    links: 4, joins: 9, joins_uncounted: 0, rewards: 1, rewards_today: 1, credits_today: 100, credits_total: 100, pending: 0, ...over,
  });

  it("starts from the stored settings (off), shows the worst case a day can pay, and the counts", () => {
    const { container } = render(<InviteAdminPanel admin={admin} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(container.querySelector("[data-invite-exposure]")!.textContent).toBe(
      en.invite.adminExposure.replace("{n}", "2,000").replace("{cap}", "20").replace("{reward}", "100"),
    );
    expect(screen.getByText("Credits paid today")).toBeTruthy();
  });

  it("saves the switch and numbers through the operator-only function", async () => {
    h.rpc.mockResolvedValue({ data: dbAdmin({ enabled: true, daily_reward_cap: 10 }), error: null });
    render(<InviteAdminPanel admin={admin} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(en.invite.adminDailyCap), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: en.invite.adminSave }));
    expect(await screen.findByText(en.invite.adminSaved)).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith("set_friend_invite_settings", {
      p_enabled: true, p_required_joins: 5, p_reward_credits: 100, p_daily_reward_cap: 10, p_link_hourly_cap: null,
    });
  });

  it("refuses an out-of-range number before asking the database", async () => {
    render(<InviteAdminPanel admin={admin} />);
    fireEvent.change(screen.getByLabelText(en.invite.adminRequired), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: en.invite.adminSave }));
    expect(await screen.findByText(en.invite.adminSaveFailed)).toBeTruthy();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("says so when the database refuses", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    render(<InviteAdminPanel admin={admin} />);
    fireEvent.click(screen.getByRole("button", { name: en.invite.adminSave }));
    expect(await screen.findByText(en.invite.adminSaveFailed)).toBeTruthy();
  });
});

describe("the sign-up page", () => {
  it("shows the one-line banner only for a visitor who came through a live link, with no promise in the banner itself", async () => {
    const { default: SignupPage } = await import("../app/signup/page");
    const banner = esc(en.signup.invitedBanner);
    const withBanner = renderToStaticMarkup(
      <InvitedProvider invited>
        <SignupPage />
      </InvitedProvider>,
    );
    const without = renderToStaticMarkup(<SignupPage />);
    expect(withBanner).toContain(banner);
    expect(withBanner).toContain("data-invite-banner");
    expect(without).not.toContain(banner);
  });
});
