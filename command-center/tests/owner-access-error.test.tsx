// @vitest-environment jsdom
/**
 * A transient database error must not silently turn the owner into a customer.
 *
 * isOperator() stays fail-closed (no operator page, link or figure on an error), but the layout now tells "could not
 * check" from "not an operator": a phone that showed the console before, or that opens a page only an operator may
 * open, gets a "Can't reach the database, Retry" screen instead of the customer frame. A customer who hits the same
 * blip on a customer page keeps their own app.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { OrgContext } from "../lib/orgs-server";
import { en } from "../lib/i18n/en";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  org: { supported: false, orgs: [], current: null } as unknown,
  rpc: "yes" as "yes" | "no" | "error",
  path: "/chronos/home" as string | null,
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
  headers: async () => new Headers(state.path ? { "x-nightshift-path": state.path } : {}),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
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
      return { data: null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: state.user } }), mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }) } },
  }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => (state.user ? state.org : { supported: false, orgs: [], current: null }), ORG_COOKIE_OPTIONS: {} }));
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
vi.mock("@/lib/server/plans", () => ({ readBillingSummary: async () => ({ state: "failed" }), planValue: () => null }));

const { default: AppLayout } = await import("../app/(app)/layout");
const { operatorLookup, isOperator } = await import("../lib/auth/org-roles");
const { AccessError } = await import("../components/shell/AccessError");

const ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const supported: OrgContext = { supported: true, orgs: [ORG], current: ORG };

function walk(node: unknown, hit: (el: ReactElement) => boolean): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as ReactElement<{ children?: unknown }>;
  if (hit(el)) return true;
  const kids = el.props?.children;
  return (Array.isArray(kids) ? kids : [kids]).some((k) => walk(k, hit));
}
const showsAccessError = (tree: unknown) => walk(tree, (el) => el.type === AccessError);

beforeEach(() => {
  cleanup();
  state.user = { id: "u1", email: "o@x.test" };
  state.org = supported;
  state.rpc = "yes";
  state.path = "/chronos/home";
  state.refresh.mockReset();
  shell.operator.length = 0;
});

describe("operatorLookup()", () => {
  it("tells 'no' from 'could not check'", async () => {
    state.rpc = "no";
    expect(await operatorLookup()).toEqual({ operator: false, failed: false });
    state.rpc = "error";
    expect(await operatorLookup()).toEqual({ operator: false, failed: true });
    state.rpc = "yes";
    expect(await operatorLookup()).toEqual({ operator: true, failed: false });
  });
  it("a failed organization lookup is 'could not check' too", async () => {
    state.org = { supported: false, orgs: [], current: null, unavailable: true };
    expect(await operatorLookup()).toEqual({ operator: false, failed: true });
  });
  it("signed out is a plain no", async () => {
    state.user = null;
    expect(await operatorLookup()).toEqual({ operator: false, failed: false });
  });
  it("isOperator stays false on an error (fail closed)", async () => {
    state.rpc = "error";
    expect(await isOperator()).toBe(false);
  });
});

describe("the (app) layout when the access lookup fails", () => {
  it("the owner's landing page (Command Center) gets the retry screen, not the customer frame", async () => {
    state.rpc = "error";
    state.path = "/chronos/command-center";
    const tree = await AppLayout({ children: null });
    expect(showsAccessError(tree)).toBe(true);
    expect(shell.operator).toHaveLength(0);
  });
  it("an operator-only page (Billing) gets the retry screen", async () => {
    state.rpc = "error";
    state.path = "/chronos/billing";
    expect(showsAccessError(await AppLayout({ children: null }))).toBe(true);
  });
  it("my_organizations failing does the same", async () => {
    state.org = { supported: false, orgs: [], current: null, unavailable: true };
    state.path = "/chronos/billing";
    expect(showsAccessError(await AppLayout({ children: null }))).toBe(true);
  });
  it("a customer on a customer page keeps their own app, with no operator console (fail closed)", async () => {
    state.rpc = "error";
    state.path = "/chronos/home";
    const tree = await AppLayout({ children: null });
    expect(showsAccessError(tree)).toBe(false);
    expect(walk(tree, (el) => (el.props as { operator?: boolean }).operator === true)).toBe(false);
  });
  it("a clean 'not an operator' on an operator page is still the old redirect to the customer home, no retry screen", async () => {
    state.rpc = "no";
    state.path = "/chronos/billing";
    await expect(AppLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/chronos/home");
  });
  it("a working lookup for the owner draws the console", async () => {
    state.path = "/chronos/billing";
    const tree = await AppLayout({ children: null });
    expect(showsAccessError(tree)).toBe(false);
    expect(walk(tree, (el) => (el.props as { operator?: boolean }).operator === true)).toBe(true);
  });
});

describe("AccessError", () => {
  it("says it can't reach the database and Retry asks the server again", () => {
    render(<AccessError />);
    expect(screen.getByRole("alert").textContent).toContain(en.ownerTruth.accessErrorTitle);
    fireEvent.click(screen.getByRole("button", { name: en.ownerTruth.accessErrorRetry }));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  it("draws no operator link", () => {
    const { container } = render(<AccessError />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});
