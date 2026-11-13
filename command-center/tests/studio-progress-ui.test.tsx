// @vitest-environment jsdom
/**
 * The Studio's generation placeholder in a DOM: the coming result in its own shape, what the job is doing from its
 * row, and a pill that is an estimate only when there is history to back it — with "~" and a spoken label saying so —
 * and otherwise counts seconds. Reduced motion stops the wave. A result that finishes fades in where the placeholder
 * was; a failure shows the reason the feed already knows, with the feed's own Try again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { dictionaries, fmt } from "@/lib/i18n";
import { GenerationPlaceholder } from "@/components/studio/GenerationPlaceholder";
import { JobFeed } from "@/components/studio/JobFeed";
import type { StudioJob } from "@/lib/creative/studio";

const t = dictionaries.en;
const tp = t.studioProgress;
const ORG = "11111111-1111-4111-8111-111111111111";
const OUT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-11-01T10:01:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const job = (over: Partial<StudioJob> = {}): StudioJob => ({
  id: "j1",
  capability: "t2i",
  status: "provider_pending",
  requested_model: "pic-1",
  params: { prompt: "a lighthouse", aspect_ratio: "16:9" },
  quoted_credits: 4,
  charged_credits: null,
  error_code: null,
  result: null,
  result_asset_ids: [],
  created_at: ago(40),
  started_at: ago(30),
  ...over,
});

let reduced = false;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  reduced = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      matches: q.includes("prefers-reduced-motion") ? reduced : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
  fetchMock = vi.fn(() => json({}, 404));
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const pill = () => screen.queryByTestId("gen-pill");

describe("the placeholder", () => {
  it("with history (≥3 finished jobs): '~N%' — elapsed since started_at over the median — and says it is an estimate", () => {
    render(withI18n(<GenerationPlaceholder job={job()} samples={[50, 60, 70]} />));
    const p = pill()!;
    expect(p.dataset.kind).toBe("estimate");
    expect(within(p).getByText("~50%").getAttribute("aria-hidden")).toBe("true");
    expect(within(p).getByText(fmt(tp.estimateSpoken, { n: 50, count: 3 }))).toBeTruthy();
    // The number is not a live region: a screen reader is not read it every second.
    expect(p.closest("[aria-live]")).toBeNull();
  });

  it("caps an estimate at ~95% while the row still says working", () => {
    render(withI18n(<GenerationPlaceholder job={job({ started_at: ago(900) })} samples={[60, 60, 60]} />));
    expect(within(pill()!).getByText("~95%")).toBeTruthy();
  });

  it("without history no percentage renders anywhere — the seconds since it started do", () => {
    const { container } = render(withI18n(<GenerationPlaceholder job={job()} samples={[60, 60]} />));
    expect(pill()!.dataset.kind).toBe("elapsed");
    expect(within(pill()!).getByText("30 s")).toBeTruthy();
    expect(within(pill()!).getByText(fmt(tp.elapsedSpoken, { n: 30 }))).toBeTruthy();
    expect(container.textContent).not.toMatch(/%/);
  });

  it("no history read at all (null) is the same: seconds, no percentage", () => {
    const { container } = render(withI18n(<GenerationPlaceholder job={job()} samples={null} />));
    expect(container.textContent).not.toMatch(/%/);
    expect(within(pill()!).getByText("30 s")).toBeTruthy();
  });

  it("counts on by itself (its own clock), and longer waits read in minutes", async () => {
    render(withI18n(<GenerationPlaceholder job={job({ started_at: ago(58) })} samples={null} />));
    expect(within(pill()!).getByText("58 s")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(within(pill()!).getByText(fmt(tp.minutes, { m: 1, s: 1 }))).toBeTruthy();
  });

  it.each([
    ["queued", tp.phase.queued],
    ["running", tp.phase.sending],
    ["provider_pending", tp.phase.making],
    ["processing", tp.phase.storing],
  ])("status %s reads '%s' in the polite live line", (status, words) => {
    render(withI18n(<GenerationPlaceholder job={job({ status, started_at: status === "queued" ? null : ago(30) })} samples={null} />));
    const line = screen.getByTestId("gen-phase");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(line.textContent).toBe(words);
  });

  it("a job in line shows how long it has waited, said as a wait", () => {
    render(withI18n(<GenerationPlaceholder job={job({ status: "queued", started_at: null })} samples={[60, 60, 60]} />));
    expect(within(pill()!).getByText("40 s")).toBeTruthy();
    expect(within(pill()!).getByText(fmt(tp.waitingSpoken, { n: 40 }))).toBeTruthy();
  });

  it("waves only when motion is welcome; prefers-reduced-motion: reduce draws still dots", () => {
    const { unmount } = render(withI18n(<GenerationPlaceholder job={job()} samples={null} />));
    expect(screen.getByTestId("gen-placeholder").dataset.motion).toBe("wave");
    unmount();
    reduced = true;
    render(withI18n(<GenerationPlaceholder job={job()} samples={null} />));
    expect(screen.getByTestId("gen-placeholder").dataset.motion).toBe("still");
  });

  it("a failed job: no wave, no number, the reason it was given", () => {
    render(withI18n(<GenerationPlaceholder job={job({ status: "failed" })} samples={[60, 60, 60]} failure="The model was busy." />));
    const ph = screen.getByTestId("gen-placeholder");
    expect(ph.dataset.motion).toBe("still");
    expect(ph.dataset.state).toBe("failed");
    expect(pill()).toBeNull();
    expect(screen.getByTestId("gen-failure").textContent).toBe("The model was busy.");
  });

  it("reads in Russian and Uzbek", () => {
    for (const locale of ["ru", "uz"] as const) {
      const d = dictionaries[locale].studioProgress;
      const { unmount } = render(withI18n(<GenerationPlaceholder job={job({ status: "processing" })} samples={[50, 60, 70]} />, locale));
      expect(screen.getByTestId("gen-phase").textContent).toBe(d.phase.storing);
      expect(within(pill()!).getByText(fmt(d.estimate, { n: 50 }))).toBeTruthy();
      unmount();
    }
  });
});

describe("in the feed", () => {
  const row = (over: Record<string, unknown> = {}) => ({ ...job(), ...over });

  it("a working job's card is the placeholder in its own shape, and asks this org's history for its model only", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [row()] });
      if (url.startsWith("/api/creative/durations")) return json({ durations: { "pic-1": [50, 60, 70] } });
      return json({}, 404);
    });
    render(withI18n(<JobFeed orgId={ORG} />));
    const ph = await screen.findByTestId("gen-placeholder");
    expect(ph.closest<HTMLElement>(".ns-frame-media")!.style.aspectRatio).toBe("16 / 9");
    await waitFor(() => expect(within(pill()!).getByText(/^~\d+%$/)).toBeTruthy());
    const asked = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/creative/durations"));
    expect(asked).toEqual([`/api/creative/durations?org_id=${ORG}&models=pic-1`]);
    // Read history, priced nothing: no POST of any kind.
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("a fixed-shape model's job (no aspect sent) holds a neutral 3:2", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/creative/jobs") ? json({ jobs: [row({ requested_model: "grounded-image-1.0", params: { prompt: "x" } })] }) : json({}, 404),
    );
    render(withI18n(<JobFeed orgId={ORG} />));
    const ph = await screen.findByTestId("gen-placeholder");
    expect(ph.closest<HTMLElement>(".ns-frame-media")!.style.aspectRatio).toBe("3 / 2");
  });

  it("when the history cannot be read, the card shows seconds and never a percentage", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [row()] });
      return json({ error: "failed" }, 502);
    });
    render(withI18n(<JobFeed orgId={ORG} />));
    const ph = await screen.findByTestId("gen-placeholder");
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/creative/durations"))).toBe(true));
    expect(within(ph).getByTestId("gen-pill").dataset.kind).toBe("elapsed");
    expect(ph.textContent).not.toMatch(/%/);
  });

  it("a job in line asks no history (there is no start to time)", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/creative/jobs") ? json({ jobs: [row({ status: "queued", started_at: null })] }) : json({}, 404),
    );
    render(withI18n(<JobFeed orgId={ORG} />));
    await screen.findByTestId("gen-placeholder");
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/creative/durations"))).toBe(false);
  });

  it("survives a refresh: a fresh mount draws the same phase from the row alone", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/creative/jobs") ? json({ jobs: [row({ status: "processing" })] }) : json({}, 404),
    );
    const first = render(withI18n(<JobFeed orgId={ORG} />));
    expect((await screen.findByTestId("gen-phase")).textContent).toBe(tp.phase.storing);
    first.unmount();
    render(withI18n(<JobFeed orgId={ORG} />));
    expect((await screen.findByTestId("gen-phase")).textContent).toBe(tp.phase.storing);
  });

  it("when the row says completed, the result appears in the placeholder's place, fading in", async () => {
    let call = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/creative/jobs")) {
        call += 1;
        return json({ jobs: [call === 1 ? row() : row({ status: "completed", charged_credits: 4, result_asset_ids: [OUT] })] });
      }
      if (url.startsWith("/api/media")) return json({ available: true, assets: [{ id: OUT, kind: "image", thumbUrl: `/t/${OUT}`, viewUrl: `/v/${OUT}` }] });
      return json({}, 404);
    });
    render(withI18n(<JobFeed orgId={ORG} />));
    await screen.findByTestId("gen-placeholder");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>(`img[src="/t/${OUT}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.parentElement!.className).toContain("gen-reveal");
    expect(img.closest<HTMLElement>(".ns-frame-media")!.style.aspectRatio).toBe("16 / 9");
    expect(screen.queryByTestId("gen-placeholder")).toBeNull();
  });

  it("a result that was already done when the page opened is simply drawn (no fade)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [row({ status: "completed", charged_credits: 4, result_asset_ids: [OUT] })] });
      if (url.startsWith("/api/media")) return json({ available: true, assets: [{ id: OUT, kind: "image", thumbUrl: `/t/${OUT}`, viewUrl: `/v/${OUT}` }] });
      return json({}, 404);
    });
    render(withI18n(<JobFeed orgId={ORG} />));
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>(`img[src="/t/${OUT}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.parentElement!.className).not.toContain("gen-reveal");
  });

  it("a failure: the placeholder says why (once), and the feed's Try again only fills the form", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/creative/jobs") ? json({ jobs: [row({ status: "failed", error_code: "provider_timeout" })] }) : json({}, 404),
    );
    const onRetry = vi.fn();
    render(withI18n(<JobFeed orgId={ORG} onRetry={onRetry} />));
    const reason = await screen.findByTestId("gen-failure");
    expect(reason.textContent).toBe(t.gen.reasons.busy);
    expect(screen.getAllByText(t.gen.reasons.busy)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t.gen.tryAgain }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ capability: "t2i", prompt: "a lighthouse" }));
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("Voice: a take on its way is a wide bar where its player will be", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/creative/jobs")
        ? json({ jobs: [row({ capability: "tts", requested_model: "voice-1", params: { prompt: "hello" } })] })
        : json({}, 404),
    );
    render(withI18n(<JobFeed orgId={ORG} variant="takes" capabilities={["tts"]} />));
    const ph = await screen.findByTestId("gen-placeholder");
    expect(ph.dataset.size).toBe("bar");
  });

  it("the monitor: a working clip is the placeholder at the clip's shape", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/creative/jobs")
        ? json({ jobs: [row({ capability: "t2v", requested_model: "vid-1", params: { prompt: "clip", aspect_ratio: "9:16", duration_s: 5 } })] })
        : json({}, 404),
    );
    render(withI18n(<JobFeed orgId={ORG} variant="monitor" capabilities={["t2v"]} />));
    const stage = await screen.findByTestId("desk-stage");
    const ph = within(stage).getByTestId("gen-placeholder");
    expect(ph.dataset.size).toBe("stage");
    expect(ph.style.aspectRatio).toBe("9 / 16");
  });
});
