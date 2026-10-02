/**
 * The Models page (app/(app)/[channel]/models), against a scripted Supabase.
 *
 * What would break without these: a customer reading the operator's registry
 * (or its availability switches), the operator losing them, and a failed or
 * missing registry rendered as an empty catalog.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";
import { PROVIDER_BRANDS } from "./helpers/brands";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  operator: false,
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
// Shared components on the public pages read the public slice the same way.
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

const sellableRow = {
  id: "vid-a",
  display_name: "Vid A",
  provider: "bytedance",
  capabilities: ["t2v"],
  availability: "ga",
  verified_at: "2026-09-30T10:00:00Z",
  credit_unit: "u_vid",
  entitlement: null,
  credits_per_unit: 3,
  margin: 7.777,
  spec: { output: "video", unit: "second", limits: { max_prompt_chars: 2000, max_concurrent_per_org: 1 } },
};
const adminRow = {
  id: "img-x",
  display_name: "Img X",
  provider: "openai",
  adapter: "image.openai",
  capabilities: ["t2i"],
  availability: "hidden",
  verified_at: null,
  credit_unit: "u_img",
  entitlement: null,
  spec: { output: "image", vendor_model: "vendor-secret", pricing: { unit: "image", provider_usd_per_unit: 0.77 } },
  updated_at: null,
};

async function page(q: Record<string, string> = {}): Promise<string> {
  const mod = await import("../app/(app)/[channel]/models/page");
  const el = (await mod.default({ searchParams: Promise.resolve(q) })) as ReactElement;
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  state.calls = [];
  state.results = {
    sellable_models: { data: [sellableRow], error: null },
    credit_prices: { data: [{ unit: "u_vid", credits_per_unit: 3, margin: 9.999, note: "NOTECANARY" }], error: null },
    model_registry_admin: { data: [adminRow], error: null },
    model_probe_runs: { data: [], error: null },
  };
});

describe("Models page", () => {
  it("shows a customer what sellable_models() returns, and never asks for the registry", async () => {
    state.operator = false;
    const html = await page();
    expect(html).toContain("Vid A");
    expect(html).toContain('href="/chronos/create?tool=t2v&amp;model=vid-a"');
    expect(state.calls).toContain("sellable_models");
    expect(state.calls).not.toContain("model_registry_admin");
    expect(state.calls).not.toContain("model_probe_runs");
    expect(html).not.toContain(esc(en.modelDiscovery.viewsLabel));
  });

  it("sends a customer no margin, price-list note, provider or brand", async () => {
    state.operator = false;
    const html = await page({ model: "vid-a" });
    for (const leak of ["7.777", "9.999", "NOTECANARY", "margin", "bytedance", "ByteDance", "u_vid"]) expect(html).not.toContain(leak);
    // The display name is the Studio's own word for a model; nothing else may name a vendor.
    expect(html.split("Vid A").join("").replace(/<[^>]+>/g, " ")).not.toMatch(PROVIDER_BRANDS);
  });

  it("gives a customer who asks for ?view=manage the catalog, not the switches", async () => {
    state.operator = false;
    const html = await page({ view: "manage" });
    expect(state.calls).not.toContain("model_registry_admin");
    expect(html).not.toContain(esc(en.models.lastProbe));
    expect(html).toContain("Vid A");
  });

  it("shows the operator the whole registry without its private spec, and keeps the switches one key away", async () => {
    state.operator = true;
    const html = await page();
    expect(html).toContain("Img X");
    expect(html).toContain(esc(en.modelDiscovery.viewsLabel));
    expect(html).not.toContain(esc(en.models.lastProbe));
    expect(html).not.toContain("vendor-secret");
    expect(html).not.toContain("0.77");
    const manage = await page({ view: "manage" });
    expect(manage).toContain(esc(en.models.lastProbe));
  });

  it("says when the registry is not applied, and when the read failed — never an empty catalog", async () => {
    state.operator = false;
    state.results.sellable_models = { data: null, error: { code: "PGRST202", message: "x" } };
    expect(await page()).toContain(esc(en.modelDiscovery.notEnabled));
    state.results.sellable_models = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await page()).toContain(esc(en.modelDiscovery.readFailed));
    state.results.sellable_models = { data: [], error: null };
    expect(await page()).toContain(esc(en.modelDiscovery.emptyCustomer));
  });
});
