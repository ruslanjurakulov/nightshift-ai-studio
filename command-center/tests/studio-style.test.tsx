// @vitest-environment jsdom
/**
 * Style kits in Studio generations (migration 0048): images and videos may
 * name one of the organization's style kits. The params carry exactly
 * `style_kit_id` and only for the kinds 0048 accepts it for; "None" is the
 * key left out; only a kit the organization has (as loaded) is ever sent, the
 * channel's default kit picked to start with; a refusal reads as a sentence,
 * never a code. The price is still the database's — the chip changes nothing
 * but the params.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

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
import { coerceStyleChoices } from "@/components/studio/useStyleKits";
import { PARAM_KEYS, STYLE_CAPABILITIES, mapCreativeError, parseGenerationInput } from "@/lib/creative/operations";
import {
  apiErrorMessage,
  buildParams,
  failureReason,
  prefillFromJob,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const KIT = "55555555-5555-4555-8555-555555555555";
const KIT2 = "66666666-6666-4666-8666-666666666666";
const GONE = "77777777-7777-4777-8777-777777777777";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "t2i",
  prompt: "a lighthouse",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

const MODELS: StudioModel[] = [
  { id: "pics", displayName: "Pictures", capabilities: ["t2i", "edit", "upscale"], beta: false },
  { id: "voice", displayName: "Voice", capabilities: ["tts"], beta: false },
];

const kitsBody = {
  org: ORG,
  kits: [
    { id: KIT, name: "Warm film", description: "", createdAt: null, updatedAt: null, references: [] },
    { id: KIT2, name: "Neon night", description: "", createdAt: null, updatedAt: null, references: [] },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<Record<string, unknown>>;
let kitsAnswer: () => Promise<Response>;
beforeEach(() => {
  quotes = [];
  kitsAnswer = () => json(kitsBody);
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/style-kits")) return kitsAnswer();
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    if (url === "/api/creative/quote") {
      quotes.push(JSON.parse(String(init?.body)));
      return json({ quote: { credits: 4 } });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("params (0048's rules)", () => {
  it("style_kit_id is a key 0048 accepts, for images and videos only", () => {
    expect(PARAM_KEYS).toContain("style_kit_id");
    expect([...STYLE_CAPABILITIES]).toEqual(["t2i", "t2v", "edit", "i2v"]);
  });

  it("adds the kit to the kinds a look can steer", () => {
    expect(buildParams(form({ styleKitId: KIT }))).toEqual({ prompt: "a lighthouse", aspect_ratio: "16:9", style_kit_id: KIT });
    expect(buildParams(form({ capability: "t2v", styleKitId: KIT }))).toMatchObject({ style_kit_id: KIT, duration_s: 5 });
    expect(buildParams(form({ capability: "edit", sourceId: PIC, styleKitId: KIT }))).toEqual({
      prompt: "a lighthouse",
      source_asset_id: PIC,
      style_kit_id: KIT,
    });
    expect(buildParams(form({ capability: "i2v", prompt: "", sourceId: PIC, styleKitId: KIT }))).toEqual({
      source_asset_id: PIC,
      duration_s: 5,
      style_kit_id: KIT,
    });
  });

  it("never sends a kit where it does not apply, an empty one, or a malformed one", () => {
    expect(buildParams(form({ capability: "tts", styleKitId: KIT }))).toEqual({ prompt: "a lighthouse" });
    expect(buildParams(form({ capability: "upscale", sourceId: PIC, styleKitId: KIT }))).not.toHaveProperty("style_kit_id");
    expect(buildParams(form({ capability: "remove_bg", sourceId: PIC, styleKitId: KIT }))).not.toHaveProperty("style_kit_id");
    expect(buildParams(form({ styleKitId: null }))).not.toHaveProperty("style_kit_id");
    expect(buildParams(form({ styleKitId: "../kits/1" }))).not.toHaveProperty("style_kit_id");
  });

  it("@names stay in the words exactly as typed", () => {
    expect(buildParams(form({ prompt: "  @hero meets @nobody  ", styleKitId: KIT })).prompt).toBe("@hero meets @nobody");
  });

  it("the route refuses a kit on the wrong kind or of the wrong shape before the database", () => {
    const parse = (capability: string, params: Record<string, unknown>) =>
      parseGenerationInput({ org_id: ORG, capability, model: "pics", params }, null, { requirePrice: false });
    expect(parse("t2i", { prompt: "x", style_kit_id: KIT }).ok).toBe(true);
    for (const [cap, params] of [
      ["tts", { prompt: "x", style_kit_id: KIT }],
      ["upscale", { source_asset_id: PIC, factor: 2, style_kit_id: KIT }],
      ["t2i", { prompt: "x", style_kit_id: "not-a-kit" }],
      ["t2i", { prompt: "x", style_kit_id: null }],
    ] as const) {
      const r = parse(cap, params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.result.body.error).toBe("invalid_params");
    }
  });

  it("the database's style refusal is a sentence in every language, never the code", () => {
    const r = mapCreativeError({ code: "NS400", message: "style_unavailable", details: "style_kit_id names no style kit in this organization" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("style_unavailable");
    for (const lang of ["en", "ru", "uz"] as const) {
      const d = dictionaries[lang];
      const msg = apiErrorMessage(d, "style_unavailable");
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toMatch(/style_unavailable|style_kit_id/);
      expect(d.gen.reasons.style.length).toBeGreaterThan(20);
      expect(d.gen.styleNone && d.gen.styleLabel && d.gen.mentionHint).toBeTruthy();
    }
  });

  it("a job the worker failed over its style gets the style reason", () => {
    expect(failureReason(t, { status: "failed", error_code: "style_unavailable" })).toBe(t.gen.reasons.style);
  });

  it("Try again keeps the job's kit, and none when it had none", () => {
    const j = (params: Record<string, unknown>, capability = "t2i"): StudioJob => ({
      id: "j",
      capability,
      status: "failed",
      requested_model: "pics",
      params,
      quoted_credits: 4,
      charged_credits: null,
      error_code: "provider_error",
      result: null,
      result_asset_ids: [],
      created_at: "",
    });
    expect(prefillFromJob(j({ prompt: "x", style_kit_id: KIT }))).toMatchObject({ styleKitId: KIT });
    expect(prefillFromJob(j({ prompt: "x" }))).toMatchObject({ styleKitId: null });
    expect(prefillFromJob(j({ prompt: "x" }, "tts"))).not.toHaveProperty("styleKitId");
  });

  it("reads only well-formed kits from the route", () => {
    expect(coerceStyleChoices(kitsBody)).toEqual([
      { id: KIT, name: "Warm film" },
      { id: KIT2, name: "Neon night" },
    ]);
    expect(coerceStyleChoices({ kits: [{ id: "x", name: "bad" }, { id: KIT, name: " " }, null] })).toEqual([]);
    expect(coerceStyleChoices(null)).toEqual([]);
  });
});

describe("GeneratePanel Style chips", () => {
  const styleGroup = () => screen.findByRole("group", { name: t.gen.styleLabel });

  it("offers None and the organization's kits; a picked kit goes into the priced params", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    const group = await styleGroup();
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([t.gen.styleNone, "Warm film", "Neon night"]);
    expect(within(group).getByRole("button", { name: t.gen.styleNone }).getAttribute("aria-pressed")).toBe("true");
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/style-kits?org=${ORG}`)).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@hero at dawn" } });
    fireEvent.click(within(group).getByRole("button", { name: "Neon night" }));
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ prompt: "@hero at dawn", aspect_ratio: "16:9", style_kit_id: KIT2 }), {
      timeout: 2000,
    });
    // The price is the database's, unchanged by the chip.
    expect(await screen.findByRole("button", { name: "Generate · 4 credits" })).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: t.gen.styleNone }));
    await waitFor(() => expect(quotes.at(-1)?.params).not.toHaveProperty("style_kit_id"), { timeout: 2000 });
  });

  it("starts from the channel's default kit", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} defaultStyleKitId={KIT} />));
    const group = await styleGroup();
    expect(within(group).getByRole("button", { name: "Warm film" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a cliff" } });
    await waitFor(() => expect(quotes.at(-1)?.params).toMatchObject({ style_kit_id: KIT }), { timeout: 2000 });
  });

  it("a default kit the organization no longer has reads as None and is never sent", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} defaultStyleKitId={GONE} />));
    const group = await styleGroup();
    expect(within(group).getByRole("button", { name: t.gen.styleNone }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a cliff" } });
    await waitFor(() => expect(quotes.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(quotes.every((q) => !(q.params as Record<string, unknown>).style_kit_id)).toBe(true);
  });

  it("voice has no Style row", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await styleGroup();
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.tts }));
    expect(screen.queryByRole("group", { name: t.gen.styleLabel })).toBeNull();
    expect(screen.queryByText(t.gen.mentionHint)).toBeNull();
  });

  it("no kits yet: None alone, and where to make one", async () => {
    kitsAnswer = () => json({ org: ORG, kits: [] });
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    const group = await styleGroup();
    expect(within(group).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("link", { name: t.gen.styleMake }).getAttribute("href")).toBe("/chronos/studio");
  });

  it("offers the Style Library beside the chips — with kits and without — and a link changes nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await styleGroup();
    expect(screen.getByRole("link", { name: t.gen.styleBrowse }).getAttribute("href")).toBe("/chronos/styles");
    cleanup();
    kitsAnswer = () => json({ org: ORG, kits: [] });
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await styleGroup();
    expect(screen.getByRole("link", { name: t.gen.styleBrowse }).getAttribute("href")).toBe("/chronos/styles");
  });

  it("a style handed in from the Library only fills the chip: no job is started and nothing is charged until Generate", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} defaultStyleKitId={KIT2} />));
    const group = await styleGroup();
    expect(within(group).getByRole("button", { name: "Neon night" }).getAttribute("aria-pressed")).toBe("true");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/creative/jobs"))).toBe(false);
  });

  it("a failed read says so and can be retried; it never reads as 'no kits'", async () => {
    kitsAnswer = () => json({ error: "read_failed" }, 502);
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    expect(await screen.findByText(t.gen.styleFailed)).toBeTruthy();
    expect(screen.queryByText(t.gen.styleEmpty)).toBeNull();
    kitsAnswer = () => json(kitsBody);
    fireEvent.click(screen.getByRole("button", { name: t.gen.styleRetry }));
    expect(await styleGroup()).toBeTruthy();
  });

  it("before style kits are switched on here, the row is not offered at all", async () => {
    kitsAnswer = () => json({ error: "not_available" }, 503);
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/style-kits"))).toBe(true));
    await waitFor(() => expect(screen.queryByText(t.gen.styleLabel)).toBeNull());
    expect(screen.queryByRole("group", { name: t.gen.styleLabel })).toBeNull();
  });
});
