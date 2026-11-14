// @vitest-environment jsdom
/**
 * The Studio's create surface built from the picked model (Pixel audit, 2026-11-13):
 *  - the shape, length and resolution keys come from the model's own lists (sellable_models' spec), never a fixed 16:9 / 9:16 / 1:1
 *    and 5 / 10 s that a model refuses (0155 shapes, 0159 lengths); Auto offers the union with a note;
 *  - a resolution is offered only where the price follows it, and the default is sent as nothing;
 *  - a model the organization cannot buy is never the default, and its lock is named in words that match the database (a first
 *    purchase opens it, or nothing does yet) — not the red "after your first credit purchase" for every refusal;
 *  - the price key turns into "Add credits · need N more" when the quote is more than the credits available;
 *  - the header's credits are read again after a generation starts, is cancelled or finishes (lib/credits-live);
 *  - a job of a model no longer sold is named from the registry, never by its raw id.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null, getUser: async () => null }));
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
import {
  buildParams,
  capabilityLine,
  durationsFor,
  entitlementReason,
  fellBackLine,
  modelLock,
  modelSettings,
  prefillFromJob,
  resolutionsFor,
  shapesFor,
  snapSeconds,
  snapShape,
  withTiers,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";
import { REGISTRY_NAMES, registryName } from "@/lib/creative/model-names";
import { creditsFor, refreshCredits, resetCreditsLive, seedCredits, useLiveCredits } from "@/lib/credits-live";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Veo 3.1's own lists (schemas/model_registry.json), sold flat (no resolution picker). */
const VEO: StudioModel = {
  id: "veo-like",
  displayName: "Veo Like",
  capabilities: ["t2v", "i2v"],
  beta: false,
  aspectRatios: ["16:9", "9:16"],
  durations: [4, 6, 8],
  resolutions: ["720p", "1080p", "4k"],
};
/** Seedance 2.0's: priced by resolution with a pinned default, so a resolution is offered. */
const SEED: StudioModel = {
  id: "seed-like",
  displayName: "Seed Like",
  capabilities: ["t2v"],
  beta: false,
  aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  durations: [4, 5, 8, 10, 15],
  resolutions: ["480p", "720p", "1080p"],
  defaultResolution: "720p",
  resolutionPriced: true,
};
/** Vidu Q3's sixteen lengths: one select, not sixteen keys. */
const LONG: StudioModel = {
  id: "long-like",
  displayName: "Long Like",
  capabilities: ["t2v"],
  beta: false,
  aspectRatios: ["16:9"],
  durations: Array.from({ length: 16 }, (_, i) => i + 1),
};

let quotes: Array<{ model?: string; mode?: string; capability: string; params: Record<string, unknown> }>;
let fetchMock: ReturnType<typeof vi.fn>;
let quoteReply: () => Promise<Response>;
const creates = () => fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST");
const accountReads = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/credits/account"));

beforeEach(() => {
  quotes = [];
  quoteReply = () => json({ quote: { credits: 25 } });
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      quotes.push(JSON.parse(String(init?.body)));
      return quoteReply();
    }
    if (url === "/api/creative/jobs" && init?.method === "POST") return json({ job: { id: "j1" }, replay: false }, 201);
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/credits/account")) return json({ supported: true, account: { balance: 400, reserved: 25 } });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  resetCreditsLive();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCreditsLive();
});

const lastQuote = () => quotes[quotes.length - 1];
const keys = (group: string) =>
  Array.from(screen.getByRole("group", { name: group }).querySelectorAll("button")).map((b) => b.textContent?.trim());

// ── the lists, from the spec ─────────────────────────────────────────────────────────────────────────────────────

describe("withTiers carries the lists the quote reads", () => {
  it("reads shapes, lengths, resolutions and whether the price follows the resolution from sellable_models' spec", () => {
    const [m] = withTiers([{ id: "a", displayName: "A", capabilities: ["t2v"], beta: false }], [
      {
        id: "a",
        spec: {
          aspect_ratios: ["9:16", "16:9", "4:3"],
          aspect_ratios_by_capability: { t2v: ["16:9"] },
          durations_s: [8, 4, 6],
          resolutions: ["720p", "768p", "2k"],
          default_resolution: "768p",
          price_variants_by: "resolution",
        },
      },
    ]);
    expect(m.aspectRatios).toEqual(["16:9", "9:16", "4:3"]);
    expect(m.shapesByCapability).toEqual({ t2v: ["16:9"] });
    expect(m.durations).toEqual([4, 6, 8]);
    expect(m.resolutions).toEqual(["720p", "768p", "2k"]);
    expect(m.defaultResolution).toBe("768p");
    expect(m.resolutionPriced).toBe(true);
  });

  it("a model sold flat is never marked as priced by resolution, and an unread spec carries no list", () => {
    const [flat, unread] = withTiers(
      [
        { id: "f", displayName: "F", capabilities: ["t2v"], beta: false },
        { id: "u", displayName: "U", capabilities: ["t2v"], beta: false },
      ],
      [{ id: "f", spec: { resolutions: ["720p", "1080p"], durations_s: [5, 10] } }],
    );
    expect(flat.resolutionPriced).toBeUndefined();
    expect(unread.durations).toBeUndefined();
    expect(unread.aspectRatios).toBeUndefined();
  });
});

describe("shapesFor / durationsFor / resolutionsFor", () => {
  it("a picked model offers exactly its own lists; one whose spec was not read keeps the old three shapes and two lengths", () => {
    expect(shapesFor([VEO], VEO, false, "t2v")).toEqual(["16:9", "9:16"]);
    expect(durationsFor([VEO], VEO, false)).toEqual([4, 6, 8]);
    const bare: StudioModel = { id: "b", displayName: "B", capabilities: ["t2v"], beta: false };
    expect(shapesFor([bare], bare, false, "t2v")).toEqual(["16:9", "9:16", "1:1"]);
    expect(durationsFor([bare], bare, false)).toEqual([5, 10]);
  });

  it("a capability narrowing wins for its capability (0155's rule)", () => {
    const m = { ...SEED, shapesByCapability: { t2v: ["16:9", "9:16"] } };
    expect(shapesFor([m], m, false, "t2v")).toEqual(["16:9", "9:16"]);
    expect(shapesFor([m], m, false, "t2i")).toEqual(["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"]);
  });

  it("Auto offers the union of every model's lists", () => {
    expect(durationsFor([VEO, SEED], null, true)).toEqual([4, 5, 6, 8, 10, 15]);
    expect(shapesFor([VEO, SEED], null, true, "t2v")).toEqual(["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"]);
  });

  it("a resolution only where the price follows it, never under Auto, the default included", () => {
    expect(resolutionsFor(SEED, false)).toEqual(["480p", "720p", "1080p"]);
    expect(resolutionsFor(VEO, false)).toEqual([]);
    expect(resolutionsFor(SEED, true)).toEqual([]);
    // a listed name the database's shape does not take is not offered (the default always is: it is sent as nothing)
    expect(resolutionsFor({ ...SEED, resolutions: ["768p", "4K", "1080p"], defaultResolution: "768p" }, false)).toEqual(["768p", "1080p"]);
  });

  it("snaps a shape and a length the model does not list to one it does", () => {
    expect(snapShape("1:1", ["16:9", "9:16"])).toBe("16:9");
    expect(snapShape("9:16", ["16:9", "9:16"])).toBe("9:16");
    expect(snapShape("1:1", ["4:3", "3:4"])).toBe("4:3");
    expect(snapSeconds(5, [4, 6, 8])).toBe(4);
    expect(snapSeconds(10, [4, 6, 8])).toBe(8);
    expect(snapSeconds(7, [5, 10])).toBe(5);
  });

  it("each model in the sheet is priced at the settings it would be sent", () => {
    expect(modelSettings(VEO, "t2v", "1:1", 5, null)).toEqual({ aspect_ratio: "16:9", duration_s: 4, resolution: null });
    expect(modelSettings(SEED, "t2v", "1:1", 5, "1080p")).toEqual({ aspect_ratio: "1:1", duration_s: 5, resolution: "1080p" });
    expect(modelSettings(SEED, "t2v", "1:1", 5, "720p")).toEqual({ aspect_ratio: "1:1", duration_s: 5, resolution: null });
  });

  it("a retried job keeps any shape and length the database could have taken, and its resolution", () => {
    const job = { id: "j", capability: "t2v", status: "failed", requested_model: "veo-like", params: { prompt: "p", aspect_ratio: "4:3", duration_s: 6, resolution: "1080p" } };
    const p = prefillFromJob(job as unknown as StudioJob);
    expect(p).toMatchObject({ aspect: "4:3", duration: 6, resolution: "1080p" });
    expect(buildParams({ capability: "t2v", prompt: "p", aspect: "4:3", duration: 6, resolution: "1080p" })).toEqual({
      prompt: "p",
      aspect_ratio: "4:3",
      duration_s: 6,
      resolution: "1080p",
    });
    // a resolution goes only with a clip
    expect(buildParams({ capability: "t2i", prompt: "p", aspect: "16:9", duration: 5, resolution: "1080p" })).toEqual({ prompt: "p", aspect_ratio: "16:9" });
  });
});

// ── the panel ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the panel builds its keys from the picked model", () => {
  it("a model that makes 4, 6 or 8 seconds in 16:9 or 9:16 is never offered 5 s, 10 s or 1:1, and is asked for what it makes", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[VEO]} initial={{ capability: "t2v", model: "", prompt: "a lighthouse", aspect: "1:1", duration: 5 }} />));
    expect(keys(t.gen.durationLabel)).toEqual(["4 s", "6 s", "8 s"]);
    expect(keys(t.gen.aspectLabel)).toEqual(["16:9", "9:16"]);
    await waitFor(() => expect(lastQuote()).toBeDefined());
    expect(lastQuote().params).toMatchObject({ aspect_ratio: "16:9", duration_s: 4 });
    // a flat-priced model offers no resolution
    expect(screen.queryByRole("group", { name: t.gen.resolutionLabel })).toBeNull();
  });

  it("a model with sixteen lengths gets one select of them", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[LONG]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    const select = screen.getByLabelText(t.gen.durationLabel) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.options).toHaveLength(16);
    fireEvent.change(select, { target: { value: "12" } });
    await waitFor(() => expect(lastQuote()?.params.duration_s).toBe(12));
  });

  it("the resolution starts on the default, which is sent as nothing, and a picked one is sent and quoted", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SEED]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    const group = screen.getByRole("group", { name: t.gen.resolutionLabel });
    expect(Array.from(group.querySelectorAll("button")).map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    await waitFor(() => expect(lastQuote()).toBeDefined());
    expect(lastQuote().params).not.toHaveProperty("resolution");
    fireEvent.click(screen.getByRole("button", { name: "1080p" }));
    await waitFor(() => expect(lastQuote().params.resolution).toBe("1080p"));
  });

  it("Auto offers every model's lengths and says it picks among the models that make them", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[VEO, SEED]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 5, auto: true }} />));
    expect(keys(t.gen.durationLabel)).toEqual(["4 s", "5 s", "6 s", "8 s", "10 s", "15 s"]);
    expect(screen.getByTestId("gen-auto-settings").textContent).toBe(t.gen.autoSettingsNote);
  });
});

describe("a model this organization cannot buy", () => {
  const LOCKED: StudioModel = { id: "aaa-locked", displayName: "AAA Locked", capabilities: ["t2i"], beta: false, entitlement: "models_image:premium", lock: "not_on_sale" };
  const OPEN: StudioModel = { id: "zzz-open", displayName: "ZZZ Open", capabilities: ["t2i"], beta: false, entitlement: "any" };

  it("is not the default even when its name sorts first", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[LOCKED, OPEN]} initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    expect(screen.getByTestId("gen-model-name").textContent).toBe("ZZZ Open");
    await waitFor(() => expect(lastQuote()?.model).toBe("zzz-open"));
  });

  it("when it is the one picked, nothing is quoted and the reason is named quietly, not as a failure", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[LOCKED, OPEN]} initial={{ capability: "t2i", model: "aaa-locked", prompt: "x", aspect: "16:9", duration: 5 }} />));
    const line = await screen.findByTestId("gen-locked");
    expect(line.textContent).toContain(t.gen.lockWhy.not_on_sale);
    expect(line.className).toContain("color-muted");
    expect(screen.getByTestId("gen-model-lock").textContent).toContain(t.gen.lock.not_on_sale);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect((screen.getByRole("button", { name: /generate/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a quote refused for a plan entitlement names the right reason from the database's words", async () => {
    quoteReply = () => json({ error: "entitlement_required", detail: "x needs the models_video:premium entitlement" }, 403);
    render(withI18n(<GeneratePanel orgId={ORG} models={[{ ...OPEN, entitlement: undefined }]} initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    expect((await screen.findByTestId("gen-locked")).textContent).toContain(t.gen.lockWhy.not_on_sale);
    expect(screen.queryByText(t.upsell.seePlans)).toBeNull();
  });

  it("a first purchase names itself and links to the top-ups", async () => {
    quoteReply = () => json({ error: "entitlement_required", detail: "x is available after the organization's first credit purchase" }, 403);
    render(withI18n(<GeneratePanel orgId={ORG} models={[{ ...OPEN, entitlement: undefined }]} initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    const line = await screen.findByTestId("gen-locked");
    expect(line.textContent).toContain(t.gen.lockWhy.first_purchase);
    expect(screen.getByRole("link", { name: t.gen.lockBuy }).getAttribute("href")).toBe("/chronos/credits#topups");
  });

  it("modelLock and entitlementReason follow creative_price: tiers are refused for everyone, paid until a purchase", () => {
    expect(modelLock("models_video:premium", true)).toBe("not_on_sale");
    expect(modelLock("models_video:premium", true, true)).toBeNull(); // 0139: a preview skips the plan rule
    expect(modelLock("paid", false)).toBe("first_purchase");
    expect(modelLock("paid", true)).toBeNull();
    expect(modelLock("paid", null)).toBeNull(); // unknown is not a refusal
    expect(modelLock("any", false)).toBeNull();
    expect(modelLock(null, false)).toBeNull();
    expect(entitlementReason("paid")).toBe("first_purchase");
    expect(entitlementReason(undefined, "m needs the models_image:basic entitlement")).toBe("not_on_sale");
    expect(entitlementReason(undefined, "something else")).toBeNull();
  });

  it("the generic sentence no longer promises a first purchase for every refusal", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      expect(dictionaries[lang].creative.errors.entitlement_required).not.toMatch(/purchase|покупк|sotib/i);
    }
  });
});

describe("short of credits", () => {
  const OPEN: StudioModel = { id: "open", displayName: "Open", capabilities: ["t2i"], beta: false };

  it("the key says how many are missing and opens the top-ups instead of pressing into a refusal", async () => {
    seedCredits(ORG, { balance: 10, reserved: 0, available: 10 });
    render(withI18n(<GeneratePanel orgId={ORG} models={[OPEN]} layout="composer" desk="image" initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    const key = await screen.findByTestId("gen-need-credits");
    expect(key.textContent).toContain("Add credits · need 15 more");
    expect(key.getAttribute("href")).toBe("/chronos/credits#topups");
    expect(key.getAttribute("aria-label")).toBe("Not enough credits: this costs 25 and 10 are available. Add credits.");
    // Enter does not send it either
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(creates()).toHaveLength(0);
  });

  it("enough credits (or none read: the exempt organization) keeps the ordinary key", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[OPEN]} initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    await waitFor(() => expect(screen.getByRole("button", { name: /25 credits/ })).toBeTruthy());
    expect(screen.queryByTestId("gen-need-credits")).toBeNull();
  });
});

describe("the header's credits are read again", () => {
  const OPEN: StudioModel = { id: "open", displayName: "Open", capabilities: ["t2i"], beta: false };

  it("after a generation is created (the hold): 400 shown while 25 are held was the bug", async () => {
    seedCredits(ORG, { balance: 400, reserved: 0, available: 400 });
    render(withI18n(<GeneratePanel orgId={ORG} models={[OPEN]} initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    const key = await screen.findByRole("button", { name: /25 credits/ });
    fireEvent.click(key);
    await waitFor(() => expect(creates()).toHaveLength(1));
    await waitFor(() => expect(accountReads()).toHaveLength(1));
    await waitFor(() => expect(creditsFor(ORG)).toEqual({ balance: 400, reserved: 25, available: 375 }));
  });

  it("never for an organization the layout showed no credits for (the exempt one)", async () => {
    await refreshCredits(ORG);
    expect(accountReads()).toHaveLength(0);
  });

  it("a failed read keeps the last value, never a zero", async () => {
    seedCredits(ORG, { balance: 50, reserved: 0, available: 50 });
    fetchMock.mockImplementationOnce(() => json({ error: "credits_read_failed" }, 503));
    await refreshCredits(ORG);
    expect(creditsFor(ORG)).toEqual({ balance: 50, reserved: 0, available: 50 });
  });

  it("the hook shows the layout's value, then the fresher one, and nothing when the layout shows none", async () => {
    function Pill({ seed }: { seed: { balance: number; reserved: number; available: number } | null }) {
      const a = useLiveCredits(ORG, seed);
      return <span data-testid="pill">{a ? String(a.available) : "none"}</span>;
    }
    const { rerender } = render(<Pill seed={{ balance: 400, reserved: 0, available: 400 }} />);
    expect(screen.getByTestId("pill").textContent).toBe("400");
    await act(async () => {
      await refreshCredits(ORG);
    });
    expect(screen.getByTestId("pill").textContent).toBe("375");
    rerender(<Pill seed={null} />);
    expect(screen.getByTestId("pill").textContent).toBe("none");
  });
});

// ── the sheet, the feed, the copy, the targets ──────────────────────────────────────────────────────────────────

describe("the model sheet", () => {
  it("each row carries one line of facts from its own lists, and a lock instead of a red refusal", async () => {
    const locked: StudioModel = { ...SEED, id: "zz-locked", displayName: "ZZ Locked", lock: "first_purchase", entitlement: "paid" };
    render(withI18n(<GeneratePanel orgId={ORG} models={[VEO, locked]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 6 }} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    const facts = document.querySelector('[data-facts="veo-like"]');
    expect(facts?.textContent).toBe("16:9 · 9:16 · 4–8 s · up to 4K");
    const lock = document.querySelector('[data-lock="zz-locked"]');
    expect(lock?.textContent).toContain(t.gen.lock.first_purchase);
    expect(lock?.querySelector("a")?.getAttribute("href")).toBe("/chronos/credits#topups");
    expect(document.querySelector('[data-price="zz-locked"]')).toBeNull();
    // the locked model is not quoted at all
    await waitFor(() => expect(quotes.some((q) => q.model === "veo-like")).toBe(true));
    expect(quotes.some((q) => q.model === "zz-locked")).toBe(false);
  });

  it("the facts line says nothing it does not know", () => {
    expect(capabilityLine(t, { id: "i", displayName: "I", capabilities: ["t2i"], beta: false, aspectRatios: [] }, "t2i")).toBe(t.gen.factOwnShape);
    expect(capabilityLine(t, { id: "i", displayName: "I", capabilities: ["t2i"], beta: false }, "t2i")).toBe("");
  });

  it("names when the model last proved it works, only from verified_at (no NEW badge: every probe moves that date)", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[{ ...VEO, verifiedAt: "2026-11-10T08:00:00Z" }, { ...SEED, verifiedAt: null }]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 6 }} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    expect(document.querySelector('[data-verified="veo-like"]')?.textContent).toMatch(/^Last proven working .*2026/);
    expect(document.querySelector('[data-verified="seed-like"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bNEW\b/);
  });
});

describe("a job of a model no longer sold is named, not shown as its id", () => {
  it("registryName is the registry file's display name, and fellBackLine uses it", () => {
    expect(registryName("veo-3.1")).toBe("Veo 3.1");
    expect(registryName("no-such-model")).toBe("no-such-model");
    expect(fellBackLine(t, { routed_model: "veo-3.1-fast", fallback_from: "veo-3.1" }, new Map())).toContain("Veo 3.1");
  });

  it("REGISTRY_NAMES is the twin of schemas/model_registry.json", () => {
    const file = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "model_registry.json"), "utf8")) as
      | { models: Array<{ id: string; display_name: string }> }
      | Array<{ id: string; display_name: string }>;
    const rows = Array.isArray(file) ? file : file.models;
    expect(REGISTRY_NAMES).toEqual(Object.fromEntries(rows.map((m) => [m.id, m.display_name])));
  });
});

describe("copy and targets", () => {
  it("no string promises 5 or 10 second clips: the lengths are each model's", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      const d = dictionaries[lang];
      expect(d.desk.blurbs.video).not.toMatch(/\b5\b.*\b10\b/);
      expect(JSON.stringify(d.home)).not.toMatch(/5–10 (second|секунд|soniya)/);
    }
  });

  it("every new string exists in en, ru and uz", () => {
    for (const lang of ["ru", "uz"] as const) {
      const g = dictionaries[lang].gen;
      for (const k of ["resolutionLabel", "resolutionDefault", "autoSettingsNote", "factSecondsRange", "factUpTo", "verifiedOn", "lockBuy", "needMore", "needMoreLabel", "needMoreNote"] as const) {
        expect(g[k], `${lang}.${k}`).toBeTruthy();
      }
      expect(g.lock.not_on_sale).not.toBe(t.gen.lock.not_on_sale);
      expect(g.lockWhy.first_purchase).not.toBe(t.gen.lockWhy.first_purchase);
    }
  });

  it("the segment keys are 40px targets, and the Enter hint is hidden under a finger", () => {
    const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");
    expect(css).toMatch(/\.studio-seg > button \{ min-height: 40px; \}/);
    const home = readFileSync(join(__dirname, "..", "components", "studio", "studio-home.css"), "utf8");
    expect(home).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{\s*\/\*[^*]*\*\/\s*\.sc-hint \{ display: none; \}/);
  });
});
