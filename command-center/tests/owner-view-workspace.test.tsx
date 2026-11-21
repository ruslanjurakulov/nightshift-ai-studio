// @vitest-environment jsdom
/**
 * The Owner account's view (lib/owner-console/nav ownerViewAllows; app/(app)/layout.tsx). What would break without these:
 * the platform owner on "Owner" seeing the Studio or the workspace (Home, Create, Studio, Library, credits) instead of the
 * console; the owner on "User" being kept out of the Studio; an admin who is not the owner, or a customer with a hand-set
 * cookie, being sent to a console they do not have.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { OrgContext } from "../lib/orgs-server";
import { en } from "../lib/i18n/en";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  org: { supported: false, orgs: [], switchable: [], current: null } as unknown,
  rpc: "yes" as "yes" | "no" | "error",
  path: "/chronos/home" as string | null,
  search: "" as string,
  cookie: undefined as string | undefined,
  owner: true as boolean,
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: state.refresh, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/billing",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.path ? { "x-nightshift-path": state.path, "x-nightshift-search": state.search } : {}),
  cookies: async () => ({
    get: (name: string) => (name === "ns_owner_mode" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
    getAll: () => [],
    set: () => undefined,
  }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "or", "is", "order", "limit", "gte", "lte", "not", "neq", "range"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return b;
    },
    rpc: async (fn: string) => {
      if (fn === "is_platform_admin") {
        if (state.rpc === "error") return { data: null, error: { message: "boom" } };
        return { data: state.rpc === "yes", error: null };
      }
      if (fn === "owner_analytics_is_owner") return { data: state.owner, error: null };
      return { data: null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: state.user } }), mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }) } },
  }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => (state.user ? state.org : { supported: false, orgs: [], switchable: [], current: null }), ORG_COOKIE_OPTIONS: {} }));
const SCOPE = { selection: "__all__", orgChannelIds: null, includeGlobal: true };
vi.mock("@/lib/channels-server", () => ({
  getChannelContext: async () => ({ channels: [], credentials: [], notMigrated: false, selection: "__all__", slug: "chronos", scope: SCOPE }),
}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }), I18nProvider: ({ children }: { children: React.ReactNode }) => children };
});
vi.mock("@/components/account/AccountParts", () => ({ useSignOut: () => async () => {} }));
const shell = vi.hoisted(() => ({ operator: [] as boolean[] }));
vi.mock("@/components/SideNav", () => ({ SideNav: () => null }));
vi.mock("@/components/NeuralBackdrop", () => ({ NeuralBackdrop: () => null }));
vi.mock("@/components/Header", () => ({ Header: () => null }));
vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/navigation/NavigationProvider", () => ({ NavigationProvider: () => null }));
vi.mock("@/components/navigation/ScrollToTop", () => ({ ScrollToTop: () => null }));
vi.mock("@/components/shell/ShellContext", () => ({
  ShellProvider: ({ operator }: { operator: boolean }) => {
    shell.operator.push(operator);
    return null;
  },
}));
vi.mock("@/lib/server/credits", () => ({ readCreditAccount: async () => null }));
vi.mock("@/components/owner-console/OwnerShell", () => ({ OwnerShell: () => null }));
vi.mock("@/lib/server/plans", () => ({ readBillingSummary: async () => ({ state: "failed" }), planValue: () => null }));

const { default: AppLayout } = await import("../app/(app)/layout");
const nav = await import("../lib/owner-console/nav");

const ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const supported: OrgContext = { supported: true, orgs: [ORG], switchable: [ORG], current: ORG };

async function outcome(): Promise<string> {
  try {
    await AppLayout({ children: null });
    return "rendered";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("NEXT_REDIRECT:")) return m.slice("NEXT_REDIRECT:".length);
    throw e;
  }
}

beforeEach(() => {
  cleanup();
  state.user = { id: "u1", email: "o@x.test" };
  state.org = supported;
  state.rpc = "yes";
  state.owner = true;
  state.cookie = undefined;
  state.path = "/chronos/home";
  state.search = "";
});

describe("the Owner view's rule", () => {
  it("allows the owner tools and nothing of the Studio or the workspace", () => {
    for (const p of ["/c/margin", "/c/owner-analytics/revenue", "/c/customers", "/c/security", "/c/command-center", "/c/model-keys"]) {
      expect(nav.ownerViewAllows(p), p).toBe(true);
    }
    for (const p of ["/c/home", "/c/create", "/c/studio", "/c/library", "/c/channels", "/c/credits", "/c/usage", "/c/trends", "/c/videos", "/c"]) {
      expect(nav.ownerViewAllows(p), p).toBe(false);
    }
    expect(nav.ownerViewAllows("/c/models")).toBe(false);
    expect(nav.ownerViewAllows("/c/models", "?view=manage")).toBe(true);
  });
});

describe("the app layout in the Owner view", () => {
  it("sends the owner on Owner from a Studio or workspace route to the console", async () => {
    for (const p of ["/chronos/home", "/chronos/create", "/chronos/studio", "/chronos/library", "/chronos/credits"]) {
      state.path = p;
      expect(await outcome(), p).toBe("/owner?from=studio");
    }
  });

  it("opens an owner tool there", async () => {
    state.path = "/chronos/margin";
    expect(await outcome()).toBe("rendered");
  });

  it("opens the Studio for the same owner on User", async () => {
    state.cookie = "off";
    for (const p of ["/chronos/home", "/chronos/create", "/chronos/studio"]) {
      state.path = p;
      expect(await outcome(), p).toBe("rendered");
    }
  });

  it("leaves an admin who is not the owner, and a customer with a hand-set cookie, in their normal app", async () => {
    state.owner = false;
    state.cookie = "on";
    state.path = "/chronos/create";
    expect(await outcome()).toBe("rendered");
    state.rpc = "no";
    expect(await outcome()).toBe("rendered");
  });
});
