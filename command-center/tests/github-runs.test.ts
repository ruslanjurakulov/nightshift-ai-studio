/**
 * GitHub's status of a dispatched Run now (lib/server/github-runs.ts). What would break without these: another channel's run shown
 * as this one, a failed read shown as "queued", a run id or URL reaching the browser, or every 6-second poll costing GitHub calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/server/fetch-timeout", () => ({ fetchWithTimeout: (...a: unknown[]) => h.fetch(...a) }));
vi.stubEnv("GITHUB_SECRETS_TOKEN", "t");
vi.stubEnv("GITHUB_SECRETS_REPO", "o/r");
const { dispatchedRunStatus, clearRunStatusCache } = await import("../lib/server/github-runs");

const CH = "ch-alpha";
const OTHER = "ch-beta";
const AT = Date.parse("2026-11-21T10:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const runs = (...xs: { id: number; created_at: string }[]) => json({ workflow_runs: xs });
const jobs = (...xs: { name: string; status: string; conclusion?: string | null }[]) => json({ jobs: xs });

beforeEach(() => {
  h.fetch.mockReset();
  clearRunStatusCache();
});

describe("the dispatched run's status", () => {
  it("finds the run by its make-video job for this channel, skipping another channel's run", async () => {
    h.fetch
      .mockResolvedValueOnce(runs({ id: 1, created_at: "2026-11-21T10:00:02Z" }, { id: 2, created_at: "2026-11-21T10:00:03Z" }))
      .mockResolvedValueOnce(jobs({ name: "resolve", status: "completed", conclusion: "success" }, { name: `make-video (${OTHER})`, status: "in_progress" }))
      .mockResolvedValueOnce(jobs({ name: "resolve", status: "completed", conclusion: "success" }, { name: `make-video (${CH})`, status: "completed", conclusion: "failure" }));
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "completed", conclusion: "failure" });
    const urls = h.fetch.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/actions/workflows/daily_video.yml/runs?event=workflow_dispatch");
    expect(urls[1]).toContain("/actions/runs/1/jobs");
  });

  it("only another channel's run, or one still resolving, is not_seen: never a guess", async () => {
    h.fetch
      .mockResolvedValueOnce(runs({ id: 1, created_at: "2026-11-21T10:00:02Z" }))
      .mockResolvedValueOnce(jobs({ name: "resolve", status: "in_progress" }));
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "not_seen" });
  });

  it("a run created long after the dispatch is not this one", async () => {
    h.fetch.mockResolvedValueOnce(runs({ id: 9, created_at: "2026-11-21T11:00:00Z" }));
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "not_seen" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("a failed or dropped read is null (not known), never queued", async () => {
    h.fetch.mockResolvedValueOnce(json({ message: "Bad credentials" }, 401));
    expect(await dispatchedRunStatus(CH, AT)).toBeNull();
    clearRunStatusCache();
    h.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await dispatchedRunStatus(CH, AT)).toBeNull();
    clearRunStatusCache();
    h.fetch.mockResolvedValueOnce(runs({ id: 1, created_at: "2026-11-21T10:00:02Z" })).mockResolvedValueOnce(json({}, 502));
    expect(await dispatchedRunStatus(CH, AT)).toBeNull();
  });

  it("answers only status words: no id, URL or log of GitHub's", async () => {
    h.fetch
      .mockResolvedValueOnce(runs({ id: 7, created_at: "2026-11-21T10:00:02Z" }))
      .mockResolvedValueOnce(json({ jobs: [{ name: `make-video (${CH})`, status: "queued", id: 77, html_url: "https://github.com/o/r/actions/runs/7", run_url: "x" }] }));
    const s = await dispatchedRunStatus(CH, AT);
    expect(s).toEqual({ state: "queued" });
    expect(JSON.stringify(s)).not.toMatch(/github|77|o\/r/);
  });

  it("asks GitHub at most once per 30 s for the same run, however often the view polls", async () => {
    h.fetch.mockImplementation(async (u: string) => (String(u).includes("/jobs") ? jobs({ name: `make-video (${CH})`, status: "in_progress" }) : runs({ id: 1, created_at: "2026-11-21T10:00:02Z" })));
    for (let i = 0; i < 5; i++) expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "in_progress" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("which run is this dispatch's (Lens, Breach)", () => {
  it("asks GitHub for a closed time range, so newer dispatches cannot push this run off the page", async () => {
    h.fetch.mockResolvedValueOnce(runs());
    await dispatchedRunStatus(CH, AT);
    const url = decodeURIComponent(String(h.fetch.mock.calls[0][0]));
    expect(url).toMatch(/created=2026-11-21T09:59:30Z\.\.2026-11-21T10:10:00Z/);
  });

  it("an earlier dispatch of the same channel (a minute before) is never this one", async () => {
    h.fetch.mockResolvedValueOnce(runs({ id: 1, created_at: "2026-11-21T09:58:30Z" }));
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "not_seen" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("while this run is still resolving, a later dispatch of the same channel does not answer for it", async () => {
    h.fetch
      .mockResolvedValueOnce(runs({ id: 1, created_at: "2026-11-21T10:00:02Z" }, { id: 2, created_at: "2026-11-21T10:03:00Z" }))
      .mockResolvedValueOnce(jobs({ name: "resolve", status: "in_progress" }))
      .mockResolvedValueOnce(jobs({ name: `make-video (${CH})`, status: "completed", conclusion: "success" }));
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "not_seen" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("a found run is pinned: later reads ask only for its jobs", async () => {
    vi.useFakeTimers({ now: AT + 60_000 });
    h.fetch
      .mockResolvedValueOnce(runs({ id: 5, created_at: "2026-11-21T10:00:02Z" }))
      .mockResolvedValueOnce(jobs({ name: `make-video (${CH})`, status: "in_progress" }))
      .mockResolvedValueOnce(jobs({ name: `make-video (${CH})`, status: "completed", conclusion: "success" }));
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "in_progress" });
    vi.setSystemTime(AT + 120_000);
    expect(await dispatchedRunStatus(CH, AT)).toEqual({ state: "completed", conclusion: "success" });
    expect(String(h.fetch.mock.calls[2][0])).toContain("/actions/runs/5/jobs");
    expect(h.fetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("the shared token's quota (Breach 4, Lens)", () => {
  it("a since that differs by milliseconds is the same read", async () => {
    h.fetch.mockResolvedValue(runs());
    await dispatchedRunStatus(CH, AT);
    await dispatchedRunStatus(CH, AT + 7);
    await dispatchedRunStatus(CH, AT + 999);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("the person's rate limit is charged before an uncached read, and a refusal asks GitHub nothing", async () => {
    const mayAsk = vi.fn(async () => false);
    expect(await dispatchedRunStatus(CH, AT, mayAsk)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(mayAsk).toHaveBeenCalledTimes(1);
  });

  it("past the process budget GitHub is not asked and the answer is not known", async () => {
    h.fetch.mockImplementation(async () => runs());
    for (let i = 0; i < 40; i++) await dispatchedRunStatus(`ch-${i}`, AT);
    expect(h.fetch).toHaveBeenCalledTimes(30);
    expect(await dispatchedRunStatus("ch-late", AT)).toBeNull();
  });
});
