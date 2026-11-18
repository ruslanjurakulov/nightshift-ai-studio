// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { JobFeed } from "@/components/studio/JobFeed";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { DISMISSED_KEY } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const row = (over: Record<string, unknown>) => ({
  id: "j",
  capability: "t2i",
  status: "completed",
  requested_model: "pic-1",
  params: { prompt: "a lighthouse at dawn" },
  quoted_credits: 4,
  charged_credits: 4,
  error_code: null,
  result: null,
  result_asset_ids: [],
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("JobFeed", () => {
  it("invites the first generation when there are none, and does not poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockImplementation(() => json({ jobs: [] }));
    render(withI18n(<JobFeed orgId={ORG} />));
    await screen.findByText(t.gen.empty);
    expect(fetchMock).toHaveBeenCalledWith(`/api/creative/jobs?org_id=${ORG}`, expect.anything());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows held / charged / returned, a failed card's reason, and polls only while active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      return json({
        jobs: [
          row({ id: "a", status: call === 1 ? "running" : "completed", capability: "t2v", requested_model: "vid-1", quoted_credits: 20, charged_credits: call === 1 ? null : 18 }),
          row({ id: "b", status: "failed", error_code: "policy", charged_credits: null }),
          row({ id: "c" }),
        ],
      });
    });
    const onRetry = vi.fn();
    render(withI18n(<JobFeed orgId={ORG} models={[{ id: "pic-1", displayName: "Picture One", capabilities: ["t2i"], beta: false }]} onRetry={onRetry} />));

    await screen.findByText("held 20 credits");
    expect(screen.getByText(t.gen.returned)).toBeTruthy();
    expect(screen.getByText(new RegExp(t.gen.reasons.policy.slice(0, 20)))).toBeTruthy();
    expect(screen.getAllByText("Picture One").length).toBe(2);
    expect(screen.getByText("vid-1")).toBeTruthy(); // no display name known: the id
    expect(screen.getByRole("link", { name: t.gen.openLibrary }).getAttribute("href")).toBe("/chronos/library");

    // One active job: the feed polls, sees it finish, then stops.
    await vi.advanceTimersByTimeAsync(5_100);
    await screen.findByText("charged 18 credits");
    const after = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock.mock.calls.length).toBe(after);

    fireEvent.click(screen.getByRole("button", { name: t.gen.tryAgain }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ capability: "t2i", model: "pic-1", prompt: "a lighthouse at dawn" }));
    expect(fetchMock.mock.calls.length).toBe(after); // Try again spends nothing

    fireEvent.click(screen.getByRole("button", { name: t.gen.dismiss }));
    await waitFor(() => expect(screen.queryByText(t.gen.returned)).toBeNull());
    expect(JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]")).toEqual(["b"]);
  });

  it("cancels a queued job through the cancel route", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ job: {}, already: false }) : json({ jobs: [row({ id: "q", status: "queued" })] }),
    );
    render(withI18n(<JobFeed orgId={ORG} />));
    fireEvent.click(await screen.findByRole("button", { name: t.gen.cancel }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/creative/jobs/q", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "cancel" }) })),
    );
  });

  it("says generations are not switched on when 0036 is missing", async () => {
    fetchMock.mockImplementation(() => json({ error: "creative_unavailable" }, 503));
    render(withI18n(<JobFeed orgId={ORG} />));
    await screen.findByText(t.gen.unavailable);
  });

  it("retries a failed first feed read explicitly without creating a job", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const jobsUrl = `/api/creative/jobs?org_id=${ORG}`;
    const running = row({ id: "first-read-running", status: "running", charged_credits: null });
    const privateReadUrl = "https://example.invalid/synthetic-read?marker=fixture-only";
    const unexpected: string[] = [];
    let reads = 0;
    let finishRead!: (response: Response) => void;
    const retryRead = new Promise<Response>((resolve) => { finishRead = resolve; });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === jobsUrl && (init?.method ?? "GET") === "GET") {
        reads += 1;
        if (reads === 1) return Promise.reject(new Error(`Synthetic transient read error: ${privateReadUrl}`));
        // A read-only retry could recover this same job; no render needs creating.
        return reads === 2 ? retryRead : json({ jobs: [running] });
      }
      unexpected.push(`${init?.method ?? "GET"} ${url}`);
      return Promise.reject(new Error("Unexpected request in first-read observation"));
    });
    const onRetry = vi.fn();
    render(withI18n(<JobFeed orgId={ORG} onRetry={onRetry} />));
    await screen.findByText(t.gen.loadFailed);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads).toBe(1);
    expect(screen.getByText(t.gen.loadFailed)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Reload generations" });
    fireEvent.click(retry);
    await waitFor(() => expect(reads).toBe(2));
    expect((screen.getByRole("button", { name: t.gen.feedLoading }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    expect(reads).toBe(2);
    await act(async () => { finishRead(await json({ jobs: [running] })); });
    await waitFor(() => expect(document.querySelector('[data-status="running"]')).not.toBeNull());
    expect(screen.queryByText(t.gen.loadFailed)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload generations" })).toBeNull();
    // Once the same running job is known, only the existing five-second poll resumes.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(reads).toBe(3);
    expect(document.querySelector('[data-status="running"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(privateReadUrl);
    expect(document.body.textContent).not.toContain("fixture-only");
    expect(onRetry).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET")).toHaveLength(0);
    expect(unexpected).toEqual([]);
  });
  it("shows failed readback after cancellation acknowledgement and stops polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const credits = await import("@/lib/credits-live");
    const refresh = vi.spyOn(credits, "refreshCredits").mockResolvedValue(undefined);
    const jobsUrl = `/api/creative/jobs?org_id=${ORG}`;
    const queued = row({ id: "failed-after-cancel", status: "queued", charged_credits: null });
    let acknowledged = false;
    const unexpected: string[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === jobsUrl && !init?.method)
        return json({ jobs: [{ ...queued, status: acknowledged ? "failed" : "queued", error_code: acknowledged ? "policy" : null }] });
      if (url === `/api/creative/jobs/${queued.id}` && init?.method === "POST") {
        acknowledged = true;
        // The acknowledgement must not override the terminal state from the following read.
        return json({ job: { ...queued, status: "cancelled" }, already: false });
      }
      unexpected.push(`${init?.method ?? "GET"} ${url}`);
      return Promise.reject(new Error("Unexpected request in failed-after-cancel fixture"));
    });
    try {
      const { container } = render(withI18n(<JobFeed orgId={ORG} />));
      fireEvent.click(await screen.findByRole("button", { name: t.gen.cancel }));
      await screen.findByText(new RegExp(t.gen.reasons.policy.slice(0, 20)));
      expect(container.querySelector('[data-status="failed"]')).not.toBeNull();
      expect(container.querySelector('[data-status="cancelled"]')).toBeNull();
      expect(screen.queryByText(t.gen.status.cancelled)).toBeNull();
      expect(screen.queryByRole("button", { name: t.gen.cancel })).toBeNull();
      const reads = () => fetchMock.mock.calls.filter(([url, init]) => url === jobsUrl && !init?.method).length;
      expect(reads()).toBe(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(reads()).toBe(2);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(unexpected).toEqual([]);
    } finally {
      refresh.mockRestore();
    }
  });


});

describe("GeneratePanel", () => {
  const models = [{ id: "pic-1", displayName: "Picture One", capabilities: ["t2i"], beta: false }];

  it("quotes after typing, shows the price on the button, and confirms exactly that price", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/api/creative/quote" ? json({ quote: { credits: 3 } }) : json({ job: { id: "x" }, replay: false }, 201),
    );
    const onCreated = vi.fn();
    render(withI18n(<GeneratePanel orgId={ORG} models={models} onCreated={onCreated} />));
    const button = screen.getByRole("button", { name: t.gen.generate }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(t.gen.promptPh.t2i), { target: { value: "a cat" } });
    const priced = (await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 })) as HTMLButtonElement;
    expect(priced.disabled).toBe(false);
    fireEvent.click(priced);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const create = fetchMock.mock.calls.find(([u]) => u === "/api/creative/jobs")!;
    const body = JSON.parse(create[1].body);
    expect(body).toMatchObject({ org_id: ORG, capability: "t2i", model: "pic-1", max_credits: 3, params: { prompt: "a cat", aspect_ratio: "16:9" } });
    expect(typeof body.idempotency_key).toBe("string");
  });

  it("links to Credits when there are not enough", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/api/creative/quote" ? json({ quote: { credits: 3 } }) : json({ error: "insufficient_credits" }, 402),
    );
    render(withI18n(<GeneratePanel orgId={ORG} models={models} />));
    fireEvent.change(screen.getByPlaceholderText(t.gen.promptPh.t2i), { target: { value: "a cat" } });
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 }));
    expect((await screen.findByRole("link", { name: t.gen.addCredits })).getAttribute("href")).toBe("/chronos/credits");
  });

  it("shows nothing to pick when no model can make the kind", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[]} />));
    expect(screen.getByText(t.gen.noModels)).toBeTruthy();
  });
});
