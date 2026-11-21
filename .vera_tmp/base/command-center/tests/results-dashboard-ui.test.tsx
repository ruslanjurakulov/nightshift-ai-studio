// @vitest-environment jsdom
/**
 * The results dashboard's states and controls (components/results).
 * What would break without these: an unmeasured video read as "0", a number drawn for a platform that has no results, a
 * failed read drawn as an empty dashboard (or beside old numbers), a stale answer that looks current, a channel / period
 * switch that is not reachable from the keyboard, a control with no name, and any request other than the one /api/results read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import type { ResultsPayload } from "../lib/resultsDashboard/payload";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});

const { ResultsDashboard } = await import("../components/results/ResultsDashboard");
const { sortVideos } = await import("../components/results/ResultsParts");
const r = en.resultsDashboard;

const fig = (value: number | null, known: number, of: number) => ({ value, known, of });
const reading = (over = {}) => ({ date: "2026-10-24", daysAfterPublish: 2, views: 1200, likes: 10, comments: 2, watchMinutes: 150, avgViewSeconds: 125, impressions: null, ...over });
const videoRow = (id: string, over = {}) => ({
  noData: false,
  videoId: id,
  channelId: "chanA1",
  title: `Title ${id}`,
  publishedAt: "2026-10-22T10:00:00.000Z",
  privacy: "private",
  format: "long",
  reading: reading(),
  ...over,
});

function payload(over: Partial<ResultsPayload> = {}): ResultsPayload {
  return {
    generatedAt: "2026-10-25T12:00:00.000Z",
    rangeDays: 28,
    selected: null,
    channels: [
      { id: "chanA1", name: "Alpha", connected: true },
      { id: "chanA2", name: "Alpha two", connected: false },
    ],
    platforms: [
      { id: "youtube", state: "live", connected: 1 },
      { id: "instagram", state: "connected_results_coming", connected: 1 },
      { id: "tiktok", state: "not_connected", connected: 0 },
      { id: "x", state: "coming", connected: 0 },
      { id: "facebook", state: "coming", connected: 0 },
    ],
    kpis: { videos: 2, measured: 1, noData: 0, views: fig(1200, 1, 2), watchHours: fig(2.5, 1, 2), likes: fig(10, 1, 2), comments: fig(2, 1, 2), avgViewSeconds: fig(125, 1, 2) },
    // newest first, as the server sends them
    videos: [videoRow("vidA0000002", { reading: null, publishedAt: "2026-10-24T10:00:00.000Z" }), videoRow("vidA0000001")] as ResultsPayload["videos"],
    history: [
      { key: "up:vidA0000001", kind: "upload", platform: "youtube", target: "Alpha", videoId: "vidA0000001", videoTitle: "Title vidA0000001", at: "2026-10-22T10:00:00.000Z", status: "uploaded", privacy: "private", reason: null, url: null },
      { key: "rq:1", kind: "request", platform: "instagram", target: "@alpha_ig", videoId: "vidA0000001", videoTitle: "Title vidA0000001", at: "2026-10-23T10:00:00.000Z", status: "failed", privacy: null, reason: "token_expired", url: null },
    ],
    freshness: { asOf: "2026-10-24", ageDays: 1, stale: false },
    subscribers: "not_collected",
    truncated: { videos: false, history: false, snapshots: false },
    sources: { requests: "ok", accounts: "ok" },
    ...over,
  };
}

const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const mountDashboard = (initial: string | null = null) => render(<ResultsDashboard initialChannel={initial} videosHref="/alpha/videos" channelsHref="/alpha/channels" />);
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("loading, error, empty", () => {
  it("shows a loading state first, with its name for a screen reader", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    mountDashboard();
    expect(screen.getByRole("status", { name: r.loading })).toBeTruthy();
    expect(screen.queryByLabelText(r.kpisLabel)).toBeNull();
  });

  it("a failed read replaces the page with an alert and a retry that reads again", async () => {
    fetchMock.mockImplementationOnce(() => ok({ error: "failed" }, 502)).mockImplementationOnce(() => ok(payload()));
    mountDashboard();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(r.errorTitle)).toBeTruthy();
    expect(screen.queryByLabelText(r.kpisLabel)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: r.retry }));
    expect(await screen.findByLabelText(r.kpisLabel)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an answer of the wrong shape is an error, not an empty dashboard", async () => {
    fetchMock.mockImplementation(() => ok({ hello: "world" }));
    mountDashboard();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("a network failure is an error", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    mountDashboard();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("a workspace with no channel says so and links to Channels", async () => {
    fetchMock.mockImplementation(() => ok(payload({ channels: [], videos: [], history: [] })));
    mountDashboard();
    expect(await screen.findByText(r.noChannelsTitle)).toBeTruthy();
    expect(screen.getByRole("link", { name: r.openChannels }).getAttribute("href")).toBe("/alpha/channels");
  });

  it("nothing published in the period is an honest empty state, and the platforms and history still show", async () => {
    fetchMock.mockImplementation(() =>
      ok(payload({ kpis: { videos: 0, measured: 0, noData: 0, views: fig(null, 0, 0), watchHours: fig(null, 0, 0), likes: fig(null, 0, 0), comments: fig(null, 0, 0), avgViewSeconds: fig(null, 0, 0) }, videos: [], history: [], freshness: { asOf: null, ageDays: null, stale: false } })),
    );
    mountDashboard();
    expect(await screen.findByText(r.emptyTitle)).toBeTruthy();
    expect(screen.getByText(r.noReadingYet)).toBeTruthy();
    expect(screen.queryByLabelText(r.kpisLabel)).toBeNull();
    expect(screen.getByText(r.historyEmpty)).toBeTruthy();
    expect(screen.getByText(r.platformsTitle)).toBeTruthy();
  });
});

describe("the figures", () => {
  it("shows the key figures with how many videos each covers, the freshness and the source", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    const kpis = await screen.findByLabelText(r.kpisLabel);
    expect(within(kpis).getByText("1,200")).toBeTruthy();
    expect(within(kpis).getByText("2.5 h")).toBeTruthy();
    expect(within(kpis).getByText("2:05")).toBeTruthy();
    expect(within(kpis).getAllByText("1 of 2 videos measured").length).toBeGreaterThan(0);
    expect(screen.getByText(/^As of 2026-10-24 \(/)).toBeTruthy();
    expect(screen.getByText(r.source)).toBeTruthy();
    expect(screen.getByText(r.readingNote)).toBeTruthy();
  });

  it("subscribers read 'Not collected', never a number", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    const kpis = await screen.findByLabelText(r.kpisLabel);
    expect(within(kpis).getByText(r.notCollected)).toBeTruthy();
    expect(within(kpis).getByText(r.subscribersNote)).toBeTruthy();
  });

  it("a figure nobody has says 'Not measured', not 0", async () => {
    fetchMock.mockImplementation(() =>
      ok(payload({ kpis: { videos: 1, measured: 0, noData: 0, views: fig(null, 0, 1), watchHours: fig(null, 0, 1), likes: fig(null, 0, 1), comments: fig(null, 0, 1), avgViewSeconds: fig(null, 0, 1) }, videos: [videoRow("vidA0000001", { reading: null })] as ResultsPayload["videos"] })),
    );
    mountDashboard();
    const kpis = await screen.findByLabelText(r.kpisLabel);
    expect(within(kpis).getAllByText(r.notMeasured)).toHaveLength(3);
    expect(within(kpis).queryByText("0")).toBeNull();
    expect(screen.getByText(r.noReadingsTitle)).toBeTruthy();
  });

  it("an unmeasured video row says so; a measured one shows its reading and how long after publishing", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    const measured = rows.find((row) => within(row).queryByText("Title vidA0000001"))!;
    const unmeasured = rows.find((row) => within(row).queryByText("Title vidA0000002"))!;
    expect(within(measured).getByText("1,200")).toBeTruthy();
    expect(within(measured).getByText("2026-10-24, 2 days after publishing")).toBeTruthy();
    expect(within(unmeasured).getByText(r.videoNotMeasured)).toBeTruthy();
    expect(within(unmeasured).queryByText("0")).toBeNull();
  });

  it("every link of a row has a name that says which video it is for", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const details = screen.getByRole("link", { name: "Details of Title vidA0000001" });
    expect(details.getAttribute("href")).toBe("/alpha/videos/vidA0000001");
    const yt = screen.getByRole("link", { name: "Watch on YouTube: Title vidA0000001" });
    expect(yt.getAttribute("href")).toBe("https://www.youtube.com/watch?v=vidA0000001");
    expect(yt.getAttribute("rel")).toContain("noopener");
  });

  it("the sort control ranks by views with the unmeasured last, and newest first on request", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const order = () => within(screen.getByRole("table")).getAllByRole("rowheader").map((c) => c.textContent ?? "");
    expect(order()[0]).toContain("Title vidA0000001"); // most views first
    expect(order()[1]).toContain("Title vidA0000002"); // the unmeasured one last, not ranked as 0
    fireEvent.change(screen.getByLabelText(r.sortLabel), { target: { value: "newest" } });
    expect(order()[0]).toContain("Title vidA0000002"); // the server's newest-first order
  });

  it("lists the top videos with their real values and no invented scale label", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const section = screen.getByRole("heading", { name: r.topTitle }).closest("section")!;
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(within(section).getByText("1,200")).toBeTruthy();
  });
});

describe("sortVideos", () => {
  const v = (id: string, views: number | null) => videoRow(id, { reading: views === null ? null : reading({ views }) }) as unknown as ResultsPayload["videos"][number];
  const rows = [v("u1", null), v("m5", 5), v("u2", null), v("m9", 9)];
  const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  it("puts the measured by views first and the unmeasured last, whatever order they arrive in", () => {
    for (const p of permutations(rows)) {
      const ids = sortVideos(p, "views").map((x) => x.videoId);
      expect(ids.slice(0, 2), p.map((x) => x.videoId).join()).toEqual(["m9", "m5"]);
      expect(ids.slice(2).sort()).toEqual(["u1", "u2"]);
    }
  });
  it("leaves the server's order alone for 'newest' and does not touch its input", () => {
    expect(sortVideos(rows, "newest").map((x) => x.videoId)).toEqual(["u1", "m5", "u2", "m9"]);
    sortVideos(rows, "views");
    expect(rows.map((x) => x.videoId)).toEqual(["u1", "m5", "u2", "m9"]);
  });
});

describe("stale and partial", () => {
  it("says the newest reading is old, with the date it stops at", async () => {
    fetchMock.mockImplementation(() => ok(payload({ freshness: { asOf: "2026-10-18", ageDays: 7, stale: true } })));
    mountDashboard();
    const note = await screen.findByText("The newest reading is 7 days old");
    expect(note.closest("[role=status]")).toBeTruthy();
    expect(screen.getByText(/Views after 2026-10-18 are not included/)).toBeTruthy();
  });

  it("does not warn when the reading is current", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.queryByText(/days old/)).toBeNull();
  });

  it("says when the list is cut", async () => {
    fetchMock.mockImplementation(() => ok(payload({ truncated: { videos: true, history: true, snapshots: false } })));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.getByText(/Showing the newest 200 videos/)).toBeTruthy();
    expect(screen.getByText(/Showing the newest 2 entries/)).toBeTruthy();
  });

  it("names a gap in the cross-posts instead of hiding it", async () => {
    fetchMock.mockImplementation(() => ok(payload({ sources: { requests: "unavailable", accounts: "ok" } })));
    mountDashboard();
    expect(await screen.findByText(r.historyRequestsUnavailable)).toBeTruthy();
  });

  it("a disconnected channel is said to be, and its stored results stay", async () => {
    fetchMock.mockImplementation(() => ok(payload({ selected: "chanA2" })));
    mountDashboard("chanA2");
    expect(await screen.findByText(r.disconnectedNote)).toBeTruthy();
    expect(screen.getByLabelText(r.kpisLabel)).toBeTruthy();
  });
});

describe("history and platforms", () => {
  it("words each entry's status, kind and recorded visibility; a failure gives its reason; no visibility is 'not recorded'", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const list = screen.getByRole("heading", { name: r.historyTitle }).closest("section")!;
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const [rq, up] = [items.find((i) => within(i).queryByText(r.kind.request))!, items.find((i) => within(i).queryByText(r.kind.upload))!];
    expect(within(up).getByText(r.status.uploaded)).toBeTruthy();
    expect(within(up).getByText(r.privacy.private)).toBeTruthy();
    expect(within(rq).getByText(r.status.failed)).toBeTruthy();
    expect(within(rq).getByText(r.privacy.notRecorded)).toBeTruthy();
    expect(within(rq).getByText(en.publish.reasons.token_expired)).toBeTruthy();
    expect(within(rq).getByText(/@alpha_ig/)).toBeTruthy();
  });

  it("words TikTok's own-only privacy, links a recorded result, and shows no link when none was recorded", async () => {
    const p = payload();
    p.history = [
      { ...p.history[1], key: "rq:5", platform: "tiktok", status: "uploaded", reason: null, privacy: "SELF_ONLY", url: "https://example.com/post/5" },
      { ...p.history[1], key: "rq:6", platform: "tiktok", status: "uploaded", reason: null, privacy: "SELF_ONLY", url: null },
    ];
    fetchMock.mockImplementation(() => ok(p));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const items = within(screen.getByRole("heading", { name: r.historyTitle }).closest("section")!).getAllByRole("listitem");
    expect(within(items[0]).getByText(r.privacy.selfOnly)).toBeTruthy();
    expect(within(items[0]).getByRole("link", { name: /Open post/ }).getAttribute("href")).toBe("https://example.com/post/5");
    expect(items[1].querySelector("a")).toBeNull();
  });

  it("never calls a video public that the record does not say is public", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.queryByText(r.privacy.public)).toBeNull();
  });

  it("draws one card per platform; the ones without results carry words and no numbers", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const cards = within(screen.getByRole("heading", { name: r.platformsTitle }).closest("section")!).getAllByRole("listitem");
    expect(cards).toHaveLength(5);
    const card = (name: string) => cards.find((c) => within(c).queryByRole("heading", { name }))!;
    expect(within(card("Instagram")).getByText(r.platformState.connected_results_coming)).toBeTruthy();
    expect(within(card("TikTok")).getByText(r.platformState.not_connected)).toBeTruthy();
    expect(within(card("X")).getByText(r.platformState.coming)).toBeTruthy();
    expect(within(card("Facebook")).getByText(r.platformState.coming)).toBeTruthy();
    for (const name of ["Instagram", "TikTok", "X", "Facebook"]) expect(card(name).textContent).not.toMatch(/\d{2,}/);
    // only a platform that can be connected and is not yet fully shown offers a way to manage accounts
    expect(within(card("YouTube")).queryByRole("link")).toBeNull();
    expect(within(card("X")).queryByRole("link")).toBeNull();
    expect(within(card("Facebook")).queryByRole("link")).toBeNull();
    expect(within(card("TikTok")).getByRole("link", { name: r.manageAccounts }).getAttribute("href")).toBe("/alpha/channels");
    expect(within(card("Instagram")).getByRole("link", { name: r.manageAccounts })).toBeTruthy();
  });
});

describe("controls", () => {
  it("changing the channel reads that channel, and the period reads that period, and nothing else is fetched", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    fireEvent.change(screen.getByLabelText(r.channelLabel), { target: { value: "chanA1" } });
    await waitFor(() => expect(urls().some((u) => u.includes("channel=chanA1"))).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: r.range.d7 }));
    await waitFor(() => expect(urls().some((u) => u.includes("channel=chanA1") && u.includes("range=7"))).toBe(true));
    for (const u of urls()) expect(u).toMatch(/^\/api\/results\?(channel=[A-Za-z0-9._-]+&)?range=(7|28|90)$/);
  });

  it("starts on all channels with no channel in the request, and the select says so", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(urls()[0]).toBe("/api/results?range=28");
    expect((screen.getByLabelText(r.channelLabel) as HTMLSelectElement).value).toBe("");
  });

  it("a channel whose id is literally 'all' is asked for by id, and is not the all-channels choice", async () => {
    fetchMock.mockImplementation(() => ok(payload({ selected: "all", channels: [{ id: "all", name: "Literally all", connected: true }] })));
    mountDashboard("all");
    await screen.findByLabelText(r.kpisLabel);
    expect(urls()[0]).toBe("/api/results?channel=all&range=28");
    const select = screen.getByLabelText(r.channelLabel) as HTMLSelectElement;
    expect(select.value).toBe("all");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "all"]);
  });

  it("starts on the channel the page was opened on", async () => {
    fetchMock.mockImplementation(() => ok(payload({ selected: "chanA1" })));
    mountDashboard("chanA1");
    await screen.findByLabelText(r.kpisLabel);
    expect(urls()[0]).toBe("/api/results?channel=chanA1&range=28");
    expect((screen.getByLabelText(r.channelLabel) as HTMLSelectElement).value).toBe("chanA1");
  });

  it("a channel that is not this workspace's falls back to all channels instead of an error", async () => {
    fetchMock.mockImplementationOnce(() => ok({ error: "not_found" }, 404)).mockImplementation(() => ok(payload()));
    mountDashboard("chanZ");
    await screen.findByLabelText(r.kpisLabel);
    expect(urls()[0]).toContain("channel=chanZ");
    expect(urls()[1]).toBe("/api/results?range=28");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the period is a keyboard-operable group: arrows move and choose", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const group = screen.getByRole("radiogroup", { name: r.rangeLabel });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((x) => x.textContent)).toEqual([r.range.d7, r.range.d28, r.range.d90]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios[1], { key: "ArrowRight" });
    await waitFor(() => expect(urls().some((u) => u.endsWith("range=90"))).toBe(true));
  });

  it("a request that was abandoned by a newer choice is not an error, even while the newer one is still loading", async () => {
    fetchMock.mockImplementation((url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        // Both requests hang; an abandoned one rejects the way fetch does when its signal fires.
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        void url;
      }),
    );
    mountDashboard();
    fireEvent.click(screen.getByRole("radio", { name: r.range.d7 }));
    await waitFor(() => expect(urls().some((u) => u.endsWith("range=7"))).toBe(true));
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: r.loading })).toBeTruthy();
  });

  it("keeps the old numbers on screen, marked busy, while a new period loads", async () => {
    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => ok(payload())).mockImplementationOnce(() => new Promise((res) => (release = res)));
    const { container } = mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    fireEvent.click(screen.getByRole("radio", { name: r.range.d90 }));
    await waitFor(() => expect(container.querySelector("[aria-busy=true]")).toBeTruthy());
    expect(screen.getByLabelText(r.kpisLabel)).toBeTruthy();
    expect(screen.getByText(r.updating)).toBeTruthy();
    release({ ok: true, status: 200, json: async () => payload({ rangeDays: 90 }) });
    await waitFor(() => expect(container.querySelector("[aria-busy=true]")).toBeNull());
  });

  it("has no control that publishes, spends or writes", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const buttonNames = screen.queryAllByRole("button").map((b) => b.textContent);
    expect(buttonNames).toEqual([]);
    for (const call of fetchMock.mock.calls) expect(call[1]?.method ?? "GET").toBe("GET");
  });
});

describe("data honesty on the page", () => {
  it("every figure tile says it is about the latest readings", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    const kpis = await screen.findByLabelText(r.kpisLabel);
    for (const label of [r.kpi.views, r.kpi.watch, r.kpi.duration]) {
      expect(label).toMatch(/latest readings/);
      expect(within(kpis).getByText(label)).toBeTruthy();
    }
  });

  it("states the rule for readings that do not count, next to the freshness", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.getByText(r.readingRules)).toBeTruthy();
    expect(r.readingRules).toMatch(/all exactly zero/);
    expect(r.readingRules).toMatch(/before the video was published/);
  });

  it("a video whose stored reading was empty says 'no data yet', and the count is explained; it is not a zero", async () => {
    const p = payload({
      kpis: { videos: 1, measured: 0, noData: 1, views: fig(null, 0, 1), watchHours: fig(null, 0, 1), likes: fig(null, 0, 1), comments: fig(null, 0, 1), avgViewSeconds: fig(null, 0, 1) },
      videos: [videoRow("vidA0000001", { reading: null, noData: true })] as ResultsPayload["videos"],
    });
    fetchMock.mockImplementation(() => ok(p));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.getByText(r.videoNoData)).toBeTruthy();
    expect(screen.getByText("1 videos have a stored reading with no data in it (every figure was zero). That counts as not measured, not as zero views.")).toBeTruthy();
    expect(within(screen.getByLabelText(r.kpisLabel)).queryByText("0")).toBeNull();
  });

  it("marks the figures as covering only the newest videos when the list was cut", async () => {
    fetchMock.mockImplementation(() => ok(payload({ truncated: { videos: true, history: false, snapshots: false } })));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    // once on the video-count tile and once as its own status line under the figures
    expect(screen.getAllByText("These figures cover the newest 200 videos only.")).toHaveLength(2);
  });

  it("warns, visibly, when some readings could not be read", async () => {
    fetchMock.mockImplementation(() => ok(payload({ truncated: { videos: false, history: false, snapshots: true } })));
    mountDashboard();
    const warn = await screen.findByText(r.snapshotsTruncated);
    expect(warn.closest("[role=status]")).toBeTruthy();
  });

  it("does not warn when nothing was cut", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.queryByText(r.snapshotsTruncated)).toBeNull();
  });
});

describe("reading age and channel choice", () => {
  it("says 'the day it was published' for day 0 and 'N days after' otherwise", async () => {
    const p = payload();
    p.videos = [videoRow("vidA0000001", { reading: reading({ daysAfterPublish: 0 }) }), videoRow("vidA0000002", { reading: reading({ daysAfterPublish: 1 }) })] as ResultsPayload["videos"];
    fetchMock.mockImplementation(() => ok(p));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    expect(screen.getByText("2026-10-24, the day it was published")).toBeTruthy();
    expect(screen.getByText("2026-10-24, 1 days after publishing")).toBeTruthy();
  });

  it("choosing 'All channels' again drops the channel from the request", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    fireEvent.change(screen.getByLabelText(r.channelLabel), { target: { value: "chanA1" } });
    await waitFor(() => expect(urls().some((u) => u.includes("channel=chanA1"))).toBe(true));
    fireEvent.change(screen.getByLabelText(r.channelLabel), { target: { value: "" } });
    await waitFor(() => expect(urls().length).toBeGreaterThanOrEqual(3));
    expect(urls()[urls().length - 1]).toBe("/api/results?range=28");
  });

  it("before the first answer the select already shows the channel the page opened on", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    mountDashboard("chanA1");
    const select = screen.getByLabelText(r.channelLabel) as HTMLSelectElement;
    expect(select.value).toBe("chanA1");
  });
});

describe("table layout and focus", () => {
  it("the table scrolls sideways inside its own wrapper, and the row header is a plain cell (no flex on a th)", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    mountDashboard();
    await screen.findByLabelText(r.kpisLabel);
    const table = screen.getByRole("table");
    expect(table.parentElement?.className).toContain("rd-scroll");
    for (const th of within(table).getAllByRole("rowheader")) {
      expect(th.className).not.toContain("rd-title");
      expect(th.querySelector(".rd-title")).toBeTruthy();
    }
    const css = (await import("node:fs")).readFileSync((await import("node:path")).join(process.cwd(), "components/results/results.css"), "utf8");
    expect(css).toMatch(/\.rd-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).not.toMatch(/\.rd-table th[^{]*\{[^}]*display:\s*flex/);
  });

  it("after Retry, focus moves to the status line instead of being lost", async () => {
    fetchMock.mockImplementationOnce(() => ok({ error: "failed" }, 502)).mockImplementation(() => new Promise(() => {}));
    mountDashboard();
    const alert = await screen.findByRole("alert");
    const retry = within(alert).getByRole("button", { name: r.retry });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(new RegExp(`^${r.rangeHint.replace("{days}", "28")}$`))));
    expect(document.activeElement?.getAttribute("role")).toBe("status");
  });

  it("another channel's numbers are not kept under a new channel after an error and a retry", async () => {
    fetchMock
      .mockImplementationOnce(() => ok(payload({ selected: "chanA1" })))
      .mockImplementationOnce(() => ok({ error: "failed" }, 502))
      .mockImplementation(() => new Promise(() => {}));
    mountDashboard("chanA1");
    await screen.findByLabelText(r.kpisLabel);
    fireEvent.change(screen.getByLabelText(r.channelLabel), { target: { value: "chanA2" } });
    const alert = await screen.findByRole("alert");
    expect(screen.queryByLabelText(r.kpisLabel)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: r.retry }));
    await waitFor(() => expect(urls().length).toBe(3));
    expect(urls()[2]).toContain("channel=chanA2");
    expect(screen.queryByLabelText(r.kpisLabel)).toBeNull();
    expect(screen.getByRole("status", { name: r.loading })).toBeTruthy();
  });

  it("switching channel clears the previous channel's numbers while the new one loads; a new period of the same channel keeps them", async () => {
    fetchMock.mockImplementationOnce(() => ok(payload({ selected: "chanA1" }))).mockImplementation(() => new Promise(() => {}));
    mountDashboard("chanA1");
    await screen.findByLabelText(r.kpisLabel);
    fireEvent.click(screen.getByRole("radio", { name: r.range.d90 }));
    await waitFor(() => expect(urls().length).toBe(2));
    expect(screen.getByLabelText(r.kpisLabel)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(r.channelLabel), { target: { value: "chanA2" } });
    await waitFor(() => expect(urls().length).toBe(3));
    expect(screen.queryByLabelText(r.kpisLabel)).toBeNull();
  });
});
