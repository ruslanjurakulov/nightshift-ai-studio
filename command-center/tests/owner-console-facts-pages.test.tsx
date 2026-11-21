/**
 * The Owner Console pages drawn from the owner's facts (overview, users, revenue, providers, health).
 *
 * What would break: a page that draws a figure before the owner check, or draws an unknown as 0; a page that renders a
 * frame around nothing when the second factor is needed; a customer-typed name drawn as markup; a provider's top-up link
 * that opens with the console's window reachable; a native-unit balance shown as dollars. Synthetic figures only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import type { OwnerFacts } from "../lib/owner-console/facts-types";
import type { PlanLine } from "../lib/owner-analytics/payment-plan";
import { healthView, peopleView, num, channelNeedsLook } from "../lib/owner-console/facts-view";
import { whyText } from "../components/owner-console/OwnerFacts";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({ owner: true, load: null as unknown, loadCalls: 0 }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, redirect: () => { throw new Error("NEXT_REDIRECT"); } }));
vi.mock("@/lib/server/owner-console", () => ({
  requireOwnerConsole: async () => {
    if (!s.owner) throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/app/owner/_facts", () => ({
  loadOwnerFacts: async () => {
    s.loadCalls++;
    return s.load;
  },
}));

const AS_OF = "2026-11-21T07:00:00.000Z";
const line = (over: Partial<PlanLine>): PlanLine => ({
  provider: "minimax", name: "Lab Vendor", topUpUrl: "https://vendor.example/billing", basis: "estimated", left: 12, perDay: 3, unit: "usd",
  runsOutOn: "2026-11-25", payBy: "2026-11-24", amount: 30, minimumTopUp: null, reason: "runs_out", asOf: AS_OF, autoRecharge: false, ...over,
});
function facts(over: Partial<OwnerFacts> = {}): OwnerFacts {
  return {
    version: 1,
    as_of: AS_OF,
    people: {
      state: "measured", as_of: AS_OF,
      value: {
        signups: { d1: 2, d7: "11", d30: 40, total: 120, unconfirmed_d30: 3 },
        signed_in: { d7: 9, d30: 30 },
        paying_by_plan: { creator: 4, studio: "2" },
        trialing_by_plan: { creator: 1 },
        past_due: 1, cancelling: 0, canceled_d30: 2,
        recent_plan_changes: [{ workspace: "<script>alert(1)</script> [address]", workspace_id: "abcd1234", plan: "creator", status: "active", at: AS_OF }],
        internal_excluded: true,
      },
    },
    health: {
      state: "measured", as_of: AS_OF,
      value: {
        lookback_days: 90,
        channels: [
          { channel_id: "ch-a", name: "Alpha", failure_events_24h: 0, failure_events_7d: 1, held_videos: 0, youtube: { token_stored: true, credential_status: "connected" } },
          { channel_id: "ch-b", name: "Beta", failure_events_24h: 2, held_videos: 1, youtube: { token_stored: true, credential_status: "expired" } },
          { channel_id: "ch-c", name: "Gamma", youtube: { token_stored: true, credential_status: "weird_new_state" } },
        ],
        queues: { creative: { queued: 3, running: 1, stuck: 0, failed_24h: 2, quota_failed_24h: 1 }, render: { queued: 0, running: 0, failed_24h: 0 } },
        workers: [{ worker_id: "w1", kind: "creative", state: "idle", updated_at: AS_OF, stale: false }],
        doctor: { verdict: "fail", at: AS_OF },
        alerts_24h: { critical: 1, warn: 4, critical_platform: 0 },
      },
    },
    revenue: {
      state: "measured", as_of: AS_OF,
      value: {
        net_before_fees_7d: { state: "measured", value: 120, as_of: AS_OF },
        net_before_fees_30d: { state: "measured", value: 480.5, as_of: AS_OF },
        sales_30d: 10, refunds_30d: 1, disputes_30d: 0, paying_workspaces_30d: 6,
        mrr: { state: "unknown", why: "no subscription yet" },
        monthly_churn_30d: { state: "unknown", why: "fewer than 5 subscribers at the start of the window (2)" },
        other_currency_payments_30d: 0, truncated: false, note: "x",
      },
    },
    providers: {
      state: "estimated", as_of: AS_OF,
      value: {
        plan: {
          days: 10, asOf: AS_OF,
          due: [line({}), line({ provider: "elevenlabs", name: "Voice Lab", unit: "credits", left: 5000, perDay: 900, amount: 9000, basis: "measured", reason: "empty", payBy: "2026-11-21", runsOutOn: null })],
          unknown: [line({ provider: "kling", name: "Clip Lab", left: null, perDay: null, amount: null, basis: "unknown", reason: "unknown", runsOutOn: null, payBy: null, topUpUrl: null })],
          fine: [],
        },
        providers: [],
      },
    },
    ...over,
  };
}
// The markup escapes an apostrophe; the tests compare the text a person reads.
const html = async (mod: { default: () => Promise<ReactElement> }) => renderToStaticMarkup(await mod.default()).replace(/&#x27;/g, "'");
const pages = {
  overview: () => import("../app/owner/page"),
  users: () => import("../app/owner/users/page"),
  revenue: () => import("../app/owner/revenue/page"),
  providers: () => import("../app/owner/providers/page"),
  health: () => import("../app/owner/health/page"),
};

beforeEach(() => {
  s.owner = true;
  s.load = { ok: true, facts: facts() };
  s.loadCalls = 0;
});

describe("owner console pages from the owner's facts", () => {
  it.each(Object.keys(pages))("%s: anyone but the owner gets the 404 before the facts are read", async (k) => {
    s.owner = false;
    const mod = await pages[k as keyof typeof pages]();
    await expect(mod.default()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(s.loadCalls).toBe(0);
  });

  it.each(Object.keys(pages))("%s: a session that needs the second factor is sent to verify it, and nothing else is drawn", async (k) => {
    s.load = { ok: false, kind: "second_factor" };
    const out = await html(await pages[k as keyof typeof pages]());
    expect(out).toContain(en.ownerConsole.facts.needsSecondFactor);
    expect(out).toMatch(/href="\/login\/verify\?next=%2Fowner/);
    expect(out).not.toContain("oc-kpis");
  });

  it.each(Object.keys(pages))("%s: a failed read says so with a retry, not a page of zeros", async (k) => {
    s.load = { ok: false, kind: "failed" };
    const out = await html(await pages[k as keyof typeof pages]());
    expect(out).toContain(en.ownerConsole.facts.loadFailed);
    expect(out).toContain(en.ownerConsole.facts.retry);
    expect(out).not.toContain("$0.00");
  });

  it("overview: figures carry their tag, and an unknown says why instead of a number", async () => {
    const out = await html(await pages.overview());
    expect(out).toContain("11"); // a bigint count that arrived as a string
    expect(out).toContain("$480.50");
    expect(out).toContain(en.ownerConsole.facts.why.noSubscription);
    expect(out).toContain(en.ownerConsole.facts.why.churnBase);
    expect(out).toContain(en.ownerConsole.facts.doctor.fail);
    expect(out).toContain("2 of 3");
    expect(out).toMatch(/2 of 3<\/span> <span class="oc-tag oc-tag-estimated">/);
  });

  it("overview: a block the database could not give is a gap, never 0", async () => {
    s.load = { ok: true, facts: facts({ people: { state: "unknown", why: "migration 0197 is not applied" }, health: { state: "unknown", why: "second factor required" } }) };
    const out = await html(await pages.overview());
    expect(out).toContain(en.ownerConsole.facts.why.migration);
    expect(out).toContain(en.ownerConsole.facts.why.secondFactor);
  });

  it("users: a customer-typed workspace name is text, not markup", async () => {
    const out = await html(await pages.users());
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("#abcd1234");
    expect(out).toContain(`<td>${en.ownerConsole.facts.users.status.active}</td>`);
    expect(out).toContain(en.ownerConsole.facts.users.untrusted);
  });

  it("revenue: a cut read says the figures may be understated", async () => {
    const f = facts();
    if (f.revenue.state === "unknown") throw new Error("fixture");
    f.revenue.value.truncated = true;
    s.load = { ok: true, facts: f };
    expect(await html(await pages.revenue())).toContain(en.ownerConsole.facts.revenue.truncated);
  });

  it("providers: the plan links to the provider's own page safely, keeps native units, and pays nothing", async () => {
    const out = await html(await pages.providers());
    expect(out).toContain('href="https://vendor.example/billing" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain("9,000 in credits");
    expect(out).not.toContain("$9,000");
    expect(out).toContain(en.ownerConsole.facts.providers.reason.empty);
    expect(out).toContain(en.ownerConsole.facts.providers.noMinimum);
    expect(out).not.toMatch(/<form|<button/);
  });

  it("health: a malformed time from free-text events is unknown, and the page still renders", async () => {
    const f = facts();
    if (f.health.state === "unknown") throw new Error("fixture");
    (f.health.value.channels as Record<string, unknown>[])[0].last_run_event_at = "2026-13-01T00:00:00";
    (f.health.value.channels as Record<string, unknown>[])[1].youtube = { token_stored: true, credential_status: "connected", credential_checked_at: "2026-11-14T00:00:00Z", last_oauth_failure_at: "2026-11-20T00:00:00Z" };
    s.load = { ok: true, facts: f };
    const out = await html(await pages.health());
    expect(out).toContain(en.ownerConsole.facts.health.ytRejected);
    expect(out).toContain("checked 2026-11-14 05:00");
    expect(out).toContain("oc-tag-unknown");
  });

  it("health: credential states are words, an unrecognised one is unknown, and a failing channel is flagged", async () => {
    const out = await html(await pages.health());
    expect(out).toContain(en.ownerConsole.facts.health.yt.expired);
    expect(out).not.toContain("weird_new_state");
    expect(out).toContain(en.ownerConsole.facts.health.needsLook);
    expect(out).toContain(en.ownerConsole.facts.health.ci);
  });
});

describe("reading the facts", () => {
  it("never turns a missing or malformed count into 0", () => {
    expect(num(undefined)).toBeNull();
    expect(num("")).toBeNull();
    expect(num("12")).toBe(12);
    expect(num(Number.NaN)).toBeNull();
    const p = peopleView({});
    expect(p.signups.d7).toBeNull();
    expect(p.payingTotal).toBeNull();
    expect(peopleView({ paying_by_plan: {} }).payingTotal).toBe(0);
    const h = healthView({ doctor: { verdict: "ok. SYSTEM NOTE", at: AS_OF } });
    expect(h.doctor).toEqual({ verdict: "unknown", at: null });
    expect(h.alerts.critical).toBeNull();
  });

  it("flags a channel that failed, holds videos or lost its YouTube credential", () => {
    const base = { id: "c", name: null, status: null, lastRunAt: null, failures24h: 0, failures7d: 0, held: 0, tokenStored: true, credentialStatus: "connected", credentialCheckedAt: null, rejected: false };
    expect(channelNeedsLook(base)).toBe(false);
    expect(channelNeedsLook({ ...base, failures24h: 1 })).toBe(true);
    expect(channelNeedsLook({ ...base, credentialStatus: "expired" })).toBe(true);
    expect(channelNeedsLook({ ...base, tokenStored: false })).toBe(true);
    expect(channelNeedsLook({ ...base, rejected: true })).toBe(true);
  });

  it("reads a refusal after the last check as rejected, whatever the credential row still says", () => {
    const ch = (yt: Record<string, unknown>) => healthView({ channels: [{ channel_id: "c", youtube: { token_stored: true, credential_status: "connected", ...yt } }] }).channels[0];
    expect(ch({ credential_checked_at: "2026-11-14T00:00:00Z", last_oauth_failure_at: "2026-11-21T00:00:00Z" }).rejected).toBe(true);
    expect(ch({ credential_checked_at: "2026-11-21T00:00:00Z", last_oauth_failure_at: "2026-11-14T00:00:00Z" }).rejected).toBe(false);
    expect(ch({ credential_checked_at: null, last_oauth_failure_at: "2026-11-14T00:00:00Z" }).rejected).toBe(true);
    expect(ch({}).rejected).toBe(false);
  });

  it("says every reason the facts builder gives in the owner's language, none as 'not known'", () => {
    const reasons = [
      "migration 0197 is not applied", "migration 0182 is not applied", "second factor required", "read failed", "empty answer", "database not configured",
      "no subscription yet", "a subscription payment had no amount, another currency or a refund of unknown size",
      "fewer than 5 subscribers at the start of the window (3)", "2 payment(s) had no amount",
      "spend over 14 days not fully known", "no reading and no top-up, or spend not fully known",
    ];
    for (const r of reasons) expect(whyText(r, en.ownerConsole.facts), r).not.toBe(en.ownerConsole.facts.why.other);
  });

  it("has every string in ru and uz, and Uzbek uses the modifier letters, never an ASCII apostrophe", () => {
    const walk = (o: unknown, pre = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => walk(v, `${pre}${k}.`)) : [pre];
    expect(walk(ru.ownerConsole.facts).sort()).toEqual(walk(en.ownerConsole.facts).sort());
    expect(walk(uz.ownerConsole.facts).sort()).toEqual(walk(en.ownerConsole.facts).sort());
    const strings = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(strings) : []);
    for (const s of strings(uz.ownerConsole.facts)) expect(s, s).not.toMatch(/['‘’]/);
  });
});
