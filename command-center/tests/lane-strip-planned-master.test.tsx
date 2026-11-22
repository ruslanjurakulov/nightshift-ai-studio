// @vitest-environment jsdom
/**
 * The strip's two additions for a live film (components/studio-canvas/LaneStrip): a "planned" length and a master slot. What would
 * break without these: a plan's share drawn like a measured file (or like a request's "~"), a total built on planned lengths
 * called "known", the master drawn as one more clip on the video track, or its control (a download) missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
  id, track: "video", name: id, tag: `tag-${id}`, status: "ok", statusWords: "Made", length: { seconds: 4, basis: "measured" }, thumb: null, made: true, ...extra,
});
const strip = (rows: LaneRow[], props: Partial<Parameters<typeof LaneStrip>[0]> = {}) => (
  <I18nProvider locale="en">
    <LaneStrip rows={rows} selected={null} onPick={() => {}} {...props} />
  </I18nProvider>
);

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(cleanup);

describe("a planned length", () => {
  it("is drawn apart from measured and requested: its own class, the word 'plan', no '~', and 'planned' in its label", () => {
    render(strip([row("p", { length: { seconds: 8, basis: "planned" } }), row("m"), row("r", { length: { seconds: 5, basis: "requested" }, made: false, status: "run" })]));
    const p = screen.getByTestId("lane-seg-p");
    expect(p.className).toContain("is-planned");
    expect(p.dataset.length).toBe("planned");
    expect(p.textContent).toContain("plan");
    expect(p.textContent).not.toContain("~");
    expect(p.getAttribute("aria-label")).toContain("planned");
    expect(screen.getByTestId("lane-seg-m").className).not.toContain("is-planned");
    expect(screen.getByTestId("lane-seg-r").className).not.toContain("is-planned");
    expect(screen.getByTestId("lane-seg-r").textContent).toContain("~");
  });

  it("a total that leans on a planned length says 'Planned length', never 'Known length'", () => {
    render(strip([row("p", { length: { seconds: 8, basis: "planned" } })]));
    const total = screen.getByTestId("lane-total");
    expect(total.dataset.planned).toBe("true");
    expect(total.textContent).toContain("Planned length");
    expect(total.textContent).not.toContain("Known length");
  });

  it("the legend names 'plan' only when a planned length is on the lane", () => {
    const { unmount } = render(strip([row("m")]));
    expect(document.querySelector(".cv-lane-meta.is-legend")!.textContent).not.toContain(l.legendPlanned);
    unmount();
    render(strip([row("p", { length: { seconds: 8, basis: "planned" } })]));
    expect(document.querySelector(".cv-lane-meta.is-legend")!.textContent).toContain(l.legendPlanned);
  });
});

describe("the master slot", () => {
  const master = row("m:master", { name: "Final video", statusWords: "Ready", length: { seconds: 14, basis: "measured" } });

  it("is drawn after the tracks, on neither of them, with the caller's control under it", () => {
    render(strip([row("a"), row("v", { track: "audio" })], { master, masterAction: <button type="button">Download</button> }));
    const cell = screen.getByTestId("lane-master");
    for (const ol of document.querySelectorAll("ol.cv-track")) expect(ol.contains(cell)).toBe(false);
    expect(within(cell).getByText("Final video")).toBeTruthy();
    expect(within(cell).getByRole("button", { name: "Download" })).toBeTruthy();
    expect(cell.compareDocumentPosition(document.querySelector("ol.cv-track.t-audio")!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("a press hands back the master's id", () => {
    const onPick = vi.fn();
    render(strip([row("a")], { master, onPick }));
    fireEvent.click(screen.getByTestId("lane-seg-m:master"));
    expect(onPick).toHaveBeenCalledWith("m:master");
  });

  it("without a master there is no slot, and the canvas's lane is unchanged", () => {
    render(strip([row("a")]));
    expect(screen.queryByTestId("lane-master")).toBeNull();
    expect(document.querySelector(".cv-lane-body")!.className).not.toContain("has-master");
  });

  it("a master not made yet shows its words and no length", () => {
    render(strip([row("a")], { master: row("m:master", { name: "Final video", statusWords: "Not assembled yet", made: false, status: "idle", length: null }) }));
    const cell = screen.getByTestId("lane-master");
    expect(cell.textContent).toContain("Not assembled yet");
    expect(cell.querySelector(".cv-pill-len")).toBeNull();
  });
});
