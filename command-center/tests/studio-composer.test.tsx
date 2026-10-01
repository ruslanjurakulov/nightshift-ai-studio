// @vitest-environment jsdom
/**
 * The Studio composer and canvas (two columns from lg, one on a phone):
 * tools are a real tablist; the model sheet is a dialog that prices each
 * model for the current settings and spends nothing; "Use as picture" hands
 * a finished result to the picture tools without starting anything; and on a
 * phone Generate is docked above the bottom tab bar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
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
import { GenerateSection } from "@/components/studio/GenerateSection";
import { pricedIds } from "@/components/studio/useModelPrices";
import {
  SHEET_PRICE_MAX,
  COMPOSER_CAPABILITIES,
  blockedReason,
  sheetQuoteParams,
  sourceFromJob,
  withTiers,
  type StudioForm,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const OUT = "33333333-3333-4333-8333-333333333333";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic-fast", displayName: "Picture Fast", capabilities: ["t2i", "edit"], beta: false, speedTier: 5, qualityTier: 3 },
  { id: "pic-fine", displayName: "Picture Fine", capabilities: ["t2i"], beta: true, speedTier: null, qualityTier: null },
  { id: "voice", displayName: "Voice One", capabilities: ["tts"], beta: false },
];
const PRICE: Record<string, number> = { "pic-fast": 4, "pic-fine": 9, voice: 2 };

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "t2i",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

const finished = (over: Record<string, unknown> = {}) => ({
  id: "done",
  capability: "t2i",
  status: "completed",
  requested_model: "pic-fast",
  params: { prompt: "a red kite", aspect_ratio: "1:1" },
  quoted_credits: 4,
  charged_credits: 4,
  error_code: null,
  result: null,
  result_asset_ids: [OUT],
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<{ model: string; capability: string; params: Record<string, unknown> }>;
let feed: unknown[];
const creates = () =>
  fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  quotes = [];
  feed = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      return json({ quote: { credits: PRICE[body.model] ?? 1 } });
    }
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: feed });
    if (url.startsWith("/api/media"))
      return json({
        available: true,
        assets: [
          {
            id: OUT,
            kind: "image",
            mime: "image/png",
            bytes: 1,
            width: 10,
            height: 10,
            durationS: null,
            source: "generated",
            name: "kite.png",
            variants: ["thumb"],
            version: 1,
            createdAt: "2026-10-01T00:00:00Z",
            thumbUrl: `/thumb/${OUT}`,
            viewUrl: `/view/${OUT}`,
          },
        ],
        uploads: [],
      });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tool tabs", () => {
  it("are one tablist of every tool, with one tab stop and arrow keys that choose", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    const list = screen.getByRole("tablist", { name: t.gen.kindLabel });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((x) => x.textContent)).toEqual(COMPOSER_CAPABILITIES.map((c) => t.gen.tabs[c]));
    expect(tabs.filter((x) => x.getAttribute("tabindex") === "0")).toHaveLength(1);

    const image = screen.getByRole("tab", { name: t.gen.tabs.t2i });
    expect(image.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(image.id);

    fireEvent.keyDown(image, { key: "ArrowRight" });
    const video = screen.getByRole("tab", { name: t.gen.tabs.t2v });
    expect(video.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(video);

    fireEvent.keyDown(video, { key: "End" });
    const last = t.gen.tabs[COMPOSER_CAPABILITIES[COMPOSER_CAPABILITIES.length - 1]];
    expect(screen.getByRole("tab", { name: last }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: last }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: t.gen.tabs.t2i }).getAttribute("aria-selected")).toBe("true");
  });

  it("every language names every tab", () => {
    for (const d of Object.values(dictionaries)) {
      for (const c of COMPOSER_CAPABILITIES) expect(d.gen.tabs[c].trim()).not.toBe("");
    }
  });

  it("says why Generate cannot be pressed yet", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    expect(screen.getByText(t.gen.blocked.need_words)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.upscale }));
    expect(screen.getByText(t.gen.noModels)).toBeTruthy();
    expect(screen.getByText(t.gen.blocked.no_model)).toBeTruthy();
  });
});

describe("model sheet", () => {
  it("opens as a dialog, prices each model for the current settings, and spends nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    const change = screen.getByRole("button", { name: t.gen.modelChangeLabel });
    fireEvent.click(change);

    const dialog = await screen.findByRole("dialog", { name: t.gen.sheetTitle });
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-model"))).toEqual(["pic-fast", "pic-fine"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    // Each model's price comes from the database, for exactly these settings.
    await within(dialog).findByText("4 credits", undefined, { timeout: 2000 });
    expect(within(dialog).getByText("9 credits")).toBeTruthy();
    expect(new Set(quotes.map((q) => q.model))).toEqual(new Set(["pic-fast", "pic-fine"]));
    for (const q of quotes) expect(q).toMatchObject({ capability: "t2i", params: { aspect_ratio: "16:9" } });

    // Marks only where the registry gives them.
    expect(within(options[0]).getByRole("img", { name: "Speed 5 of 5" })).toBeTruthy();
    expect(within(options[0]).getByRole("img", { name: "Quality 3 of 5" })).toBeTruthy();
    expect(within(options[1]).queryByRole("img")).toBeNull();

    // Keyboard: down to the second model, Enter picks it, the sheet closes, focus returns.
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1], { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(change);
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fine");

    expect(creates()).toHaveLength(0);
  });

  it("the picked model is the one priced on Generate and created with", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("option")[1]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a kite" } });
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 9 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(JSON.parse(String(creates()[0][1].body))).toMatchObject({ model: "pic-fine", max_credits: 9 });
  });

  it("Escape closes it without a choice; voice without words is not priced", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.tts }));
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(t.gen.blocked.need_words)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(quotes).toHaveLength(0);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Voice One");
  });
});

describe("pricing the sheet", () => {
  it("asks with the real params when complete, a stand-in only where the words never change the price", () => {
    expect(sheetQuoteParams(form({ prompt: "a kite" }))).toEqual({ prompt: "a kite", aspect_ratio: "16:9" });
    expect(sheetQuoteParams(form({}))).toMatchObject({ aspect_ratio: "16:9" });
    expect(sheetQuoteParams(form({ capability: "t2v", duration: 10 }))).toMatchObject({ duration_s: 10 });
    // Speech is priced by its characters: no words, no price.
    expect(sheetQuoteParams(form({ capability: "tts" }))).toBeNull();
    // A picture tool needs its picture.
    expect(sheetQuoteParams(form({ capability: "upscale" }))).toBeNull();
    expect(sheetQuoteParams(form({ capability: "upscale", sourceId: PIC, factor: 4 }))).toEqual({ source_asset_id: PIC, factor: 4 });
  });

  it("prices at most a handful of models, the picked one always among them", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    expect(pricedIds(ids, "m11")).toHaveLength(SHEET_PRICE_MAX);
    expect(pricedIds(ids, "m11")[0]).toBe("m11");
    expect(pricedIds(ids, "gone")).toEqual(ids.slice(0, SHEET_PRICE_MAX));
  });

  it("marks come only from the registry's 1–5 values, and never add a model", () => {
    const base: StudioModel[] = [{ id: "a", displayName: "A", capabilities: ["t2i"], beta: false }];
    const out = withTiers(base, [
      { id: "a", spec: { quality_tier: 4, speed_tier: 9 } },
      { id: "hidden", spec: { quality_tier: 5, speed_tier: 5 } },
    ]);
    expect(out).toEqual([{ ...base[0], qualityTier: 4, speedTier: null }]);
    expect(withTiers(base, null)).toEqual(base);
  });

  it("blockedReason names the missing piece", () => {
    expect(blockedReason(form({}), false)).toBe("no_model");
    expect(blockedReason(form({ capability: "edit", prompt: "x" }), true)).toBe("need_picture");
    expect(blockedReason(form({}), true)).toBe("need_words");
    expect(blockedReason(form({ capability: "remove_bg", sourceId: PIC }), true)).toBeNull();
  });
});

describe("use as picture", () => {
  it("is offered for a finished picture only", () => {
    expect(sourceFromJob(finished())).toBe(OUT);
    expect(sourceFromJob(finished({ status: "failed" }))).toBeNull();
    expect(sourceFromJob(finished({ capability: "t2v" }))).toBeNull();
    expect(sourceFromJob(finished({ result_asset_ids: ["nope"] }))).toBeNull();
  });

  it("fills the composer's picture tool with the result, keeps the words, and starts nothing", async () => {
    feed = [finished()];
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} />));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "make it night" } });

    const card = (await screen.findByText("a red kite")).closest("li")!;
    await waitFor(() => expect(card.querySelector(`img[src="/thumb/${OUT}"]`)).not.toBeNull());
    fireEvent.click(within(card).getByRole("button", { name: t.gen.useAsSource }));

    expect(screen.getByRole("tab", { name: t.gen.tabs.edit }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("make it night");
    expect(await screen.findByRole("button", { name: t.gen.sourceChange })).toBeTruthy();
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ capability: "edit", params: { source_asset_id: OUT } }), {
      timeout: 2000,
    });
    expect(creates()).toHaveLength(0);
  });

  it("invites the first generation on an empty canvas", async () => {
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} />));
    expect(await screen.findByText(t.gen.emptyTitle)).toBeTruthy();
    expect(screen.getByText(t.gen.empty)).toBeTruthy();
  });
});

describe("phone layout", () => {
  const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

  it("docks Generate in the composer, above the bottom tab bar", () => {
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} />));
    const dock = screen.getByTestId("gen-dock");
    expect(dock.classList.contains("studio-dock")).toBe(true);
    expect(within(dock).getByRole("button", { name: t.gen.generate })).toBeTruthy();
    expect(screen.getByTestId("gen-composer").contains(dock)).toBe(true);
    const root = screen.getByTestId("gen-composer").parentElement as HTMLElement;
    expect(root.style.getPropertyValue("--studio-dock-offset")).toBe("60px");
  });

  it("has no bar to clear for the operator", () => {
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} bottomBar={false} />));
    const root = screen.getByTestId("gen-composer").parentElement as HTMLElement;
    expect(root.style.getPropertyValue("--studio-dock-offset")).toBe("0px");
  });

  it("the dock is sticky on a phone and in the flow from lg up", () => {
    const rule = css.slice(css.indexOf(".studio-dock {"), css.indexOf("}", css.indexOf(".studio-dock {")));
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("var(--studio-dock-offset");
    const desktop = css.slice(css.indexOf("@media (min-width: 1024px) {\n  .studio-dock"));
    expect(desktop).toMatch(/\.studio-dock \{\s*position: static;/);
  });

  it("the Studio tokens exist in the light, prefers-dark and data-theme=dark blocks", () => {
    for (const token of ["--studio-field", "--studio-raised", "--studio-cta-bg", "--studio-cta-fg", "--studio-scrim", "--studio-dock-bg"]) {
      expect(css.split(`${token}:`).length - 1, token).toBe(3);
    }
  });
});
