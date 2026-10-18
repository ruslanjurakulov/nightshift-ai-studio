/**
 * The Billing, Security and Team pages and NIGHTSHIFT_OWNER_RPC.
 *
 * Off: none of the new reads is made and none of the new panels is drawn (the pages are what they were). On: Billing
 * asks the database for the provider spend and draws it, with an unknown as unknown; Security draws the read-only
 * safety panel for the operator and for nobody else; Team hands the board `ownerRpc`. On, but migration 0106/0107
 * not applied: the pages say so or fall back, never break.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";
import { recordingSupabase, type Res } from "./helpers/recordingStub";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  client: null as unknown,
  operator: true,
  role: "owner" as string,
  boardProps: null as Record<string, unknown> | null,
}));

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/billing" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => s.client, getUser: async () => ({ id: "u1", email: "me@a.uz" }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope } = await import("../lib/channels");
  const scope = unscopedScope();
  return { getChannelContext: async () => ({ selection: scope.selection, channels: [], scope }) };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({ supported: true, orgs: [], current: { id: "org-1", name: "Org", is_default: false, role: "owner" } }),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  guardOperatorPage: async () => true,
  isOperator: async () => s.operator,
  currentMfaAction: async () => "allow",
}));
vi.mock("@/lib/auth/roles", () => ({
  resolveRole: async () => s.role,
  requireRole: async () => s.role,
}));
vi.mock("@/lib/server/github-secrets", () => ({ isGithubConfigured: false, listConfiguredSecretNames: async () => [] }));
// The team board is a client component that reads the roster itself; here only what the page hands it matters.
vi.mock("@/components/members/MembersBoard", () => ({
  MembersBoard: (props: Record<string, unknown>) => {
    s.boardProps = props;
    return null;
  },
}));
vi.mock("@/components/security/SecurityBoard", () => ({ SecurityBoard: () => null }));

const o = en.ownerRpc;
const SECURITY = {
  ok: true,
  settings: { admin_aal2_required: false, recent_mfa_minutes: 480, grant_max_per_call: 100000, grant_max_per_24h: 500000, price_max_change_ratio: 3, reverse_window_days: 14 },
  caller: { ok: true, why: "gate_off", aal: "aal1", has_verified_factor: false },
  would_block_after_enable: false,
  admins: [{ email: "owner@a.uz", role: "owner", bound: true, verified_factors: 2 }],
  factors_readable: true,
  can_enable: true,
};
const has = (html: string, text: string) => html.includes(esc(text));

let results: Record<string, Res> = {};
const stub = () => recordingSupabase((name) => results[name] ?? { data: [], error: null });
const asked = (st: ReturnType<typeof stub>) => new Set(st.log.map((q) => q.table));

beforeEach(() => {
  s.operator = true;
  s.role = "owner";
  s.boardProps = null;
  results = {};
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const billing = async () => renderToStaticMarkup((await (await import("../app/(app)/[channel]/billing/page")).default()) as ReactElement);
const security = async () => renderToStaticMarkup((await (await import("../app/(app)/[channel]/security/page")).default()) as ReactElement);
const members = async () => renderToStaticMarkup((await (await import("../app/(app)/[channel]/members/page")).default()) as ReactElement);

describe("Billing", () => {
  it.each([undefined, "", "off", "true"])("flag %j: no provider-spend read and no panel", async (flag) => {
    if (flag !== undefined) vi.stubEnv("NIGHTSHIFT_OWNER_RPC", flag);
    else delete process.env.NIGHTSHIFT_OWNER_RPC;
    const st = stub();
    s.client = st.client;
    const html = await billing();
    expect(asked(st).has("owner_provider_spend")).toBe(false);
    expect(has(html, o.spend.title)).toBe(false);
  });

  it("on: asks for 30 days, draws the providers, and shows an unpriced provider as unknown", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_provider_spend = {
      data: [
        { day: "2026-10-17", provider: "elevenlabs", usd: 4.5, usd_priced: 4.5, unpriced_rows: 0, units: 9000, unit: "tts_characters", runs: 2 },
        { day: "2026-10-17", provider: "kling", usd: null, usd_priced: null, unpriced_rows: 2, units: 2, unit: "video_gen_clips", runs: 1 },
        { day: "2026-10-17", provider: "render", usd: null, usd_priced: null, unpriced_rows: 1, units: 60, unit: "render_seconds", runs: 1 },
      ],
      error: null,
    };
    const st = stub();
    s.client = st.client;
    const html = await billing();
    expect(st.of("owner_provider_spend")).toHaveLength(1);
    expect(has(html, o.spend.title)).toBe(true);
    expect(has(html, "$4.50")).toBe(true);
    expect(has(html, "Kling")).toBe(true);
    expect(has(html, o.spend.unknown)).toBe(true);
    expect(has(html, o.spend.estimatesTitle)).toBe(true);
    expect(has(html, "Rendering")).toBe(true);
  });

  it("on, but the function is not there (0106): the panel says so and the rest of the page is unchanged", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_provider_spend = { data: null, error: { code: "42883", message: "does not exist" } };
    const st = stub();
    s.client = st.client;
    const html = await billing();
    expect(has(html, o.spend.unsupported)).toBe(true);
    expect(has(html, "ElevenLabs")).toBe(true); // the provider cards still render from the raw rows
  });

  it("on, but the read failed: no figure, and the failure is said", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_provider_spend = { data: null, error: { code: "XX000", message: "boom" } };
    const st = stub();
    s.client = st.client;
    const html = await billing();
    expect(has(html, o.spend.failed)).toBe(true);
  });
});

describe("Security", () => {
  it.each([undefined, "off"])("flag %j: only the two-factor board, no owner panel, nothing asked", async (flag) => {
    if (flag !== undefined) vi.stubEnv("NIGHTSHIFT_OWNER_RPC", flag);
    else delete process.env.NIGHTSHIFT_OWNER_RPC;
    const st = stub();
    s.client = st.client;
    const html = await security();
    expect(has(html, o.security.title)).toBe(false);
    expect(asked(st).has("owner_security_get")).toBe(false);
    expect(asked(st).has("owner_security_events")).toBe(false);
  });

  it("on, operator: the read-only panel with the gate state, the admins and the events", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_security_get = { data: SECURITY, error: null };
    results.owner_security_events = { data: [{ id: 1, at: "2026-10-18T10:00:00Z", kind: "credits.grant", severity: "notice", actor_email: "owner@a.uz", target: "org-1", detail: { reason: "welcome" } }], error: null };
    const st = stub();
    s.client = st.client;
    const html = await security();
    expect(has(html, o.security.title)).toBe(true);
    expect(has(html, o.security.gateOff)).toBe(true);
    expect(has(html, "owner@a.uz")).toBe(true);
    expect(has(html, "Credits given")).toBe(true);
    expect(has(html, o.security.readyYes)).toBe(true);
    // read-only: the page has no control for the database gate
    expect(html.toLowerCase()).not.toContain("enable_admin_mfa");
    expect(html).not.toContain("<button");
  });

  it("on, not an operator: nothing is asked and nothing is shown", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    s.operator = false;
    const st = stub();
    s.client = st.client;
    const html = await security();
    expect(has(html, o.security.title)).toBe(false);
    expect(asked(st).has("owner_security_get")).toBe(false);
  });

  it("on, 0107 not applied: the panel says the functions are not installed", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_security_get = { data: null, error: { code: "42883", message: "x" } };
    results.owner_security_events = { data: null, error: { code: "42883", message: "x" } };
    const st = stub();
    s.client = st.client;
    expect(has(await security(), o.security.unsupported)).toBe(true);
  });

  it("on, unreadable: said as unreadable, never as an 'off' gate or an empty list", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_security_get = { data: null, error: { code: "XX000", message: "x" } };
    results.owner_security_events = { data: null, error: { code: "XX000", message: "x" } };
    const st = stub();
    s.client = st.client;
    const html = await security();
    expect(has(html, o.security.failed)).toBe(true);
    expect(has(html, o.security.eventsFailed)).toBe(true);
    expect(has(html, o.security.gateOff)).toBe(false);
    expect(has(html, o.security.eventsEmpty)).toBe(false);
  });
});

describe("Team", () => {
  it.each([undefined, "", "off"])("flag %j: the board writes the table as before and nothing is asked", async (flag) => {
    if (flag !== undefined) vi.stubEnv("NIGHTSHIFT_OWNER_RPC", flag);
    else delete process.env.NIGHTSHIFT_OWNER_RPC;
    const st = stub();
    s.client = st.client;
    await members();
    expect(s.boardProps?.ownerRpc).toBe(false);
    expect(asked(st).has("owner_security_get")).toBe(false);
  });

  it("on, owner: the board goes through the server", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_security_get = { data: SECURITY, error: null };
    const st = stub();
    s.client = st.client;
    await members();
    expect(s.boardProps?.ownerRpc).toBe(true);
  });

  it("on, but 0107 is not applied: the board falls back to the table", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    results.owner_security_get = { data: null, error: { code: "PGRST202", message: "x" } };
    const st = stub();
    s.client = st.client;
    await members();
    expect(s.boardProps?.ownerRpc).toBe(false);
  });

  it("on, but the person is only an editor: no control to wire, and nothing asked", async () => {
    vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on");
    s.role = "editor";
    const st = stub();
    s.client = st.client;
    await members();
    expect(s.boardProps?.ownerRpc).toBe(false);
    expect(asked(st).has("owner_security_get")).toBe(false);
  });
});
