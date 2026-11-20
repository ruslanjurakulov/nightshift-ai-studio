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
import { useEffect, useState, type ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { useExportPoll } from "@/components/editor/useExportPoll";
import type { ProjectSnapshot } from "@/components/editor/editorApi";
import { ExportStatusPanel } from "@/components/editor/ExportStatusPanel";
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
    // Preview and the original are two addresses (S2): the preview opens in a tab, the original is its own button.
    const open = screen.getByRole("link", { name: new RegExp(en.assetDownload.preview) });
    expect(open.getAttribute("href")).toBe(`/api/library/${B}/download?variant=preview`);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("button", { name: /Download original/ })).toBeTruthy();
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
    expect(screen.getByText(fmt(ep.fixFirst, { export: te.export }))).toBeTruthy();
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
    expect(panel().getAttribute("data-export-state")).toBe("done");
    expect(live().textContent).toContain(ep.linkPending);
    expect(live().textContent).toContain(ep.linkPendingLine);
    expect(live().textContent).not.toContain(te.exportStatus.done);
    expect(live().textContent).not.toContain(ep.doneLine);
    expect(screen.queryByRole("link", { name: new RegExp(en.assetDownload.preview) })).toBeNull();
    expect(screen.getByText(ep.noLink)).toBeTruthy();
    state.exports = [row("done", { assetId: B })];
    state.assets = { [B]: RESULT };
    fireEvent.click(screen.getByRole("button", { name: ep.getLink }));
    await tick(10);
    expect(screen.getByRole("link", { name: new RegExp(en.assetDownload.preview) }).getAttribute("href")).toBe(`/api/library/${B}/download?variant=preview`);
    expect(live().textContent).toContain(te.exportStatus.done);
    expect(live().textContent).toContain(ep.doneLine);
    expect(live().textContent).not.toContain(ep.linkPendingLine);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("older exports get their own 'Earlier exports' section only when there are older ones", () => {
    mount([ex()]);
    expect(screen.queryByText(te.exports)).toBeNull();
    cleanup();
    mount([ex({ id: "e2" }), ex({ id: "e1", status: "failed", reason: "worker_lost" })]);
    expect(screen.getByRole("heading", { name: te.exports })).toBeTruthy();
    expect(te.exports).toBe("Earlier exports");
  });

  it("the live region is polite and announces only what changed", () => {
    mount([ex({ status: "rendering" })]);
    const r = live();
    expect(r.getAttribute("aria-live")).toBe("polite");
    expect(r.getAttribute("aria-atomic")).toBe("false");
    expect(panel().querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("signed out on the first poll: it stops at once and says to sign in, no clock, no useless Check now", async () => {
    fetchMock.mockImplementation(((url: string, init?: RequestInit) =>
      String(url).endsWith(PID) && (init?.method ?? "GET") === "GET" ? json({ error: "unauthorized" }, 401) : json({ error: "failed" }, 502)) as never);
    mount([ex()]);
    await tick(1500);
    expect(live().textContent).not.toContain(ep.signedOut);
    await tick(3000); // first poll at 4 s
    expect(live().textContent).toContain(ep.signedOut);
    expect(panel().textContent).not.toContain(ep.timeLeft);
    expect(screen.queryByRole("button", { name: ep.checkNow })).toBeNull();
    expect(screen.queryByText(ep.checkFailed)).toBeNull();
    const n = gets().length;
    await tick(120_000);
    expect(gets().length).toBe(n); // and it does not keep asking
  });

  it("project gone on a later poll: it says so (not just 'could not check') and stops", async () => {
    mount([ex()]);
    state.exports = [row("rendering")];
    await tick(4100);
    expect(panel().getAttribute("data-export-state")).toBe("rendering");
    fetchMock.mockImplementation(((url: string, init?: RequestInit) =>
      String(url).endsWith(PID) && (init?.method ?? "GET") === "GET" ? json({ error: "not_found" }, 404) : json({ error: "failed" }, 502)) as never);
    await tick(4100);
    expect(live().textContent).toContain(ep.notFound);
    expect(live().textContent).not.toContain(ep.signedOut);
    expect(screen.queryByRole("button", { name: ep.checkNow })).toBeNull();
    const n = gets().length;
    await tick(120_000);
    expect(gets().length).toBe(n);
  });

  it("an edit-caused failure offers the retry again once a newer version is saved, and says which version", () => {
    mount([ex({ status: "failed", reason: "asset_unavailable", rev: 0 })]);
    expect(screen.getByRole("button", { name: ep.retry })).toHaveProperty("disabled", false);
    expect(screen.getByText(fmt(ep.retryOtherVersion, { rev: 1 }))).toBeTruthy();
    expect(screen.queryByText(fmt(ep.fixFirst, { export: te.export }))).toBeNull();
  });

  it("a deleted project gets its own sentence, never the 'change the edit' one, even on another version", () => {
    mount([ex({ status: "failed", reason: "project_deleted", rev: 0 })]);
    expect(screen.queryByRole("button", { name: ep.retry })).toBeNull();
    expect(screen.getByText(ep.deletedLine)).toBeTruthy();
    expect(screen.queryByText(fmt(ep.fixFirst, { export: te.export }))).toBeNull();
  });

  it("after Try again the keyboard stays in the panel (not on <body>)", async () => {
    routes.push((url, init) => (url.endsWith("/exports") && init?.method === "POST" ? json({ id: "e2", status: "queued" }, 201) : undefined));
    mount([ex({ status: "failed", reason: "render_failed" })]);
    const retry = screen.getByRole("button", { name: ep.retry });
    retry.focus();
    fireEvent.click(retry);
    await tick(10);
    expect(panel().getAttribute("data-export-state")).toBe("queued");
    expect(document.activeElement).toBe(panel());
    expect(panel().getAttribute("tabindex")).toBe("-1");
  });

  it("a refused retry is shown inside the panel's one live region and the button gets the keyboard back", async () => {
    routes.push((url, init) => (url.endsWith("/exports") && init?.method === "POST" ? json({ error: "daily_limit" }, 429) : undefined));
    mount([ex({ status: "failed", reason: "worker_lost" })]);
    fireEvent.click(screen.getByRole("button", { name: ep.retry }));
    await tick(10);
    expect(live().textContent).toContain(te.errors.daily_limit);
    expect(panel().querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: ep.retry }));
    expect(posts()).toHaveLength(1);
  });
});

/** The poll hook on its own: an older answer never overwrites a newer one. */
function Probe({ active }: { active: boolean }) {
  const [seen, setSeen] = useState("none");
  const p = useExportPoll({ projectId: PID, active, onSnapshot: (s) => setSeen(s.exports.map((e) => e.status).join(",")) });
  return (
    <div>
      <button onClick={() => void p.checkNow()}>go</button>
      <output role="status">{seen}</output>
      <i>{p.checking ? "checking" : "idle"}</i>
    </div>
  );
}
const snapshot = (status: string) => new Response(JSON.stringify({ id: PID, rev: 1, doc: newDocForAsset(ASSET), exports: [row(status)], assets: {} }), { status: 200 });

describe("poll answers arrive out of order", () => {
  it("does not apply Job A's delayed preview read to Job B after a project switch", async () => {
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const jobA = ex({ id: "job-a", status: "done", assetId: A });
    const jobB = ex({ id: "job-b", status: "done", assetId: B });
    let finishA!: (response: Response) => void;
    const pendingA = new Promise<Response>((resolve) => { finishA = resolve; });
    const unexpected: string[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === `/api/editor/projects/${PID}` && (init?.method ?? "GET") === "GET") return pendingA;
      unexpected.push(`${init?.method ?? "GET"} ${url}`);
      return json({ error: "failed" }, 502);
    });
    function SwitchedPanel({ projectId, job }: { projectId: string; job: EditorExport }) {
      const [latest, setLatest] = useState(job);
      const [assets, setAssets] = useState<Record<string, EditorAsset>>({ [B]: RESULT });
      useEffect(() => { setLatest(job); }, [job]);
      const poll = useExportPoll({ projectId, active: false, onSnapshot: (snapshot) => {
        setLatest(snapshot.exports[0]);
        setAssets((previous) => ({ ...previous, ...snapshot.assets }));
      } });
      return <ExportStatusPanel latest={latest} assets={assets} currentRev={1} dirty={false} busy={false}
        failing={poll.failing} halt={poll.halt} checking={poll.checking}
        onRetry={() => { throw new Error("No render permitted in stale-read fixture"); }} onCheckNow={poll.checkNow} />;
    }
    const { rerender } = render(<I18nProvider locale="en"><SwitchedPanel projectId={PID} job={jobA} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: ep.getLink }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<I18nProvider locale="en"><SwitchedPanel projectId={projectB} job={jobB} /></I18nProvider>);
    expect(screen.getByRole("link", { name: new RegExp(en.assetDownload.preview) }).getAttribute("href")).toBe(`/api/library/${B}/download?variant=preview`);
    await act(async () => {
      finishA(await json({ id: PID, rev: 1, doc: newDocForAsset(ASSET), exports: [row("done", { id: jobA.id, assetId: A })], assets: { [A]: ASSET } }));
    });
    expect(screen.getByRole("link", { name: new RegExp(en.assetDownload.preview) }).getAttribute("href")).toBe(`/api/library/${B}/download?variant=preview`);
    expect(panel().querySelector(`a[href*="${A}"]`)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unexpected).toEqual([]);
  });

  it("a slow Check now (asked first) does not overwrite the newer one", async () => {
    const waiting: ((r: Response) => void)[] = [];
    fetchMock.mockImplementation(((url: string, init?: RequestInit) => {
      if (!(String(url).endsWith(PID) && (init?.method ?? "GET") === "GET")) return json({}, 502);
      return waiting.length === 0 ? new Promise<Response>((res) => waiting.push(res)) : Promise.resolve(snapshot("done"));
    }) as never);
    render(<I18nProvider locale="en"><Probe active={false} /></I18nProvider>);
    fireEvent.click(screen.getByText("go")); // older, slow
    fireEvent.click(screen.getByText("go")); // newer, fast
    await tick(10);
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("done");
    await act(async () => { waiting[0](snapshot("queued")); await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("done");
    expect(document.querySelector("i")!.textContent).toBe("idle");
  });

  it("a slow poll answer does not overwrite a newer Check now", async () => {
    const waiting: ((r: Response) => void)[] = [];
    fetchMock.mockImplementation(((url: string, init?: RequestInit) => {
      if (!(String(url).endsWith(PID) && (init?.method ?? "GET") === "GET")) return json({}, 502);
      return waiting.length === 0 ? new Promise<Response>((res) => waiting.push(res)) : Promise.resolve(snapshot("rendering"));
    }) as never);
    render(<I18nProvider locale="en"><Probe active /></I18nProvider>);
    await tick(4100); // the poll asks and waits
    expect(waiting).toHaveLength(1);
    fireEvent.click(screen.getByText("go")); // newer, answered at once
    await tick(10);
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("rendering");
    await act(async () => { waiting[0](snapshot("queued")); await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("rendering");
  });
});

/** Manual reads have a project lifetime even when no export is being polled. */
function ScopedReadProbe({ projectId, active = false, onSnapshot }: { projectId: string; active?: boolean; onSnapshot?: (s: ProjectSnapshot) => void }) {
  const [seen, setSeen] = useState("none");
  const p = useExportPoll({ projectId, active, onSnapshot: s => { onSnapshot?.(s); setSeen(s.exports[0].id); } });
  return <div>
    <button onClick={() => void p.checkNow()}>read scope</button>
    <output data-testid="scope-seen">{seen}</output>
    <output data-testid="scope-checking">{p.checking ? "checking" : "idle"}</output>
    <output data-testid="scope-halt">{p.halt ?? "none"}</output>
  </div>;
}
const scopeAnswer = (projectId: string, job: string) => json({ id: projectId, rev: 1,
  doc: newDocForAsset(ASSET), exports: [row("done", { id: job, assetId: B })], assets: { [B]: RESULT } });

describe("manual export read scope lifetime", () => {
  it("an in-flight automatic poll cannot apply after the project scope is left", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const { rerender } = render(<ScopedReadProbe projectId={PID} active />);
    await tick(4100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<ScopedReadProbe projectId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />);
    await act(async () => { finish(await scopeAnswer(PID, "old-poll-a")); });
    expect(screen.getByTestId("scope-seen").textContent).toBe("none");
    expect(screen.getByTestId("scope-checking").textContent).toBe("idle");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("revisiting A creates a new read scope and old A cannot clear its pending read", async () => {
    const waiting: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => waiting.push(resolve)));
    const { rerender } = render(<ScopedReadProbe projectId={PID} />);
    fireEvent.click(screen.getByText("read scope"));
    expect(screen.getByTestId("scope-checking").textContent).toBe("checking");
    rerender(<ScopedReadProbe projectId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />);
    expect(screen.getByTestId("scope-checking").textContent).toBe("idle");
    rerender(<ScopedReadProbe projectId={PID} />);
    fireEvent.click(screen.getByText("read scope"));
    expect(waiting).toHaveLength(2);
    await act(async () => { waiting[0](await scopeAnswer(PID, "old-a")); });
    expect(screen.getByTestId("scope-seen").textContent).toBe("none");
    expect(screen.getByTestId("scope-checking").textContent).toBe("checking");
    await act(async () => { waiting[1](await scopeAnswer(PID, "current-a")); });
    expect(screen.getByTestId("scope-seen").textContent).toBe("current-a");
    expect(screen.getByTestId("scope-checking").textContent).toBe("idle");
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("an old project's failed read cannot halt or mark the new project as checking", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const { rerender } = render(<ScopedReadProbe projectId={PID} />);
    fireEvent.click(screen.getByText("read scope"));
    rerender(<ScopedReadProbe projectId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />);
    await act(async () => { finish(await json({ error: "not_found" }, 404)); });
    expect(screen.getByTestId("scope-halt").textContent).toBe("none");
    expect(screen.getByTestId("scope-checking").textContent).toBe("idle");
    expect(screen.getByTestId("scope-seen").textContent).toBe("none");
  });

  it("a pending manual read cannot apply its snapshot after unmount", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const onSnapshot = vi.fn();
    const { unmount } = render(<ScopedReadProbe projectId={PID} onSnapshot={onSnapshot} />);
    fireEvent.click(screen.getByText("read scope"));
    unmount();
    await act(async () => { finish(await scopeAnswer(PID, "unmounted-a")); });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
