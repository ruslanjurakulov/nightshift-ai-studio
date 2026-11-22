// @vitest-environment jsdom
/**
 * The timeline strip on its own (components/studio-canvas/LaneStrip), fed plain rows as a live film view will feed it, with no
 * canvas behind it. What would break without these: a caller whose rows are not cards (takes) getting nothing drawn, or its rows
 * reordered; a lane with no known length printing 00:00:00:00 as if it measured nothing (rule 5); a feed that says what landed
 * not being animated, or animated again on every refresh; and a press that does not hand back the row's id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/studio",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { LaneStrip } from "@/components/studio-canvas/LaneStrip";
import type { LaneRow } from "@/lib/studio/lane";

const l = dictionaries.en.studioCanvas.lane;
const row = (id: string, extra: Partial<LaneRow> = {}): LaneRow => ({
  id,
  track: "video",
  name: id,
  tag: `tag-${id}`,
  status: "ok",
  statusWords: "Made",
  length: { seconds: 4, basis: "measured" },
  thumb: null,
  made: true,
  ...extra,
});
const strip = (rows: LaneRow[], props: Partial<Parameters<typeof LaneStrip>[0]> = {}) => (
  <I18nProvider locale="en">
    <LaneStrip rows={rows} selected={null} onPick={() => {}} {...props} />
  </I18nProvider>
);
const seg = (id: string) => screen.getByTestId(`lane-seg-${id}`);

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(cleanup);

describe("the strip draws rows, whoever read them", () => {
  it("each row on its track, in the order given (S3 · T2 before S1 · T1 if that is the order sent), each to scale", () => {
    render(strip([row("s3t2"), row("s1t1", { length: { seconds: 2, basis: "measured" } }), row("narr", { track: "audio", length: { seconds: 6, basis: "measured" } })]));
    const video = [...document.querySelectorAll('ol[aria-label="Video"] [data-lane-seg]')].map((e) => (e as HTMLElement).dataset.laneSeg);
    expect(video).toEqual(["s3t2", "s1t1"]);
    expect(seg("narr").closest("ol")!.getAttribute("aria-label")).toBe(l.audio);
    // 28 px a second: a 4 s take is 112 px wide and the next starts there.
    expect((seg("s1t1").parentElement as HTMLElement).style.left).toBe("112px");
    expect(screen.getByTestId("lane-total").textContent).toContain("00:00:06:00");
  });

  it("with no length known anywhere, the total says so in words, never 00:00:00:00", () => {
    render(strip([row("a", { length: null, made: false, status: "idle" })]));
    expect(screen.getByTestId("lane-total").textContent).toBe(l.lengthUnknown);
    expect(screen.getByTestId("lane-total").textContent).not.toMatch(/00:00/);
    expect(seg("a").dataset.length).toBe("unknown");
  });

  it("a press hands back the row's id", () => {
    const onPick = vi.fn();
    render(strip([row("take-7")], { onPick }));
    fireEvent.click(seg("take-7"));
    expect(onPick).toHaveBeenCalledWith("take-7");
  });
});

describe("landing", () => {
  it("rows a feed says just landed grow in once; a refresh with the same list does not replay them", () => {
    vi.useFakeTimers();
    try {
      const rows = [row("a"), row("b")];
      const { rerender } = render(strip(rows, { landedIds: [] }));
      expect(seg("b").className).not.toContain("is-new");
      rerender(strip(rows, { landedIds: ["b"] }));
      expect(seg("b").className).toContain("is-new");
      expect(seg("a").className).not.toContain("is-new");
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(seg("b").className).not.toContain("is-new");
      // The same landed list again, with a row's words changed (a poll): no second landing.
      rerender(strip([row("a"), row("b", { statusWords: "Made again" })], { landedIds: ["b"] }));
      expect(seg("b").className).not.toContain("is-new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a feed's list, a row that was not there before is the one that lands; the first rows do not animate", () => {
    const { rerender } = render(strip([row("a")]));
    expect(seg("a").className).not.toContain("is-new");
    rerender(strip([row("a"), row("b")]));
    expect(seg("b").className).toContain("is-new");
    expect(seg("a").className).not.toContain("is-new");
  });
});
