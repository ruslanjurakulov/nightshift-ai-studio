// @vitest-environment jsdom
/**
 * "Repurpose into clips" on the video page (migration 0080), in a browser-like DOM.
 *
 * What would break without these: opening or ticking clips spending anything;
 * a price appearing only after the press; a press sending another price than
 * the one on the button, a window of its own, or a new key on a retry of the
 * same press; clips offered as ranked by retention when none was measured;
 * overlapping picks reaching the server; a person who may not start paid work
 * offered the button; a failed or partial request shown without saying what it
 * cost; a slow answer for an earlier selection labelling the button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { dictionaries, fmt } from "@/lib/i18n";
import { RepurposePanel } from "@/components/videos/RepurposePanel";
import { proposeClips, type Proposals, type RequestRow } from "@/lib/repurpose";

const t = dictionaries.en.repurpose;
const VID = "run-0123456789abcdef0123";

function manifest() {
  const lengths = [20, 5, 8, 12, 25, 10, 30, 15, 18, 7];
  let at = 0;
  return {
    scenes: lengths.map((n, i) => {
      const s = at;
      at += n;
      return { id: `s${String(i).padStart(3, "0")}`, start_s: s, end_s: at };
    }),
    audio: { duration_s: at },
  };
}

const NOT_MEASURED: Proposals = proposeClips(manifest(), []);
// Structure only: s001-s005 (20-80), s006-s007 (80-125), s008-s009 (125-150), s000 (0-20).
const [P1, P2, P3] = NOT_MEASURED.clips;

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let quote: unknown;
let pressAnswer: { status: number; body: unknown };

const pricedFor = (n: number, credits: number) => ({
  status: "priced", credits, clip_credits: 4, may_start: true,
  clips: Array.from({ length: n }, (_, i) => ({ position: i + 1, first: "s000", last: "s000", scene_ids: ["s000"], start_s: 0, end_s: 20, duration_s: 20 })),
});

beforeEach(() => {
  calls = [];
  refresh.mockReset();
  quote = pricedFor(1, 5);
  pressAnswer = { status: 200, body: { ok: true, id: "r1", status: "queued" } };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    if (method === "GET") return new Response(JSON.stringify({ quote, queue: true }), { status: 200 });
    return new Response(JSON.stringify(pressAnswer.body), { status: pressAnswer.status });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(props: Partial<React.ComponentProps<typeof RepurposePanel>> = {}) {
  return render(
    <RepurposePanel videoId={VID} proposals={NOT_MEASURED} queue requests={[]} hrefs={{}} labels={t} {...props} />,
  );
}
const tick = (rank: number) => fireEvent.click(screen.getByLabelText(fmt(t.rank, { rank: String(rank) })));

describe("RepurposePanel", () => {
  it("ranked by scene structure only: it says retention was not measured and shows no number", () => {
    mount();
    expect(screen.getByText(t.retentionNotMeasured)).toBeTruthy();
    expect(screen.queryByText(t.retentionMeasured)).toBeNull();
    expect(screen.getAllByText(t.scoreNotMeasured)).toHaveLength(NOT_MEASURED.clips.length);
    expect(screen.getByText(t.pickHint)).toBeTruthy();
  });

  it("says measured only when a curve scored a window, and shows what it found", () => {
    const m = manifest();
    const points = [[0.05, 0.95], [0.15, 0.7], [0.25, 0.62], [0.35, 0.6], [0.45, 0.6], [0.55, 0.59], [0.65, 0.58], [0.75, 0.5], [0.85, 0.42], [0.95, 0.35], [1, 0.33]]
      .map(([r, w]) => ({ elapsed_ratio: r, watch_ratio: w, measured_date: "2026-09-01" }));
    mount({ proposals: proposeClips(m, points) });
    expect(screen.getByText(t.retentionMeasured)).toBeTruthy();
    expect(screen.queryByText(t.retentionNotMeasured)).toBeNull();
    expect(screen.queryAllByText(t.scoreNotMeasured).length).toBeLessThan(5);
  });

  it("opening and ticking spend nothing; the price is on the button before the press", async () => {
    mount();
    expect(calls).toEqual([]);
    tick(1);
    const confirm = await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "5" }) });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0].url).toBe(`/api/videos/${VID}/repurpose?clips=${encodeURIComponent(`${P1.first}-${P1.last}`)}`);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const press = calls.find((c) => c.method === "POST")!;
    // Exactly the price on the button, the picked pair, and one key: nothing else.
    expect(press.body).toEqual({ clips: [{ first: P1.first, last: P1.last }], max_credits: 5, idempotency_key: expect.stringMatching(/^repurpose:/) });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("picks are quoted in the order they run in the video, as pairs only", async () => {
    quote = pricedFor(2, 8);
    mount();
    tick(3); // s008-s009 (late)
    tick(2); // s006-s007
    await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "8" }) });
    const last = calls.filter((c) => c.method === "GET").pop()!;
    expect(decodeURIComponent(last.url.split("clips=")[1])).toBe(`${P2.first}-${P2.last},${P3.first}-${P3.last}`);
    expect(screen.getByText(fmt(t.selected, { n: "2" }))).toBeTruthy();
  });

  it("never proposes more than five, and every one of them can be ticked", () => {
    const many = proposeClips({ scenes: Array.from({ length: 20 }, (_, i) => ({ id: `s${String(i).padStart(3, "0")}`, start_s: i * 16, end_s: i * 16 + 16 })) }, []);
    expect(many.clips).toHaveLength(5);
    mount({ proposals: many });
    for (let r = 1; r <= 5; r++) tick(r);
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).filter((b) => b.checked)).toHaveLength(5);
  });

  it("an unset price is said, and there is nothing to press", async () => {
    quote = { status: "unpriced", credits: null, may_start: true, clips: pricedFor(1, 5).clips };
    mount();
    tick(1);
    expect(await screen.findByText(t.unpriced)).toBeTruthy();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/credits/)).toBeNull();
  });

  it("a person who may only read sees the price but is told they cannot start it", async () => {
    quote = { ...pricedFor(1, 5), may_start: false };
    mount();
    tick(1);
    expect(await screen.findByText(t.noPermission)).toBeTruthy();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an unavailable quote says why and offers no price", async () => {
    quote = { status: "unavailable", reason: "gate_blocked", may_start: true };
    mount();
    tick(1);
    expect(await screen.findByText(t.reasons.gate_blocked)).toBeTruthy();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("without the queue backend it says so instead of offering a press", async () => {
    mount({ queue: false });
    tick(1);
    expect(await screen.findByText(t.errors.queueRequired)).toBeTruthy();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("two clips that share a scene are refused on the screen and never quoted", async () => {
    // s000 (0-20) and a window that also covers it would overlap; the proposals
    // never do, so build two that do from the same manifest.
    const over = {
      retention: "not_measured" as const,
      clips: [
        { rank: 1, first: "s000", last: "s002", sceneIds: ["s000", "s001", "s002"], startS: 0, endS: 33, durationS: 33, score: null, measured: false },
        { rank: 2, first: "s002", last: "s004", sceneIds: ["s002", "s003", "s004"], startS: 25, endS: 70, durationS: 45, score: null, measured: false },
      ],
    };
    mount({ proposals: over });
    tick(1);
    await waitFor(() => expect(calls).toHaveLength(1));
    tick(2);
    expect(await screen.findByText(t.overlap)).toBeTruthy();
    expect((screen.getByRole("button", { name: /credits|included/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a changed price is said with the new number, nothing is pressed again by itself, and the next press is a new key", async () => {
    pressAnswer = { status: 409, body: { error: "price_changed", credits: 6 } };
    mount();
    tick(1);
    const shown = await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "5" }) });
    quote = pricedFor(1, 6);
    fireEvent.click(shown);
    expect(await screen.findByText(fmt(t.errors.priceChanged, { credits: "6" }))).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    pressAnswer = { status: 200, body: { ok: true } };
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "6" }) }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.method === "POST");
    expect(b.body?.max_credits).toBe(6);
    expect(b.body?.idempotency_key).not.toBe(a.body?.idempotency_key);
  });

  it("a press that never arrived is retried with the same key, so it can never hold twice", async () => {
    let fail = true;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && fail) {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        throw new TypeError("network");
      }
      return real(url, init);
    });
    mount();
    tick(1);
    const button = await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "5" }) });
    fireEvent.click(button);
    expect(await screen.findByText(t.errors.failed)).toBeTruthy();
    fail = false;
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "5" }) }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.method === "POST");
    expect(b.body?.idempotency_key).toBe(a.body?.idempotency_key);
  });

  it("insufficient credits are said with the person's own numbers", async () => {
    pressAnswer = { status: 402, body: { error: "insufficient_credits", needed: 5, available: 2 } };
    mount();
    tick(1);
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "5" }) }));
    expect(await screen.findByText("Not enough credits: 5 needed, 2 available.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a slow answer for an earlier selection never labels the button (latest request wins)", async () => {
    let releaseFirst: (() => void) | null = null;
    const real = globalThis.fetch;
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && n++ === 0) {
        await new Promise<void>((r) => (releaseFirst = r));
        return new Response(JSON.stringify({ quote: pricedFor(1, 99), queue: true }), { status: 200 });
      }
      return real(url, init);
    });
    mount();
    tick(1);
    await waitFor(() => expect(releaseFirst).not.toBeNull());
    quote = pricedFor(2, 8);
    tick(2);
    await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "8" }) });
    releaseFirst!();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: fmt(t.priceButton, { credits: "99" }) })).toBeNull();
    expect(screen.getByRole("button", { name: fmt(t.priceButton, { credits: "8" }) })).toBeTruthy();
  });

  it("while a request is running nothing can be picked or pressed", () => {
    const running: RequestRow = { id: "r1", status: "running", clipCount: 2, quotedCredits: 8, chargedCredits: null, errorCode: null, createdAt: "2026-10-02T10:00:00Z", finishedAt: null, clips: [] };
    mount({ requests: [running] });
    expect(screen.getByRole("status").textContent).toBe(fmt(t.status.running, { done: "0", n: "2" }));
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).every((b) => b.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: /credits|included/i })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a finished request says what was made and what it cost, with links only to clips that exist", () => {
    const done: RequestRow = {
      id: "r1", status: "partial", clipCount: 2, quotedCredits: 8, chargedCredits: 5, errorCode: "cut_failed",
      createdAt: "2026-10-02T10:00:00Z", finishedAt: "2026-10-02T10:05:00Z",
      clips: [
        { requestId: "r1", ordinal: 1, first: "s000", last: "s000", startS: 0, endS: 20, durationS: 20, status: "rendered", clipVideoId: "run-aaaaaaaaaaaaaaaaaaaa", errorCode: null, captions: { youtube: "T #Shorts" } },
        { requestId: "r1", ordinal: 2, first: "s004", last: "s004", startS: 45, endS: 70, durationS: 25, status: "failed", clipVideoId: null, errorCode: "master_changed", captions: null },
      ],
    };
    mount({ requests: [done], hrefs: { "run-aaaaaaaaaaaaaaaaaaaa": "/news/videos/run-aaaaaaaaaaaaaaaaaaaa" } });
    expect(screen.getAllByText(fmt(t.status.partial, { made: "1", n: "2", credits: "5" })).length).toBeGreaterThan(0);
    expect(screen.getByText(t.failures.master_changed)).toBeTruthy();
    const link = screen.getByRole("link", { name: t.openClip }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/news/videos/run-aaaaaaaaaaaaaaaaaaaa");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(t.captionsReady)).toBeTruthy();
  });

  it("a video with no whole-scene window says there is nothing to cut", () => {
    mount({ proposals: proposeClips({ scenes: [{ id: "s000", start_s: 0, end_s: 8 }] }, []) });
    expect(screen.getByText(t.noProposals)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("is complete in Russian and Uzbek too", () => {
    for (const lang of ["ru", "uz"] as const) {
      cleanup();
      mount({ labels: dictionaries[lang].repurpose });
      expect(screen.getByText(dictionaries[lang].repurpose.lead)).toBeTruthy();
      expect(screen.getByText(dictionaries[lang].repurpose.retentionNotMeasured)).toBeTruthy();
    }
  });
});
