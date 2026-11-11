// @vitest-environment jsdom
/**
 * The owner's "Prices & budget" view (app/(app)/[channel]/models?view=budget) and its board, against a scripted Supabase.
 *
 * What would break without these: vendor costs reaching anybody but the platform owner (an admin who is not the owner, a
 * customer), the address answering anything but a 404 for them, the registry being read on their behalf, a failed read
 * drawn as an empty list, and the calculator showing a figure before an amount is typed or for a model with no price.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => "/chronos/models",
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/chronos${s}` }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: async () => ({ slug: "chronos" }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => state.operator }));
vi.mock("@/lib/auth/roles", () => ({ resolvePlatformRole: async () => state.role }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ current: null }) }));

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

type Entry = Record<string, unknown> & { id: string };
const REGISTRY = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "model_registry.json"), "utf8")) as { models: Entry[] };
const COLUMNS = ["id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement"];
const rowOf = (id: string, availability = "hidden") => {
  const e = REGISTRY.models.find((m) => m.id === id)!;
  const spec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!COLUMNS.includes(k)) spec[k] = v;
  return { id: e.id, display_name: e.display_name, provider: e.provider, capabilities: e.capabilities, credit_unit: e.credit_unit, entitlement: e.entitlement, availability, spec };
};
const ROWS = [rowOf("minimax-h3-lite", "ga"), rowOf("recraft-v4.1"), rowOf("kling-v2.6"), rowOf("elevenlabs-flash-v2.5"), rowOf("veo-3.1", "beta")];

async function page(q: Record<string, string> = {}): Promise<string> {
  const mod = await import("../app/(app)/[channel]/models/page");
  const el = (await mod.default({ searchParams: Promise.resolve(q) })) as ReactElement;
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  state.operator = true;
  state.role = "owner";
  state.calls = [];
  state.results = {
    model_registry_admin: { data: ROWS, error: null },
    credit_prices: { data: [{ unit: "model_recraft_v4_1_image", credits_per_unit: 5, margin: 0.2 }], error: null },
    sellable_models: { data: [], error: null },
  };
});
afterEach(() => cleanup());

describe("who may open Prices & budget", () => {
  it("the platform owner has the link and the board, with the vendor's price", async () => {
    const nav = await page();
    expect(nav).toContain(esc(en.modelBudget.viewBudget));
    expect(nav).toContain('href="/chronos/models?view=budget"');
    state.calls = [];
    const html = await page({ view: "budget" });
    expect(state.calls).toEqual(expect.arrayContaining(["model_registry_admin", "credit_prices"]));
    expect(html).toContain('data-testid="model-budget-board"');
    expect(html).toContain(esc(String(REGISTRY.models.find((m) => m.id === "minimax-h3-lite")!.display_name)));
    expect(html).toContain("$0.04");
    expect(html).toContain(esc(en.modelBudget.noPrice));
    expect(html).toContain(esc(en.modelBudget.kinds.video));
    expect(html).toContain('aria-current="page"');
  });

  it("an admin who is not the owner has no link, and the address is a 404 that reads nothing", async () => {
    state.role = "admin";
    expect(await page()).not.toContain(esc(en.modelBudget.viewBudget));
    state.calls = [];
    await expect(page({ view: "budget" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.calls).not.toContain("model_registry_admin");
    expect(state.calls).not.toContain("credit_prices");
  });

  it("a customer gets a 404 and nothing is read for them", async () => {
    state.operator = false;
    state.role = null;
    state.calls = [];
    await expect(page({ view: "budget" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.calls).toEqual([]);
    expect(await page()).not.toContain(esc(en.modelBudget.viewBudget));
  });

  it("an operator whose role could not be read is not the owner", async () => {
    state.role = null;
    await expect(page({ view: "budget" })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the database refusing the read (42501) is a 404 too, never an empty board", async () => {
    state.results.model_registry_admin = { data: null, error: { code: "42501", message: "platform admin only" } };
    await expect(page({ view: "budget" })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("what the owner sees when a read goes wrong", () => {
  it("a missing function says the registry is not installed", async () => {
    state.results.model_registry_admin = { data: null, error: { code: "PGRST202", message: "Could not find the function public.model_registry_admin" } };
    expect(await page({ view: "budget" })).toContain(esc(en.modelBudget.notEnabled));
  });

  it("a failed read is an error, not an empty list", async () => {
    state.results.model_registry_admin = { data: null, error: { code: "XX000", message: "boom" } };
    const html = await page({ view: "budget" });
    expect(html).toContain(esc(en.modelBudget.failed));
    expect(html).not.toContain('data-testid="model-budget-board"');
  });

  it("an empty registry says how to fill it", async () => {
    state.results.model_registry_admin = { data: [], error: null };
    expect(await page({ view: "budget" })).toContain(esc(en.modelBudget.empty));
  });

  it("a price list that could not be read leaves customer prices unknown, and says so", async () => {
    state.results.credit_prices = { data: null, error: { code: "XX000", message: "boom" } };
    const html = await page({ view: "budget" });
    expect(html).toContain(esc(en.modelBudget.pricesUnread));
    expect(html).toContain(esc(en.modelBudget.customerUnread));
  });
});

describe("the calculator under each model", () => {
  async function board() {
    const { budgetModelsFrom } = await import("../lib/owner/budget");
    const { ModelBudgetBoard } = await import("../components/models/ModelBudgetBoard");
    const groups = budgetModelsFrom(ROWS, { model_recraft_v4_1_image: 6 }, "2026-11-11");
    render(<ModelBudgetBoard groups={groups} pricesUnread={false} />);
  }
  const row = (id: string) => screen.getAllByTestId("budget-model").find((el) => el.getAttribute("data-model") === id)!;

  it("shows nothing until an amount is typed, then the count, rounded down, at the stated option and length", async () => {
    await board();
    const r = within(row("minimax-h3-lite"));
    expect(r.getByTestId("budget-result").textContent).toBe("");
    fireEvent.change(r.getByTestId("budget-input"), { target: { value: "10" } });
    const text = r.getByTestId("budget-result").textContent ?? "";
    expect(text).toContain("Videos of 4 s: ≈ 62 (≈ 4.1 min in all)");
    expect(text).toContain(en.modelBudget.startsOn.default_resolution);
    expect(text).toContain(en.modelBudget.shortest);
    fireEvent.change(r.getByTestId("budget-input"), { target: { value: "ten" } });
    expect(r.getByTestId("budget-result").textContent).toBe("");
    fireEvent.change(r.getByTestId("budget-input"), { target: { value: "10,5" } });
    expect(r.getByTestId("budget-result").textContent).toContain("≈ 65");
  });

  it("recounts when another option or length is picked", async () => {
    await board();
    const r = within(row("minimax-h3-lite"));
    fireEvent.change(r.getByTestId("budget-input"), { target: { value: "10" } });
    fireEvent.change(r.getByLabelText(en.modelBudget.option), { target: { value: "480p" } });
    fireEvent.change(r.getByLabelText(en.modelBudget.length), { target: { value: "10" } });
    expect(r.getByTestId("budget-result").textContent).toContain("Videos of 10 s: ≈ 40 (≈ 6.6 min in all)");
  });

  it("images, characters, and the customer price where one exists", async () => {
    await board();
    const img = within(row("recraft-v4.1"));
    fireEvent.change(img.getByTestId("budget-input"), { target: { value: "10" } });
    expect(img.getByTestId("budget-result").textContent).toBe("Images: ≈ 285");
    expect(img.getByTestId("budget-customer").textContent).toBe("6 credits per image");
    expect(img.getByTestId("budget-vendor-cost").textContent).toContain(en.modelBudget.estimate);
    const voice = within(row("elevenlabs-flash-v2.5"));
    fireEvent.change(voice.getByTestId("budget-input"), { target: { value: "10" } });
    expect(voice.getByTestId("budget-result").textContent).toBe("Characters of speech: ≈ 250,000");
    expect(voice.getByTestId("budget-customer").textContent).toBe(en.modelBudget.customerNone);
  });

  it("a model with no price has no field and says so", async () => {
    await board();
    const r = within(row("kling-v2.6"));
    expect(r.getByTestId("budget-no-price").textContent).toBe(en.modelBudget.noPrice);
    expect(r.queryByTestId("budget-input")).toBeNull();
  });

  it("names a vendor shutdown that has passed", async () => {
    await board();
    expect(row("veo-3.1").textContent).toContain("Past vendor shutdown (2026-10-22)");
    expect(row("veo-3.1").textContent).toContain(en.modelBudget.status.beta);
  });
});

describe("the three languages", () => {
  it("have the same keys", async () => {
    const { ru } = await import("../lib/i18n/ru");
    const { uz } = await import("../lib/i18n/uz");
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}.${k}`)) : [p];
    expect(keys(ru.modelBudget).sort()).toEqual(keys(en.modelBudget).sort());
    expect(keys(uz.modelBudget).sort()).toEqual(keys(en.modelBudget).sort());
    expect(ru.modelBudget.rules.items).toHaveLength(en.modelBudget.rules.items.length);
    expect(uz.modelBudget.rules.items).toHaveLength(en.modelBudget.rules.items.length);
  });
});
