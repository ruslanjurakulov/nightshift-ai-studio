// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { coerceTimelineFilm, type TimelineFilm } from "../lib/studio/timeline";
import { studioTimelineEn } from "../lib/i18n/studio-timeline/en";
import { studioTimelineRu } from "../lib/i18n/studio-timeline/ru";
import { studioTimelineUz } from "../lib/i18n/studio-timeline/uz";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz", film: null as TimelineFilm | null,
  urls: new Map(), refresh: vi.fn(), reload: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { ru } = await import("../lib/i18n/ru");
  const { uz } = await import("../lib/i18n/uz");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: { en, ru, uz }[h.locale], locale: h.locale, fmt }) };
});
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (path: string) => `/synthetic${path}` }));
vi.mock("@/components/studio-canvas/StudioCanvas", () => ({ BAR_SLOT_ID: "unused-scrub-bar", ProjectBar: () => null }));
// Quote controls and their side effects are outside this scrubbing-only test.
vi.mock("@/components/studio-timeline/AssemblePanel", () => ({ AssemblePanel: () => null }));
vi.mock("@/components/studio-timeline/useTimelineData", () => ({
  useTimelineFilm: () => ({ load: { state: "ready", film: h.film }, stale: false, reload: h.reload, replace: h.replace }),
  useFilmList: () => ({ load: { state: "ready", films: [] }, reload: h.reload }),
  useMediaUrls: () => ({ urls: h.urls, refresh: h.refresh }),
  usePeaks: () => null,
}));
const { StudioTimeline } = await import("../components/studio-timeline/StudioTimeline");

beforeEach(() => {
  const sql = readFileSync(resolve("../supabase/migrations/0166_films_core.sql"), "utf8");
  const body = sql.slice(sql.indexOf("create or replace function public.film_limits()"));
  const limits = Object.fromEntries([...body.slice(body.indexOf("jsonb_build_object("), body.indexOf("$$;")).matchAll(/'([a-z_]+)',\s*(\d+)/g)].map((match) => [match[1], Number(match[2])]));
  h.film = coerceTimelineFilm({
    film: { id: "0f000000-0000-4000-8000-00000000000f", org_id: "0a000000-0000-4000-8000-00000000000a", channel_id: null,
      title: "Synthetic scrub readout", source_kind: "topic", source_text: "Synthetic", language: "en", aspect: "16:9", target_seconds: 300,
      status: "draft", version: 1, created_at: "2026-11-18T00:00:00Z", updated_at: "2026-11-18T00:00:00Z", archived_at: null },
    editable: true, totals: { scenes: 1, planned_seconds: 8 }, refs: [], takes: [], events: [], limits,
    scenes: [{ id: "51000000-0000-4000-8000-000000000001", position: 0, title: "Synthetic scene", narration: "", visual_prompt: "Synthetic room",
      negative_prompt: "", planned_seconds: 8, shot_count: 1, first_frame: "keyframe", first_frame_asset_id: null, last_frame: "none", last_frame_asset_id: null,
      keyframe_model: null, clip_model: null, clip_params: {}, transition_in: null, current_version: null, status: "draft", refs: [], takes: [] }],
  });
  expect(h.film).not.toBeNull();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in scrubbing test"); }));
  class Pointer extends MouseEvent { pointerId = 1; }
  vi.stubGlobal("PointerEvent", Pointer);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const strings = { en: studioTimelineEn, ru: studioTimelineRu, uz: studioTimelineUz };
function mount(locale: typeof h.locale) {
  h.locale = locale;
  render(<StudioTimeline filmStudio filmId={h.film!.view.film.id} />);
  return screen.getByRole("slider", { name: strings[locale].ruler });
}
// Existing default zoom is 22 px/s, with an 8 px ruler inset and zero jsdom scroll/left.
const scrub = (ruler: HTMLElement, seconds: number) => fireEvent.pointerDown(ruler, { clientX: 8 + seconds * 22, pointerId: 1 });

describe("scrubbing time readout only", () => {
  it.each([
    ["en", "Hours 0, minutes 0, seconds 3, frames 13"],
    ["ru", "Часы: 0, минуты: 0, секунды: 3, кадры: 13"],
    ["uz", "Soat: 0, daqiqa: 0, soniya: 3, kadr: 13"],
  ] as const)("exposes readable units in %s while preserving the visual timecode", (locale, spoken) => {
    const ruler = mount(locale);
    ruler.focus();
    scrub(ruler, 3.52);
    expect(screen.getByTestId("timecode").textContent).toBe("00:00:03:13");
    expect(ruler.getAttribute("aria-valuetext")).toBe(spoken);
    expect(ruler.getAttribute("aria-valuenow")).toBe("3.52");
    expect(document.activeElement).toBe(ruler);
  });

  it("does not emit value attribute mutations when repeated scrubs stay in the displayed frame", async () => {
    const ruler = mount("en");
    scrub(ruler, 0.499);
    expect(screen.getByTestId("timecode").textContent).toBe("00:00:00:12");
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(ruler, { attributes: true, attributeFilter: ["aria-valuenow", "aria-valuetext"] });
    await act(async () => { scrub(ruler, 0.501); scrub(ruler, 0.501); });
    expect(screen.getByTestId("timecode").textContent).toBe("00:00:00:12");
    expect(changes).toHaveLength(0);
    await act(async () => { scrub(ruler, 0.521); });
    expect(ruler.getAttribute("aria-valuenow")).toBe("0.52");
    expect(ruler.getAttribute("aria-valuetext")).toBe("Hours 0, minutes 0, seconds 0, frames 13");
    expect(changes.length).toBeGreaterThan(0);
    observer.disconnect();
  });

  it("keeps a fractional clip endpoint inside the announced slider range", () => {
    const scene = h.film!.view.scenes[0];
    scene.currentVersion = 1;
    h.film!.sceneTakes.set(scene.id, [{ id: "synthetic-take", kind: "clip", status: "completed", version: 1,
      shotIndex: 0, durationS: 8.49, resultAssetId: "synthetic-asset" }]);
    const ruler = mount("en");
    scrub(ruler, 100);
    expect(ruler.getAttribute("aria-valuemax")).toBe("8.49");
    expect(ruler.getAttribute("aria-valuenow")).toBe("8.48");
    expect(Number(ruler.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(ruler.getAttribute("aria-valuemax")));
    expect(screen.getByTestId("timecode").textContent).toBe("00:00:08:12");
  });
});
