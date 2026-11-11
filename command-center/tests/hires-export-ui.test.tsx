// @vitest-environment jsdom
/**
 * 1440p and 4K in "Sizes to export" (migration 0132, NIGHTSHIFT_HIRES_EXPORT: the page passes `hires`; default off):
 * the picker's paid boxes, the server's price under them (HiresExportQuote), and Export with a paid size.
 *
 * What would break without these: a paid size offered while the switch is off; a price shown before the server quoted
 * it, or Export spending before the person said yes to it; a yes surviving a change of the sizes or of the quote; a
 * paid size sent without the number the person confirmed, or with another; a video longer than a paid size allows, or a
 * 60 fps project, being exportable in 4K; and a refusal (not on sale, too long, not allowed, too few credits, a read that
 * failed) passing without its sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/chronos/editor/p" }));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { ExportRatioPicker } from "@/components/editor/ExportRatioPicker";
import { HiresExportQuote, type HiresConfirmation } from "@/components/editor/HiresExportQuote";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { newDocForAsset, type EditorAsset, type EditorError } from "@/lib/editor";
import type { HiresPresetId, HiresQuote } from "@/lib/hiresExport/limits";
import type { EditorResult } from "@/components/editor/editorApi";

const te = en.editor;
const hx = te.exportHires;
const er = te.exportRatios;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

const QUOTE = (frame: HiresPresetId, over: Partial<HiresQuote> = {}): HiresQuote => ({
  frame, tier: frame.endsWith("2160p") ? "2160p" : "1440p", durationS: 10, minutes: 1, maxS: frame.endsWith("2160p") ? 180 : 300,
  tooLong: false, maxFps: frame.endsWith("2160p") ? 30 : 60, tooFast: false, fps: 30, onSale: true,
  creditsPerMinute: frame.endsWith("2160p") ? 12 : 6, credits: frame.endsWith("2160p") ? 12 : 6, hold: frame.endsWith("2160p") ? 12 : 6,
  speedCurve: false, available: 100, exempt: false, mayPay: true,
  ...over,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let quoteFor: (frame: HiresPresetId) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const posts = () =>
  fetchMock.mock.calls
    .filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith("/exports"))
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, unknown>);
const quoteUrls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/exports/quote"));

beforeEach(() => {
  let n = 0;
  quoteFor = (frame) => json({ quote: QUOTE(frame) });
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/exports/quote")) return quoteFor(new URL(u, "http://x").searchParams.get("frame") as HiresPresetId);
    if (u.endsWith("/exports") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { frames: string[] };
      return json({ exports: body.frames.map((frame) => ({ frame, id: `e${++n}`, status: "queued" })) }, 201);
    }
    return json({ error: "failed" }, 502);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wrap = (ui: ReactNode) => render(<I18nProvider locale="en">{ui}</I18nProvider>);
function editor(props: Partial<ComponentProps<typeof TimelineEditor>> = {}) {
  return wrap(
    <TimelineEditor projectId={PID} title="Trip" rev={1} doc={newDocForAsset(VIDEO)!} exports={[]} assets={{ [A]: VIDEO }} videos={[VIDEO]} {...props} />,
  );
}
const ratios = () => document.querySelector("details[data-export-ratios]") as HTMLDetailsElement | null;
const box = (name: string) => screen.getByRole("checkbox", { name: (n) => n.startsWith(name) }) as HTMLInputElement;
const exportButton = () => screen.getByRole("button", { name: te.export }) as HTMLButtonElement;
const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const valuesIn = (el: Element) => [...el.querySelectorAll("input[type=checkbox]")].map((b) => (b as HTMLInputElement).value);

describe("the picker's paid sizes", () => {
  const base = { width: 1920, height: 1080, totalS: 10, selected: ["project"] as const, blocked: [], onChange: () => {} };

  it("are marked paid, with their size in pixels", () => {
    wrap(<ExportRatioPicker {...base} selected={["project"]} choices={["square_1080", "youtube_1440p", "vertical_2160p"]} />);
    ratios()!.setAttribute("open", "");
    expect(box(hx.names.youtube_1440p).closest("label")!.textContent).toContain(hx.paidTag);
    expect(box(hx.names.vertical_2160p).closest("label")!.textContent).toContain(fmt(er.size, { w: 2160, h: 3840 }));
    expect(box(te.exportPreset.names.square_1080).closest("label")!.textContent).not.toContain(hx.paidTag);
  });

  it("cannot be ticked over their length cap or their frame rate, and say why", async () => {
    const onChange = vi.fn();
    wrap(
      <ExportRatioPicker
        {...base}
        selected={["project"]}
        totalS={200}
        fps={60}
        choices={["youtube_1440p", "youtube_2160p", "vertical_2160p"]}
        overCap={["youtube_2160p"]}
        tooFast={["vertical_2160p"]}
        onChange={onChange}
      />,
    );
    ratios()!.setAttribute("open", "");
    expect(box(hx.names.youtube_2160p).disabled).toBe(true);
    expect(box(hx.names.vertical_2160p).disabled).toBe(true);
    expect(box(hx.names.youtube_1440p).disabled).toBe(false);
    await press(box(hx.names.youtube_2160p));
    await press(box(hx.names.vertical_2160p));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(fmt(hx.tooLong, { name: hx.names.youtube_2160p, max: "3:00", length: "3:20" }))).toBeTruthy();
    expect(screen.getByText(fmt(hx.tooFast, { name: hx.names.vertical_2160p, max: 30, fps: 60 }))).toBeTruthy();
  });
});

describe("the price (HiresExportQuote)", () => {
  type Load = (id: string, rev: number, frame: HiresPresetId) => Promise<EditorResult<HiresQuote>>;
  function quote(frames: HiresPresetId[], load: Load, dirty = false) {
    const seen: HiresConfirmation[] = [];
    const r = wrap(<HiresExportQuote projectId={PID} rev={4} dirty={dirty} frames={frames} onChange={(c) => seen.push(c)} load={load} />);
    return { ...r, seen, last: () => seen[seen.length - 1] };
  }
  const ok = (over: Partial<HiresQuote> = {}): Load => async (_id, _rev, f) => ({ ok: true, value: QUOTE(f, over) });

  it("shows the server's numbers, and is ready only after the person ticks the yes", async () => {
    const load = vi.fn(ok());
    const q = quote(["youtube_1440p", "youtube_2160p"], load);
    await waitFor(() =>
      expect(screen.getByText(fmt(hx.line, { name: hx.names.youtube_2160p, minutes: 1, perMinute: "12", credits: "12", hold: "12" }))).toBeTruthy(),
    );
    expect(load.mock.calls.map((c) => c.slice(1))).toEqual([[4, "youtube_1440p"], [4, "youtube_2160p"]]);
    expect(screen.getByText(fmt(hx.total, { credits: "18", hold: "18" }))).toBeTruthy();
    expect(q.last().ready).toBe(false);
    await press(screen.getByRole("checkbox", { name: fmt(hx.confirm, { credits: "18" }) }));
    expect(q.last()).toEqual({ ready: true, key: "4|youtube_1440p,youtube_2160p", maxCredits: { youtube_1440p: 6, youtube_2160p: 12 } });
  });

  it("says each refusal with its sentence and offers no yes", async () => {
    const cases: [Partial<HiresQuote>, string][] = [
      [{ onSale: false, credits: null, creditsPerMinute: null }, fmt(hx.notOnSale, { name: hx.names.youtube_2160p })],
      [{ tooLong: true, durationS: 200 }, fmt(hx.tooLong, { name: hx.names.youtube_2160p, max: "3:00", length: "3:20" })],
      [{ tooFast: true, fps: 60 }, fmt(hx.tooFast, { name: hx.names.youtube_2160p, max: 30, fps: 60 })],
      [{ mayPay: false }, fmt(hx.notAllowed, { name: hx.names.youtube_2160p })],
      [{ available: 5 }, fmt(hx.short, { name: hx.names.youtube_2160p, hold: "12", available: "5" })],
      [{ credits: 4, hold: 30, available: 20 }, fmt(hx.short, { name: hx.names.youtube_2160p, hold: "30", available: "20" })],
      [{ speedCurve: true }, fmt(hx.speedCurve, { name: hx.names.youtube_2160p })],
    ];
    for (const [over, sentence] of cases) {
      const q = quote(["youtube_2160p"], ok(over));
      await waitFor(() => expect(screen.getByText(sentence)).toBeTruthy());
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(q.seen.every((c) => !c.ready)).toBe(true);
      q.unmount();
    }
  });

  it("a read that failed says so and asks again on request; unsaved changes ask nothing", async () => {
    let fail = true;
    const load = vi.fn<Load>(async (_id, _rev, f) => (fail ? { ok: false, error: "failed" as EditorError } : { ok: true, value: QUOTE(f) }));
    quote(["vertical_1440p"], load);
    await waitFor(() => expect(screen.getByText(`${fmt(hx.failed, { name: hx.names.vertical_1440p })} ${te.errors.failed}`)).toBeTruthy());
    fail = false;
    await press(screen.getByRole("button", { name: hx.retry }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: fmt(hx.confirm, { credits: "6" }) })).toBeTruthy());
    cleanup();
    const idle = vi.fn<Load>(ok());
    quote(["vertical_1440p"], idle, true);
    expect(screen.getByText(hx.saveFirst)).toBeTruthy();
    expect(idle).not.toHaveBeenCalled();
  });

  it("with the platform's job minimum, the charge and the hold are both said, and the yes carries the CHARGE", async () => {
    const q = quote(["youtube_2160p"], ok({ creditsPerMinute: 4, credits: 4, hold: 30 }));
    await waitFor(() =>
      expect(screen.getByText(fmt(hx.line, { name: hx.names.youtube_2160p, minutes: 1, perMinute: "4", credits: "4", hold: "30" }))).toBeTruthy(),
    );
    expect(screen.getByText(fmt(hx.total, { credits: "4", hold: "30" }))).toBeTruthy();
    expect(hx.line).toMatch(/charged.*held while it renders/);
    await press(screen.getByRole("checkbox", { name: fmt(hx.confirm, { credits: "4" }) }));
    expect(q.last()).toEqual({ ready: true, key: "4|youtube_2160p", maxCredits: { youtube_2160p: 4 } });
  });

  it("the exempt workspace is told nothing is held, and its yes carries the quoted number", async () => {
    const q = quote(["youtube_2160p"], ok({ exempt: true, available: null }));
    await waitFor(() => expect(screen.getByText(fmt(hx.exemptLine, { name: hx.names.youtube_2160p }))).toBeTruthy());
    await press(screen.getByRole("checkbox"));
    expect(q.last()).toEqual({ ready: true, key: "4|youtube_2160p", maxCredits: { youtube_2160p: 12 } });
  });
});

describe("a project above 1080p and a speed curve in the editor", () => {
  const big = () => ({ ...newDocForAsset(VIDEO)!, width: 3840, height: 2160 });

  it("without the size picker, Export of a 4K project is disabled and says what to do", () => {
    editor({ doc: big() });
    expect(exportButton().disabled).toBe(true);
    expect(screen.getAllByText(hx.ownTooBigOff).length).toBeGreaterThan(0);
  });

  it("with the sizes but without the paid ones, a free smaller size can still be exported", async () => {
    editor({ multiRatio: true, doc: big() });
    ratios()!.setAttribute("open", "");
    const own = screen.getByRole("checkbox", { name: (n) => n.startsWith(te.exportRatios.own) }) as HTMLInputElement;
    expect([own.checked, own.disabled]).toEqual([false, true]);
    expect(exportButton().disabled).toBe(true);
    await press(box(te.exportPreset.names.youtube_1080p));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1, frames: ["youtube_1080p"] }]);
  });

  it("with the paid sizes, a 4K project is exported in the paid 4K size after the price and the yes", async () => {
    editor({ multiRatio: true, hires: true, doc: big() });
    ratios()!.setAttribute("open", "");
    expect(screen.getAllByText(hx.ownTooBig).length).toBeGreaterThan(0);
    await press(box(hx.names.youtube_2160p));
    await press(await screen.findByRole("checkbox", { name: fmt(hx.confirm, { credits: "12" }) }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1, frames: ["youtube_2160p"], maxCredits: { youtube_2160p: 12 } }]);
  });

  it("a video with a speed curve cannot tick a paid size, and says why", () => {
    const d = newDocForAsset(VIDEO)!;
    const v = (d.tracks as { clips: Record<string, unknown>[] }[]).find((tr) => tr.clips.some((c) => "asset_id" in c))!;
    v.clips[0].speed_curve = [{ at: 0, speed: 0.5 }, { at: 1, speed: 1 }];
    editor({ multiRatio: true, hires: true, doc: d });
    ratios()!.setAttribute("open", "");
    for (const n of [hx.names.youtube_1440p, hx.names.vertical_2160p]) expect(box(n).disabled).toBe(true);
    expect(box(te.exportPreset.names.square_1080).disabled).toBe(false);
    expect(screen.getByText(hx.speedCurveAll)).toBeTruthy();
  });
});

describe("the editor with the hires switch", () => {
  it("off: no paid size is offered and nothing is quoted", () => {
    editor({ multiRatio: true });
    expect(valuesIn(ratios()!)).toEqual(["project", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]);
    expect(quoteUrls()).toEqual([]);
  });

  it("on: Export waits for the server's price and the yes, then sends that number, and the sizes in the list's order", async () => {
    editor({ multiRatio: true, hires: true });
    ratios()!.setAttribute("open", "");
    expect(valuesIn(ratios()!).slice(-4)).toEqual(["youtube_1440p", "vertical_1440p", "youtube_2160p", "vertical_2160p"]);
    await press(box(hx.names.youtube_2160p));
    await waitFor(() => expect(quoteUrls()).toEqual([`/api/editor/projects/${PID}/exports/quote?rev=1&frame=youtube_2160p`]));
    expect(exportButton().disabled).toBe(true);
    expect(screen.getAllByText(te.errors.quote_required).length).toBeGreaterThan(0);
    await press(await screen.findByRole("checkbox", { name: fmt(hx.confirm, { credits: "12" }) }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1, frames: ["project", "youtube_2160p"], maxCredits: { youtube_2160p: 12 } }]);
  });

  it("unticking the paid size takes the yes back, and ticking it again asks again", async () => {
    editor({ multiRatio: true, hires: true });
    ratios()!.setAttribute("open", "");
    await press(box(hx.names.youtube_1440p));
    await press(await screen.findByRole("checkbox", { name: fmt(hx.confirm, { credits: "6" }) }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    await press(box(hx.names.youtube_1440p));
    await press(box(hx.names.youtube_1440p));
    expect(exportButton().disabled).toBe(true);
    const yes = await screen.findByRole("checkbox", { name: fmt(hx.confirm, { credits: "6" }) });
    expect((yes as HTMLInputElement).checked).toBe(false);
    expect(quoteUrls()).toHaveLength(2);
  });

  it("a 60 fps project cannot tick 4K, and can tick 1440p", () => {
    editor({ multiRatio: true, hires: true, doc: { ...newDocForAsset(VIDEO)!, fps: 60 } });
    ratios()!.setAttribute("open", "");
    expect(box(hx.names.youtube_2160p).disabled).toBe(true);
    expect(box(hx.names.vertical_2160p).disabled).toBe(true);
    expect(box(hx.names.youtube_1440p).disabled).toBe(false);
    expect(screen.getByText(fmt(hx.tooFast, { name: hx.names.youtube_2160p, max: 30, fps: 60 }))).toBeTruthy();
  });
});
