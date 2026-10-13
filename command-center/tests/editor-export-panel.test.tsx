// @vitest-environment jsdom
/**
 * The editor's export status (ExportStatusPanel + useExportPoll) with fake
 * timers and a fake fetch: queued -> rendering -> done, the clock and the
 * honest "time left unknown", a poll that backs off and stops on done, failed
 * and unmount, a failure with ONE retry however fast it is pressed, and the
 * panel's polite live region. Nothing here renders, spends or publishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { newDocForAsset, type EditorAsset, type EditorExport } from "@/lib/editor";

const te = en.editor;
const ep = te.exportPanel;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-03-01T12:00:00.000Z");

const ASSET: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const RESULT: EditorAsset = { id: B, kind: "video", name: "export.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/b", thumbUrl: null };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

type Route = (url: string, init?: RequestInit) => Promise<Response> | undefined;
let routes: Route[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
const gets = () => fetchMock.mock.calls.filter(([u, i]) => ((i as RequestInit | undefined)?.method ?? "GET") === "GET" && String(u).endsWith(PID));
const posts = () => fetchMock.mock.calls.filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith("/exports"));

/** An export as GET /api/editor/projects/:id sends it: the route has already shaped it (camelCase). */
const row = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "e1", rev: 1, status, reason: null, durationS: 10, assetId: null,
  createdAt: new Date(T0).toISOString(), finishedAt: null, ...extra,
});
/** The project the fake server returns, from whatever `state.exports` holds right now. */
const state: { exports: unknown[]; assets: Record<string, EditorAsset>; fail: boolean } = { exports: [], assets: {}, fail: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  routes = [];
  state.exports = [];
  state.assets = {};
  state.fail = false;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    if (String(url).endsWith(PID) && (init?.method ?? "GET") === "GET")
      return state.fail ? json({ error: "failed" }, 502) : json({ id: PID, rev: 1, doc: newDocForAsset(ASSET), exports: state.exports, assets: state.assets });
    return json({ error: "failed" }, 502);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(exports: EditorExport[]) {
  const ui: ReactNode = (
    <I18nProvider locale="en">
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={newDocForAsset(ASSET)!} exports={exports} assets={{ [A]: ASSET }} videos={[ASSET]} />
    </I18nProvider>
  );
  return render(ui);
}
const ex = (over: Partial<EditorExport> = {}): EditorExport => ({
  id: "e1", rev: 1, status: "queued", reason: null, durationS: 10, assetId: null,
  createdAt: new Date(T0).toISOString(), finishedAt: null, ...over,
});
const panel = () => document.querySelector("[data-export-state]") as HTMLElement;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const live = () => panel().querySelector('[role="status"]') as HTMLElement;

describe("export status", () => {
  it("queued -> rendering -> done: words, clock, 'time left unknown', then the video", async () => {
    mount([ex()]);
    await tick(1);
    expect(panel().getAttribute("data-export-state")).toBe("queued");
    expect(live().textContent).toContain(te.exportStatus.queued);
    expect(panel().textContent).toContain(ep.timeLeft);
    expect(panel().textContent).toContain(fmt(ep.elapsed, { time: "0:00" }));

    // The clock moves every second but is not inside the live region.
    await tick(3000);
    expect(panel().textContent).toContain(fmt(ep.elapsed, { time: "0:03" }));
    expect(live().textContent).not.toMatch(/\d:\d\d/);

    state.exports = [row("rendering")];
    await tick(1100); // first poll at 4 s
    expect(panel().getAttribute("data-export-state")).toBe("rendering");
    expect(live().textContent).toContain(te.exportStatus.rendering);
    expect(panel().textContent).toContain(ep.timeLeft);
    expect(panel().querySelector('a[href="/v/b"]')).toBeNull();

    state.exports = [row("done", { assetId: B, finishedAt: new Date(T0 + 83_000).toISOString() })];
    state.assets = { [B]: RESULT };
    await tick(4100);
    expect(panel().getAttribute("data-export-state")).toBe("done");
    expect(live().textContent).toContain(te.exportStatus.done);
    expect(panel().textContent).not.toContain(ep.timeLeft);
    expect(panel().textContent).toContain(fmt(ep.tookLabel, { time: "1:23" }));
    const open = screen.getByRole("link", { name: new RegExp(ep.openVideo) });
    expect(open.getAttribute("href")).toBe("/v/b");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link", { name: te.viewInLibrary }).getAttribute("href")).toBe("/chronos/library");

    // Done: the poll has stopped.
    const n = gets().length;
    await tick(120_000);
    expect(gets().length).toBe(n);
  });

  it("the poll waits longer while nothing changes, and starts over when something does", async () => {
    mount([ex()]);
    state.exports = [row("queued")];
    const at: number[] = [];
    fetchMock.mockImplementation(((url: string, init?: RequestInit) => {
      if (String(url).endsWith(PID) && (init?.method ?? "GET") === "GET") {
        at.push(Date.now() - T0);
        return json({ id: PID, rev: 1, doc: newDocForAsset(ASSET), exports: state.exports, assets: {} });
      }
      return json({ error: "failed" }, 502);
    }) as never);
    await tick(70_000);
    // 1st poll sees a new signature (wait resets to 4 s), then the same status: 6, 9, 13, 20, 20 s later.
    expect(at).toEqual([4000, 8000, 14000, 23000, 36000, 56000]);
    state.exports = [row("rendering")];
    await tick(20_000);
    // The poll at 76 s sees the change, so the next waits are 4 s and then 6 s again.
    expect(at.slice(6, 9)).toEqual([76000, 80000, 86000]);
  });

  it("stops polling when the editor goes away", async () => {
    const { unmount } = mount([ex()]);
    await tick(4100);
    expect(gets().length).toBe(1);
    unmount();
    await tick(120_000);
    expect(gets().length).toBe(1);
  });

  it("an answer that arrives after the editor is gone changes nothing and does not throw", async () => {
    let release: () => void = () => {};
    fetchMock.mockImplementation(((url: string, init?: RequestInit) =>
      String(url).endsWith(PID) && (init?.method ?? "GET") === "GET"
        ? new Promise<Response>((res) => {
            release = () => res(new Response(JSON.stringify({ id: PID, rev: 1, doc: newDocForAsset(ASSET), exports: [row("done", { assetId: B })], assets: { [B]: RESULT } }), { status: 200 }));
          })
        : json({ error: "failed" }, 502)) as never);
    const { unmount } = mount([ex()]);
    await tick(4100);
    unmount();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(gets().length).toBe(1);
  });

  it("does not ask while the tab is hidden and asks at once when it is back", async () => {
    mount([ex()]);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await tick(30_000);
    expect(gets().length).toBe(0);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(gets().length).toBe(1);
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  it("when checks keep failing it says so, offers Check now, and recovers quietly", async () => {
    mount([ex()]);
    state.fail = true;
    await tick(4100);
    expect(screen.queryByText(ep.checkFailed)).toBeNull(); // one blip is not news
    await tick(6100);
    expect(screen.getByText(ep.checkFailed)).toBeTruthy();
    // Still shows the last known state with its honest clock.
    expect(panel().getAttribute("data-export-state")).toBe("queued");
    state.fail = false;
    state.exports = [row("rendering")];
    fireEvent.click(screen.getByRole("button", { name: ep.checkNow }));
    await tick(10);
    expect(panel().getAttribute("data-export-state")).toBe("rendering");
    expect(screen.queryByText(ep.checkFailed)).toBeNull();
  });

  it("a failed export reads as a sentence; Try again starts exactly one export, however fast it is pressed", async () => {
    routes.push((url, init) => (url.endsWith("/exports") && init?.method === "POST" ? json({ id: "e2", status: "queued" }, 201) : undefined));
    mount([ex({ status: "failed", reason: "render_failed", finishedAt: new Date(T0 + 9000).toISOString() })]);
    expect(panel().getAttribute("data-export-state")).toBe("failed");
    expect(live().textContent).toContain(te.exportReasons.render_failed);
    expect(live().textContent).toContain(ep.failedLine);
    const retry = screen.getByRole("button", { name: ep.retry });
    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(retry);
    await tick(10);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ rev: 1 });
    expect(panel().getAttribute("data-export-state")).toBe("queued");
    // While it runs there is no retry to press, and the main button is held too.
    expect(screen.queryByRole("button", { name: ep.retry })).toBeNull();
    expect(screen.getByRole("button", { name: te.export })).toHaveProperty("disabled", true);
    // The failed one is kept in the history below.
    expect(screen.getAllByText(te.exportReasons.render_failed)).toHaveLength(1);
  });

  it("a refused retry (the server says one is already running) reads as a sentence and is not repeated", async () => {
    routes.push((url, init) => (url.endsWith("/exports") && init?.method === "POST" ? json({ error: "export_in_progress" }, 409) : undefined));
    mount([ex({ status: "failed", reason: "worker_lost" })]);
    fireEvent.click(screen.getByRole("button", { name: ep.retry }));
    await tick(10);
    expect(screen.getByRole("alert").textContent).toContain(te.errors.export_in_progress);
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: ep.retry })).toHaveProperty("disabled", false);
  });

  it("no retry for a failure the edit itself causes: it says what to change instead", () => {
    mount([ex({ status: "failed", reason: "asset_unavailable" })]);
    expect(screen.queryByRole("button", { name: ep.retry })).toBeNull();
    expect(screen.getByText(ep.fixFirst)).toBeTruthy();
    expect(live().textContent).toContain(te.exportReasons.asset_unavailable);
  });

  it("unsaved changes hold the retry and say why; an older version is named", () => {
    mount([ex({ status: "failed", reason: "timed_out" })]);
    fireEvent.click(screen.getByRole("radio", { name: "2×" }));
    const retry = screen.getByRole("button", { name: ep.retry });
    expect(retry).toHaveProperty("disabled", true);
    expect(retry.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(ep.retryNeedsSave)).toBeTruthy();
    cleanup();
    mount([ex({ status: "failed", reason: "timed_out", rev: 0 })]);
    expect(screen.getByText(fmt(ep.retryOtherVersion, { rev: 1 }))).toBeTruthy();
  });

  it("done without a preview link says so and can fetch one", async () => {
    mount([ex({ status: "done", assetId: B, finishedAt: new Date(T0 + 5000).toISOString() })]);
    expect(screen.getByText(ep.noLink)).toBeTruthy();
    state.exports = [row("done", { assetId: B })];
    state.assets = { [B]: RESULT };
    fireEvent.click(screen.getByRole("button", { name: ep.getLink }));
    await tick(10);
    expect(screen.getByRole("link", { name: new RegExp(ep.openVideo) }).getAttribute("href")).toBe("/v/b");
  });

  it("the live region is polite and announces only what changed", () => {
    mount([ex({ status: "rendering" })]);
    const r = live();
    expect(r.getAttribute("aria-live")).toBe("polite");
    expect(r.getAttribute("aria-atomic")).toBe("false");
    expect(panel().querySelectorAll("[aria-live]")).toHaveLength(1);
  });
});
