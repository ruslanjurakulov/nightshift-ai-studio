import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { OrgContext } from "../lib/orgs-server";

/**
 * BR-H-001, the layers behind the middleware. A request the middleware never
 * saw (`/favicon.icox/providers` before the matcher was anchored) rendered the
 * operator console signed out, because:
 *
 * - the (app) layout never checked for a session itself;
 * - isOperator() answered true for nobody signed in (getOrgContext reads a
 *   signed-out visitor as "organizations not supported");
 * - providers, billing, alerts and getting-started read the operator's GitHub
 *   secret names, routing variables and ALERT_EMAIL_* with the server's token
 *   and no session check of their own — and a layout's redirect does not stop
 *   the page rendered beside it from running.
 *
 * Each layer now refuses on its own. What would break without these: a
 * signed-out visitor, or a customer, seeing which provider keys the operator
 * has, the routing settings and the alert addresses, and spending the
 * operator's GitHub API quota.
 */

vi.mock("server-only", () => ({}));

const state: {
  configured: boolean;
  user: { id: string; email?: string } | null;
  org: OrgContext;
  platformAdmin: boolean;
} = {
  configured: true,
  user: null,
  org: { supported: false, orgs: [], current: null },
  platformAdmin: false,
};

const calls = { orgContext: 0, channelContext: 0 };
const listConfiguredSecretNames = vi.fn(async () => ["ELEVENLABS_API_KEY", "SLACK_WEBHOOK_URL"]);
const readVariables = vi.fn(async () => ({ CHRONOS_VIDEO_PROVIDER: "x", ALERT_EMAIL_TO: "ops@example.test" }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/providers",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
}));

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  get isSupabaseConfigured() {
    return state.configured;
  },
}));

/** A PostgREST-ish builder: every filter returns itself; awaiting it yields no rows. */
function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "is", "order", "limit", "gte", "lte", "not", "neq", "range"])
    b[m] = () => b;
  b.maybeSingle = async () => ({ data: null, error: null });
  b.single = async () => ({ data: null, error: null });
  b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
  return b;
}

const fakeClient = {
  from: () => builder(),
  rpc: async (fn: string) => {
    if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
    if (fn === "bind_current_member") return { data: state.platformAdmin ? "owner" : null, error: null };
    return { data: null, error: null };
  },
  auth: { getUser: async () => ({ data: { user: state.user } }) },
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => (state.configured ? state.user : null),
  createClient: async () => (state.configured ? fakeClient : null),
}));

vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => {
    calls.orgContext += 1;
    // What the real one does: no client or no user reads as "not supported".
    if (!state.configured || !state.user) return { supported: false, orgs: [], current: null };
    return state.org;
  },
  ORG_COOKIE_OPTIONS: {},
}));

const SCOPE = { selection: "__all__", orgChannelIds: null, includeGlobal: true };
vi.mock("@/lib/channels-server", () => ({
  isChannelInCurrentOrg: async () => true,
  getChannelScope: async () => SCOPE,
  getChannelContext: async () => {
    calls.channelContext += 1;
    return { channels: [], credentials: [], notMigrated: false, selection: "__all__", slug: "all-channels", scope: SCOPE };
  },
}));
vi.mock("@/lib/channels-path-server", () => ({
  getChannelPath: async () => (section: string) => `/chronos/${section}`,
  getChannelSlug: async () => "chronos",
}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});

vi.mock("@/lib/server/github-secrets", () => ({
  GITHUB_REPO: "owner/bot",
  isGithubConfigured: true,
  listConfiguredSecretNames,
}));
vi.mock("@/lib/server/github-variables", () => ({ readVariables }));

// The shell's client components are not what is under test: stubs that record
// what the layout handed them.
const shell = vi.hoisted(() => ({ sideNav: [] as Record<string, unknown>[] }));
vi.mock("@/components/SideNav", () => ({
  SideNav: (props: Record<string, unknown>) => {
    shell.sideNav.push(props);
    return null;
  },
}));
vi.mock("@/components/NeuralBackdrop", () => ({ NeuralBackdrop: () => null }));
vi.mock("@/components/Header", () => ({ Header: () => null }));
vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/navigation/NavigationProvider", () => ({ NavigationProvider: () => null }));
vi.mock("@/components/navigation/ScrollToTop", () => ({ ScrollToTop: () => null }));
vi.mock("@/components/shell/ShellContext", () => ({ ShellProvider: () => null }));
vi.mock("@/lib/server/credits", () => ({ readCreditAccount: async () => null }));
vi.mock("@/lib/server/plans", () => ({ readBillingSummary: async () => ({ state: "failed" }), planValue: () => null }));

const { isOperator, guardOperatorPage } = await import("../lib/auth/org-roles");
const { default: AppLayout } = await import("../app/(app)/layout");
const { default: ProvidersPage } = await import("../app/(app)/[channel]/providers/page");
const { default: BillingPage } = await import("../app/(app)/[channel]/billing/page");
const { default: AlertsPage } = await import("../app/(app)/[channel]/alerts/page");
const { default: GettingStartedPage } = await import("../app/(app)/[channel]/getting-started/page");

const CUSTOMER_ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };

function signedOut() {
  state.user = null;
  state.org = { supported: false, orgs: [], current: null };
  state.platformAdmin = false;
}
/** Signed up and owns their own organization: an admin, but not the operator. */
function customerAdmin() {
  state.user = { id: "u-bob", email: "bob@example.test" };
  state.org = { supported: true, orgs: [CUSTOMER_ORG], current: CUSTOMER_ORG };
  state.platformAdmin = false;
}
/** Signed in, organizations exist, the membership lookup failed. */
function lookupFailed() {
  state.user = { id: "u-bob" };
  state.org = { supported: false, orgs: [], current: null, unavailable: true };
  state.platformAdmin = false;
}
function operator() {
  state.user = { id: "u-op", email: "op@example.test" };
  state.org = { supported: true, orgs: [CUSTOMER_ORG], current: CUSTOMER_ORG };
  state.platformAdmin = true;
}

beforeEach(() => {
  state.configured = true;
  signedOut();
  calls.orgContext = 0;
  calls.channelContext = 0;
  shell.sideNav.length = 0;
  listConfiguredSecretNames.mockClear();
  readVariables.mockClear();
});

const githubReads = () => listConfiguredSecretNames.mock.calls.length + readVariables.mock.calls.length;

const PAGES = [
  ["providers", () => ProvidersPage({ params: Promise.resolve({ channel: "chronos" }), searchParams: Promise.resolve({}) })],
  ["billing", () => BillingPage()],
  ["alerts", () => AlertsPage()],
  ["getting-started", () => GettingStartedPage()],
] as const;

describe("isOperator() is false when nobody is signed in", () => {
  it("signed out: false, though the org context reads 'not supported'", async () => {
    signedOut();
    expect(await isOperator()).toBe(false);
  });

  it("a failed org lookup: false", async () => {
    lookupFailed();
    expect(await isOperator()).toBe(false);
  });

  it("a customer organization's admin: false", async () => {
    customerAdmin();
    expect(await isOperator()).toBe(false);
  });

  it("the platform operator: true", async () => {
    operator();
    expect(await isOperator()).toBe(true);
  });

  it("before 0018, a signed-in member: true, as before", async () => {
    state.user = { id: "u-team" };
    state.org = { supported: false, orgs: [], current: null };
    expect(await isOperator()).toBe(true);
  });

  it("Supabase not configured (local development): true, as before", async () => {
    state.configured = false;
    expect(await isOperator()).toBe(true);
  });
});

describe("the (app) layout sends a signed-out visitor to /login itself", () => {
  it("signed out: redirect before anything is read or drawn", async () => {
    signedOut();
    await expect(AppLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(calls.orgContext).toBe(0);
    expect(calls.channelContext).toBe(0);
    expect(shell.sideNav).toHaveLength(0);
  });

  /** The `operator` prop of the ShellProvider, wherever the layout nests it. */
  function shellOperatorProp(node: unknown): boolean | undefined {
    if (!node || typeof node !== "object") return undefined;
    const el = node as { props?: { operator?: boolean; children?: unknown } };
    if (typeof el.props?.operator === "boolean") return el.props.operator;
    const kids = el.props?.children;
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      const found = shellOperatorProp(k);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  it("a customer gets the customer's frame, not the operator console", async () => {
    customerAdmin();
    const tree = (await AppLayout({ children: null })) as ReactElement;
    expect(tree).toBeTruthy();
    expect(JSON.stringify(tree.props)).not.toContain('"operator":true');
    // The ShellProvider is told who is looking.
    expect(shellOperatorProp(tree)).toBe(false);
  });

  it("the operator still gets the console", async () => {
    operator();
    const tree = (await AppLayout({ children: null })) as ReactElement;
    expect(shellOperatorProp(tree)).toBe(true);
  });

  it("Supabase not configured: renders, as before (nothing to sign in to)", async () => {
    state.configured = false;
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });
});

describe("guardOperatorPage()", () => {
  it("signed out → /login; not the operator → 404; the operator → true; unconfigured → false", async () => {
    signedOut();
    await expect(guardOperatorPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    customerAdmin();
    await expect(guardOperatorPage()).rejects.toThrow("NEXT_NOT_FOUND");
    lookupFailed();
    await expect(guardOperatorPage()).rejects.toThrow("NEXT_NOT_FOUND");
    operator();
    await expect(guardOperatorPage()).resolves.toBe(true);
    state.configured = false;
    await expect(guardOperatorPage()).resolves.toBe(false);
  });
});

describe("the four GitHub-token pages check the operator themselves", () => {
  it.each(PAGES)("%s: signed out → /login, and GitHub is never called", async (_name, render) => {
    signedOut();
    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(githubReads()).toBe(0);
  });

  it.each(PAGES)("%s: a customer organization's admin → 404, and GitHub is never called", async (_name, render) => {
    customerAdmin();
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(githubReads()).toBe(0);
  });

  it.each(PAGES)("%s: a failed membership lookup → 404, and GitHub is never called", async (_name, render) => {
    lookupFailed();
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(githubReads()).toBe(0);
  });

  it.each(PAGES)("%s: the operator still sees it, read from GitHub", async (_name, render) => {
    operator();
    await expect(render()).resolves.toBeTruthy();
    expect(githubReads()).toBeGreaterThan(0);
  });

  it.each(PAGES)("%s: Supabase not configured → the server token is not spent", async (_name, render) => {
    state.configured = false;
    await render();
    expect(githubReads()).toBe(0);
  });
});
