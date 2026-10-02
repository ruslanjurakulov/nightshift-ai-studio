import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ALL_CHANNELS, SECTIONS, appRedirect, isSection } from "@/lib/channels";
import {
  CUSTOMER_NAV_KEYS,
  CUSTOMER_RAIL,
  CUSTOMER_SIDEBAR,
  SECTION_TABS,
  tabsFor,
  NAV_GROUPS,
  NAV_ITEMS,
  RAIL_HIDDEN_KEYS,
  isOperatorOnlySection,
  landingSection,
  navGroupsFor,
  sectionAllowed,
} from "@/lib/navigation";
import { accountPlan, coerceAccountSummary, creditsSpent, derivePlan, packFromPurchase } from "@/lib/account";
import { coerceBillingSummary } from "@/lib/plans";
import type { ChannelCredentialRow, ChannelRow } from "@/lib/types";
import type { ChannelTokenStatus } from "@/lib/channel-tokens";

vi.mock("server-only", () => ({}));
const { youtubeAccounts } = await import("@/lib/connectedAccounts");

/**
 * The customer-shaped app: which rail each viewer gets, where a URL they may
 * not use sends them, and the account panel's numbers — every one derived from
 * real ledger rows, never assumed.
 */

const keys = (operator: boolean) => navGroupsFor(operator).flatMap((g) => g.items.map((i) => i.key));

describe("nav filtering by role", () => {
  it("gives a customer exactly five destinations, in rail order", () => {
    expect(keys(false)).toEqual(["hub", "videos", "channels", "credits", "settings"]);
  });

  it("puts every customer screen behind a rail entry or its tabs", () => {
    const reachable = new Set<string>([
      ...CUSTOMER_RAIL.map((i) => i.key),
      ...SECTION_TABS.hub.map((i) => i.key),
      ...SECTION_TABS.settings.map((i) => i.key),
    ]);
    for (const k of CUSTOMER_NAV_KEYS) if (k !== "command") expect(reachable.has(k)).toBe(true);
    expect(tabsFor("library")?.rail).toBe("hub");
    expect(tabsFor("developers")?.rail).toBe("settings");
    expect(tabsFor("videos")).toBeNull();
    // Tabs never open an operator-only screen.
    for (const g of Object.values(SECTION_TABS)) for (const i of g) expect(isOperatorOnlySection(i.href.slice(1))).toBe(false);
  });

  it("keeps the operator's console for a platform admin, minus All Accounts and Team", () => {
    const op = keys(true);
    expect(op).not.toContain("accounts");
    expect(op).not.toContain("members");
    const expected = NAV_ITEMS.map((i) => i.key).filter((k) => !RAIL_HIDDEN_KEYS.includes(k));
    expect(op).toEqual(expected);
  });

  it("drops a group left empty instead of rendering a bare heading", () => {
    for (const g of navGroupsFor(false)) expect(g.items.length).toBeGreaterThan(0);
    expect(navGroupsFor(false).map((g) => g.label)).toEqual([undefined]);
  });

  it("still lists All Accounts and Team for breadcrumbs and tab titles", () => {
    const all = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.key));
    expect(all).toContain("accounts");
    expect(all).toContain("members");
  });

  it("marks every non-customer section operator-only, and nothing else", () => {
    expect(isOperatorOnlySection("accounts")).toBe(true);
    expect(isOperatorOnlySection("members")).toBe(true);
    expect(isOperatorOnlySection("pipeline")).toBe(true);
    expect(isOperatorOnlySection("logs")).toBe(true);
    expect(isOperatorOnlySection("getting-started")).toBe(true);
    for (const s of ["command-center", "create", "videos", "studio", "channels", "credits", "series", "organization"])
      expect(isOperatorOnlySection(s), s).toBe(false);
    // Not a section at all: left to 404 or the channel index, not bounced.
    expect(isOperatorOnlySection("")).toBe(false);
    expect(isOperatorOnlySection("no-such-page")).toBe(false);
    expect(sectionAllowed("pipeline", true)).toBe(true);
    expect(sectionAllowed("pipeline", false)).toBe(false);
  });

  it("keeps team features away from a self-serve customer: no Team page, no two-person approvals", () => {
    // A workspace has one person and no roles, so a second approver cannot
    // exist; both screens stay for the platform operator.
    for (const s of ["members", "approvals"]) {
      expect(isOperatorOnlySection(s), s).toBe(true);
      expect(sectionAllowed(s, false), s).toBe(false);
      expect(sectionAllowed(s, true), s).toBe(true);
    }
    expect(keys(false)).not.toContain("approvals");
    expect(keys(true)).toContain("approvals");
  });
});

describe("SECTIONS", () => {
  it("includes create, credits and billing, so bare /create and /credits land on a channel", () => {
    for (const s of ["create", "credits", "billing"]) {
      expect(SECTIONS, s).toContain(s);
      expect(isSection(s), s).toBe(true);
    }
  });

  it("covers every route folder under app/(app)/[channel]", () => {
    const dir = path.resolve(process.cwd(), "app/(app)/[channel]");
    const routes = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isDirectory());
    for (const r of routes) expect(isSection(r), r).toBe(true);
  });
});

const ch = (id: string, name: string, extra: Partial<ChannelRow> = {}): ChannelRow => ({
  channel_id: id,
  name,
  niche: "",
  status: "ACTIVE",
  agent_config: null,
  schedule_config: null,
  credential_ref: null,
  auto_publish: false,
  created_at: null,
  updated_at: null,
  ...extra,
});

describe("appRedirect", () => {
  const channels = [ch("default", "Chronos"), ch("ext", "Extinct World")];
  const base = { search: "", channels, selection: ALL_CHANNELS as string };

  it("moves a customer off the every-channel view to their first channel, keeping screen and query", () => {
    expect(
      appRedirect({ ...base, path: "/all-channels/channels", search: "?yt=connected", honestSlug: "all-channels", operator: false }),
    ).toBe("/chronos/channels?yt=connected");
    expect(appRedirect({ ...base, path: "/all-channels", honestSlug: "all-channels", operator: false })).toBe("/chronos");
  });

  it("leaves a customer with no channel yet on the only view there is", () => {
    expect(
      appRedirect({ ...base, channels: [], path: "/all-channels/credits", honestSlug: "all-channels", operator: false }),
    ).toBeNull();
  });

  it("lets the operator open the every-channel view by URL", () => {
    expect(appRedirect({ ...base, path: "/all-channels/accounts", honestSlug: "all-channels", operator: true })).toBeNull();
  });

  it("sends a customer on an operator-only screen to that channel's Home, dropping the query", () => {
    expect(
      appRedirect({ ...base, selection: "default", path: "/chronos/members", search: "?x=1", honestSlug: "chronos", operator: false }),
    ).toBe("/chronos/home");
    expect(appRedirect({ ...base, path: "/all-channels/accounts", honestSlug: "all-channels", operator: false })).toBe(
      "/chronos/home",
    );
  });

  it("keeps Getting Started away from a customer everywhere, and sends its URL to Home; the operator keeps it", () => {
    // Not a customer section, rail entry, tab or sidebar row...
    expect(CUSTOMER_NAV_KEYS).not.toContain("onboarding");
    expect(CUSTOMER_RAIL.map((i) => i.key)).not.toContain("onboarding" as never);
    for (const g of Object.values(SECTION_TABS)) expect(g.map((i) => i.key)).not.toContain("onboarding");
    expect(tabsFor("getting-started")).toBeNull();
    const sidebar = [...CUSTOMER_SIDEBAR.work, ...CUSTOMER_SIDEBAR.footer].map((i) => i.key);
    expect(sidebar).not.toContain("onboarding");
    expect(keys(false)).not.toContain("onboarding");
    // ...and it is operator-only, so the layout's redirect covers it.
    expect(isOperatorOnlySection("getting-started")).toBe(true);
    expect(sectionAllowed("getting-started", false)).toBe(false);
    expect(sectionAllowed("getting-started", true)).toBe(true);
    expect(
      appRedirect({ ...base, selection: "default", path: "/chronos/getting-started", honestSlug: "chronos", operator: false }),
    ).toBe("/chronos/home");
    expect(
      appRedirect({ ...base, selection: "default", path: "/chronos/getting-started", search: "?x=1", honestSlug: "chronos", operator: false }),
    ).toBe("/chronos/home");
    expect(appRedirect({ ...base, path: "/all-channels/getting-started", honestSlug: "all-channels", operator: false })).toBe(
      "/chronos/home",
    );
    // The operator stays on it, and still has it in the console rail.
    expect(
      appRedirect({ ...base, selection: "default", path: "/chronos/getting-started", honestSlug: "chronos", operator: true }),
    ).toBeNull();
    expect(keys(true)).toContain("onboarding");
  });

  it("starts the operator on the Command Center (unchanged) and a customer on Home", () => {
    expect(landingSection(true)).toBe("command-center");
    expect(landingSection(false)).toBe("home");
    expect(sectionAllowed(landingSection(false), false)).toBe(true);
    // Home is a customer screen, not an operator-only one, and a known section.
    expect(isOperatorOnlySection("home")).toBe(false);
    expect(isSection("home")).toBe(true);
  });

  it("opens Home from the hub's rail entry, as the hub's first tab, without changing the operator's rail", () => {
    expect(CUSTOMER_RAIL.find((i) => i.key === "hub")?.href).toBe("/home");
    expect(SECTION_TABS.hub[0]).toEqual({ href: "/home", key: "home" });
    expect(tabsFor("home")?.rail).toBe("hub");
    expect(keys(true)).not.toContain("home" as never);
  });

  it("still rewrites a channel id to its name, for everyone", () => {
    expect(
      appRedirect({ ...base, selection: "default", path: "/default/videos/abc", honestSlug: "chronos", operator: true }),
    ).toBe("/chronos/videos/abc");
    expect(appRedirect({ ...base, selection: "default", path: "/chronos/videos", honestSlug: "chronos", operator: false })).toBeNull();
  });
});

describe("plan from the ledger", () => {
  it("is Free with no purchase — a welcome grant is not a plan", () => {
    expect(derivePlan([])).toEqual({ kind: "free" });
    expect(derivePlan([{ kind: "grant", amount: 100, note: "welcome" }])).toEqual({ kind: "free" });
  });

  it("is unknown, not Free, when the ledger could not be read", () => {
    expect(derivePlan(null)).toEqual({ kind: "unknown" });
  });

  it("names the pack of the last purchase, from the webhook's note", () => {
    const rows = [
      { kind: "purchase", amount: 1000, note: "Paddle txn_1: 1× starter", created_at: "2026-01-01T00:00:00Z" },
      { kind: "purchase", amount: 5000, note: "Paddle txn_2: 1× creator · bought by user u", created_at: "2026-03-01T00:00:00Z" },
    ];
    expect(derivePlan(rows)).toEqual({ kind: "pack", pack: "creator" });
  });

  it("takes the largest pack when one checkout bought several", () => {
    expect(packFromPurchase({ amount: 22000, note: "Paddle txn_3: 2× starter, 1× studio" })).toBe("studio");
  });

  it("falls back to an exact pack amount, and never guesses otherwise", () => {
    expect(packFromPurchase({ amount: "20000.00", note: null })).toBe("studio");
    expect(packFromPurchase({ amount: 1234, note: "manual" })).toBeNull();
    expect(derivePlan([{ kind: "purchase", amount: 1234, note: null }])).toEqual({ kind: "purchased" });
  });
});

describe("credits spent", () => {
  it("sums capture rows, which the ledger stores negative", () => {
    expect(creditsSpent([{ amount: -12.5 }, { amount: "-7.25" }, { amount: -0.25 }], 3)).toBe(20);
  });

  it("ignores other kinds when the rows carry one", () => {
    expect(creditsSpent([{ kind: "capture", amount: -10 }, { kind: "release", amount: 5 }], null)).toBe(10);
  });

  it("is zero with no runs yet", () => {
    expect(creditsSpent([], 0)).toBe(0);
  });

  it("is unknown when fewer rows were read than exist, or a row is unreadable", () => {
    expect(creditsSpent([{ amount: -1 }], 2)).toBeNull();
    expect(creditsSpent(null, null)).toBeNull();
    expect(creditsSpent([{ amount: "abc" }], 1)).toBeNull();
  });
});

describe("coerceAccountSummary", () => {
  it("keeps real values and turns anything malformed into unknown / —", () => {
    const s = coerceAccountSummary({
      email: "a@b.co",
      plan: { kind: "plan", id: "pro", name: "Pro", isDefault: false, status: "active", periodEnd: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: false },
      credits: { available: 900, reserved: 100, spent: null, fromPlan: 600, fromTopups: 300 },
      accounts: [
        { platform: "youtube", id: "c1", name: "Chronos", avatarUrl: null, connected: true },
        { platform: "myspace", id: "x", name: "x", avatarUrl: null, connected: true },
      ],
    });
    expect(s).toEqual({
      email: "a@b.co",
      plan: { kind: "plan", id: "pro", name: "Pro", isDefault: false, status: "active", periodEnd: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: false },
      credits: { available: 900, reserved: 100, spent: null, fromPlan: 600, fromTopups: 300 },
      accounts: [{ platform: "youtube", id: "c1", name: "Chronos", avatarUrl: null, connected: true }],
      connectable: { instagram: false, tiktok: false },
    });
    expect(coerceAccountSummary({ plan: { kind: "pack", pack: "starter" }, credits: { available: "9" } })).toEqual({
      email: null,
      plan: { kind: "unknown" },
      credits: null,
      accounts: [],
      connectable: { instagram: false, tiktok: false },
    });
    expect(coerceAccountSummary({ plan: { kind: "plan", id: "free", name: "Free", status: "hacked", periodEnd: "soon" } })?.plan).toEqual({
      kind: "plan",
      id: "free",
      name: "Free",
      isDefault: false,
      status: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
    });
    expect(coerceAccountSummary({ accounts: [], connectable: { instagram: true, tiktok: "yes" } })?.connectable).toEqual({
      instagram: true,
      tiktok: false,
    });
    expect(coerceAccountSummary(null)).toBeNull();
  });
});

describe("the account panel's plan is the real subscription (0034)", () => {
  const summary = coerceBillingSummary({
    exempt: false,
    plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
    subscription: { plan_id: "creator", status: "active", current_period_end: "2026-11-01T00:00:00Z", cancel_at_period_end: true, manageable: true },
    credits: { subscription: 1500, pack: 800, other: 100, held: 0 },
  });
  it("names the plan and when it ends", () => {
    expect(accountPlan(summary, false)).toEqual({
      kind: "plan",
      id: "creator",
      name: "Creator",
      isDefault: false,
      status: "active",
      periodEnd: "2026-11-01T00:00:00Z",
      cancelAtPeriodEnd: true,
    });
  });
  it("is exempt for the operator and unknown when nothing could be read — never guessed from purchases", () => {
    expect(accountPlan(summary, true)).toEqual({ kind: "exempt" });
    expect(accountPlan(null, false)).toEqual({ kind: "unknown" });
  });
});

describe("connectedAccounts mapping", () => {
  const cred = (channel_id: string, status: string): ChannelCredentialRow => ({
    channel_id,
    provider: "youtube",
    status,
    youtube_channel_id: null,
    expires_at: null,
    last_verified_at: null,
    detail: null,
    synced_at: null,
  });
  const token = (channel_id: string, connected: boolean): ChannelTokenStatus => ({
    channel_id,
    connected,
    youtube_channel_id: "UC1",
    youtube_channel_title: "t",
    google_account_email: null,
    scopes: [],
    connected_at: null,
    connected_by_email: null,
    revoked_at: connected ? null : "2026-01-01T00:00:00Z",
  });

  it("names a channel by its verified YouTube title and avatar, else its own name", () => {
    const rows = youtubeAccounts(
      [
        ch("c1", "Chronos", {
          credential_ref: { youtube_title: "Chronos TV", youtube_thumbnail: "https://yt3.ggpht.com/a.jpg" },
        }),
        ch("c2", "Draft"),
      ],
      [],
      null,
    );
    expect(rows).toEqual([
      { platform: "youtube", id: "c1", name: "Chronos TV", avatarUrl: "https://yt3.ggpht.com/a.jpg", connected: false },
      { platform: "youtube", id: "c2", name: "Draft", avatarUrl: null, connected: false },
    ]);
  });

  it("never renders a non-https avatar", () => {
    const [row] = youtubeAccounts([ch("c1", "X", { credential_ref: { youtube_thumbnail: "javascript:alert(1)" } })], [], null);
    expect(row.avatarUrl).toBeNull();
    const [row2] = youtubeAccounts([ch("c1", "X", { credential_ref: { youtube_thumbnail: "http://x/a.jpg" } })], [], null);
    expect(row2.avatarUrl).toBeNull();
  });

  it("is connected from the operator's credential health when there is no Vault token", () => {
    const rows = youtubeAccounts([ch("c1", "A"), ch("c2", "B")], [cred("c1", "connected"), cred("c2", "expired")], []);
    expect(rows.map((r) => r.connected)).toEqual([true, false]);
  });

  it("trusts a customer channel's Vault token over a stale health row", () => {
    const rows = youtubeAccounts(
      [ch("c1", "A"), ch("c2", "B")],
      [cred("c1", "connected"), cred("c2", "not_connected")],
      [token("c1", false), token("c2", true)],
    );
    expect(rows.map((r) => r.connected)).toEqual([false, true]);
  });
});
