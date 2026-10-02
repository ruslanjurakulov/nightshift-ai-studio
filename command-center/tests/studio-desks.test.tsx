// @vitest-environment jsdom
/**
 * The Studio's desks (lib/creative/desks): the composer's tools grouped by the
 * job, each desk laid out around it. A desk only arranges the page. These
 * tests hold the money path to that: on every desk the price comes from the
 * quote route, the press sends exactly that price as max_credits with a fresh
 * idempotency key, and the create request is byte-for-byte the one the
 * composer outside a desk sends for the same form.
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
import { GenerateSection } from "@/components/studio/GenerateSection";
import { JobFeed, elapsedSeconds } from "@/components/studio/JobFeed";
import { DeskBar, StudioOverview, YouTubeDesk } from "@/components/studio/Desks";
import {
  DESKS,
  DESK_TOOLS,
  MEDIA_DESKS,
  deskFor,
  deskFromQuery,
  deskHref,
  isDesk,
  pictureToolFor,
} from "@/lib/creative/desks";
import { PANEL_CAPABILITIES, STUDIO_VOICES, needsSource, type StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const OUT = "33333333-3333-4333-8333-333333333333";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic", displayName: "Picture", capabilities: ["t2i", "edit", "upscale", "remove_bg", "describe"], beta: false },
  { id: "clip", displayName: "Clip", capabilities: ["t2v", "i2v"], beta: false },
  { id: "voice", displayName: "Voice", capabilities: ["tts", "voice_change", "dub"], beta: false },
];
const PRICE: Record<string, number> = { pic: 4, clip: 40, voice: 2 };

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<{ model: string; capability: string; params: Record<string, unknown> }>;
let feed: unknown[];
const creates = () =>
  fetchMock.mock.calls
    .filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const asset = (id: string, kind = "image") => ({
  id,
  kind,
  mime: kind === "image" ? "image/png" : "audio/mpeg",
  bytes: 1,
  width: 10,
  height: 10,
  durationS: kind === "audio" ? 3 : null,
  source: "generated",
  name: `${id}.bin`,
  variants: ["thumb"],
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  thumbUrl: kind === "image" ? `/thumb/${id}` : null,
  viewUrl: `/view/${id}`,
});

beforeEach(() => {
  quotes = [];
  feed = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      return json({ quote: { credits: PRICE[body.model] ?? 1 } });
    }
    if (url.startsWith("/api/creative/jobs") && init?.method === "POST") return json({ job: { id: "new" } });
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: feed });
    if (url.startsWith("/api/media")) return json({ available: true, assets: [asset(PIC), asset(OUT), asset("44444444-4444-4444-8444-444444444444", "audio")], uploads: [] });
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

describe("the desks (pure)", () => {
  it("put every composer tool on exactly one desk, and nothing else", () => {
    const all = MEDIA_DESKS.flatMap((d) => [...DESK_TOOLS[d]]);
    expect([...all].sort()).toEqual([...PANEL_CAPABILITIES].sort());
    expect(new Set(all).size).toBe(all.length);
    for (const c of PANEL_CAPABILITIES) expect(DESK_TOOLS[deskFor(c)]).toContain(c);
  });

  it("open the desk the link asks for, the tool's own desk, the run for a topic, else the overview", () => {
    expect(deskFromQuery({})).toBe("overview");
    expect(deskFromQuery({ desk: "voice" })).toBe("voice");
    expect(deskFromQuery({ tool: "upscale" })).toBe("enhance");
    expect(deskFromQuery({ tool: "i2v" })).toBe("video");
    expect(deskFromQuery({ tool: "describe" })).toBe("image");
    // A tool from another desk is not dropped: its desk opens.
    expect(deskFromQuery({ desk: "image", tool: "t2v" })).toBe("video");
    expect(deskFromQuery({ hasRunPrefill: true })).toBe("youtube");
    expect(deskFromQuery({ desk: "youtube", tool: "t2i" })).toBe("youtube");
    // Junk falls through, never throws.
    expect(deskFromQuery({ desk: "<script>", tool: "sfx" })).toBe("overview");
    expect(deskFromQuery({ desk: ["video", "image"] })).toBe("video");
    expect(isDesk("overview")).toBe(true);
    expect(deskHref("overview")).toBe("/create");
    expect(deskHref("enhance")).toBe("/create?desk=enhance");
  });

  it("send a picture to the desk's own picture tool", () => {
    expect(pictureToolFor(PANEL_CAPABILITIES, "t2i", needsSource)).toBe("edit");
    expect(pictureToolFor(DESK_TOOLS.image, "t2i", needsSource)).toBe("edit");
    expect(pictureToolFor(DESK_TOOLS.video, "t2v", needsSource)).toBe("i2v");
    expect(pictureToolFor(DESK_TOOLS.enhance, "video_upscale", needsSource)).toBe("upscale");
    expect(pictureToolFor(DESK_TOOLS.enhance, "remove_bg", needsSource)).toBe("remove_bg");
  });

  it("are named, described and labelled in every language", () => {
    for (const d of Object.values(dictionaries)) {
      for (const k of DESKS) {
        expect(d.desk.names[k].trim(), k).not.toBe("");
        expect(d.desk.blurbs[k].trim(), k).not.toBe("");
        expect(d.desk.keySub[k].trim(), k).not.toBe("");
      }
      for (const c of PANEL_CAPABILITIES) {
        expect(d.desk.tools[c].trim(), c).not.toBe("");
        expect(d.desk.toolFrom[c].trim(), c).not.toBe("");
      }
      for (const m of MEDIA_DESKS) {
        expect(d.desk.emptyTitle[m].trim()).not.toBe("");
        expect(d.desk.empty[m].trim()).not.toBe("");
        expect(d.desk.feedTitle[m].trim()).not.toBe("");
      }
    }
  });

  it("never invent elapsed time", () => {
    expect(elapsedSeconds("not a date", Date.now())).toBeNull();
    expect(elapsedSeconds("2026-10-01T00:00:00Z", Date.parse("2026-10-01T00:01:05Z"))).toBe(65);
    expect(elapsedSeconds("2026-10-01T00:00:10Z", Date.parse("2026-10-01T00:00:00Z"))).toBe(0);
  });
});

describe("a desk's composer", () => {
  it("offers only its desk's tools, as one tablist with one tab stop", () => {
    for (const desk of MEDIA_DESKS) {
      const { unmount } = render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} desk={desk} />));
      const list = screen.getByRole("tablist", { name: t.gen.kindLabel });
      const tabs = within(list).getAllByRole("tab");
      expect(tabs).toHaveLength(DESK_TOOLS[desk].length);
      expect(tabs.map((x) => x.id)).toEqual(DESK_TOOLS[desk].map((c) => `gen-tab-${c}`));
      expect(tabs.filter((x) => x.getAttribute("tabindex") === "0")).toHaveLength(1);
      expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs.find((x) => x.getAttribute("aria-selected") === "true")?.id);
      unmount();
    }
  });

  it("arrow keys wrap within the desk", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} desk="voice" />));
    const tts = document.getElementById("gen-tab-tts") as HTMLElement;
    expect(tts.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tts, { key: "ArrowLeft" });
    expect(document.getElementById("gen-tab-dub")?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.id).toBe("gen-tab-dub");
  });

  it("Video: prices the shot and creates with exactly the quoted price and a fresh key", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} desk="video" />));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a ferry at night" } });
    // The shape and length keys are the same choices, drawn as a shape and a counter.
    fireEvent.click(within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button")[1]);
    const key = await screen.findByRole("button", { name: "Generate · 40 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toMatchObject({ capability: "t2v", model: "clip", params: { prompt: "a ferry at night", duration_s: 10, aspect_ratio: "16:9" } });
    fireEvent.click(key);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const body = creates()[0];
    expect(body).toMatchObject({ org_id: ORG, capability: "t2v", model: "clip", max_credits: 40, params: { duration_s: 10 } });
    expect(typeof body.idempotency_key).toBe("string");
    expect(String(body.idempotency_key).length).toBeGreaterThan(8);
  });

  it("Voice: the cast is a radio group; speech is priced only with a voice and created with it", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} desk="voice" />));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello there" } });
    expect(screen.getByTestId("gen-char-count").textContent).toContain("11");
    await new Promise((r) => setTimeout(r, 650));
    expect(quotes).toHaveLength(0);
    const cast = screen.getByRole("radiogroup", { name: t.gen.ttsVoiceLabel });
    const first = within(cast).getAllByRole("radio")[0];
    fireEvent.click(first);
    expect(first.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 2 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]).toMatchObject({ capability: "tts", max_credits: 2, params: { prompt: "Hello there", voice_id: STUDIO_VOICES[0].id } });
  });

  it("Enhance: the size keys stand apart; the price follows the size picked", async () => {
    render(
      withI18n(
        <GeneratePanel
          orgId={ORG}
          models={MODELS}
          desk="enhance"
          initial={{ capability: "upscale", model: "", prompt: "", aspect: "16:9", duration: 5, sourceId: PIC, factor: 2 }}
        />,
      ),
    );
    fireEvent.click(within(screen.getByRole("group", { name: t.gen.factorLabel })).getByRole("button", { name: "4× larger" }));
    const key = await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 });
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ capability: "upscale", params: { source_asset_id: PIC, factor: 4 } }));
    fireEvent.click(key);
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]).toMatchObject({ capability: "upscale", max_credits: 4, params: { source_asset_id: PIC, factor: 4 } });
  });

  it("sends the same create request on a desk as outside one, for the same form", async () => {
    const press = async (desk: "image" | null) => {
      const { unmount } = render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} desk={desk} />));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "a lighthouse at dawn" } });
      fireEvent.click(await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 }));
      await waitFor(() => expect(creates().length).toBeGreaterThan(0));
      const body = creates().at(-1) as Record<string, unknown>;
      unmount();
      fetchMock.mockClear();
      const { idempotency_key: _key, ...rest } = body;
      return rest;
    };
    const outside = await press(null);
    const onDesk = await press("image");
    expect(onDesk).toEqual(outside);
    expect(outside).toMatchObject({ capability: "t2i", max_credits: 4 });
  });

  it("lays the chosen picture on the table, large, with a way to change it", async () => {
    render(
      withI18n(
        <GeneratePanel
          orgId={ORG}
          models={MODELS}
          desk="image"
          initial={{ capability: "edit", model: "", prompt: "", aspect: "16:9", duration: 5, sourceId: PIC, factor: 2 }}
        />,
      ),
    );
    const well = await screen.findByTestId("source-well");
    await waitFor(() => expect(well.querySelector(`img[src="/view/${PIC}"]`)).not.toBeNull());
    expect(within(well).getByRole("button", { name: t.gen.sourceChange })).toBeTruthy();
  });
});

describe("a desk's results", () => {
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

  it("lists only the desk's own tools, with the desk's empty words when there are none", async () => {
    feed = [job({ id: "a", capability: "tts", params: { prompt: "spoken words" }, result_asset_ids: [] })];
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} desk="image" />));
    expect(await screen.findByText(t.desk.emptyTitle.image)).toBeTruthy();
    expect(screen.queryByText("spoken words")).toBeNull();
  });

  it("Voice: each finished take gets its own player; a failed one says why and offers Try again", async () => {
    feed = [
      job({ id: "a", capability: "tts", params: { prompt: "first take" }, result_asset_ids: ["44444444-4444-4444-8444-444444444444"] }),
      job({ id: "b", capability: "dub", status: "failed", error_code: "provider_timeout", params: { source_asset_id: PIC, target_language: "ru" }, result_asset_ids: [] }),
    ];
    render(withI18n(<JobFeed orgId={ORG} models={MODELS} capabilities={DESK_TOOLS.voice} variant="takes" onRetry={() => {}} />));
    expect(await screen.findByText("first take")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('audio[src="/view/44444444-4444-4444-8444-444444444444"]')).not.toBeNull());
    expect(screen.getByText(new RegExp(t.gen.reasons.busy.slice(0, 20)))).toBeTruthy();
    expect(screen.getByRole("button", { name: t.gen.tryAgain })).toBeTruthy();
  });

  it("Video: the newest clip is on the monitor; a frame on the strip puts another there", async () => {
    feed = [
      job({ id: "a", capability: "t2v", status: "running", params: { prompt: "clip one", duration_s: 5 }, result_asset_ids: [], charged_credits: null }),
      job({ id: "b", capability: "t2v", params: { prompt: "clip two", duration_s: 5 } }),
    ];
    render(withI18n(<JobFeed orgId={ORG} models={MODELS} capabilities={DESK_TOOLS.video} variant="monitor" />));
    const stage = await screen.findByTestId("desk-stage");
    expect(within(stage).getByText("clip one")).toBeTruthy();
    const strip = screen.getByRole("list", { name: t.desk.stripLabel });
    const frames = within(strip).getAllByRole("button");
    expect(frames[0].getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(frames[1]);
    expect(within(screen.getByTestId("desk-stage")).getByText("clip two")).toBeTruthy();
    // Picking a frame only shows it: nothing is created or cancelled.
    expect(creates()).toHaveLength(0);
  });

  it("the overview's log links each generation to its desk", async () => {
    feed = [job({ id: "a", capability: "upscale", params: { source_asset_id: PIC, factor: 2 } })];
    render(withI18n(<JobFeed orgId={ORG} variant="log" />));
    const link = await screen.findByRole("link", { name: "Open the Enhance desk" });
    expect(link.getAttribute("href")).toBe("/chronos/create?desk=enhance");
  });
});

describe("the desk switcher, the overview and the YouTube desk", () => {
  it("the switcher is a navigation of links with the current desk marked", () => {
    render(withI18n(<DeskBar current="voice" />));
    const nav = screen.getByRole("navigation", { name: t.desk.nav });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(DESKS.length);
    expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.getAttribute("href"))).toEqual(["/chronos/create?desk=voice"]);
  });

  it("an unreadable balance is words, not a zero, and no meter is drawn", () => {
    render(withI18n(<StudioOverview orgId={ORG} credits={{ state: "unknown" }} projects={{ state: "failed" }} />));
    expect(screen.getByText(t.desk.creditsUnknown)).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(t.desk.projectsFailed)).toBeTruthy();
  });

  it("a real balance is drawn as a meter with what is held", () => {
    render(
      withI18n(
        <StudioOverview
          orgId={ORG}
          credits={{ state: "account", account: { balance: 130, reserved: 30, available: 100 } }}
          projects={{ state: "ok", projects: [{ id: "p1", title: "Cut two", updatedAt: null }] }}
        />,
      ),
    );
    const meter = screen.getByRole("meter", { name: t.desk.creditsTitle });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("link", { name: /Cut two/ }).getAttribute("href")).toBe("/chronos/editor/p1");
  });

  it("the operator's own organization reads as not charged", () => {
    render(withI18n(<StudioOverview orgId={ORG} credits={{ state: "exempt" }} projects={{ state: "ok", projects: [] }} />));
    expect(screen.getByText(t.desk.creditsExempt)).toBeTruthy();
    expect(screen.getByText(t.desk.projectsEmpty)).toBeTruthy();
  });

  it("the YouTube rundown lights only the step this form is, and links the rest to customer pages", () => {
    render(withI18n(<YouTubeDesk run={<p>run form</p>} />));
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(6);
    expect(steps.filter((s) => s.getAttribute("aria-current") === "step")).toHaveLength(1);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/chronos/videos", "/chronos/studio", "/chronos/editor", "/chronos/videos", "/chronos/videos"]);
    expect(screen.getByText("run form")).toBeTruthy();
  });
});
