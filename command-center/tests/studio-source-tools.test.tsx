// @vitest-environment jsdom
/**
 * The Studio's picture tools (migration 0046): edit, animate, upscale and
 * remove background start from ONE library picture. The params are exactly
 * what 0046's creative_params_problem accepts; no price is asked for until
 * the picture (and, where required, the words) are there; the Library's
 * "Use in Studio" links only fill the form.
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
import { MediaViewer } from "@/components/media/MediaViewer";
import {
  STUDIO_CAPABILITIES,
  buildParams,
  canQuote,
  prefillFromJob,
  prefillFromQuery,
  type StudioForm,
  type StudioModel,
} from "@/lib/creative/studio";
import type { LibraryAsset } from "@/lib/media";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const PIC2 = "33333333-3333-4333-8333-333333333333";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "t2i",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

const MODELS: StudioModel[] = [
  { id: "pic-tools", displayName: "Picture tools", capabilities: ["edit", "upscale", "remove_bg"], beta: false },
  { id: "motion", displayName: "Motion", capabilities: ["i2v"], beta: true },
];

const libraryAsset = (id: string, name: string, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id,
  kind: "image",
  mime: "image/png",
  bytes: 2048,
  width: 1024,
  height: 1024,
  durationS: null,
  source: "upload",
  name,
  variants: ["thumb"],
  version: 1,
  createdAt: "2026-09-30T10:00:00Z",
  thumbUrl: `/api/media/file/${id}/thumb`,
  viewUrl: `/api/media/file/${id}/original`,
  ...extra,
});

const libraryBody = {
  available: true,
  host: { media: true, staging: true, signing: true },
  assets: [
    libraryAsset(PIC, "lighthouse.png"),
    libraryAsset(PIC2, "forest.png"),
    { ...libraryAsset("44444444-4444-4444-8444-444444444444", "clip.mp4"), kind: "video", mime: "video/mp4" },
  ],
  uploads: [],
  quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
};

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<Record<string, unknown>>;
beforeEach(() => {
  quotes = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/media")) return json(libraryBody);
    if (url === "/api/creative/quote") {
      quotes.push(JSON.parse(String(init?.body)));
      return json({ quote: { credits: 6 } });
    }
    if (url === "/api/creative/jobs") return json({ job: { id: "j1" } }, 201);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("params (0046's rules)", () => {
  it("offers the four picture tools in the Studio", () => {
    expect(STUDIO_CAPABILITIES).toEqual(expect.arrayContaining(["edit", "i2v", "upscale", "remove_bg"]));
  });

  it("edit: the words and the picture, never an aspect ratio", () => {
    expect(buildParams(form({ capability: "edit", prompt: " warmer light ", sourceId: PIC }))).toEqual({
      prompt: "warmer light",
      source_asset_id: PIC,
    });
  });

  it("i2v: the picture and a length; the words only when given", () => {
    expect(buildParams(form({ capability: "i2v", sourceId: PIC, duration: 10 }))).toEqual({
      source_asset_id: PIC,
      duration_s: 10,
    });
    expect(buildParams(form({ capability: "i2v", prompt: "slow push in", sourceId: PIC }))).toEqual({
      prompt: "slow push in",
      source_asset_id: PIC,
      duration_s: 5,
    });
  });

  it("upscale: the picture and a factor; remove_bg: the picture alone", () => {
    expect(buildParams(form({ capability: "upscale", sourceId: PIC, factor: 4 }))).toEqual({ source_asset_id: PIC, factor: 4 });
    expect(buildParams(form({ capability: "remove_bg", prompt: "ignored", sourceId: PIC }))).toEqual({ source_asset_id: PIC });
  });

  it("asks for a price only when the form is complete", () => {
    expect(canQuote(form({ capability: "upscale" }))).toBe(false);
    expect(canQuote(form({ capability: "upscale", sourceId: "not-a-uuid" }))).toBe(false);
    expect(canQuote(form({ capability: "upscale", sourceId: PIC }))).toBe(true);
    expect(canQuote(form({ capability: "edit", sourceId: PIC }))).toBe(false);
    expect(canQuote(form({ capability: "edit", sourceId: PIC, prompt: "x" }))).toBe(true);
    expect(canQuote(form({ capability: "remove_bg", sourceId: PIC }))).toBe(true);
    expect(canQuote(form({ capability: "t2i" }))).toBe(false);
    expect(canQuote(form({ capability: "t2i", prompt: "x" }))).toBe(true);
  });
});

describe("prefill", () => {
  it("from the Library link: a picture tool and a well-formed id only", () => {
    expect(prefillFromQuery("upscale", PIC)).toMatchObject({ capability: "upscale", sourceId: PIC, factor: 2 });
    expect(prefillFromQuery("t2i", PIC)).toBeNull();
    expect(prefillFromQuery("upscale", "../etc")).toBeNull();
    expect(prefillFromQuery(["upscale"], PIC)).toBeNull();
    expect(prefillFromQuery(undefined, undefined)).toBeNull();
  });

  it("Try again keeps the picture and the factor", () => {
    const p = prefillFromJob({
      id: "j",
      capability: "upscale",
      status: "failed",
      requested_model: "pic-tools",
      params: { source_asset_id: PIC, factor: 4 },
      quoted_credits: 6,
      charged_credits: null,
      error_code: "provider_error",
      result: null,
      result_asset_ids: [],
      created_at: "",
    });
    expect(p).toMatchObject({ capability: "upscale", sourceId: PIC, factor: 4 });
  });
});

describe("GeneratePanel picture tools", () => {
  it("prices an upscale only after a picture is picked, with that picture and factor", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.kinds.upscale }));

    const grid = await screen.findByRole("radiogroup", { name: t.gen.sourceLabel });
    // Images only: the video in the library is not offered.
    expect(within(grid).getAllByRole("radio")).toHaveLength(2);
    expect(quotes).toHaveLength(0);

    fireEvent.click(within(grid).getByRole("radio", { name: "lighthouse.png" }));
    fireEvent.click(screen.getByRole("button", { name: "4× larger" }));

    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ capability: "upscale", model: "pic-tools" }), { timeout: 2000 });
    expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, factor: 4 });
    expect(await screen.findByRole("button", { name: "Generate · 6 credits" })).toBeTruthy();
    // The pick shows large, with a way to change it.
    expect(screen.getByRole("button", { name: t.gen.sourceChange })).toBeTruthy();
  });

  it("background removal asks for no words", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.kinds.remove_bg }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens with the Library's picture chosen and spends nothing by itself", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={prefillFromQuery("i2v", PIC)} />));
    expect(screen.getByRole("button", { name: t.gen.kinds.i2v }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, duration_s: 5 }), { timeout: 2000 });
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/creative/jobs")).toBe(false);
  });

  it("shows a way to the Library when it has no pictures", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/media") ? json({ ...libraryBody, assets: [] }) : json({}, 404),
    );
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.kinds.edit }));
    const link = await screen.findByRole("link", { name: t.gen.sourceOpenLibrary });
    expect(link.getAttribute("href")).toBe("/chronos/library");
  });
});

describe("Library viewer: Use in Studio", () => {
  const noop = () => {};
  it("links a picture to each tool with its id, and nothing else", () => {
    const a = libraryAsset(PIC, "lighthouse.png");
    render(withI18n(<MediaViewer items={[a]} index={0} onNavigate={noop} onClose={noop} deleting={false} />));
    const dialog = screen.getByRole("dialog");
    for (const tool of ["edit", "i2v", "upscale", "remove_bg"] as const) {
      const link = within(dialog).getByRole("link", { name: t.gen.kinds[tool] });
      expect(link.getAttribute("href")).toBe(`/chronos/create?tool=${tool}&source=${PIC}`);
    }
  });
});
