/**
 * The Models page's "Switches" view (app/(app)/[channel]/models?view=switch, migration 0124), against a scripted Supabase.
 *
 * What would break without these: the view or its link showing while NIGHTSHIFT_MODEL_SWITCH is off (the feature ships dark), a customer
 * or an admin who is not the owner reaching the owner's switches, the owner's document read for anybody else, a failed or missing function
 * drawn as an empty board that reads as "nothing is switched off", and the existing views changing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  operator: true,
  role: "owner" as string | null,
  calls: [] as string[],
  results: {} as Record<string, { data: unknown; error: null | { code?: string; message?: string } }>,
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/chronos/models" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/chronos${s}` }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: async () => ({ slug: "chronos" }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => state.operator }));
vi.mock("@/lib/auth/roles", () => ({ resolvePlatformRole: async () => state.role }));

function builder(name: string) {
  state.calls.push(name);
  const result = state.results[name] ?? { data: [], error: null };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "eq"]) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: (fn: string) => builder(fn), from: (t: string) => builder(t) }),
  getUser: async () => ({ id: "u1" }),
}));

const DOC = {
  enforced: true,
  auto_suggest: false,
  suggest_threshold: 3,
  suggest_window_minutes: 60,
  providers: [
    {
      provider: "bytedance",
      switch: { enabled: false, reason: "out_of_funds", note: "SECRETNOTE", changed_at: "2026-10-25T10:00:00Z", changed_by_email: "owner@a.uz" },
      hidden: true,
      models: [{ id: "seedance-1.5-pro", display_name: "Seedance 1.5 Pro", capabilities: ["t2v"], availability: "ga", switch: null, hidden: true }],
    },
  ],
  alerts: [],
  log: [],
};

async function page(q: Record<string, string> = {}): Promise<string> {
  const mod = await import("../app/(app)/[channel]/models/page");
  const el = (await mod.default({ searchParams: Promise.resolve(q) })) as ReactElement;
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  state.operator = true;
  state.role = "owner";
  state.calls = [];
  state.results = {
    owner_model_switches: { data: DOC, error: null },
    model_registry_admin: { data: [], error: null },
    sellable_models: { data: [], error: null },
  };
});

describe("the owner's switches view", () => {
  it("with the variable off (the default) there is no link and the view reads nothing", async () => {
    for (const v of [undefined, "", "off", "true", "1"]) {
      if (v === undefined) delete process.env.NIGHTSHIFT_MODEL_SWITCH;
      else vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", v);
      state.calls = [];
      const browse = await page();
      expect(browse, String(v)).not.toContain(esc(en.modelSwitch.viewSwitch));
      const html = await page({ view: "switch" });
      expect(html).toContain(esc(en.modelSwitch.off.body));
      expect(html).not.toContain("SECRETNOTE");
      expect(state.calls).not.toContain("owner_model_switches");
    }
  });

  it("with the variable on, the owner has the link and the board with the owner's own words", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on");
    const nav = await page();
    expect(nav).toContain(esc(en.modelSwitch.viewSwitch));
    expect(nav).toContain('href="/chronos/models?view=switch"');
    state.calls = [];
    const html = await page({ view: "switch" });
    expect(state.calls).toContain("owner_model_switches");
    expect(html).toContain('data-testid="model-switch-board"');
    expect(html).toContain("SECRETNOTE");
    expect(html).toContain(esc(en.modelSwitch.status.hidden));
    expect(html).toContain('aria-current="page"');
  });

  it("an admin who is not the owner has no link, and opening the address reads nothing", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on");
    state.role = "admin";
    expect(await page()).not.toContain(esc(en.modelSwitch.viewSwitch));
    state.calls = [];
    const html = await page({ view: "switch" });
    expect(html).toContain(esc(en.modelSwitch.ownerOnly));
    expect(html).not.toContain("SECRETNOTE");
    expect(state.calls).not.toContain("owner_model_switches");
  });

  it("a customer never sees the view: the address shows the ordinary catalog", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on");
    state.operator = false;
    state.role = null;
    state.results.sellable_models = {
      data: [{ id: "vid-a", display_name: "Vid A", provider: "bytedance", capabilities: ["t2v"], availability: "ga", verified_at: "2026-09-30T10:00:00Z", credit_unit: "u_vid", entitlement: null, credits_per_unit: 3, margin: 0, spec: { output: "video", unit: "second", limits: { max_prompt_chars: 2000, max_concurrent_per_org: 1 } } }],
      error: null,
    };
    const html = await page({ view: "switch" });
    expect(state.calls).not.toContain("owner_model_switches");
    expect(html).not.toContain(esc(en.modelSwitch.viewSwitch));
    expect(html).not.toContain("SECRETNOTE");
    expect(html).toContain("Vid A");
  });

  it("the database refusing the owner (42501) reads as owner-only, never as an empty board", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on");
    state.results.owner_model_switches = { data: null, error: { code: "42501", message: "only the platform owner may do this" } };
    const html = await page({ view: "switch" });
    expect(html).toContain(esc(en.modelSwitch.ownerOnly));
    expect(html).not.toContain('data-testid="model-switch-board"');
  });

  it("migration 0124 missing says so; any other failure says it could not read; a malformed document is a failure", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on");
    state.results.owner_model_switches = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect(await page({ view: "switch" })).toContain(esc(en.modelSwitch.unsupported));
    state.results.owner_model_switches = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await page({ view: "switch" })).toContain(esc(en.modelSwitch.failed));
    state.results.owner_model_switches = { data: { providers: [] }, error: null };
    const html = await page({ view: "switch" });
    expect(html).toContain(esc(en.modelSwitch.failed));
    expect(html).not.toContain('data-testid="model-switch-board"');
  });

  it("the other views are what they were", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on");
    state.calls = [];
    await page({ view: "manage" });
    expect(state.calls).toContain("model_registry_admin");
    expect(state.calls).not.toContain("owner_model_switches");
  });
});
