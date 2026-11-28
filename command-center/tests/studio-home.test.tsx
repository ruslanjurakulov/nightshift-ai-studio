// @vitest-environment jsdom
/**
 * /create, composer first (components/studio/StudioHome.tsx and GeneratePanel's
 * `composer` layout). The page changed its arrangement, not its money path.
 * These tests hold that: the chips only pick the tools, an example only fills
 * the box, the price on the send key is the quote route's, and the create
 * request the box sends is byte for byte the one the old panel sends for the
 * same form. What would break without them: a second spend path, a price the
 * server did not quote, or a card that starts a job by itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} data-next-link="" {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { StudioHome, type AssistantData } from "@/components/studio/StudioHome";
import { CREATIVE_EXAMPLES, STUDIO_MODES, examplePrompt, isStudioMode, modeDesk } from "@/lib/creative/examples";
import { exampleModelsFor } from "@/lib/server/creative-examples";
import { DESK_TOOLS, MEDIA_DESKS } from "@/lib/creative/desks";
import { PANEL_CAPABILITIES, type StudioModel } from "@/lib/creative/studio";
import { bannedHits } from "@/lib/marketing-banned";

const t = dictionaries.en;
const th = t.studioHome;
const ORG = "11111111-1111-4111-8111-111111111111";
const OUT = "33333333-3333-4333-8333-333333333333";
const withI18n = (ui: ReactNode, locale: "en" | "uz" | "ru" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic", displayName: "Picture", capabilities: ["t2i", "edit", "upscale", "remove_bg", "describe"], beta: false },
  // The id an example was written for (lib/server/creative-examples.ts): offered here, so the example picks it.
  { id: "seedream-5.0-pro", displayName: "Picture Pro", capabilities: ["t2i"], beta: false },
  { id: "clip", displayName: "Clip", capabilities: ["t2v", "i2v"], beta: false },
  { id: "voice", displayName: "Voice", capabilities: ["tts", "voice_change", "dub"], beta: false },
];
const PRICE: Record<string, number> = { pic: 4, "seedream-5.0-pro": 7, clip: 40, voice: 2 };

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<{ model: string; capability: string; params: Record<string, unknown> }>;
let feed: unknown[];
/** A test's own answer to the create POST (a refusal, or a promise that never settles: a job still being started). */
let jobPost: (() => Promise<Response>) | null;
const creates = () =>
  fetchMock.mock.calls
    .filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const asset = (id: string) => ({
  id,
  kind: "image",
  mime: "image/png",
  bytes: 1,
  width: 10,
  height: 10,
  durationS: null,
  source: "generated",
  name: `${id}.png`,
  variants: ["thumb"],
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  thumbUrl: `/thumb/${id}`,
  viewUrl: `/view/${id}`,
});

const ASSISTANT: AssistantData = { orgId: ORG, models: MODELS, channels: [], currentSlug: null, canRun: false, runConfigured: false };
const home = (over: Partial<Parameters<typeof StudioHome>[0]> = {}) => (
  <StudioHome
    orgId={ORG}
    models={MODELS}
    exampleModels={exampleModelsFor(MODELS)}
    credits={{ state: "unknown" }}
    projects={{ state: "ok", projects: [] }}
    assistant={ASSISTANT}
    {...over}
  />
);

beforeEach(() => {
  quotes = [];
  feed = [];
  jobPost = null;
  push.mockClear();
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      return json({ quote: { credits: PRICE[body.model] ?? 1 } });
    }
    if (url.startsWith("/api/creative/jobs") && init?.method === "POST") return jobPost ? jobPost() : json({ job: { id: "new" } });
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: feed });
    // One asset, read as the member: freshly signed links, the original among them.
    if (url === `/api/library/${OUT}/download?variant=original`) return new Response("x", { status: 206 });
    if (url === `/api/media/${OUT}`)
      return json({ asset: { ...asset(OUT), name: "out.png" }, urls: { original: `/api/media/file/${OUT}/original?sig=fresh`, thumb: `/thumb/${OUT}` }, served: true });
    if (url.startsWith("/api/media")) return json({ available: true, assets: [asset(OUT)], uploads: [] });
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

const modes = () => screen.getByRole("radiogroup", { name: th.modesLabel });
const chip = (name: string) => within(modes()).getByRole("radio", { name: new RegExp(`^${name}`) });
const composerTools = () => within(screen.getByTestId("composer-tools")).getAllByRole("tab").map((x) => x.id);

describe("the mode chips", () => {
  it("are one radio group of the five kinds, Image first, with one tab stop", () => {
    render(withI18n(home()));
    const radios = within(modes()).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(STUDIO_MODES.map((m) => th.modes[m]));
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent)).toEqual([th.modes.image]);
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(composerTools()).toEqual(DESK_TOOLS.image.map((c) => `gen-tab-${c}`));
  });

  it("switch the box to each mode's own tools, and the arrow keys move between them", () => {
    render(withI18n(home()));
    for (const m of MEDIA_DESKS) {
      fireEvent.click(chip(th.modes[m]));
      expect(chip(th.modes[m]).getAttribute("aria-checked")).toBe("true");
      expect(composerTools()).toEqual(DESK_TOOLS[m].map((c) => `gen-tab-${c}`));
    }
    fireEvent.keyDown(chip(th.modes.enhance), { key: "ArrowLeft" });
    expect(chip(th.modes.voice).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chip(th.modes.voice));
  });

  it("carry the words typed into the next mode, and nothing is priced as spent by switching", async () => {
    render(withI18n(home()));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a lighthouse at dawn" } });
    fireEvent.click(chip(th.modes.video));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("a lighthouse at dawn");
    expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("t2v");
    expect(creates()).toHaveLength(0);
  });

  it("YouTube video: the box takes a topic, and Continue opens the video page (which prices and asks)", () => {
    render(withI18n(home()));
    fireEvent.click(chip(th.modes.youtube));
    const box = screen.getByTestId("topic-composer");
    const topic = within(box).getByRole("textbox", { name: th.youtube.label });
    fireEvent.change(topic, { target: { value: "  The Silk Road  " } });
    fireEvent.keyDown(topic, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/chronos/create?desk=youtube&topic=The%20Silk%20Road");
    expect(creates()).toHaveLength(0);
  });
});

describe("an example", () => {
  it("fills the box with its mode, its model (when offered) and its words, and starts nothing", async () => {
    render(withI18n(home()));
    const e = CREATIVE_EXAMPLES.find((x) => x.id === "samarkand_dawn")!;
    fireEvent.click(screen.getByRole("button", { name: `Use this example: ${examplePrompt(e, "en")}` }));
    expect(chip(th.modes.image).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(e.prompt_en);
    expect(screen.getByTestId("composer-model").textContent).toContain("Picture Pro");
    // The price on the key is the quote for exactly that model and shape.
    expect(await screen.findByRole("button", { name: "Generate · 7 credits" }, { timeout: 2000 })).toBeTruthy();
    expect(quotes.at(-1)).toMatchObject({ capability: "t2i", model: "seedream-5.0-pro", params: { prompt: e.prompt_en, aspect_ratio: "16:9" } });
    expect(creates()).toHaveLength(0);
  });

  it("whose model is not offered keeps the box's own default, named on the model key", async () => {
    render(withI18n(home()));
    const e = CREATIVE_EXAMPLES.find((x) => x.id === "thumbnail_portrait")!;
    fireEvent.click(screen.getByRole("button", { name: `Use this example: ${e.prompt_en}` }));
    expect(screen.getByTestId("composer-model").textContent).toContain("Picture");
    await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toMatchObject({ model: "pic" });
  });

  it("in Video sets the clip's length and shape; in Enhance it sends no words; in YouTube it fills the topic", async () => {
    render(withI18n(home(), "uz"));
    const city = CREATIVE_EXAMPLES.find((x) => x.id === "city_night")!;
    fireEvent.click(screen.getByRole("button", { name: dictionaries.uz.studioHome.examples.use.replace("{prompt}", city.prompt_uz) }));
    expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("t2v");
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ capability: "t2v", params: { duration_s: 10, aspect_ratio: "16:9", prompt: city.prompt_uz } }), { timeout: 2000 });

    const sharpen = CREATIVE_EXAMPLES.find((x) => x.id === "sharpen_photo")!;
    fireEvent.click(screen.getByRole("button", { name: dictionaries.uz.studioHome.examples.use.replace("{prompt}", sharpen.prompt_uz) }));
    expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("upscale");
    expect((screen.queryByRole("textbox") as HTMLTextAreaElement | null)?.value ?? "").toBe("");

    const yt = CREATIVE_EXAMPLES.find((x) => x.id === "yt_history")!;
    fireEvent.click(screen.getByRole("button", { name: dictionaries.uz.studioHome.examples.use.replace("{prompt}", yt.prompt_uz) }));
    expect((within(screen.getByTestId("topic-composer")).getByRole("textbox") as HTMLTextAreaElement).value).toBe(yt.prompt_uz);
    expect(creates()).toHaveLength(0);
  });
});

describe("the send key", () => {
  /** Type, wait for the priced key, press it (or Enter), return the create request without its fresh key. */
  async function press(ui: ReactNode, setup: () => void, how: "click" | "enter" = "click") {
    const { unmount } = render(withI18n(ui));
    setup();
    const key = await screen.findByRole("button", { name: /^Generate · \d+ credits$/ }, { timeout: 2000 });
    if (how === "enter") fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    else fireEvent.click(key);
    await waitFor(() => expect(creates().length).toBeGreaterThan(0));
    const body = creates().at(-1) as Record<string, unknown>;
    const quote = quotes.at(-1);
    unmount();
    fetchMock.mockClear();
    quotes = [];
    const { idempotency_key: key2, ...rest } = body;
    expect(typeof key2).toBe("string");
    return { rest, quote };
  }
  const type = (v: string) => () => fireEvent.change(screen.getByRole("textbox"), { target: { value: v } });

  it("sends exactly the old panel's create request for the same picture (and the same quote before it)", async () => {
    const old = await press(<GeneratePanel orgId={ORG} models={MODELS} />, type("a lighthouse at dawn"));
    const box = await press(home(), type("a lighthouse at dawn"));
    expect(box.rest).toEqual(old.rest);
    expect(box.quote).toEqual(old.quote);
    expect(old.rest).toMatchObject({ org_id: ORG, capability: "t2i", model: "pic", max_credits: 4, params: { prompt: "a lighthouse at dawn" } });
  });

  it("sends exactly the old Video panel's request for a 10 s clip set behind the settings key", async () => {
    const old = await press(<GeneratePanel orgId={ORG} models={MODELS} desk="video" />, () => {
      type("a ferry at night")();
      fireEvent.click(within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button")[1]);
    });
    const box = await press(home(), () => {
      fireEvent.click(chip(th.modes.video));
      type("a ferry at night")();
      fireEvent.click(screen.getByTestId("composer-settings-key"));
      fireEvent.click(within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button")[1]);
    });
    expect(box.rest).toEqual(old.rest);
    expect(box.rest).toMatchObject({ capability: "t2v", model: "clip", max_credits: 40, params: { duration_s: 10 } });
  });

  it("Enter sends (the same request), Shift+Enter is a new line and sends nothing", async () => {
    render(withI18n(home()));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "a red kite" } });
    await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(creates()).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]).toMatchObject({ capability: "t2i", max_credits: 4, params: { prompt: "a red kite" } });
  });

  it("cannot be pressed, by click or Enter, before the server has quoted", () => {
    render(withI18n(home()));
    const key = screen.getByRole("button", { name: /^Generate/ });
    expect((key as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(creates()).toHaveLength(0);
    // No price is drawn that was not quoted.
    expect(key.textContent).not.toMatch(/\d/);
  });
});

describe("the model key", () => {
  it("opens the model sheet with each model's price as the quote route gives it, and the pick changes the price", async () => {
    render(withI18n(home()));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a lighthouse" } });
    const key = screen.getByTestId("composer-model");
    expect(key.getAttribute("aria-label")).toBe("Model: Picture. Change the model");
    fireEvent.click(key);
    const sheet = screen.getByRole("dialog");
    const options = within(sheet).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Picture"), expect.stringContaining("Picture Pro")]);
    await waitFor(() => expect(within(sheet).getByText("4 credits")).toBeTruthy(), { timeout: 2000 });
    expect(within(sheet).getByText("7 credits")).toBeTruthy();
    // Every price shown was asked of the quote route, for that model.
    expect(quotes.map((q) => q.model)).toEqual(expect.arrayContaining(["pic", "seedream-5.0-pro"]));
    fireEvent.click(options[1]);
    expect(screen.getByTestId("composer-model").textContent).toContain("Picture Pro");
    expect(await screen.findByRole("button", { name: "Generate · 7 credits" }, { timeout: 2000 })).toBeTruthy();
    expect(creates()).toHaveLength(0);
  });
});

describe("the Plan toggle", () => {
  it("turns the box into the Assistant with the words typed, and making the plan only asks prices", async () => {
    render(withI18n(home()));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "three thumbnails about Bukhara" } });
    fireEvent.click(screen.getByTestId("composer-plan"));
    expect(screen.getByTestId("composer-plan").getAttribute("aria-pressed")).toBe("true");
    const goal = screen.getByRole("textbox", { name: th.plan.goalLabel }) as HTMLTextAreaElement;
    expect(goal.value).toBe("three thumbnails about Bukhara");
    fireEvent.keyDown(goal, { key: "Enter" });
    expect(await screen.findByRole("list", { name: t.assistant.planTitle })).toBeTruthy();
    expect(creates()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("composer-plan"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("three thumbnails about Bukhara");
  });
});

describe("the box on a phone", () => {
  it("is marked to pin above the tab bar, and the page's CSS pins it there below the desktop width", () => {
    const { unmount } = render(withI18n(home()));
    const wrap = screen.getByTestId("studio-composer");
    expect(wrap.getAttribute("data-sticky")).toBe("mobile");
    expect(within(wrap).getByTestId("composer")).toBeTruthy();
    expect((screen.getByTestId("studio-home") as HTMLElement).style.getPropertyValue("--studio-dock-offset")).toBe("60px");
    unmount();
    render(withI18n(home({ bottomBar: false })));
    expect((screen.getByTestId("studio-home") as HTMLElement).style.getPropertyValue("--studio-dock-offset")).toBe("0px");

    const css = readFileSync(join(__dirname, "..", "components/studio/studio-home.css"), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 1023.98px)"));
    const rule = phone.slice(phone.indexOf('.sh-composer[data-sticky="mobile"] {'), phone.indexOf("}", phone.indexOf('.sh-composer[data-sticky="mobile"] {')));
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("var(--studio-dock-offset");
    expect(rule).toContain("env(safe-area-inset-bottom)");
    // Last in the column, so it is pinned while the rest scrolls under it.
    expect(rule).toContain("order: 10");
  });
});

describe("the recent work", () => {
  const job = (over: Record<string, unknown>) => ({
    id: "j",
    capability: "t2i",
    status: "completed",
    requested_model: "pic",
    params: { prompt: "p" },
    quoted_credits: 4,
    charged_credits: 4,
    error_code: null,
    result: null,
    result_asset_ids: [OUT],
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  });

  it("with nothing made says where to start, and its key moves to the examples", async () => {
    render(withI18n(home()));
    expect(await screen.findByText(th.recent.emptyTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: th.recent.emptyAction }));
    expect(document.activeElement?.getAttribute("data-example")).toBe(CREATIVE_EXAMPLES[0].id);
  });

  it("a finished picture: make a video from it, enhance it, download it — each only fills the box or saves the file", async () => {
    feed = [job({ id: "a" })];
    render(withI18n(home()));
    fireEvent.click(await screen.findByRole("button", { name: th.actions.animate }));
    expect(chip(th.modes.video).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("i2v");
    fireEvent.click(screen.getByRole("button", { name: th.actions.enhance }));
    expect(chip(th.modes.enhance).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("composer").getAttribute("data-capability")).toBe("upscale");
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ capability: "upscale", params: { source_asset_id: OUT, factor: 2 } }), { timeout: 2000 });
    // Download saves the ORIGINAL (not the view copy, a video's 480p proxy) through its session-checked address (S2).
    const clicked: Array<{ href: string; download: string }> = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });
    fireEvent.click(await screen.findByRole("button", { name: th.actions.download }));
    await waitFor(() => expect(clicked).toEqual([{ href: `/api/library/${OUT}/download?variant=original`, download: "" }]));
    spy.mockRestore();
    expect(screen.getByRole("link", { name: th.recent.all }).getAttribute("href")).toBe("/chronos/library");
    expect(creates()).toHaveLength(0);
  });

  it("a download that cannot start says why in words on the card, not only in a tooltip, and saves nothing", async () => {
    feed = [job({ id: "a" })];
    const clicked: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute("href") ?? "");
    });
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === `/api/library/${OUT}/download?variant=original`
        ? Promise.resolve(new Response(JSON.stringify({ error: "gone" }), { status: 410 }))
        : (base as (u: string, i?: RequestInit) => Promise<Response>)(url, init),
    );
    render(withI18n(home()));
    fireEvent.click(await screen.findByRole("button", { name: th.actions.download }));
    const reason = await screen.findByTestId("result-download-reason");
    expect(reason.textContent).toBe(t.assetDownload.errors.gone);
    expect(clicked).toEqual([]);
    spy.mockRestore();
  });
});

describe("Advanced", () => {
  it("keeps every full page reachable, plus the presets, the credits and the edit projects", () => {
    render(withI18n(home()));
    const section = screen.getByRole("region", { name: th.advanced.title });
    const hrefs = within(section).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/chronos/create?desk=image",
        "/chronos/create?desk=video",
        "/chronos/create?desk=voice",
        "/chronos/create?desk=enhance",
        "/chronos/create?desk=youtube",
        "/chronos/presets",
        "/chronos/credits",
        "/chronos/editor",
      ]),
    );
    expect(within(section).getByText(t.desk.creditsUnknown)).toBeTruthy();
  });
});

describe("one send per quote (review M1)", () => {
  it("a held Enter (auto-repeat) sends once", async () => {
    render(withI18n(home()));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "a red kite" } });
    await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 });
    fireEvent.keyDown(box, { key: "Enter" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(box, { key: "Enter", repeat: true });
    await waitFor(() => expect(creates()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(creates()).toHaveLength(1);
  });

  it("two Enters before React re-renders send once", async () => {
    render(withI18n(home()));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "a red kite" } });
    await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 });
    act(() => {
      fireEvent.keyDown(box, { key: "Enter" });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await waitFor(() => expect(creates()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(creates()).toHaveLength(1);
  });

  it("after a job started, neither Enter nor the key sends again until the words or a setting change (and a fresh quote comes)", async () => {
    render(withI18n(home()));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "a red kite" } });
    const key = await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 });
    fireEvent.click(key);
    await waitFor(() => expect(creates()).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole("button", { name: /^Generate/ }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /^Generate/ }));
    await new Promise((r) => setTimeout(r, 650));
    expect(creates()).toHaveLength(1);
    // A change asks a fresh quote; that one can be spent once more.
    fireEvent.change(box, { target: { value: "a red kite at dusk" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Generate · 4 credits" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(creates()).toHaveLength(2));
    expect(creates()[1]).toMatchObject({ params: { prompt: "a red kite at dusk" } });
    expect(creates()[1].idempotency_key).not.toBe(creates()[0].idempotency_key);
  });
});

describe("a running plan is never orphaned (review M2)", () => {
  const startKey = () => screen.getByRole("button", { name: /^Start/ });
  async function startPlan() {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "2 images about tea" } });
    fireEvent.click(screen.getByTestId("composer-plan"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: th.plan.goalLabel }), { key: "Enter" });
    await waitFor(() => expect((startKey() as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    await act(async () => fireEvent.click(startKey()));
  }

  it("leaving the Plan while it starts its items keeps the one run; coming back shows it, never a second loop", async () => {
    // The first item's create never answers: the plan is mid-run.
    jobPost = () => new Promise<Response>(() => {});
    render(withI18n(home()));
    await startPlan();
    await waitFor(() => expect(creates()).toHaveLength(1));
    // Every way off the Plan: a chip, an example, an action. The planner stays mounted, hidden.
    fireEvent.click(chip(th.modes.video));
    expect(screen.getByTestId("composer-plan-running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Use this example: ${CREATIVE_EXAMPLES[0].prompt_en}` }));
    fireEvent.click(screen.getByTestId("composer-plan"));
    expect(screen.getByTestId("assistant-progress").textContent).toContain("0 of 2");
    // Still running: no Continue to press, no second create.
    expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
    expect(screen.getAllByTestId("assistant")).toHaveLength(1);
    expect(creates()).toHaveLength(1);
  });

  it("a plan stopped by a refusal is open again after a reload, with its Continue", async () => {
    jobPost = () => json({ error: "insufficient_credits" }, 402);
    const first = render(withI18n(home()));
    await startPlan();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(t.assistant.stopped));
    first.unmount();
    render(withI18n(home()));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("composer-plan").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Continue/ })).toBeTruthy();
    expect(creates()).toHaveLength(1);
  });
});

describe("focus and the chips (review M4)", () => {
  it("picking a mode with the arrow keys keeps focus on the chip, even with words typed", () => {
    render(withI18n(home()));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a lighthouse" } });
    chip(th.modes.image).focus();
    fireEvent.keyDown(chip(th.modes.image), { key: "ArrowRight" });
    expect(chip(th.modes.video).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chip(th.modes.video));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("a lighthouse");
  });

  it("an example puts focus in the words, ready to edit", () => {
    render(withI18n(home()));
    fireEvent.click(screen.getByRole("button", { name: `Use this example: ${CREATIVE_EXAMPLES[0].prompt_en}` }));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("the settings key controls an element that exists, folded or not", () => {
    render(withI18n(home()));
    const key = screen.getByTestId("composer-settings-key");
    const id = key.getAttribute("aria-controls") as string;
    expect(document.getElementById(id)).not.toBeNull();
    expect(key.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(key);
    expect(document.getElementById(id)?.hidden).toBe(false);
  });
});

describe("the same request on every way into the box", () => {
  async function pressBox(setup: () => void) {
    render(withI18n(home()));
    setup();
    const key = await screen.findByRole("button", { name: /^Generate · \d+ credits$/ }, { timeout: 2000 });
    fireEvent.click(key);
    await waitFor(() => expect(creates().length).toBeGreaterThan(0));
    const { idempotency_key: _k, ...rest } = creates().at(-1) as Record<string, unknown>;
    cleanup();
    fetchMock.mockClear();
    return rest;
  }
  async function pressPanel(ui: ReactNode, setup: () => void) {
    render(withI18n(ui));
    setup();
    const key = await screen.findByRole("button", { name: /^Generate · \d+ credits$/ }, { timeout: 2000 });
    fireEvent.click(key);
    await waitFor(() => expect(creates().length).toBeGreaterThan(0));
    const { idempotency_key: _k, ...rest } = creates().at(-1) as Record<string, unknown>;
    cleanup();
    fetchMock.mockClear();
    return rest;
  }
  const type = (v: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: v } });

  it("after switching modes away and back", async () => {
    const old = await pressPanel(<GeneratePanel orgId={ORG} models={MODELS} />, () => type("a lighthouse at dawn"));
    const box = await pressBox(() => {
      type("a lighthouse at dawn");
      fireEvent.click(chip(th.modes.voice));
      fireEvent.click(chip(th.modes.video));
      fireEvent.click(chip(th.modes.image));
    });
    expect(box).toEqual(old);
  });

  it("after picking an example", async () => {
    const e = CREATIVE_EXAMPLES.find((x) => x.id === "samarkand_dawn")!;
    const old = await pressPanel(
      <GeneratePanel
        orgId={ORG}
        models={MODELS}
        initial={{ capability: "t2i", model: "seedream-5.0-pro", prompt: e.prompt_en, aspect: "16:9", duration: 5 }}
      />,
      () => {},
    );
    const box = await pressBox(() => fireEvent.click(screen.getByRole("button", { name: `Use this example: ${e.prompt_en}` })));
    expect(box).toEqual(old);
    expect(box).toMatchObject({ capability: "t2i", model: "seedream-5.0-pro", max_credits: 7 });
  });

  it("Animate sends the finished picture as the clip's source", async () => {
    feed = [
      {
        id: "a",
        capability: "t2i",
        status: "completed",
        requested_model: "pic",
        params: { prompt: "p" },
        quoted_credits: 4,
        charged_credits: 4,
        error_code: null,
        result: null,
        result_asset_ids: [OUT],
        created_at: "2026-10-01T00:00:00Z",
      },
    ];
    render(withI18n(home()));
    fireEvent.click(await screen.findByRole("button", { name: th.actions.animate }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 40 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]).toMatchObject({ capability: "i2v", model: "clip", max_credits: 40, params: { source_asset_id: OUT } });
  });
});

describe("the examples and the words (pure)", () => {
  it("every example is a real mode and, where it names a tool, one of that mode's tools", () => {
    for (const e of CREATIVE_EXAMPLES) {
      expect(isStudioMode(e.mode), e.id).toBe(true);
      const d = modeDesk(e.mode);
      if (d) {
        expect(e.capability && (PANEL_CAPABILITIES as readonly string[]).includes(e.capability), e.id).toBe(true);
        expect(DESK_TOOLS[d], e.id).toContain(e.capability);
      }
      for (const p of [e.prompt_uz, e.prompt_en, e.prompt_ru]) expect(p.trim(), e.id).not.toBe("");
    }
    expect(new Set(CREATIVE_EXAMPLES.map((e) => e.id)).size).toBe(CREATIVE_EXAMPLES.length);
  });

  it("ship no stock or third-party media: a sample, when one is added, is our own same-origin file", () => {
    for (const e of CREATIVE_EXAMPLES) {
      if (e.mediaSrc === undefined) continue;
      expect(e.mediaSrc, e.id).toMatch(/^\/(?!\/)/);
    }
    // There is no sample yet: every card is the prompt-only card.
    expect(CREATIVE_EXAMPLES.every((e) => e.mediaSrc === undefined)).toBe(true);
  });

  it("the page's words and the examples make no banned claim, name no provider, and never say desk", () => {
    const flat = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flat) : []);
    for (const [lang, d] of Object.entries(dictionaries) as Array<["en" | "ru" | "uz", (typeof dictionaries)["en"]]>) {
      // "Улучшение" (improvement, the Enhance section's name) is not a superlative; the list's лучш\w* catches it by its letters.
      const words = flat(d.studioHome).join("\n");
      expect(bannedHits({ [lang]: words.replace(/[Уу]лучш\w*/g, "") }), lang).toEqual([]);
      expect(words, lang).not.toMatch(/\bdesks?\b|стол|\bstol/i);
      // Not the words the owner ruled out in Uzbek either.
      expect(words.toLowerCase(), lang).not.toMatch(/eng (yaxshi|zoʻr|tez|arzon|kuchli)/);
    }
    for (const e of CREATIVE_EXAMPLES) {
      expect(bannedHits({ uz: e.prompt_uz, en: e.prompt_en, ru: e.prompt_ru }), e.id).toEqual([]);
      // Uzbek in the examples spells its apostrophes the one way (tests/uz-apostrophes.test.ts's rule).
      expect(e.prompt_uz, e.id).not.toMatch(/[A-Za-zʻʼ]'|‘/);
    }
  });

  it("is written in all three languages, with the same keys", () => {
    const keys = (v: unknown, p = ""): string[] =>
      v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => keys(x, `${p}.${k}`)) : [p];
    const en = keys(dictionaries.en.studioHome).sort();
    expect(keys(dictionaries.ru.studioHome).sort()).toEqual(en);
    expect(keys(dictionaries.uz.studioHome).sort()).toEqual(en);
    expect(dictionaries.uz.studioHome.title).toBe("Bugun nima yaratamiz?");
    expect(dictionaries.uz.studioHome.examples.title).toBe("Misoldan boshlang");
    expect(dictionaries.uz.studioHome.recent.title).toBe("Soʻnggi ishlaringiz");
    expect(dictionaries.uz.studioHome.advanced.title).toBe("Kengaytirilgan");
    expect(STUDIO_MODES.map((m) => dictionaries.uz.studioHome.modes[m])).toEqual(["Rasm", "Video", "Ovoz", "Kuchaytirish", "YouTube video"]);
    // One name for the Enhance section everywhere: the chip, the switcher and the sidebar.
    for (const d of Object.values(dictionaries)) expect(d.studioHome.modes.enhance).toBe(d.desk.names.enhance);
  });
});
