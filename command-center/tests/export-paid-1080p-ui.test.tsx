// @vitest-environment jsdom
/**
 * Exports up to 1080p sold by the started minute (migration 0136) in the editor: the quote of every size once the server says
 * they are sold (export_needs_quote), "N credits charged, M held while it renders" for 1080p too, the confirmation, and the
 * confirmed number on the request.
 *
 * What would break without these: the editor staying on the free request after the server refused it (a dead button); a
 * sold 1080p size exported without the person's yes, or with another number; a free size asking for a yes; and the page
 * without the price route (switches off) offering an Export that can only be refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/chronos/editor/p" }));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { HiresExportQuote, type HiresConfirmation } from "@/components/editor/HiresExportQuote";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { newDocForAsset, type EditorAsset } from "@/lib/editor";
import type { ExportQuote, HiresQuote, QuotableFrame } from "@/lib/hiresExport/limits";
import type { EditorResult } from "@/components/editor/editorApi";

const te = en.editor;
const hx = te.exportHires;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

const SOLD = (frame: QuotableFrame, over: Partial<HiresQuote> = {}): HiresQuote => ({
  frame, tier: "1080p", durationS: 10, minutes: 1, maxS: 1800, tooLong: false, maxFps: 60, tooFast: false, fps: 30, onSale: true,
  creditsPerMinute: 1, credits: 1, hold: 30, speedCurve: false, curveSold: true, available: 100, exempt: false, mayPay: true, ...over,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let sold = true;
let fetchMock: ReturnType<typeof vi.fn>;
const posts = () =>
  fetchMock.mock.calls
    .filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith("/exports"))
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  sold = true;
  let n = 0;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/exports/quote")) {
      const frame = new URL(u, "http://x").searchParams.get("frame") as QuotableFrame;
      return json(sold ? { quote: SOLD(frame) } : { free: true, frame });
    }
    if (u.endsWith("/exports") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { frames?: string[]; maxCredits?: Record<string, number> };
      // The server with the 1080p price set: a request without a confirmed number is refused.
      if (sold && !body.maxCredits) return json({ error: "export_needs_quote" }, 409);
      if (!body.frames) return json({ id: `e${++n}`, status: "queued" }, 201);
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
const exportButton = () => screen.getByRole("button", { name: te.export }) as HTMLButtonElement;
const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe("the quote of sizes up to 1080p", () => {
  type Load = (id: string, rev: number, frame: QuotableFrame) => Promise<EditorResult<ExportQuote>>;
  function quote(frames: QuotableFrame[], load: Load) {
    const seen: HiresConfirmation[] = [];
    wrap(<HiresExportQuote projectId={PID} rev={2} dirty={false} frames={frames} onChange={(c) => seen.push(c)} load={load} />);
    return () => seen[seen.length - 1];
  }

  it("says 1 credit charged and 30 held for each sold size, and the yes carries the charges", async () => {
    const last = quote(["project", "square_1080"], async (_i, _r, f) => ({ ok: true, value: { free: false, quote: SOLD(f) } }));
    await waitFor(() =>
      expect(screen.getByText(fmt(hx.line, { name: te.exportRatios.own, minutes: 1, perMinute: "1", credits: "1", hold: "30" }))).toBeTruthy(),
    );
    expect(screen.getByText(fmt(hx.line, { name: te.exportPreset.names.square_1080, minutes: 1, perMinute: "1", credits: "1", hold: "30" }))).toBeTruthy();
    expect(screen.getByText(fmt(hx.introSold, { max1440: "5:00", max2160: "3:00" }))).toBeTruthy();
    expect(screen.getByText(fmt(hx.total, { credits: "2", hold: "60" }))).toBeTruthy();
    expect(last().ready).toBe(false);
    await press(screen.getByRole("checkbox", { name: fmt(hx.confirm, { credits: "2" }) }));
    expect(last()).toEqual({ ready: true, key: "2|project,square_1080", maxCredits: { project: 1, square_1080: 1 } });
  });

  it("a free size says so and asks for no yes", async () => {
    const last = quote(["project"], async (_i, _r, f) => ({ ok: true, value: { free: true, frame: f } }));
    await waitFor(() => expect(screen.getByText(fmt(hx.freeLine, { name: te.exportRatios.own }))).toBeTruthy());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(last()).toEqual({ ready: true, key: "2|project", maxCredits: {} });
  });

  it("every new sentence is in three languages", () => {
    for (const d of [en, ru, uz]) {
      for (const k of ["freeLine", "introSold", "soldNoQuote"] as const) expect(d.editor.exportHires[k], k).toBeTruthy();
      expect(d.editor.errors.export_needs_quote).toBeTruthy();
      expect(d.editor.exportHires.line).toMatch(/\{credits\}.*\{hold\}/);
    }
  });
});

describe("the editor once the server says sizes up to 1080p are sold", () => {
  it("with the size picker and the paid sizes: the plain Export is refused, the price is asked, and the yes is sent", async () => {
    editor({ multiRatio: true, hires: true });
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1 }]);                                        // the free request, as before the price
    await waitFor(() => expect(screen.getAllByText(te.errors.export_needs_quote).length).toBeGreaterThan(0));
    await press(await screen.findByRole("checkbox", { name: fmt(hx.confirm, { credits: "1" }) }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    await press(exportButton());
    expect(posts()[1]).toEqual({ rev: 1, frames: ["project"], maxCredits: { project: 1 } });
  });

  it("without the price route (switches off) Export says the price cannot be shown, instead of a button that can only fail", async () => {
    editor();
    await press(exportButton());
    await waitFor(() => expect(exportButton().disabled).toBe(true));
    expect(screen.getAllByText(hx.soldNoQuote).length).toBeGreaterThan(0);
  });

  it("while the price is NULL nothing changes: one free request, no price asked", async () => {
    sold = false;
    editor({ multiRatio: true, hires: true });
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1 }]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports/quote"))).toEqual([]);
  });
});
