// @vitest-environment jsdom
/**
 * "Sizes to export" in the video editor (components/editor/ExportRatioPicker.tsx and its place in TimelineEditor),
 * behind NIGHTSHIFT_MULTI_RATIO_EXPORT (the page passes `multiRatio`; default off).
 *
 * What would break without these: the picker showing while the switch is off; a plain export's request changing by one
 * byte; a size leaving the browser as anything but an id of the closed list; more sizes asked than can be in flight;
 * a refused size passing without a word (or with the wrong size's name); a size the edit does not fit being
 * exportable; only the newest of several exports being visible; a retry of a failed size exporting ANOTHER size; and a
 * file rendered in the wrong size shown as if it were the one asked for.
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
import { ExportRatioPicker } from "@/components/editor/ExportRatioPicker";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { newDocForAsset, type EditorAsset, type EditorExport } from "@/lib/editor";
import { MAX_EXPORT_FRAMES, type ExportFrameChoice } from "@/lib/multiRatioExport/frames";

const te = en.editor;
const er = te.exportRatios;
const names = te.exportPreset.names;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let answer: (body: Record<string, unknown>) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const posts = () =>
  fetchMock.mock.calls
    .filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith("/exports"))
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  let n = 0;
  // The server with the switch on and 0129 applied: every size is queued.
  answer = (body) =>
    Array.isArray(body.frames)
      ? json({ exports: (body.frames as string[]).map((frame) => ({ frame, id: `e${++n}`, status: "queued" })) }, 201)
      : json({ id: `e${++n}`, status: "queued" }, 201);
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (String(url).endsWith("/exports") && init?.method === "POST") return answer(JSON.parse(String(init.body)));
    // The poll: nothing has changed on the server yet.
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

function editor(props: Partial<ComponentProps<typeof TimelineEditor>> = {}, locale: "en" | "ru" | "uz" = "en") {
  const ui: ReactNode = (
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={newDocForAsset(VIDEO)!} exports={[]} assets={{ [A]: VIDEO }} videos={[VIDEO]} {...props} />
    </I18nProvider>
  );
  return render(ui);
}
const ratios = () => document.querySelector("details[data-export-ratios]") as HTMLDetailsElement | null;
const box = (name: string) => screen.getByRole("checkbox", { name: (n) => n.startsWith(name) }) as HTMLInputElement;
const exportButton = () => screen.getByRole("button", { name: te.export }) as HTMLButtonElement;
const panels = () => [...document.querySelectorAll("[data-export-state]")] as HTMLElement[];
const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe("with the switch off (the default)", () => {
  it("there is no size picker and Export is the plain request it always was", async () => {
    editor();
    expect(ratios()).toBeNull();
    expect(screen.queryByText(er.summaryOwn)).toBeNull();
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1 }]);
    await waitFor(() => expect(panels()).toHaveLength(1));
    expect(panels()[0].querySelector("h2")!.textContent).toBe(te.exportPanel.latest);
  });

  it("an export row that carries a frame is still one plain panel", () => {
    const exports: EditorExport[] = [
      { id: "e2", rev: 1, status: "done", reason: null, durationS: 10, assetId: null, createdAt: null, finishedAt: null, frame: { preset: "square_1080", width: 1080, height: 1080 } },
      { id: "e1", rev: 1, status: "done", reason: null, durationS: 10, assetId: null, createdAt: null, finishedAt: null },
    ];
    editor({ exports });
    expect(panels()).toHaveLength(1);
    expect(panels()[0].querySelector("h2")!.textContent).toBe(te.exportPanel.latest);
  });
});

describe("with the switch on", () => {
  it("offers the project's own size, ticked, and every OTHER format, as real checkboxes in one named group", () => {
    editor({ multiRatio: true });
    const d = ratios()!;
    expect(d.querySelector("summary")!.textContent).toBe(er.summaryOwn);
    d.setAttribute("open", "");
    expect(screen.getByRole("group", { name: er.legend })).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox").filter((b) => d.contains(b)) as HTMLInputElement[];
    // 1920 x 1080 is the project's own size: "YouTube wide 1080p" would be the same picture twice, so it is not offered.
    expect(boxes.map((b) => b.value)).toEqual(["project", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]);
    expect(boxes.filter((b) => b.checked).map((b) => b.value)).toEqual(["project"]);
    for (const b of boxes) expect(b.type).toBe("checkbox");
    // Each box's name carries its size in pixels, so a ratio is never the only thing said.
    expect(box(er.own).closest("label")!.textContent).toContain(fmt(er.size, { w: 1920, h: 1080 }));
    expect(box(names.vertical_1080p).closest("label")!.textContent).toContain(fmt(er.size, { w: 1080, h: 1920 }));
    const hint = document.getElementById(screen.getByRole("group", { name: er.legend }).getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(fmt(er.hint, { max: MAX_EXPORT_FRAMES }));
  });

  it("only the project's own size ticked: the request is the plain one, with no `frames` at all", async () => {
    editor({ multiRatio: true });
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1 }]);
  });

  it("ticking sizes is not an edit: nothing becomes unsaved and nothing is sent until Export", async () => {
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(box(names.square_1080));
    expect(screen.queryByText(te.unsaved)).toBeNull();
    expect(exportButton().disabled).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(0);
    expect(ratios()!.querySelector("summary")!.textContent).toBe(fmt(er.summaryCount, { count: 3 }));
  });

  it("Export asks for one export per ticked size, by id only, and shows a panel for each", async () => {
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(box(names.square_1080));
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1, frames: ["project", "vertical_1080p", "square_1080"] }]);
    await waitFor(() => expect(panels()).toHaveLength(3));
    const heads = panels().map((p) => p.querySelector("h2")!.textContent);
    expect(heads).toContain(fmt(er.panelFor, { name: er.own }));
    expect(heads).toContain(fmt(er.panelFor, { name: `${names.vertical_1080p} · ${fmt(er.size, { w: 1080, h: 1920 })}` }));
    expect(heads).toContain(fmt(er.panelFor, { name: `${names.square_1080} · ${fmt(er.size, { w: 1080, h: 1080 })}` }));
    for (const p of panels()) expect(p.getAttribute("data-export-state")).toBe("queued");
    // While they are on their way nothing more can be started.
    expect(exportButton().disabled).toBe(true);
  });

  it("without the project's own size, only the ticked sizes are asked", async () => {
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.feed_4x5_1080));
    await press(box(er.own));
    await press(exportButton());
    expect(posts()).toEqual([{ rev: 1, frames: ["feed_4x5_1080"] }]);
    await waitFor(() => expect(panels()).toHaveLength(1));
  });

  it("at most three at a time: the other boxes switch off and a sentence says why", async () => {
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(box(names.square_1080));
    expect(box(names.feed_4x5_1080).disabled).toBe(true);
    expect(box(names.youtube_720p).disabled).toBe(true);
    // A ticked box can always be unticked.
    expect(box(names.square_1080).disabled).toBe(false);
    expect(ratios()!.querySelector("[aria-live=polite]")!.textContent).toContain(fmt(er.atLimit, { max: 3 }));
    await press(box(names.square_1080));
    expect(box(names.feed_4x5_1080).disabled).toBe(false);
    expect(ratios()!.querySelector("[aria-live=polite]")!.textContent).toBe("");
  });

  it("nothing ticked: Export is off and says to choose a size", async () => {
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(er.own));
    expect(exportButton().disabled).toBe(true);
    expect(document.getElementById(exportButton().getAttribute("aria-describedby")!)!.textContent).toBe(er.none);
    expect(ratios()!.querySelector("[aria-live=polite]")!.textContent).toContain(er.none);
    await press(exportButton());
    expect(posts()).toEqual([]);
  });

  it("a size that was refused is said by name with its reason, beside the ones that started", async () => {
    answer = () =>
      json({ exports: [{ frame: "project", id: "e1", status: "queued" }, { frame: "vertical_1080p", id: "e2", status: "queued" }, { frame: "square_1080", error: "daily_limit" }] }, 201);
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(box(names.square_1080));
    await press(exportButton());
    await waitFor(() => expect(panels()).toHaveLength(2));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(fmt(er.refused, { name: names.square_1080, reason: te.errors.daily_limit }));
  });

  it("before 0129 a size is said to be unavailable, and the project's own size is said to still work", async () => {
    answer = () => json({ error: "not_available", exports: [{ frame: "vertical_1080p", error: "not_available" }] }, 503);
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(box(er.own));
    await press(exportButton());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe(fmt(er.refused, { name: names.vertical_1080p, reason: er.notAvailable }));
    expect(panels()).toHaveLength(0);
  });

  it("a server that answers as with the switch off is reported as it is: the plain export started, the size did not", async () => {
    answer = () => json({ id: "e9", status: "queued" }, 201);
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(box(er.own));
    await press(exportButton());
    await waitFor(() => expect(panels()).toHaveLength(1));
    expect(panels()[0].querySelector("h2")!.textContent).toBe(fmt(er.panelFor, { name: er.own }));
    expect(screen.getByRole("alert").textContent).toBe(fmt(er.refused, { name: names.vertical_1080p, reason: er.notAvailable }));
  });

  it("a refusal of the whole request is the ordinary error line", async () => {
    answer = () => json({ error: "bad_request" }, 400);
    editor({ multiRatio: true });
    ratios()!.setAttribute("open", "");
    await press(box(names.vertical_1080p));
    await press(exportButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(te.errors.bad_request));
    expect(panels()).toHaveLength(0);
  });

  it("a failed size is retried in THAT size, never as the project's", async () => {
    const exports: EditorExport[] = [
      { id: "e2", rev: 1, status: "failed", reason: "render_failed", durationS: 10, assetId: null, createdAt: null, finishedAt: null, frame: { preset: "square_1080", width: 1080, height: 1080 } },
      { id: "e1", rev: 1, status: "done", reason: null, durationS: 10, assetId: null, createdAt: null, finishedAt: null },
    ];
    editor({ multiRatio: true, exports });
    expect(panels()).toHaveLength(2);
    const failed = panels().find((p) => p.getAttribute("data-export-state") === "failed")!;
    await press(failed.querySelector("button")!);
    expect(posts()).toEqual([{ rev: 1, frames: ["square_1080"] }]);
  });

  it("a size failure the worker gave is explained and not offered as try again", () => {
    for (const reason of ["invalid_frame", "frame_off"] as const) {
      cleanup();
      editor({
        multiRatio: true,
        exports: [{ id: "e2", rev: 1, status: "failed", reason, durationS: 10, assetId: null, createdAt: null, finishedAt: null, frame: { preset: "square_1080", width: 1080, height: 1080 } }],
      });
      expect(panels()[0].textContent).toContain(te.exportReasons[reason]);
      expect([...panels()[0].querySelectorAll("button")].map((b) => b.textContent)).not.toContain(te.exportPanel.retry);
    }
  });

  it("a finished file that is not the size asked for says so, with both sizes", () => {
    const wrong: EditorAsset = { id: B, kind: "video", name: "export.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/b", thumbUrl: null };
    const done: EditorExport = { id: "e2", rev: 1, status: "done", reason: null, durationS: 10, assetId: B, createdAt: null, finishedAt: null, frame: { preset: "vertical_1080p", width: 1080, height: 1920 } };
    editor({ multiRatio: true, exports: [done], assets: { [A]: VIDEO, [B]: wrong } });
    expect(panels()[0].querySelector("[data-export-notice]")!.textContent).toBe(fmt(er.mismatch, { w: 1920, h: 1080, fw: 1080, fh: 1920 }));
    cleanup();
    editor({ multiRatio: true, exports: [done], assets: { [A]: VIDEO, [B]: { ...wrong, width: 1080, height: 1920 } } });
    expect(panels()[0].querySelector("[data-export-notice]")).toBeNull();
  });

  it("speaks Russian and Uzbek", () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      cleanup();
      editor({ multiRatio: true }, locale);
      expect(ratios()!.querySelector("summary")!.textContent).toBe(d.editor.exportRatios.summaryOwn);
      ratios()!.setAttribute("open", "");
      expect(screen.getByRole("group", { name: d.editor.exportRatios.legend })).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: (n) => n.startsWith(d.editor.exportRatios.own) })).toBeTruthy();
    }
  });
});

describe("the picker on its own", () => {
  function picker(props: Partial<ComponentProps<typeof ExportRatioPicker>> = {}) {
    const onChange = vi.fn();
    render(
      <I18nProvider locale="en">
        <ExportRatioPicker width={1280} height={720} totalS={20} choices={["youtube_1080p", "vertical_1080p", "square_1080"]} selected={["project"]} blocked={[]} onChange={onChange} {...props} />
      </I18nProvider>,
    );
    ratios()!.setAttribute("open", "");
    return onChange;
  }

  it("asks for the new selection, in the order ticked", () => {
    const onChange = picker();
    fireEvent.click(box(names.vertical_1080p));
    expect(onChange).toHaveBeenLastCalledWith(["project", "vertical_1080p"] satisfies ExportFrameChoice[]);
    fireEvent.click(box(er.own));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("a size the edit does not fit cannot be ticked, and the reason is written under the group", () => {
    const onChange = picker({ blocked: ["vertical_1080p"] });
    expect(box(names.vertical_1080p).disabled).toBe(true);
    expect(box(names.vertical_1080p).closest("label")!.getAttribute("data-disabled")).toBe("true");
    fireEvent.click(box(names.vertical_1080p));
    expect(onChange).not.toHaveBeenCalled();
    expect(ratios()!.querySelector("[aria-live=polite]")!.textContent).toBe(fmt(er.blocked, { name: names.vertical_1080p }));
    expect(box(names.square_1080).disabled).toBe(false);
  });

  it("says a video is long for a ticked size, and never blocks it", () => {
    picker({ selected: ["project", "vertical_1080p"], totalS: 312 });
    expect(ratios()!.querySelector("[aria-live=polite]")!.textContent).toBe(fmt(er.longFor, { name: names.vertical_1080p, length: "5:12", max: "3:00" }));
    expect(box(names.vertical_1080p).disabled).toBe(false);
  });

  it("the fourth tick does nothing", () => {
    const onChange = picker({ selected: ["project", "youtube_1080p", "vertical_1080p"] });
    expect(box(names.square_1080).disabled).toBe(true);
    fireEvent.click(box(names.square_1080));
    expect(onChange).not.toHaveBeenCalled();
  });
});
