// @vitest-environment jsdom
/**
 * Auto-captions in the editor (migration 0072), in a browser-like DOM.
 *
 * The one paid step goes the same priced way as every creative tool: the
 * database quotes it (/api/creative/quote), the price is on the button, and
 * pressing it — only that — sends it as `max_credits` with one idempotency
 * key. Everything after it (a finished transcript, the look, editing,
 * deleting, the SRT / WebVTT downloads) is free and local. Nothing here
 * publishes or re-renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/editor/p",
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
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { fmt } from "@/lib/i18n";
import { CaptionsPanel, type CaptionModelOption } from "@/components/editor/CaptionsPanel";
import { captionsOf } from "@/lib/captions";
import { toDoc, validateTimeline, type EditorAsset, type EditorModel } from "@/lib/editor";

const t = dictionaries.en;
const tc = t.captions;
const ORG = "00000000-0000-4000-8000-000000000001";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const TRACK = "44444444-4444-4444-8444-444444444444";

const SCRIBE: CaptionModelOption = { id: "scribe", displayName: "Transcriber", languages: ["uz", "ru", "en"] };

const asset = (id: string, over: Partial<EditorAsset> = {}): EditorAsset => ({
  id, kind: "video", name: "talk.mp4", durationS: 95, width: 1080, height: 1920, viewUrl: null, thumbUrl: null, ...over,
});

const baseModel = (over: Partial<EditorModel> = {}): EditorModel => ({
  width: 1080,
  height: 1920,
  fps: 30,
  clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 95, speed: 1, audio: true }],
  texts: [],
  sounds: [],
  keep: [],
  ...over,
});

const WORDS = [
  { t: "Salom", s: 0.5, e: 0.9 },
  { t: "dunyo.", s: 1.0, e: 1.6 },
  { t: "Bugun", s: 3.0, e: 3.4 },
  { t: "gaplashamiz.", s: 3.5, e: 4.2 },
];
const TRACK_ROW = { id: TRACK, language: "uz", duration_s: "95.000", word_count: 4, created_at: "2026-10-01T10:00:00Z", asset_id: A };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
type Route = (url: string, init?: RequestInit) => Promise<Response> | undefined;
let routes: Route[];
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (method: string, part: string) =>
  fetchMock.mock.calls.filter(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && String(u).includes(part));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

let seen: EditorModel | null;

function Host({
  model: initial = baseModel(),
  models = [SCRIBE],
  assets = { [A]: asset(A) },
  locale = "en",
}: {
  model?: EditorModel;
  models?: CaptionModelOption[];
  assets?: Record<string, EditorAsset>;
  locale?: "en" | "ru" | "uz";
}) {
  const [model, setModel] = useState(initial);
  seen = model;
  return (
    <I18nProvider locale={locale}>
      <CaptionsPanel orgId={ORG} projectTitle="My talk" model={model} assets={assets} models={models} pictureEnd={95} onChange={setModel} />
    </I18nProvider>
  );
}

const quoteOk = (credits: number): Route => (url) => (url.endsWith("/api/creative/quote") ? json({ quote: { credits } }) : undefined);
const noTracks: Route = (url) => (url.startsWith("/api/captions/tracks?") ? json({ tracks: [] }) : undefined);
const noJobs: Route = (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [] }) : undefined);

beforeEach(() => {
  routes = [];
  seen = null;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return json({ error: "failed" }, 502);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const makeBtn = (n: number | null) =>
  screen.getByRole("button", { name: n === null ? tc.make : fmt(tc.makePriced, { n: String(n) }) });

describe("the paid step: quote, price on the button, one priced press", () => {
  it("shows the database's price on the button and holds nothing until it is pressed", async () => {
    routes.push(quoteOk(6.2), noTracks, noJobs);
    render(<Host />);
    await waitFor(() => expect(makeBtn(6.2)).toBeTruthy());
    const [q] = calls("POST", "/api/creative/quote");
    expect(bodyOf(q)).toEqual({ org_id: ORG, capability: "captions", model: "scribe", params: { source_asset_id: A, language: "en" } });
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(0);
    expect(screen.getByText(tc.priceNote)).toBeTruthy();
  });

  it("the press sends exactly the quoted price as max_credits, with an idempotency key, once", async () => {
    routes.push(quoteOk(6.2), noTracks, noJobs, (url, init) =>
      url.endsWith("/api/creative/jobs") && init?.method === "POST"
        ? json({ job: { id: JOB, capability: "captions", status: "queued", params: { source_asset_id: A }, quoted_credits: 6.2 } }, 201)
        : undefined,
    );
    render(<Host />);
    await waitFor(() => expect(makeBtn(6.2)).toHaveProperty("disabled", false));
    const press = makeBtn(6.2);
    fireEvent.click(press);
    fireEvent.click(press);
    await waitFor(() => expect(screen.getByText(tc.working)).toBeTruthy());
    const posts = calls("POST", "/api/creative/jobs");
    expect(posts).toHaveLength(1);
    const body = bodyOf(posts[0]);
    expect(body).toMatchObject({ org_id: ORG, capability: "captions", model: "scribe", max_credits: 6.2, params: { source_asset_id: A, language: "en" } });
    expect(typeof body.idempotency_key).toBe("string");
    expect(body.idempotency_key.length).toBeGreaterThan(8);
    // While a job runs the button cannot be pressed again.
    expect(press).toHaveProperty("disabled", true);
  });

  it("detecting the language sends no language at all", async () => {
    routes.push(quoteOk(3), noTracks, noJobs);
    render(<Host />);
    await waitFor(() => expect(makeBtn(3)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(tc.languageLabel), { target: { value: "detect" } });
    await waitFor(() => expect(calls("POST", "/api/creative/quote").length).toBe(2));
    expect(bodyOf(calls("POST", "/api/creative/quote")[1]).params).toEqual({ source_asset_id: A });
  });

  it("offers only the languages the model was proven for, and falls back to detecting", async () => {
    routes.push(quoteOk(3), noTracks, noJobs);
    render(<Host models={[{ id: "narrow", displayName: "Narrow", languages: ["uz"] }]} />);
    // The app is read in English, which this model does not list.
    const select = screen.getByLabelText(tc.languageLabel) as HTMLSelectElement;
    expect(select.value).toBe("detect");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([tc.languages.uz, tc.detect]);
    await waitFor(() => expect(makeBtn(3)).toBeTruthy());
    expect(bodyOf(calls("POST", "/api/creative/quote")[0]).params).toEqual({ source_asset_id: A });
  });

  it("insufficient credits is a sentence with a way to add credits, and nothing is started", async () => {
    routes.push(
      (url) => (url.endsWith("/api/creative/quote") ? json({ quote: { credits: 6.2 } }) : undefined),
      noTracks,
      noJobs,
      (url, init) => (url.endsWith("/api/creative/jobs") && init?.method === "POST" ? json({ error: "insufficient_credits", available: 1, needed: 6.2 }, 402) : undefined),
    );
    render(<Host />);
    await waitFor(() => expect(makeBtn(6.2)).toHaveProperty("disabled", false));
    fireEvent.click(makeBtn(6.2));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(t.creative.errors.insufficient_credits));
    expect(screen.getByRole("link", { name: tc.addCredits }).getAttribute("href")).toBe("/chronos/credits");
    expect(screen.queryByText(tc.working)).toBeNull();
    // Pressable again: nothing was held.
    expect(makeBtn(6.2)).toHaveProperty("disabled", false);
  });

  it("a changed price asks again instead of charging more", async () => {
    let price = 6.2;
    routes.push(
      (url) => (url.endsWith("/api/creative/quote") ? json({ quote: { credits: price } }) : undefined),
      noTracks,
      noJobs,
      (url, init) => {
        if (!(url.endsWith("/api/creative/jobs") && init?.method === "POST")) return undefined;
        price = 8;
        return json({ error: "price_changed" }, 409);
      },
    );
    render(<Host />);
    await waitFor(() => expect(makeBtn(6.2)).toHaveProperty("disabled", false));
    fireEvent.click(makeBtn(6.2));
    await waitFor(() => expect(makeBtn(8)).toBeTruthy());
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(1);
  });

  it("a model with no price (unpriced) is a sentence, never a zero", async () => {
    routes.push((url) => (url.endsWith("/api/creative/quote") ? json({ error: "unpriced" }, 422) : undefined), noTracks, noJobs);
    render(<Host />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(t.creative.errors.unpriced));
    expect(screen.queryByText(/credits/)?.textContent ?? "").not.toMatch(/· 0 credits/);
    expect(screen.getByRole("button", { name: tc.make })).toHaveProperty("disabled", true);
  });
});

describe("what blocks it", () => {
  it("without a sold model it says so and asks nothing", () => {
    routes.push(noTracks, noJobs);
    render(<Host models={[]} />);
    expect(screen.getByText(tc.noModels)).toBeTruthy();
    expect(calls("POST", "/api/creative/quote")).toHaveLength(0);
  });

  it("without a recording on the timeline it says what to add, and asks nothing", () => {
    routes.push(noTracks, noJobs);
    render(<Host model={baseModel({ clips: [] })} />);
    expect(screen.getByText(tc.noRecordings)).toBeTruthy();
    expect(calls("POST", "/api/creative/quote")).toHaveLength(0);
  });

  it("a recording over 30 minutes is refused before it is priced", () => {
    routes.push(noTracks, noJobs);
    render(<Host assets={{ [A]: asset(A, { durationS: 1801 }) }} />);
    expect(screen.getByRole("alert").textContent).toBe(tc.tooLong);
    expect(calls("POST", "/api/creative/quote")).toHaveLength(0);
    expect(screen.getByRole("button", { name: tc.make })).toHaveProperty("disabled", true);
  });

  it("a recording of unknown length cannot be priced, and is never priced as 0", () => {
    routes.push(noTracks, noJobs);
    render(<Host assets={{ [A]: asset(A, { durationS: null }) }} />);
    expect(screen.getByRole("alert").textContent).toBe(tc.unknownLength);
    expect(calls("POST", "/api/creative/quote")).toHaveLength(0);
  });

  it("a muted clip says its words would not be heard", () => {
    routes.push(quoteOk(3), noTracks, noJobs);
    render(<Host model={baseModel({ clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 95, speed: 1, audio: false }] })} />);
    expect(screen.getByText(tc.muted)).toBeTruthy();
  });
});

describe("a job on its way", () => {
  it("is found again after a refresh and followed to its end: the transcript is read back, free", async () => {
    let polls = 0;
    routes.push(
      quoteOk(6.2),
      noTracks,
      (url) =>
        url.startsWith("/api/creative/jobs?")
          ? json({ jobs: [{ id: JOB, capability: "captions", status: "provider_pending", params: { source_asset_id: A }, quoted_credits: 6.2 }] })
          : undefined,
      (url) => {
        if (!url.endsWith(`/api/creative/jobs/${JOB}`)) return undefined;
        polls += 1;
        return json({ job: { id: JOB, capability: "captions", status: "completed", params: { source_asset_id: A }, result: { track_id: TRACK }, quoted_credits: 6.2, charged_credits: 6.2 } });
      },
      (url) => (url.endsWith(`/api/captions/tracks/${TRACK}`) ? json({ track: { ...TRACK_ROW, words: WORDS } }) : undefined),
    );
    render(<Host />);
    await waitFor(() => expect(screen.getByText(tc.working)).toBeTruthy());
    // Not pressable again while it runs, and nothing new was started.
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(0);
    await waitFor(() => expect(screen.getByText(fmt(tc.ready, { words: 4, lang: tc.languages.uz }))).toBeTruthy(), { timeout: 8000 });
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(0);
  }, 12000);

  it("a failed job says it did not finish and that the credits came back (no speech has its own sentence)", async () => {
    routes.push(
      quoteOk(6.2),
      noTracks,
      (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [{ id: JOB, capability: "captions", status: "queued", params: { source_asset_id: A }, quoted_credits: 6.2 }] }) : undefined),
      (url) =>
        url.endsWith(`/api/creative/jobs/${JOB}`)
          ? json({ job: { id: JOB, capability: "captions", status: "failed", params: { source_asset_id: A }, error_code: "no_speech", quoted_credits: 6.2 } })
          : undefined,
    );
    render(<Host />);
    await waitFor(() => expect(screen.getByText(new RegExp(tc.failed))).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByText(new RegExp(t.gen.reasons.no_speech))).toBeTruthy();
    // And it can be tried again.
    await waitFor(() => expect(makeBtn(6.2)).toHaveProperty("disabled", false));
  }, 12000);

  it("a job of another recording is not picked up", async () => {
    routes.push(
      quoteOk(6.2),
      noTracks,
      (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [{ id: JOB, capability: "captions", status: "running", params: { source_asset_id: B }, quoted_credits: 6.2 }] }) : undefined),
    );
    render(<Host />);
    await waitFor(() => expect(makeBtn(6.2)).toBeTruthy());
    expect(screen.queryByText(tc.working)).toBeNull();
  });
});

describe("stopping and finding a job", () => {
  const running = (source: string, status = "queued") => ({
    id: JOB, capability: "captions", status, params: { source_asset_id: source }, quoted_credits: 6.2,
  });

  it("a queued job can be cancelled: the database releases the hold, and the button is pressable again", async () => {
    routes.push(
      quoteOk(6.2),
      noTracks,
      (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [running(A)] }) : undefined),
      (url, init) =>
        url.endsWith(`/api/creative/jobs/${JOB}`) && init?.method === "POST"
          ? json({ job: { ...running(A), status: "cancelled" }, already: false })
          : undefined,
    );
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: tc.cancel }));
    await waitFor(() => expect(screen.getByText(tc.cancelled)).toBeTruthy());
    const [post] = calls("POST", `/api/creative/jobs/${JOB}`);
    expect(bodyOf(post)).toEqual({ action: "cancel" });
    expect(screen.queryByText(tc.working)).toBeNull();
    await waitFor(() => expect(makeBtn(6.2)).toHaveProperty("disabled", false));
    // Cancelling never starts (or pays for) a job.
    expect(fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("a job the provider already has is not cancellable, and says so instead of failing silently", async () => {
    routes.push(
      quoteOk(6.2),
      noTracks,
      (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [running(A, "provider_pending")] }) : undefined),
      (url, init) => (url.endsWith(`/api/creative/jobs/${JOB}`) && init?.method === "POST" ? json({ error: "not_cancellable" }, 409) : undefined),
    );
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: tc.cancel }));
    await waitFor(() => expect(screen.getByText(tc.notCancellable)).toBeTruthy());
    expect(screen.getByText(tc.working)).toBeTruthy();
  });

  it("a job for a recording that is not in this project is still listed, and can be cancelled from here", async () => {
    routes.push(
      quoteOk(6.2),
      noTracks,
      (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [running(B)] }) : undefined),
      (url, init) =>
        url.endsWith(`/api/creative/jobs/${JOB}`) && init?.method === "POST" ? json({ job: { ...running(B), status: "cancelled" } }) : undefined,
    );
    render(<Host />);
    await screen.findByText(tc.otherRunning);
    expect(screen.getByRole("heading", { name: tc.othersHeading })).toBeTruthy();
    // It is not this recording's job: the panel is not "working" on this one.
    expect(screen.queryByText(tc.working)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tc.cancel }));
    await waitFor(() => expect(screen.queryByText(tc.otherRunning)).toBeNull());
    expect(screen.getByText(tc.cancelled)).toBeTruthy();
  });

  it("is found even in a project with no recording yet", async () => {
    routes.push(noTracks, (url) => (url.startsWith("/api/creative/jobs?") ? json({ jobs: [running(B)] }) : undefined));
    render(<Host model={baseModel({ clips: [] })} />);
    await screen.findByText(tc.otherRunning);
    expect(screen.getByText(tc.noRecordings)).toBeTruthy();
  });
});

describe("a transcript, then captions on the video (free)", () => {
  function withTrack() {
    routes.push(
      quoteOk(6.2),
      (url) => (url.startsWith("/api/captions/tracks?") ? json({ tracks: [TRACK_ROW] }) : undefined),
      noJobs,
      (url, init) => (url.endsWith(`/api/captions/tracks/${TRACK}`) && !init?.method ? json({ track: { ...TRACK_ROW, words: WORDS } }) : undefined),
    );
  }

  it("lists transcripts already made; using one is free and starts nothing", async () => {
    withTrack();
    render(<Host />);
    await screen.findByText(tc.earlier);
    expect(screen.getByText(tc.earlierNote)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tc.useTranscript }));
    await waitFor(() => expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", false));
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(0);
  });

  it("puts captions on the video, in a valid document, and shows them in the list", async () => {
    withTrack();
    render(<Host />);
    expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", true);
    fireEvent.click(await screen.findByRole("button", { name: tc.useTranscript }));
    await waitFor(() => expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: tc.put }));
    const caps = captionsOf(seen!)!;
    expect(caps.cues.map((c) => c.text)).toEqual(["Salom dunyo.", "Bugun gaplashamiz."]);
    expect(validateTimeline(toDoc(seen!))).toEqual([]);
    expect(screen.getByText(fmt(tc.added, { n: 2 }))).toBeTruthy();
    expect(screen.getByRole("heading", { name: fmt(tc.cuesHeading, { n: 2 }) })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: fmt(tc.cueText, { n: 1 }) })).toHaveProperty("value", "Salom dunyo.");
    // The default look is the classic preset.
    expect(caps.style.color).toBe("#FFFFFF");
  });

  it("choosing a look restyles existing captions and keeps the person's words", async () => {
    withTrack();
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: tc.useTranscript }));
    await waitFor(() => expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: tc.put }));
    const box = screen.getByRole("textbox", { name: fmt(tc.cueText, { n: 1 }) });
    fireEvent.change(box, { target: { value: "My words" } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(tc.presets.bold) }));
    const caps = captionsOf(seen!)!;
    expect(caps.style.color).toBe("#FFE600");
    expect(caps.cues[0].text).toBe("My words");
    // Rebuilding from the transcript is a deliberate, warned step.
    fireEvent.click(screen.getByRole("button", { name: tc.rebuild }));
    expect(screen.getByText(tc.rebuildWarn)).toBeTruthy();
    expect(captionsOf(seen!)!.cues[0].text).toBe("My words");
  });

  it("edits, deletes and clears captions; an emptied one is flagged", async () => {
    withTrack();
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: tc.useTranscript }));
    await waitFor(() => expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: tc.put }));
    const box = screen.getByRole("textbox", { name: fmt(tc.cueText, { n: 2 }) });
    fireEvent.change(box, { target: { value: "  " } });
    fireEvent.blur(box);
    expect(screen.getByText(tc.cueEmpty)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: tc.deleteCue })[1]);
    expect(captionsOf(seen!)!.cues).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: tc.clear }));
    expect(seen!.captions).toBeUndefined();
    expect(screen.getByText(tc.noCues)).toBeTruthy();
  });

  it("a recording none of whose sound is heard has nothing to caption, and says so", async () => {
    withTrack();
    render(<Host model={baseModel({ clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 95, speed: 1, audio: false }] })} />);
    fireEvent.click(await screen.findByRole("button", { name: tc.useTranscript }));
    await waitFor(() => expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: tc.put }));
    expect(screen.getByText(tc.nothingHeard)).toBeTruthy();
    expect(seen!.captions).toBeUndefined();
  });

  it("removing a transcript asks first, then hides it", async () => {
    withTrack();
    routes.push((url, init) => (url.endsWith(`/api/captions/tracks/${TRACK}`) && init?.method === "DELETE" ? json({ ok: true }) : undefined));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Host />);
    const rm = await screen.findByRole("button", { name: tc.removeTranscript });
    fireEvent.click(rm);
    expect(calls("DELETE", "/api/captions/tracks/")).toHaveLength(0);
    fireEvent.click(rm);
    await waitFor(() => expect(calls("DELETE", `/api/captions/tracks/${TRACK}`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: tc.removeTranscript })).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("downloads SRT and WebVTT made from the captions as they are now", async () => {
    withTrack();
    const blobs: Blob[] = [];
    const names: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.push(b), "blob:x"), revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: tc.useTranscript }));
    await waitFor(() => expect(screen.getByRole("button", { name: tc.put })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: tc.put }));
    fireEvent.click(screen.getByRole("button", { name: tc.downloadSrt }));
    fireEvent.click(screen.getByRole("button", { name: tc.downloadVtt }));
    expect(names).toEqual(["My-talk.uz.srt", "My-talk.uz.vtt"]);
    const read = (b: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(b);
      });
    const srt = await read(blobs[0]);
    const vtt = await read(blobs[1]);
    expect(srt).toContain("1\n00:00:00,500 --> ");
    expect(srt).toContain("Salom dunyo.");
    expect(vtt.startsWith("WEBVTT\n\n1\n00:00:00.500 --> ")).toBe(true);
    // Free: nothing was asked of the creative routes beyond the price check.
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(0);
  });
});

describe("the other languages", () => {
  for (const locale of ["ru", "uz"] as const) {
    it(`${locale}: the panel reads in that language and starts in it`, async () => {
      routes.push(quoteOk(6.2), noTracks, noJobs);
      render(<Host locale={locale} />);
      const d = dictionaries[locale].captions;
      expect(screen.getByRole("heading", { name: d.heading })).toBeTruthy();
      await waitFor(() => expect(screen.getByRole("button", { name: fmt(d.makePriced, { n: "6.2" }) })).toBeTruthy());
      expect(bodyOf(calls("POST", "/api/creative/quote")[0]).params.language).toBe(locale);
    });
  }
});

describe("inside the editor", () => {
  it("shows the project's captions on the preview and in the panel, and the unsaved mark follows an edit", async () => {
    const { TimelineEditor } = await import("@/components/editor/TimelineEditor");
    const { newDocForAsset } = await import("@/lib/editor");
    const doc = newDocForAsset({ ...asset(A, { durationS: 10 }) })!;
    const withCaptions = {
      ...doc,
      captions: { style: { font: "DejaVu Sans", size: 64, color: "#FFE600", outline_color: "#000000", outline_width: 4, bold: true, y: 0.8 }, cues: [{ id: "cap1", start_s: 0, end_s: 2, text: "Salom dunyo" }] },
    };
    routes.push(noTracks, noJobs);
    const { container } = render(
      <I18nProvider locale="en">
        <TimelineEditor
          projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          title="Trip"
          rev={1}
          doc={withCaptions}
          exports={[]}
          assets={{ [A]: asset(A, { durationS: 10 }) }}
          videos={[]}
          orgId={ORG}
          captionModels={[SCRIBE]}
        />
      </I18nProvider>,
    );
    // On the preview at the playhead, in the caption's own look.
    const onScreen = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Salom dunyo" && (s as HTMLElement).style.color !== "");
    expect(onScreen).toBeTruthy();
    expect(screen.getByRole("heading", { name: tc.heading })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: fmt(tc.cueText, { n: 1 }) })).toHaveProperty("value", "Salom dunyo");
    const box = screen.getByRole("textbox", { name: fmt(tc.cueText, { n: 1 }) });
    fireEvent.change(box, { target: { value: "Edited" } });
    fireEvent.blur(box);
    expect(screen.getByText(t.editor.unsaved)).toBeTruthy();
    // Free, and never a render: nothing was exported or priced.
    expect(calls("POST", "/exports")).toHaveLength(0);
    expect(calls("POST", "/api/creative/jobs")).toHaveLength(0);
  });
});
