// @vitest-environment jsdom
/**
 * Home ("Bosh sahifa"): the composer only hands a topic to the existing run
 * form — it never starts, prices or spends — and with no connected channel it
 * leads to connecting one. The run form takes the hand-off as a prefill and
 * still asks before it runs. Every string exists in all three languages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/home",
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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
import { dictionaries, type Locale } from "@/lib/i18n";
import { HomeHub } from "@/components/home/HomeHub";
import { HomeComposer } from "@/components/home/HomeComposer";
import { CreateStudio } from "@/components/create/CreateStudio";
import {
  HOME_FORMATS,
  HOME_LENGTHS,
  QUICK_ACTIONS,
  RUN_DURATIONS_S,
  buildHomeChannels,
  channelStanding,
  countByChannel,
  lastVideoByChannel,
  nextScheduledRun,
  runHandoffHref,
  runPrefillFromQuery,
  toolPrefill,
  type HomeChannel,
} from "@/lib/home";
import { STUDIO_CAPABILITIES } from "@/lib/creative/studio";
import type { ChannelRow } from "@/lib/types";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const wrap = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  push.mockReset();
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    if (url.startsWith("/api/credits/estimate")) return json({ estimate: null });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Anything that is not a plain read. Home must never produce one. */
const writes = () =>
  fetchMock.mock.calls.filter(([url, init]) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    return method !== "GET" || String(url).startsWith("/api/agent/run") || String(url).startsWith("/api/creative/quote");
  });

const card = (over: Partial<HomeChannel> = {}): HomeChannel => ({
  id: "c1",
  slug: "chronos",
  name: "Chronos",
  avatar: null,
  language: "",
  standing: "live",
  autoPublish: false,
  lastVideo: null,
  nextRun: null,
  waiting: 0,
  ...over,
});

const continueLink = () => screen.getByRole("link", { name: new RegExp(t.home.continue) });

describe("the composer hands off and spends nothing", () => {
  it("links to the chosen channel's run form with topic, length and language", async () => {
    render(wrap(<HomeComposer channels={[{ slug: "chronos", name: "Chronos", autoPublish: false }]} currentSlug="chronos" />));
    fireEvent.change(screen.getByLabelText(t.home.promptLabel), { target: { value: "  Why the Aral Sea   disappeared " } });
    fireEvent.click(screen.getByRole("radio", { name: t.home.lengths.m10_20 }));
    fireEvent.click(screen.getByRole("radio", { name: "Русский" }));
    const href = continueLink().getAttribute("href")!;
    expect(href).toBe("/chronos/create?topic=Why+the+Aral+Sea+++disappeared&length=1200&lang=Russian#run");
    // What the run form will read back from that link.
    const q = Object.fromEntries(new URL(href, "https://x").searchParams);
    expect(runPrefillFromQuery(q)).toEqual({ brief: "Why the Aral Sea disappeared", duration: "1200", language: "Russian" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes on with ⌘/Ctrl+Enter by navigating — never by calling the run route", () => {
    render(wrap(<HomeComposer channels={[{ slug: "chronos", name: "Chronos", autoPublish: false }]} currentSlug="chronos" />));
    const box = screen.getByLabelText(t.home.promptLabel);
    fireEvent.change(box, { target: { value: "Ancient Khiva" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(push).toHaveBeenCalledWith("/chronos/create?topic=Ancient+Khiva&length=600&lang=English#run");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts in the viewer's language and on the channel in the URL", () => {
    render(
      wrap(
        <HomeComposer
          channels={[
            { slug: "first", name: "First", autoPublish: false },
            { slug: "chronos", name: "Chronos", autoPublish: true },
          ]}
          currentSlug="chronos"
        />,
        "uz",
      ),
    );
    expect(screen.getByRole("radio", { name: "O'zbek" }).getAttribute("aria-checked")).toBe("true");
    const link = screen.getByRole("link", { name: new RegExp(dictionaries.uz.home.continue) });
    expect(link.getAttribute("href")).toMatch(/^\/chronos\/create\?length=600&lang=Uzbek#run$/);
    // Auto publish on that channel is said plainly, not hidden behind "approval".
    expect(screen.getByText(new RegExp(dictionaries.uz.home.approvalAuto.slice(0, 20)))).toBeTruthy();
  });

  it("with no connected channel leads to connecting one instead", () => {
    render(wrap(<HomeHub channels={[card({ standing: "draft" })]} currentSlug="chronos" orgId={null} allPrivate={false} />));
    const hero = screen.getByRole("region", { name: t.home.heroTitle });
    const connect = within(hero).getByRole("link", { name: new RegExp(t.home.connect) });
    expect(connect.getAttribute("href")).toBe("/chronos/channels/new");
    expect(within(hero).queryByRole("link", { name: new RegExp(t.home.continue) })).toBeNull();
    expect(screen.getByText(t.home.noChannel)).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("a format card presets the box — length and a starter — and starts nothing", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    render(wrap(<HomeHub channels={[card()]} currentSlug="chronos" orgId={ORG} allPrivate />));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t.home.formats.interview.title) }));
    expect((screen.getByLabelText(t.home.promptLabel) as HTMLTextAreaElement).value).toBe(t.home.formats.interview.starter);
    expect(screen.getByRole("radio", { name: t.home.lengths.m10_20 }).getAttribute("aria-checked")).toBe("true");
    expect(continueLink().getAttribute("href")).toContain("length=1200");
    expect(writes()).toEqual([]);
  });
});

describe("the rest of Home", () => {
  it("quick tools open the Studio panel on their tool", () => {
    render(wrap(<HomeHub channels={[card()]} currentSlug="chronos" orgId={null} allPrivate />));
    for (const a of QUICK_ACTIONS) {
      const link = screen.getByRole("link", { name: new RegExp(t.home.quick[a.id].title) });
      expect(link.getAttribute("href")).toBe(`/chronos/create?tool=${a.tool}`);
      expect(toolPrefill(a.tool)?.capability).toBe(a.tool);
    }
  });

  it("each channel card says what is waiting, links to review, and never shows an unread count as 0", () => {
    render(
      wrap(
        <HomeHub
          channels={[card({ waiting: 2 }), card({ id: "c2", slug: "ext", name: "Extinct", waiting: null })]}
          currentSlug="chronos"
          orgId={null}
          allPrivate
        />,
      ),
    );
    const [first, second] = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-channel"));
    expect(within(first).getByTestId("waiting").textContent).toBe("2");
    expect(within(first).getByRole("link", { name: new RegExp(t.home.review) }).getAttribute("href")).toBe("/chronos/videos");
    expect(within(second).getByText(t.home.waitingUnknown)).toBeTruthy();
    expect(within(second).queryByTestId("waiting")).toBeNull();
    expect(within(second).getByRole("link", { name: new RegExp(t.home.review) }).getAttribute("href")).toBe("/ext/videos");
  });

  it("offers the first action when nothing has been made yet", async () => {
    render(wrap(<HomeHub channels={[card()]} currentSlug="chronos" orgId={ORG} allPrivate />));
    const cta = await screen.findByRole("link", { name: t.home.recentEmptyCta });
    expect(cta.getAttribute("href")).toBe("/chronos/create?tool=t2i");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([`/api/creative/jobs?org_id=${ORG}`]);
    expect(writes()).toEqual([]);
  });

  it("with no channel at all, the channels section is the connect step", () => {
    render(wrap(<HomeHub channels={[]} currentSlug={null} orgId={null} allPrivate={false} />));
    expect(screen.getByText(t.home.noChannelsTitle)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: new RegExp(t.home.connect) }).every((a) => a.getAttribute("href") === "/chronos/channels/new")).toBe(true);
  });
});

describe("the run form takes the hand-off", () => {
  it("is filled from the query and still asks before it runs", async () => {
    const initial = runPrefillFromQuery({ topic: "Ancient Khiva", length: "60", lang: "Uzbek" });
    render(
      wrap(
        <CreateStudio channelId="default" githubConfigured agentConfig={null} canRun initial={initial} />,
      ),
    );
    await act(async () => {});
    expect((screen.getByPlaceholderText(t.create.placeholder) as HTMLTextAreaElement).value).toBe("Ancient Khiva");
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects.some((s) => s.value === "60")).toBe(true);
    expect(selects.some((s) => s.value === "Uzbek")).toBe(true);
    expect(screen.getByText(t.create.prefilled)).toBeTruthy();
    // The first press only asks; nothing reached the run route.
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    expect(screen.getByRole("button", { name: t.create.confirm })).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("drops what it does not recognise instead of guessing", () => {
    expect(runPrefillFromQuery({})).toBeNull();
    expect(runPrefillFromQuery({ length: "999", lang: "Klingon" })).toBeNull();
    expect(runPrefillFromQuery({ topic: ["a", "b"], length: "600" })).toEqual({ brief: "", duration: "600", language: "" });
    expect(runPrefillFromQuery({ length: "1e3" })).toBeNull();
    expect(runPrefillFromQuery({ topic: "x".repeat(500) })?.brief).toHaveLength(300);
    for (const l of HOME_LENGTHS) expect(RUN_DURATIONS_S).toContain(l.seconds);
    expect(runHandoffHref("a b", { topic: "  ", seconds: 300, language: "English" })).toBe("/a%20b/create?length=300&lang=English#run");
  });

  it("opens any Studio tool empty, and nothing that is not one", () => {
    for (const c of STUDIO_CAPABILITIES) expect(toolPrefill(c)).toMatchObject({ capability: c, prompt: "", sourceId: null });
    expect(toolPrefill("publish")).toBeNull();
    expect(toolPrefill(["t2i"])).toBeNull();
  });
});

describe("channel status, from the channel's own settings", () => {
  const ch = (over: Partial<ChannelRow> = {}): ChannelRow => ({
    channel_id: "c1",
    name: "Chronos",
    niche: "",
    status: "ACTIVE",
    agent_config: { language: "Uzbek" },
    schedule_config: { publish_hour_utc: 9, enabled: true },
    credential_ref: { youtube_channel_id: "UC1", verified_at: "2026-01-01T00:00:00Z", youtube_thumbnail: "https://yt3.example/a.jpg" },
    auto_publish: false,
    created_at: null,
    updated_at: null,
    ...over,
  });
  const now = new Date("2026-10-01T10:30:00Z");

  it("schedules the next run at the publish hour, today or tomorrow, and only for a live channel", () => {
    expect(nextScheduledRun(ch(), now)?.toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect(nextScheduledRun(ch({ schedule_config: { publish_hour_utc: 20 } }), now)?.toISOString()).toBe("2026-10-01T20:00:00.000Z");
    expect(nextScheduledRun(ch({ schedule_config: null }), now)?.toISOString()).toBe("2026-10-01T15:00:00.000Z");
    expect(nextScheduledRun(ch({ status: "PAUSED" }), now)).toBeNull();
    expect(nextScheduledRun(ch({ schedule_config: { enabled: false } }), now)).toBeNull();
    expect(nextScheduledRun(ch({ credential_ref: null }), now)).toBeNull();
    expect(channelStanding(ch({ credential_ref: null }))).toBe("draft");
  });

  it("builds each card from the reads, keeping an unread count unknown", () => {
    const last = lastVideoByChannel([
      { channel_id: "c1", title: "Newest", published_at: "2026-09-30T00:00:00Z" },
      { channel_id: "c1", title: "Older", published_at: "2026-09-01T00:00:00Z" },
      { channel_id: 5 },
    ]);
    const [a] = buildHomeChannels({ channels: [ch()], slugOf: () => "chronos", lastVideos: last, waiting: countByChannel([{ channel_id: "c1" }, { channel_id: "c1" }]), now });
    expect(a).toMatchObject({ slug: "chronos", standing: "live", language: "Uzbek", waiting: 2, lastVideo: { title: "Newest" }, avatar: "https://yt3.example/a.jpg" });
    const [b] = buildHomeChannels({ channels: [ch({ credential_ref: { youtube_thumbnail: "javascript:alert(1)" } })], slugOf: () => "x", lastVideos: new Map(), waiting: null, now });
    expect(b).toMatchObject({ waiting: null, avatar: null, standing: "draft", nextRun: null });
  });
});

describe("every Home string, in all three languages", () => {
  const shape = (v: unknown): unknown =>
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;
  const leaves = (v: unknown): string[] =>
    v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v as string];

  it("has the same keys in en, ru and uz, none empty", () => {
    for (const loc of ["ru", "uz"] as const) expect(shape(dictionaries[loc].home)).toEqual(shape(dictionaries.en.home));
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc];
      for (const s of leaves(d.home)) expect(typeof s === "string" && s.trim().length > 0).toBe(true);
      for (const s of [d.nav.home, d.agents.runDur1m, d.create.prefilled]) expect(s.trim().length).toBeGreaterThan(0);
      for (const f of HOME_FORMATS) expect(d.home.formats[f.id].starter).toContain("[");
    }
    expect(dictionaries.uz.home.title).toBe("Bosh sahifa");
  });
});
