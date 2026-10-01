// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
