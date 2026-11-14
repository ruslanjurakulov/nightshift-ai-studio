// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { en } from "../lib/i18n/en";
import { fmt } from "../lib/i18n";
import type { MyReferrals, ReferralAdmin, ReferralTerms } from "../lib/referrals";

/**
 * The referral card, the operator panel, the Credits page section and the public /referral terms (migration 0165). What would
 * break without these: a pending referral shown as earned credits, an empty or failed read shown as a row of zeros, an
 * "invited" number nobody measured, the link or Telegram share not carrying the person's own link, the Create button live
 * while the programme is closed, the section not falling back to 0092's card before 0165 is applied, the terms page printing a
 * number the database did not give (a default, a remembered one) or promising an amount when the numbers could not be read,
 * and the operator's form sending a reward above the payment that earns it.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  headers: new Headers(),
  server: { rpc: vi.fn() } as { rpc: ReturnType<typeof vi.fn> } | null,
}));

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
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ t: en, locale: "en" }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: () => {} }) }));
vi.mock("next/headers", () => ({ headers: async () => h.headers, cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));

const { ReferralCard, ReferralCardSkeleton } = await import("../components/credits/ReferralCard");
const { ReferralAdminPanel } = await import("../components/credits/ReferralAdminPanel");
const { ReferralSection } = await import("../components/credits/ReferralSection");
const { ReferralTermsPage } = await import("../components/site/ReferralTermsPage");
const { readMyReferrals } = await import("../lib/server/referrals");

const TOKEN = "0123456789abcdef0123456789abcdef";
const base: MyReferrals = {
  enabled: true,
  credits: 200,
  minCredits: 1000,
  holdDays: 30,
  qualifyDays: 60,
  monthlyCap: 10,
  link: null,
  org: null,
  joined: 0,
  held: 0,
  due: 0,
  nextReleaseOn: null,
  paid: 0,
  earned: 0,
  paidThisMonth: 0,
  clawed: 0,
  clawedCredits: 0,
  clawOwed: 0,
  void: 0,
  milestoneCredits: null,
};
const withLink = (over: Partial<MyReferrals> = {}): MyReferrals => ({ ...base, link: { token: TOKEN, createdAt: "2026-11-01T00:00:00Z" }, ...over });
const dbShape = (m: MyReferrals) => ({
  enabled: m.enabled, credits: m.credits, min_credits: m.minCredits, hold_days: m.holdDays, qualify_days: m.qualifyDays,
  monthly_cap: m.monthlyCap, link: m.link ? { token: m.link.token, created_at: m.link.createdAt } : null, org: m.org, joined: m.joined,
  held: m.held, due: m.due, next_release_on: m.nextReleaseOn, paid: m.paid, earned: m.earned, paid_this_month: m.paidThisMonth,
  clawed: m.clawed, clawed_credits: m.clawedCredits, claw_owed: m.clawOwed, void: m.void, milestone_credits: m.milestoneCredits,
});
const statValue = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")?.textContent;

beforeEach(() => {
  h.rpc.mockReset();
  h.refresh.mockReset();
  h.server = { rpc: vi.fn() };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
});

describe("the referral card", () => {
  it("states the terms in one line from the database's numbers and links the full terms", () => {
    render(<ReferralCard referrals={{ ...base, credits: 250, minCredits: 1500, holdDays: 45, monthlyCap: 4 }} orgId="org-1" />);
    const line = screen.getByText((_, el) => el?.hasAttribute("data-referral-terms") ?? false);
    expect(line.textContent).toContain(fmt(en.referral.terms, { credits: "250", min: "1,500", hold: 45, cap: 4 }));
    expect(screen.getByRole("link", { name: en.referral.termsLink }).getAttribute("href")).toBe("/referral");
  });

  it("before a link: Create, which makes the link for this workspace and then shows it", async () => {
    h.rpc.mockResolvedValue({ data: { enabled: true, required: 5, reward: 100, joined: 0, paid: false, pending: false, link: { token: TOKEN, created_at: "2026-11-01T00:00:00Z", org_id: "o" } }, error: null });
    render(<ReferralCard referrals={base} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.referral.create }));
    const field = (await screen.findByLabelText(en.referral.linkLabel)) as HTMLTextAreaElement;
    expect(h.rpc).toHaveBeenCalledWith("create_friend_invite", { p_org: "org-1" });
    expect(field.value).toBe(`${window.location.origin}/i/${TOKEN}`);
    expect(screen.getByText(en.referral.empty)).toBeTruthy();
  });

  it("a failed Create says so and keeps the button", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    render(<ReferralCard referrals={base} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: en.referral.create }));
    expect(await screen.findByText(en.referral.createFailed)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.referral.create })).toBeTruthy();
  });

  it("while the programme is closed, Create is disabled and says why", () => {
    render(<ReferralCard referrals={{ ...base, enabled: false }} orgId="org-1" />);
    expect((screen.getByRole("button", { name: en.referral.create }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(en.referral.closedShort)).toBeTruthy();
  });

  it("empty: the link, zero joined, pending 'none', nothing earned, and no invited count", () => {
    render(<ReferralCard referrals={withLink()} orgId="org-1" />);
    expect(screen.getByText(en.referral.empty)).toBeTruthy();
    expect(statValue(en.referral.joined)).toBe("0");
    expect(statValue(en.referral.qualified)).toBe("0");
    expect(statValue(en.referral.pending)).toBe(en.referral.pendingNone);
    expect(statValue(en.referral.earned)).toBe("0");
    expect(screen.getByText(en.referral.notTracked)).toBeTruthy();
    expect(screen.queryByText(/invited:/i)).toBeNull();
  });

  it("with referrals: pending is a count and a date, never credits; earned is only what was paid", () => {
    render(
      <ReferralCard
        referrals={withLink({ joined: 5, held: 3, due: 1, nextReleaseOn: "2026-12-14", paid: 2, earned: 400, paidThisMonth: 2, clawed: 1, clawedCredits: 200, clawOwed: 50, void: 1, org: { id: "org-9", name: "Ana Studio" } })}
        orgId="org-1"
      />,
    );
    expect(statValue(en.referral.joined)).toBe("5");
    expect(statValue(en.referral.qualified)).toBe("5");
    expect(statValue(en.referral.pending)).toBe("3");
    expect(statValue(en.referral.earned)).toBe("400");
    expect(screen.getByText(fmt(en.referral.heldUntil, { n: 2, date: "2026-12-14" }))).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.heldDue, { n: 1 }))).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.monthUsed, { n: 2, cap: 10 }))).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.clawed, { n: 1, credits: "200" }))).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.void, { n: 1 }))).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.clawOwed, { credits: "50" }))).toBeTruthy();
    // Where the reward went is the link's workspace, named; never "this workspace" when it may be another.
    expect(screen.getByText(fmt(en.referral.earnedHint, { workspace: "Ana Studio" }))).toBeTruthy();
    // 3 pending × 200 would be 600: that is an estimate, and it is never shown.
    expect(document.body.textContent).not.toContain("600");
    expect(screen.queryByText(en.referral.empty)).toBeNull();
  });

  it("copies the person's own link, and Telegram carries the same link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ReferralCard referrals={withLink()} orgId="org-1" />);
    await waitFor(() => expect((screen.getByLabelText(en.referral.linkLabel) as HTMLTextAreaElement).value).toContain(TOKEN));
    fireEvent.click(screen.getByRole("button", { name: en.referral.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/i/${TOKEN}`));
    const tg = screen.getByRole("link", { name: en.referral.telegram });
    expect(tg.getAttribute("href")).toContain(encodeURIComponent(`${window.location.origin}/i/${TOKEN}`));
    expect(tg.getAttribute("rel")).toContain("noopener");
  });

  it("offers Share only where the device has a share sheet", async () => {
    render(<ReferralCard referrals={withLink()} orgId="org-1" />);
    expect(screen.queryByRole("button", { name: en.referral.share })).toBeNull();
    cleanup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<ReferralCard referrals={withLink()} orgId="org-1" />);
    fireEvent.click(await screen.findByRole("button", { name: en.referral.share }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${window.location.origin}/i/${TOKEN}` })));
  });

  it("loading: a labelled, busy placeholder, no numbers", () => {
    render(<ReferralCardSkeleton />);
    const section = screen.getByText(en.referral.loading).closest("section");
    expect(section?.getAttribute("aria-busy")).toBe("true");
    expect(section?.textContent).not.toMatch(/\d/);
  });
});

describe("the Credits page section", () => {
  const legacy = { state: "ok" as const, value: { enabled: true, required: 5, reward: 100, link: null, joined: 0, paid: false, creditsPaid: null, pending: false } };

  it("settles first (claim_referral_rewards) and shows the card", async () => {
    h.server!.rpc.mockResolvedValue({ data: dbShape(withLink({ joined: 2 })), error: null });
    render(await ReferralSection({ orgId: "org-1", legacy }));
    expect(h.server!.rpc).toHaveBeenCalledWith("claim_referral_rewards");
    expect(statValue(en.referral.joined)).toBe("2");
  });

  it("a failed read is the error with Retry, never zeros", async () => {
    h.server!.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    render(await ReferralSection({ orgId: "org-1", legacy }));
    expect(screen.getByText(en.referral.readFailed)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.common.retry })).toBeTruthy();
    expect(screen.queryByText(en.referral.joined)).toBeNull();
  });

  it("closed and no link yet: one line, not a dead button", async () => {
    h.server!.rpc.mockResolvedValue({ data: dbShape({ ...base, enabled: false }), error: null });
    render(await ReferralSection({ orgId: "org-1", legacy }));
    expect(screen.getByText(en.referral.closedShort)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a router prefetch only reads (my_referrals): settling is for a real visit", async () => {
    h.headers = new Headers({ "next-router-prefetch": "1" });
    h.server!.rpc.mockResolvedValue({ data: dbShape(withLink({ joined: 2 })), error: null });
    render(await ReferralSection({ orgId: "org-1", legacy }));
    expect(h.server!.rpc.mock.calls.map((c) => c[0])).toEqual(["my_referrals"]);
    h.headers = new Headers();
  });

  it("before 0165: 0092's card, exactly as it was", async () => {
    h.server!.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    render(await ReferralSection({ orgId: "org-1", legacy }));
    expect(screen.getByText(fmt(en.invite.offer, { required: 5, credits: "100" }))).toBeTruthy();
    cleanup();
    render(await ReferralSection({ orgId: "org-1", legacy: { state: "ok", value: { ...legacy.value, enabled: false } } }));
    expect(screen.getByText(en.invite.closedShort)).toBeTruthy();
    cleanup();
    render(await ReferralSection({ orgId: "org-1", legacy: { state: "failed" } }));
    expect(screen.getByText(en.invite.readFailed)).toBeTruthy();
  });
});

describe("readMyReferrals", () => {
  it("falls back to the plain read when the settle fails, and is unknown when both fail", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "55P03", message: "lock timeout" } })
      .mockResolvedValueOnce({ data: dbShape(withLink({ joined: 1 })), error: null });
    const got = await readMyReferrals({ rpc });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["claim_referral_rewards", "my_referrals"]);
    expect(got.state === "ok" && got.value.joined).toBe(1);
    const bad = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await readMyReferrals({ rpc: bad })).toEqual({ state: "failed" });
    const garbled = vi.fn().mockResolvedValue({ data: { enabled: true }, error: null });
    expect(await readMyReferrals({ rpc: garbled })).toEqual({ state: "failed" });
  });
});

describe("the operator panel", () => {
  const admin: ReferralAdmin = {
    enabled: false, milestoneEnabled: false, credits: 200, minCredits: 1000, holdDays: 30, qualifyDays: 60, monthlyCap: 10, dailyCap: 50,
    updatedAt: null, links: 3, joins: 7, held: 2, due: 0, paid: 1, paidToday: 0, creditsMonth: 200, creditsTotal: 200, voidRefunded: 1,
    voidSamePayer: 0, voidMember: 0, clawed: 0, clawOwed: 0, milestoneRewards: 0, linksOpen: true, schedule: true, openSince: null, orphaned: 0,
    lastRun: { at: "2026-11-14T09:00:00Z", links: 3, changed: 1, failed: 0, error: null }, runsFailed24h: 0, reversedByEvent: 0,
  };

  it("sends the switch, the milestone switch and the numbers to set_referral_settings", async () => {
    h.rpc.mockResolvedValue({ data: { ...admin, enabled: true, milestone_enabled: false, min_credits: 1000, hold_days: 30, qualify_days: 60, monthly_cap: 10, daily_cap: 50, updated_at: null, paid_today: 0, credits_month: 200, credits_total: 200, void_refunded: 1, void_same_payer: 0, void_member: 0, claw_owed: 0, milestone_rewards: 0, links_open: true, schedule: true, open_since: null, orphaned: 0, runs_failed_24h: 0, reversed_by_event: 0, last_run: null }, error: null });
    render(<ReferralAdminPanel admin={admin} />);
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(en.referral.adminSwitch) }));
    fireEvent.click(screen.getByRole("button", { name: en.referral.adminSave }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalled());
    expect(h.rpc).toHaveBeenCalledWith("set_referral_settings", {
      p_enabled: true, p_milestone_enabled: false, p_credits: 200, p_min_credits: 1000, p_hold_days: 30, p_qualify_days: 60, p_monthly_cap: 10, p_daily_cap: 50,
    });
    expect(await screen.findByText(en.referral.adminSaved)).toBeTruthy();
  });

  it("says plainly when no settle job is scheduled, and what the last run did", () => {
    render(<ReferralAdminPanel admin={{ ...admin, schedule: false, runsFailed24h: 2, reversedByEvent: 1 }} />);
    expect(screen.getByText(en.referral.adminNoSchedule)).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.adminRunsFailed, { n: 2 }))).toBeTruthy();
    expect(screen.getByText(fmt(en.referral.adminByEvent, { n: 1 }))).toBeTruthy();
    cleanup();
    render(<ReferralAdminPanel admin={admin} />);
    expect(screen.queryByText(en.referral.adminNoSchedule)).toBeNull();
    expect(screen.getByText((_, el) => el?.hasAttribute("data-referral-last-run") ?? false).textContent).toContain("2026-11-14 09:00 UTC");
  });

  it("names the second-factor and rate-limit refusals of owner_guard in our words", async () => {
    for (const [code, text] of [["mfa_required", en.referral.adminMfa], ["rate_limited", en.referral.adminRateLimited]] as const) {
      h.rpc.mockResolvedValueOnce({ data: { ok: false, error: code, message: "server text" }, error: null });
      render(<ReferralAdminPanel admin={admin} />);
      fireEvent.click(screen.getByRole("button", { name: en.referral.adminSave }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByText("server text")).toBeNull();
      cleanup();
    }
  });

  it("refuses a reward above the smallest payment before anything is sent", () => {
    render(<ReferralAdminPanel admin={admin} />);
    fireEvent.change(screen.getByLabelText(en.referral.adminCredits), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: en.referral.adminSave }));
    expect(h.rpc).not.toHaveBeenCalled();
    expect(screen.getByText(en.referral.adminSaveFailed)).toBeTruthy();
  });
});

describe("/referral", () => {
  const terms: ReferralTerms = { enabled: true, credits: 250, minCredits: 1500, holdDays: 45, qualifyDays: 21, monthlyCap: 4, dailyCap: 30, linkHourlyCap: 7, newAccountDays: 2, updatedAt: "2026-11-20T09:00:00Z" };
  const page = (read: Parameters<typeof ReferralTermsPage>[0]["read"]) => render(<ReferralTermsPage t={en} locale="en" read={read} />);

  it("states every rule with the database's numbers, dated by when they changed", () => {
    page({ state: "ok", value: terms });
    const text = document.body.textContent ?? "";
    expect(text).toContain(en.referral.page.open);
    expect(text).toContain(fmt(en.referral.page.dated, { date: "2026-11-14", changed: "2026-11-20" }));
    for (const line of [
      fmt(en.referral.page.how[2], { qualify: 21, min: "1,500" }),
      fmt(en.referral.page.how[3], { hold: 45 }),
      fmt(en.referral.page.how[4], { credits: "250" }),
      fmt(en.referral.page.limits[0], { cap: 4 }),
      fmt(en.referral.page.limits[1], { daily: 30 }),
      fmt(en.referral.page.limits[2], { hourly: 7 }),
      ...en.referral.page.not.map((line) => fmt(line, { days: 2 })),
      en.referral.page.refund,
      en.referral.page.noIncome,
      en.referral.page.changes,
    ]) {
      expect(text).toContain(line);
    }
    // The defaults (200 / 1000 / 30 days) are nowhere: only what the database said.
    expect(text).not.toMatch(/\b200 credits\b|\b1,000\b|\b30 days\b/);
  });

  it("signed out it offers sign-up; signed in it opens the person's own Credits page", () => {
    page({ state: "ok", value: terms });
    expect(screen.getByRole("link", { name: new RegExp(en.referral.page.ctaSignedOut) }).getAttribute("href")).toBe("/signup");
    expect(screen.queryByText(en.referral.page.ctaCredits)).toBeNull();
    cleanup();
    render(<ReferralTermsPage t={en} locale="en" read={{ state: "ok", value: terms }} signedIn />);
    expect(screen.getByRole("link", { name: new RegExp(en.referral.page.ctaCredits) }).getAttribute("href")).toBe("/all-channels/credits#invite");
  });

  it("closed: says so, and still shows the terms", () => {
    page({ state: "ok", value: { ...terms, enabled: false } });
    expect(screen.getByText(en.referral.page.closed)).toBeTruthy();
    expect(screen.getByText(en.referral.page.notTitle)).toBeTruthy();
  });

  it("numbers unreadable: says so, and no sentence carries a number", () => {
    page({ state: "failed" });
    expect(screen.getByText(en.referral.page.unknown)).toBeTruthy();
    expect(screen.queryByText(en.referral.page.numbersTitle)).toBeNull();
    for (const sel of ["ol li", "ul li"]) {
      // No placeholder and no number of the programme's (the fixed "100%" of a free promo is a word of the rule, not a number of it).
      for (const li of Array.from(document.querySelectorAll(sel))) expect(li.textContent?.replace("100%", "")).not.toMatch(/\{|\d/);
    }
  });

  it("before 0165: not available here, and no sign-up offer for it", () => {
    page({ state: "unsupported" });
    expect(screen.getByText(en.referral.page.unsupported)).toBeTruthy();
    expect(screen.queryByText(en.referral.page.ctaSignedOut)).toBeNull();
  });
});
