// @vitest-environment jsdom
/**
 * Image quality tiers (migration 0060): the Studio composer shows low /
 * medium / high for a picture model that sells them, with each tier's price
 * from the database; the quote and the create call carry the tier; a model
 * without tiers is never sent one; and nothing here prices anything itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { coerceSellableModels } from "@/lib/creative/registry";
import { IMAGE_QUALITIES, parseGenerationInput, PARAM_KEYS, QUALITY_CAPABILITIES } from "@/lib/creative/operations";
import {
  buildParams,
  effectiveQuality,
  prefillFromJob,
  sheetQuoteParams,
  tierQuoteParams,
  withTiers,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const TIERED: StudioModel = {
  id: "tiered",
  displayName: "Tiered Picture",
  capabilities: ["t2i", "edit"],
  beta: false,
  qualities: ["low", "medium", "high"],
};
const FLAT: StudioModel = { id: "flat", displayName: "Flat Picture", capabilities: ["t2i", "edit"], beta: false };

/** The database's prices: one per tier, none for a tier that has no row. */
let tierCredits: Record<string, number | null>;
let quotes: Array<{ model: string; capability: string; params: Record<string, unknown> }>;
let fetchMock: ReturnType<typeof vi.fn>;
const creates = () =>
  fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  tierCredits = { low: 1, medium: 4, high: 16 };
  quotes = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      if (body.model === "flat") {
        // The database refuses a tier a model does not list.
        if (body.params.quality) return json({ error: "invalid_params" }, 400);
        return json({ quote: { credits: 3 } });
      }
      const q = (body.params.quality ?? "medium") as string;
      const credits = tierCredits[q];
      return credits == null ? json({ error: "unpriced" }, 422) : json({ quote: { credits, quality: q } });
    }
    if (url === "/api/creative/jobs" && init?.method === "POST") return json({ job: { id: "j1" }, replay: false }, 201);
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "t2i",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

// ── the pure half ────────────────────────────────────────────────────────────

describe("the tier in the request", () => {
  it("is sent for t2i and edit when one is named, and left out otherwise", () => {
    expect(buildParams(form({ prompt: "a cat", quality: "high" }))).toEqual({ prompt: "a cat", aspect_ratio: "16:9", quality: "high" });
    expect(buildParams(form({ prompt: "a cat" }))).toEqual({ prompt: "a cat", aspect_ratio: "16:9" });
    expect(buildParams(form({ prompt: "a cat", quality: null }))).not.toHaveProperty("quality");
    expect(buildParams(form({ capability: "edit", prompt: "night", sourceId: PIC, quality: "low" }))).toEqual({
      prompt: "night",
      source_asset_id: PIC,
      quality: "low",
    });
  });

  it("is never sent for a tool that has no tiers", () => {
    for (const capability of ["t2v", "i2v", "upscale", "remove_bg", "describe", "tts"] as const) {
      const params = buildParams(form({ capability, prompt: "x", sourceId: PIC, quality: "high" }));
      expect(params, capability).not.toHaveProperty("quality");
    }
  });

  it("the key is one the database accepts, only for the capabilities that have tiers", () => {
    expect(PARAM_KEYS).toContain("quality");
    expect([...QUALITY_CAPABILITIES]).toEqual(["t2i", "edit"]);
  });
});

describe("the tier a model is asked for", () => {
  it("is the picked one when the model sells it, else medium, else its first", () => {
    expect(effectiveQuality(TIERED, "high")).toBe("high");
    expect(effectiveQuality(TIERED, null)).toBe("medium");
    expect(effectiveQuality({ qualities: ["low", "high"] }, "medium")).toBe("low");
    expect(effectiveQuality({ qualities: ["low", "high"] }, null)).toBe("low");
  });

  it("is none for a model without tiers, so none is sent", () => {
    expect(effectiveQuality(FLAT, "high")).toBeNull();
    expect(effectiveQuality(null, "high")).toBeNull();
    expect(effectiveQuality({ qualities: [] }, "low")).toBeNull();
  });
});

describe("the model's tiers come from the database's public spec", () => {
  const row = (id: string, spec: Record<string, unknown>) => ({ id, spec });
  it("keeps the canonical order and drops anything that is not a tier", () => {
    const [m] = withTiers([{ ...FLAT, id: "m" }], [row("m", { qualities: ["high", "low", "ultra", "medium"] })]);
    expect(m.qualities).toEqual(["low", "medium", "high"]);
  });

  it("a model whose spec states none carries none", () => {
    expect(withTiers([FLAT], [row("flat", {})])[0].qualities).toBeUndefined();
    expect(withTiers([FLAT], [row("flat", { qualities: [] })])[0].qualities).toBeUndefined();
    expect(withTiers([FLAT], [row("flat", { qualities: "high" })])[0].qualities).toBeUndefined();
  });

  it("the typed spec reads the tiers too", () => {
    const [m] = coerceSellableModels([
      {
        id: "tiered",
        display_name: "Tiered",
        provider: "acme",
        capabilities: ["t2i"],
        availability: "beta",
        verified_at: "2026-09-30T10:00:00Z",
        credit_unit: "model_tiered_image",
        entitlement: null,
        credits_per_unit: "16",
        margin: "0",
        spec: {
          output: "image",
          unit: "image",
          qualities: ["low", "medium", "high", "extreme"],
          limits: { max_prompt_chars: 4000, max_concurrent_per_org: 2 },
        },
      },
    ]);
    expect(m.spec.qualities).toEqual(["low", "medium", "high"]);
  });
});

describe("Try again keeps the tier the job had", () => {
  const job = (capability: string, params: Record<string, unknown>) =>
    ({ id: "j", capability, requested_model: "tiered", params, status: "completed" }) as unknown as StudioJob;
  it("for a picture job", () => {
    expect(prefillFromJob(job("t2i", { prompt: "x", quality: "high" }))?.quality).toBe("high");
    expect(prefillFromJob(job("t2i", { prompt: "x", quality: "ultra" }))).not.toHaveProperty("quality");
    expect(prefillFromJob(job("t2i", { prompt: "x" }))).not.toHaveProperty("quality");
    expect(prefillFromJob(job("t2v", { prompt: "x", quality: "high" }))).not.toHaveProperty("quality");
  });
});

describe("the route's input check", () => {
  const parse = (capability: string, params: Record<string, unknown>) =>
    parseGenerationInput({ capability, model: "m", params, max_credits: 5 }, ORG, { requirePrice: true });

  it("accepts a tier on t2i and edit", () => {
    expect(parse("t2i", { prompt: "x", quality: "low" }).ok).toBe(true);
    expect(parse("edit", { prompt: "x", source_asset_id: PIC, quality: "high" }).ok).toBe(true);
  });

  it("refuses an unknown tier, a non-text tier and a tier on another tool", () => {
    for (const quality of ["ultra", "HIGH", "", 2, null, ["low"]]) {
      const p = parse("t2i", { prompt: "x", quality });
      expect(p.ok, JSON.stringify(quality)).toBe(false);
      if (!p.ok) expect(p.result.body.error).toBe("invalid_params");
    }
    const p = parse("t2v", { prompt: "x", quality: "low" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(JSON.stringify(p.result.body)).toContain("quality does not apply to t2v");
  });
});

describe("the tiers are priced without the words", () => {
  it("a stand-in for the prompt, no tier of its own, and nothing until an edit has its picture", () => {
    expect(tierQuoteParams(form({ prompt: "my secret plan" }))).toEqual({ prompt: "price check", aspect_ratio: "16:9" });
    expect(tierQuoteParams(form({ prompt: "x", quality: "high" }))).not.toHaveProperty("quality");
    expect(tierQuoteParams(form({ capability: "edit", prompt: "x", sourceId: null }))).toBeNull();
    expect(tierQuoteParams(form({ capability: "edit", prompt: "x", sourceId: PIC }))).toEqual({
      prompt: "price check",
      source_asset_id: PIC,
    });
    expect(tierQuoteParams(form({ capability: "t2v", prompt: "x" }))).toBeNull();
  });
});

describe("the sheet prices the same settings", () => {
  it("never carries a tier of its own: each model is priced at its own", () => {
    expect(sheetQuoteParams(form({ prompt: "a cat" }))).not.toHaveProperty("quality");
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

describe("the quality selector", () => {
  it("shows each tier with the price the database gave it, medium picked to start", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED]} />));
    expect(screen.getByRole("group", { name: t.gen.qualityLabel })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("gen-quality-high").textContent).toContain("16 credits"));
    expect(screen.getByTestId("gen-quality-low").textContent).toBe("Low · 1 credits");
    expect(screen.getByTestId("gen-quality-medium").textContent).toBe("Medium · 4 credits");
    expect(screen.getByTestId("gen-quality-medium").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("gen-quality-low").getAttribute("aria-pressed")).toBe("false");
    // Every number came from a quote of that tier — nothing was computed here.
    const asked = quotes.filter((q) => q.params.quality).map((q) => q.params.quality);
    expect(new Set(asked)).toEqual(new Set(["low", "medium", "high"]));
  });

  it("never sends the words to a tier price, and typing does not ask the tiers again", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED]} />));
    await waitFor(() => expect(screen.getByTestId("gen-quality-high").textContent).toContain("16 credits"));
    const tierQuotes = () => quotes.filter((q) => q.params.prompt === "price check");
    expect(tierQuotes()).toHaveLength(3);
    const area = document.getElementById("gen-prompt") as HTMLTextAreaElement;
    for (const text of ["a", "a red", "a red kite over a quiet harbour"]) fireEvent.change(area, { target: { value: text } });
    // The one price for the button (the real words, the picked tier) is asked once the typing pauses.
    await screen.findByRole("button", { name: /Generate · 4 credits/ });
    expect(tierQuotes()).toHaveLength(3);
    const typed = quotes.filter((q) => q.params.prompt !== "price check");
    expect(typed.length).toBeGreaterThan(0);
    // Only the button's own quote carries the words; none of the tier prices do.
    expect(typed.every((q) => q.params.quality === "medium")).toBe(true);
    expect(JSON.stringify(tierQuotes())).not.toContain("harbour");
  });

  it("asks the price of the picked tier for the button, and sends exactly that tier and price on create", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED]} />));
    fireEvent.change(document.getElementById("gen-prompt") as HTMLTextAreaElement, { target: { value: "a red kite" } });
    // Default tier: medium.
    const button = await screen.findByRole("button", { name: /Generate · 4 credits/ });
    fireEvent.click(screen.getByTestId("gen-quality-high"));
    const high = await screen.findByRole("button", { name: /Generate · 16 credits/ });
    expect(button).toBe(high);
    fireEvent.click(high);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const sent = JSON.parse(String((creates()[0][1] as RequestInit).body));
    expect(sent.params).toMatchObject({ prompt: "a red kite", quality: "high" });
    // The ceiling is the price of the tier the person saw on the button.
    expect(sent.max_credits).toBe(16);
  });

  it("sends the default tier explicitly, so what was priced is what is sent", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED]} />));
    fireEvent.change(document.getElementById("gen-prompt") as HTMLTextAreaElement, { target: { value: "a red kite" } });
    fireEvent.click(await screen.findByRole("button", { name: /Generate · 4 credits/ }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(JSON.parse(String((creates()[0][1] as RequestInit).body)).params.quality).toBe("medium");
  });

  it("is not shown for a model without tiers, and no tier is ever sent to it", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[FLAT]} />));
    fireEvent.change(document.getElementById("gen-prompt") as HTMLTextAreaElement, { target: { value: "a red kite" } });
    await screen.findByRole("button", { name: /Generate · 3 credits/ });
    expect(screen.queryByTestId("gen-quality")).toBeNull();
    expect(quotes.every((q) => !("quality" in q.params))).toBe(true);
  });

  it("is not shown for a tool that has no tiers", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[{ ...TIERED, capabilities: ["t2v"] }]} />));
    expect(screen.queryByTestId("gen-quality")).toBeNull();
  });

  it("a tier with no price is said to be unpriced and cannot be picked — never shown as free", async () => {
    tierCredits = { low: null, medium: 4, high: 16 };
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED]} />));
    await waitFor(() => expect(screen.getByTestId("gen-quality-low").textContent).toContain(t.gen.qualityUnpriced));
    const low = screen.getByTestId("gen-quality-low") as HTMLButtonElement;
    expect(low.disabled).toBe(true);
    expect(low.textContent).not.toMatch(/\b0\b/);
    expect(screen.getByTestId("gen-quality-high").textContent).toContain("16 credits");
  });

  it("starts from the tier Try again carries", async () => {
    render(
      withI18n(
        <GeneratePanel
          orgId={ORG}
          models={[TIERED]}
          initial={{ capability: "t2i", model: "tiered", prompt: "a kite", aspect: "1:1", duration: 5, quality: "low" }}
        />,
      ),
    );
    expect(screen.getByTestId("gen-quality-low").getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("button", { name: /Generate · 1 credits/ });
    expect(creates()).toHaveLength(0); // a prefill spends nothing
  });

  it("the model sheet prices each model at its own tier: a flat model is asked without one", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED, FLAT]} />));
    await waitFor(() => expect(screen.getByTestId("gen-quality-high").textContent).toContain("16 credits"));
    fireEvent.click(screen.getByTestId("gen-quality-high"));
    quotes.length = 0;
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    await waitFor(() => expect(quotes.filter((q) => q.params.prompt === "price check")).toHaveLength(2));
    const sheet = quotes.filter((q) => q.params.prompt === "price check");
    expect(sheet.find((q) => q.model === "tiered")?.params.quality).toBe("high");
    expect(sheet.find((q) => q.model === "flat")?.params).not.toHaveProperty("quality");
    // Prices only, never a hold.
    expect(creates()).toHaveLength(0);
  });

  it("an edit asks for no tier price until a picture is chosen", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[TIERED]} initial={{ capability: "edit", model: "tiered", prompt: "", aspect: "16:9", duration: 5, sourceId: null }} />));
    expect(quotes).toHaveLength(0);
    expect(screen.getByTestId("gen-quality-medium").textContent).toBe("Medium");
  });
});

// ── copy ─────────────────────────────────────────────────────────────────────

describe("the words", () => {
  it("exist in all three languages and name no vendor", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      const g = dictionaries[lang].gen;
      for (const text of [g.qualityLabel, g.qualities.low, g.qualities.medium, g.qualities.high, g.qualityNote, g.qualityUnpriced]) {
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/openai|gpt|google|gemini|flux|ideogram/i);
      }
    }
    expect(dictionaries.ru.gen.qualities.low).not.toBe(dictionaries.en.gen.qualities.low);
    expect(dictionaries.uz.gen.qualities.low).not.toBe(dictionaries.en.gen.qualities.low);
  });

  it("the panel puts no tier price in the source: only the database's quote is shown", () => {
    const src = readFileSync(path.join(process.cwd(), "components/studio/GeneratePanel.tsx"), "utf8");
    expect(src).not.toMatch(/credits_per_unit|creditsPerUnit/);
  });
});

// ── pinned to 0060 ───────────────────────────────────────────────────────────

const SQL = readFileSync(path.join(process.cwd(), "..", "supabase/migrations/0060_image_quality.sql"), "utf8");
function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(.*?\\n\\$\\$;\\n`, "s").exec(SQL);
  if (!m) throw new Error(`0060 does not define ${name}`);
  return m[0];
}

describe("pinned to 0060", () => {
  it("the tier allow-list is the same in the code and the database", () => {
    expect(fn("creative_params_problem")).toContain(`not in (${IMAGE_QUALITIES.map((q) => `'${q}'`).join(", ")})`);
    expect(fn("creative_params_problem")).toContain("p_capability not in ('t2i', 'edit')");
    expect(QUALITY_CAPABILITIES).toEqual(["t2i", "edit"]);
  });

  it("every param key the code sends is one 0060 accepts", () => {
    const params = fn("creative_params_problem");
    for (const k of PARAM_KEYS) expect(params, k).toContain(`'${k}'`);
  });

  it("the default tier is medium on both sides, and a tier is priced by its own row", () => {
    const price = fn("creative_price");
    expect(price).toContain("coalesce(p_params ->> 'quality', 'medium')");
    expect(price).toContain("m_unit := m_unit || '_' ||");
    expect(price).toContain("perform public.creative_refuse('unpriced',");
  });

  it("the public spec carries the tiers", () => {
    expect(fn("sellable_models")).toContain("'qualities', m.spec -> 'qualities'");
  });
});
