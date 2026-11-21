/**
 * The Credits page and NIGHTSHIFT_OWNER_RPC.
 *
 * Off (unset, empty, `off`, anything but `on`): the page asks the database for none of the new things and renders
 * the old grant form and the old price editor, byte for byte what it rendered before. On: the grant form with its
 * reason and limits, the recent grants, the price editor in server mode and the price history. On, but migration
 * 0107 not applied (owner_security_get does not exist): the old forms, not a broken page. On, for someone who is
 * not a platform owner/admin: still nothing new is asked or shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";
import { recordingSupabase, type Res } from "./helpers/recordingStub";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/credits" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.client,
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({ supported: true, orgs: [], current: { id: "org-1", name: "Org", is_default: false, role: "owner" } }),
}));

const o = en.ownerRpc;
const SECURITY = {
  ok: true,
  settings: { admin_aal2_required: false, recent_mfa_minutes: 480, grant_max_per_call: 100000, grant_max_per_24h: 500000, price_max_change_ratio: 3, reverse_window_days: 14 },
  caller: { ok: true, why: "gate_off" },
  admins: [],
  factors_readable: true,
  can_enable: false,
};
const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

let admin = true;
let security: Res = { data: SECURITY, error: null };
const stub = () =>
  recordingSupabase((name) => {
    switch (name) {
      case "is_platform_admin":
        return { data: admin, error: null };
      case "credit_accounts":
        return { data: { balance: 75, reserved: 5 }, error: null };
      case "credit_prices":
        return { data: [{ unit: "usd", credits_per_unit: 100, margin: 0.25, note: null, updated_at: null }], error: null };
      case "owner_security_get":
        return security;
      case "credit_price_history":
        return {
          data: [{ id: 3, at: hoursAgo(2), unit: "usd", action: "set", old_credits_per_unit: 80, old_margin: 0.25, new_credits_per_unit: 100, new_margin: 0.25, reason: "raise", source: "rpc" }],
          error: null,
        };
      case "credit_transactions":
        return {
          data: [{ id: 41, org_id: "org-1", kind: "grant", amount: 500, balance_after: 575, reserved_after: 5, job_id: null, note: "owner grant: pilot", external_id: "owner-grant:g-abc12345", created_by: "u1", created_at: hoursAgo(3) }],
          error: null,
        };
      default:
        return { data: [], error: null };
    }
  });

const load = async () => (await import("../app/(app)/[channel]/credits/page")).default() as Promise<ReactElement>;
const has = (html: string, text: string) => html.includes(esc(text));
const asked = (s: ReturnType<typeof stub>) => new Set(s.log.map((q) => q.table));

beforeEach(() => {
  admin = true;
  security = { data: SECURITY, error: null };
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Credits page, NIGHTSHIFT_OWNER_RPC off", () => {
  it.each([undefined, "", "off", "0", "true", "yes"])("flag %j: the old forms, and none of the new reads", async (flag) => {
    if (flag !== undefined) vi.stubEnv("NIGHTSHIFT_OWNER_RPC", flag);
    else delete process.env.NIGHTSHIFT_OWNER_RPC;
    const s = stub();
    state.client = s.client;
    const html = renderToStaticMarkup(await load());
    // the old grant form (note, no reason) and the old editor
    expect(has(html, en.credits.grantNote)).toBe(true);
    expect(html).not.toContain(esc(o.grant.reasonPh));
    expect(has(html, o.prices.historyTitle)).toBe(false);
    expect(has(html, o.grant.recentTitle)).toBe(false);
    expect(has(html, o.prices.reasonLabel)).toBe(false);
    // and the database was not asked for any of it
    const names = asked(s);
    for (const name of ["owner_security_get", "credit_price_history", "owner_security_events", "owner_provider_spend"]) expect(names.has(name), name).toBe(false);
    expect(s.of("credit_transactions").every((q) => !q.calls.some(([m, a]) => m === "eq" && a[0] === "kind"))).toBe(true);
  });
});

describe("Credits page, NIGHTSHIFT_OWNER_RPC on", () => {
  beforeEach(() => vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on"));

  it("the owner's page: the grant form with its reason and limits, recent grants, the price history", async () => {
    const s = stub();
    state.client = s.client;
    const html = renderToStaticMarkup(await load());
    expect(html).toContain(esc(o.grant.reasonPh));
    expect(has(html, "One grant: up to 100,000 credits")).toBe(true);
    expect(has(html, "Last 24 hours: 500 of 500,000 credits given")).toBe(true);
    expect(has(html, o.grant.recentTitle)).toBe(true);
    expect(has(html, o.grant.reverse)).toBe(true);
    expect(has(html, o.prices.historyTitle)).toBe(true);
    expect(has(html, o.prices.restore)).toBe(true);
    expect(has(html, o.prices.reasonLabel)).toBe(true);
    // the old grant form is not rendered beside it
    expect(has(html, en.credits.grantNote)).toBe(false);
    expect(asked(s).has("owner_security_get")).toBe(true);
  });

  it("migration 0107 not applied: the old forms, not a broken page", async () => {
    security = { data: null, error: { code: "42883", message: "function public.owner_security_get() does not exist" } };
    const s = stub();
    state.client = s.client;
    const html = renderToStaticMarkup(await load());
    expect(has(html, en.credits.grantNote)).toBe(true);
    expect(html).not.toContain(esc(o.grant.reasonPh));
    expect(has(html, o.prices.historyTitle)).toBe(false);
    expect(asked(s).has("credit_price_history")).toBe(false);
  });

  it("the limits could not be read (a failed read, not a missing function): the server still guards, the page says the limits are unknown and offers nothing as reversible", async () => {
    security = { data: null, error: { code: "XX000", message: "boom" } };
    const s = stub();
    state.client = s.client;
    const html = renderToStaticMarkup(await load());
    expect(html).toContain(esc(o.grant.reasonPh));
    expect(has(html, o.grant.capsUnknown)).toBe(true);
    expect(has(html, o.grant.recentFailed)).toBe(true);
    expect(has(html, o.grant.reverse)).toBe(false);
  });

  it("someone who is not a platform owner/admin gets none of it and the database is not asked", async () => {
    admin = false;
    const s = stub();
    state.client = s.client;
    const html = renderToStaticMarkup(await load());
    expect(html).not.toContain(esc(o.grant.reasonPh));
    expect(has(html, o.prices.historyTitle)).toBe(false);
    for (const name of ["owner_security_get", "credit_price_history"]) expect(asked(s).has(name), name).toBe(false);
  });
});
