// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
vi.mock("next/navigation", () => ({ usePathname: () => "/chronos/create", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
import { JobFeed } from "../components/studio/JobFeed";
import { I18nProvider } from "../lib/i18n/context";
import { dictionaries } from "../lib/i18n";

const ORG = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const row = (over: Record<string, unknown> = {}) => ({ id: "existing-video", capability: "t2v", status: "cancelled",
  requested_model: "vid-1", params: { prompt: "Synthetic existing video" }, quoted_credits: 4,
  charged_credits: null, result: null, result_asset_ids: [], error_code: null, created_at: "2030-01-01T00:00:00Z", ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve!: (r: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { resolve, promise }; };
const view = (orgId = ORG, locale: "en" | "ru" | "uz" = "en", onLoaded?: (jobs: unknown[]) => void,
  capabilities: readonly string[] = ["t2v", "i2v"]) =>
  <I18nProvider locale={locale}><JobFeed orgId={orgId} variant="monitor" capabilities={capabilities} onLoaded={onLoaded} /></I18nProvider>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse("2030-01-01T00:01:00Z") });
  window.localStorage.clear();
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  expect(fetchMock.mock.calls.every(([url, init]) => String(url).startsWith("/api/creative/jobs?") && (!init?.method || init.method === "GET"))).toBe(true);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

it("distinguishes a pending first read from unavailable without background retry", async () => {
  const read = deferred(); fetchMock.mockReturnValue(read.promise);
  const { container } = render(view());
  expect(container.querySelector('section[aria-busy="true"]')).not.toBeNull();
  expect(screen.queryByText(dictionaries.en.gen.unavailable)).toBeNull();
  expect(screen.queryByText(dictionaries.en.gen.emptyTitle)).toBeNull();
  await act(async () => { read.resolve(json({ error: "creative_unavailable" }, 503)); });
  await screen.findByText(dictionaries.en.gen.unavailable);
  expect(container.querySelector('section[aria-busy="true"]')).toBeNull();
  expect(screen.queryByText(dictionaries.en.gen.emptyTitle)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ["en", "Cancellation recorded in Nightshift. Provider cancellation is not confirmed by this job record."],
  ["ru", "Отмена записана в Nightshift. Эта запись задания не подтверждает отмену у провайдера."],
  ["uz", "Bekor qilish Nightshift’da qayd etilgan. Bu vazifa yozuvi provayder bekor qilganini tasdiqlamaydi."],
] as const)("reopens the existing cancelled video with explicit unconfirmed provider outcome in %s", async (locale, words) => {
  fetchMock.mockImplementation(() => Promise.resolve(json({ jobs: [row()] })));
  const first = render(view(ORG, locale));
  await waitFor(() => expect(screen.getAllByText(words).length).toBeGreaterThan(0));
  first.unmount();
  const reopened = render(view(ORG, locale));
  await waitFor(() => expect(screen.getAllByText(words).length).toBeGreaterThan(0));
  expect(screen.getByTestId("desk-stage").getAttribute("data-status")).toBe("cancelled");
  expect(reopened.container.querySelector("time[datetime]")).toBeNull();
  expect(screen.queryByRole("button", { name: dictionaries[locale].gen.cancel })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("hides the previous scope immediately while the next existing feed is read", async () => {
  const next = deferred(); fetchMock.mockImplementation((url: string) => url.includes(OTHER)
    ? next.promise : Promise.resolve(json({ jobs: [row()] })));
  const ui = render(view());
  await screen.findByTestId("desk-stage");
  ui.rerender(view(OTHER));
  expect(screen.queryByTestId("desk-stage")).toBeNull();
  expect(screen.queryByText("Synthetic existing video")).toBeNull();
  expect(ui.container.querySelector('section[aria-busy="true"]')).not.toBeNull();
  await act(async () => { next.resolve(json({ jobs: [] })); });
  await screen.findByText(dictionaries.en.gen.emptyTitle);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("ignores a read completing after its feed scope was closed", async () => {
  const old = deferred(), current = deferred(), loaded = vi.fn();
  fetchMock.mockImplementation((url: string) => url.includes(OTHER) ? current.promise : old.promise);
  const ui = render(view(ORG, "en", loaded)); ui.rerender(view(OTHER, "en", loaded));
  await act(async () => { old.resolve(json({ jobs: [row()] })); });
  expect(loaded).not.toHaveBeenCalled();
  expect(screen.queryByTestId("desk-stage")).toBeNull();
  await act(async () => { current.resolve(json({ jobs: [] })); });
  await screen.findByText(dictionaries.en.gen.emptyTitle);
  expect(loaded).toHaveBeenCalledTimes(1);
});

it("clears the previous video capability before reading the next desk scope in the same organization", async () => {
  const next = deferred(); fetchMock.mockImplementation((url: string) => url.endsWith("capability=i2v")
    ? next.promise : Promise.resolve(json({ jobs: [row()] })));
  const ui = render(view(ORG, "en", undefined, ["t2v"]));
  await screen.findByTestId("desk-stage");
  ui.rerender(view(ORG, "en", undefined, ["i2v"]));
  expect(screen.queryByTestId("desk-stage")).toBeNull();
  expect(ui.container.querySelector('section[aria-busy="true"]')).not.toBeNull();
  await act(async () => { next.resolve(json({ jobs: [row({ capability: "i2v", params: { prompt: "Synthetic image-to-video" } })] })); });
  await screen.findByTestId("desk-stage");
  expect(screen.getByText("Synthetic image-to-video")).toBeTruthy();
  expect(screen.queryByText("Synthetic existing video")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
