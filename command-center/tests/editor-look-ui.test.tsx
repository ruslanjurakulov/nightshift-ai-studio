// @vitest-environment jsdom
/**
 * "Reuse a look" in the editor: a selection of several items (Shift / Ctrl-click, select mode and a long press on a
 * phone), what the keys and the selection bar do to all of it, sync lock on the lanes, and the paste-attributes
 * dialog with its presets. What would break without these: a multi-delete that is several undo steps, a key that
 * fires while a person types or takes Alt + Left (Back) from the browser for nothing, a single click that no longer
 * selects one item, a text left behind by a delete, a pasted look the validator refuses, a stored preset that crashes
 * the editor, a sentence missing in a language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { validateTimeline, type EditorAsset, type TimelineDoc } from "@/lib/editor";
import { presetStoreKey } from "@/lib/editorPasteLook";

const te = en.editor;
const rs = te.reuse.select;
const lk = te.reuse.look;
const sy = te.reuse.sync;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT" ? json({ id: PID, rev: 2 }) : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** c1 [0,4] (0-4, graded), c2 [4,8] (2-6), c3 [8,10] (6-8); a title at 1 and one at 9 (over c3). */
const doc3 = (): TimelineDoc => ({
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  tracks: [
    {
      id: "v1",
      kind: "V",
      clips: [
        { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, speed: 1, audio: true, grade: { brightness: 0.1, contrast: 1.2, saturation: 1.1 }, vignette: 0.3 },
        { id: "c2", asset_id: A, start_s: 4, in_s: 2, out_s: 6, speed: 1, audio: true },
        { id: "c3", asset_id: A, start_s: 8, in_s: 6, out_s: 8, speed: 1, audio: true },
      ],
    },
    { id: "t1", kind: "T", clips: [{ id: "x1", start_s: 1, end_s: 2, text: "Hook", size: 64, x: 0.5, y: 0.85, anchor: "center" }] },
    { id: "t2", kind: "T", clips: [{ id: "x2", start_s: 9, end_s: 9.5, text: "Late", size: 64, x: 0.5, y: 0.85, anchor: "center" }] },
  ],
});
function mount(doc: TimelineDoc = doc3(), locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]} assets={{ [A]: VIDEO }} videos={[VIDEO]} userId="user-1" />
    </I18nProvider>,
  );
}
const key = (k: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key: k, ...init });
const item = (kind: string, id: string) => document.querySelector<HTMLElement>(`[data-item-kind="${kind}"][data-item-id="${id}"]`)!;
const undo = () => fireEvent.click(screen.getByRole("button", { name: te.undo }));
const save = async () => {
  fetchMock.mockClear();
  fireEvent.click(screen.getByRole("button", { name: te.save }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc as TimelineDoc;
};
const vclips = (d: TimelineDoc) => d.tracks.find((t) => t.kind === "V")!.clips as Record<string, unknown>[];
const texts = (d: TimelineDoc) =>
  Object.fromEntries(d.tracks.filter((t) => t.kind === "T").flatMap((t) => t.clips).map((c) => [String(c.id), c.start_s]));
const count = () => screen.queryByTestId("selection-count")?.textContent ?? null;
const selStatus = () => screen.queryByTestId("selection-status")?.textContent ?? null;

describe("selecting several items", () => {
  it("Shift- and Ctrl-click add and take out; a plain click selects one again", () => {
    mount();
    expect(count()).toBeNull();
    fireEvent.click(item("clip", "c2"), { shiftKey: true });
    expect(count()).toBe(fmt(rs.count.few, { n: 2 })); // c1 (selected when the editor opened) and c2
    fireEvent.click(item("text", "x2"), { ctrlKey: true });
    expect(count()).toBe(fmt(rs.count.few, { n: 3 }));
    expect(item("text", "x2").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(item("clip", "c2"), { metaKey: true });
    expect(count()).toBe(fmt(rs.count.few, { n: 2 }));
    expect(item("clip", "c2").getAttribute("aria-pressed")).toBe("false");
    // a plain click: just that one, as it always was
    fireEvent.click(item("clip", "c3"));
    expect(count()).toBeNull();
    expect(item("clip", "c3").getAttribute("aria-pressed")).toBe("true");
    expect(item("clip", "c1").getAttribute("aria-pressed")).toBe("false");
  });

  it("a long press on a phone turns select mode on with that item alone; a tap then adds", () => {
    // jsdom has no PointerEvent: one that carries pointerType, as a phone's does
    class TouchPointer extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    vi.stubGlobal("PointerEvent", TouchPointer);
    vi.useFakeTimers();
    mount();
    fireEvent.pointerDown(item("clip", "c2"), { pointerType: "touch", clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(520));
    fireEvent.pointerUp(item("clip", "c2"), { pointerType: "touch" });
    // the click after the press does not undo it
    fireEvent.click(item("clip", "c2"));
    expect(screen.getByRole("button", { name: rs.done }).getAttribute("aria-pressed")).toBe("true");
    expect(item("clip", "c2").getAttribute("aria-pressed")).toBe("true");
    expect(item("clip", "c1").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(item("text", "x1"));
    expect(count()).toBe(fmt(rs.count.few, { n: 2 }));
    // moving the finger is scrolling, not holding
    fireEvent.click(screen.getByRole("button", { name: rs.done }));
    fireEvent.pointerDown(item("clip", "c3"), { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerMove(item("clip", "c3"), { pointerType: "touch", clientX: 60, clientY: 5 });
    act(() => vi.advanceTimersByTime(800));
    expect(screen.getByRole("button", { name: rs.mode }).getAttribute("aria-pressed")).toBe("false");
  });

  it("a long press the phone sends no click after does not swallow the next tap on that item", () => {
    class TouchPointer extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    vi.stubGlobal("PointerEvent", TouchPointer);
    vi.useFakeTimers();
    mount();
    fireEvent.pointerDown(item("clip", "c2"), { pointerType: "touch", clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(520));
    fireEvent.pointerCancel(item("clip", "c2"), { pointerType: "touch" });
    fireEvent.click(screen.getByRole("button", { name: rs.done }));
    // a later tap on the same clip (pointer down, then its click) selects it, as any tap does
    fireEvent.click(item("clip", "c1"));
    fireEvent.pointerDown(item("clip", "c2"), { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(item("clip", "c2"), { pointerType: "touch" });
    fireEvent.click(item("clip", "c2"));
    expect(item("clip", "c2").getAttribute("aria-pressed")).toBe("true");
    expect(item("clip", "c1").getAttribute("aria-pressed")).toBe("false");
  });

  it("Delete takes the whole selection in ONE undo step, the later text moves up with it, and the document is valid", async () => {
    mount();
    fireEvent.click(item("clip", "c2"));
    fireEvent.click(item("text", "x1"), { shiftKey: true });
    key("Delete");
    expect(selStatus()).toBe(fmt(rs.removed.few, { n: 2 }));
    const d = await save();
    expect(vclips(d).map((c) => c.id)).toEqual(["c1", "c3"]);
    // x2 was over c3 at 9: c2 (4 s) went, so it is at 5
    expect(texts(d)).toEqual({ x2: 5 });
    expect(validateTimeline(d)).toEqual([]);
    // one undo brings both back (and the text to where it was)
    undo();
    expect(document.querySelectorAll('[data-item-kind="clip"]')).toHaveLength(3);
    expect(item("text", "x2").getAttribute("aria-label")).toContain("0:09.0");
    expect(item("clip", "c2")).toBeTruthy();
    expect(item("text", "x1")).toBeTruthy();
  });

  it("every clip selected: the picture keeps one, and says so", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: rs.forward }));
    expect(count()).toBe(fmt(rs.count.few, { n: 5 }));
    fireEvent.click(screen.getByRole("button", { name: rs.remove }));
    expect(selStatus()).toContain(fmt(rs.keptClip, { n: 1 }));
    expect(document.querySelectorAll('[data-item-kind="clip"]')).toHaveLength(1);
  });

  it("Alt + arrows nudge the selected texts a frame (Shift: five), one undo step each; picture clips stay", async () => {
    mount();
    fireEvent.click(item("text", "x1"));
    fireEvent.click(item("clip", "c2"), { shiftKey: true });
    key("ArrowRight", { altKey: true });
    key("ArrowRight", { altKey: true, shiftKey: true });
    const d = await save();
    expect(texts(d).x1).toBeCloseTo(1 + 6 / 30, 3);
    expect(vclips(d).map((c) => c.start_s)).toEqual([0, 4, 8]);
    undo();
    expect(texts(await save()).x1).toBeCloseTo(1 + 1 / 30, 3);
  });

  it("the keys are left alone where they belong to something else", () => {
    mount();
    // a clip alone: nothing to nudge, so Alt + Left stays the browser's (Back)
    const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // in a text field: no nudge, no dialog
    fireEvent.click(item("text", "x1"));
    const field = screen.getAllByRole("textbox")[0];
    key("ArrowRight", { altKey: true }, field);
    key("v", { ctrlKey: true, altKey: true }, field);
    expect(screen.queryByRole("dialog", { name: lk.title })).toBeNull();
    // on a slider (the playhead) it is the slider's
    key("v", { ctrlKey: true, altKey: true }, screen.getByRole("slider", { name: te.playhead }));
    expect(screen.queryByRole("dialog", { name: lk.title })).toBeNull();
    // Ctrl + Alt + V from the page opens it (on a Cyrillic layout too: the physical key)
    key("м", { ctrlKey: true, altKey: true, code: "KeyV" });
    expect(screen.getByRole("dialog", { name: lk.title })).toBeTruthy();
  });

  it("Ctrl + C and Ctrl + V copy and paste the whole selection after the selected clip, in one undo step", async () => {
    mount();
    fireEvent.click(item("clip", "c1"));
    fireEvent.click(item("text", "x1"), { shiftKey: true });
    key("c", { ctrlKey: true });
    expect(selStatus()).toBe(fmt(rs.copied.few, { n: 2 }));
    fireEvent.click(item("clip", "c3"));
    key("v", { ctrlKey: true });
    expect(selStatus()).toBe(fmt(rs.pasted.few, { n: 2 }));
    const d = await save();
    expect(vclips(d)).toHaveLength(4);
    expect(Object.keys(texts(d))).toHaveLength(3);
    expect(validateTimeline(d)).toEqual([]);
    undo();
    expect(document.querySelectorAll('[data-item-kind="clip"]')).toHaveLength(3);
  });
});

describe("sync lock", () => {
  it("deleting a clip moves the text after it; a locked text lane keeps its times, and the lock is remembered", async () => {
    mount();
    fireEvent.click(item("clip", "c2"));
    key("Delete");
    expect(texts(await save())).toEqual({ x1: 1, x2: 5 });
    undo();
    const lock = screen.getByRole("button", { name: fmt(sy.lock, { lane: sy.lanes.texts }) });
    expect(lock.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(lock);
    expect(lock.getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem("ns:editor:sync-locks:v1")!).texts).toBe(true);
    fireEvent.click(item("clip", "c2"));
    key("Delete");
    expect(texts(await save())).toEqual({ x1: 1, x2: 9 });
    cleanup();
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: fmt(sy.lock, { lane: sy.lanes.texts }) }).getAttribute("aria-pressed")).toBe("true"),
    );
  });
});

describe("paste attributes", () => {
  it("copy the look of clip 1, paste only the ticked groups on clips 2 and 3, in one undo step", async () => {
    mount();
    fireEvent.click(item("clip", "c1"));
    fireEvent.click(screen.getByRole("button", { name: lk.copy }));
    expect(selStatus()).toBe(fmt(lk.copiedFrom, { n: 1 }));
    fireEvent.click(item("clip", "c2"));
    fireEvent.click(item("clip", "c3"), { shiftKey: true });
    fireEvent.click(within(screen.getByTestId("selection-bar")).getByRole("button", { name: lk.paste }));
    const dlg = screen.getByRole("dialog", { name: lk.title });
    // only the groups the look has are offered, all ticked
    const boxes = within(dlg).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.parentElement!.textContent)).toEqual([lk.group.effects, lk.group.grade]);
    fireEvent.click(within(dlg).getByRole("checkbox", { name: lk.group.effects }));
    fireEvent.click(within(dlg).getByRole("button", { name: fmt(lk.to.few, { n: 2 }) }));
    expect(screen.queryByRole("dialog", { name: lk.title })).toBeNull();
    expect(selStatus()).toBe(fmt(lk.done.few, { n: 2 }));
    const d = await save();
    const [, c2, c3] = vclips(d);
    expect(c2.grade).toEqual({ brightness: 0.1, contrast: 1.2, saturation: 1.1 });
    expect(c3.grade).toEqual(c2.grade);
    expect(c2.vignette).toBeUndefined();
    expect([c2.in_s, c3.in_s]).toEqual([2, 6]);
    expect(validateTimeline(d)).toEqual([]);
    undo();
    expect(vclips(await save())[1].grade).toBeUndefined();
  });

  it("Escape closes the dialog and focus goes back to what opened it", async () => {
    mount();
    const opener = screen.getByRole("button", { name: lk.paste });
    opener.focus();
    fireEvent.click(opener);
    const dlg = screen.getByRole("dialog", { name: lk.title });
    expect(within(dlg).getByText(lk.noSource)).toBeTruthy();
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: lk.title })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a preset is saved here, survives a reload and pastes; a corrupted store opens an editor with none", async () => {
    mount();
    fireEvent.click(item("clip", "c1"));
    fireEvent.click(screen.getByRole("button", { name: lk.copy }));
    fireEvent.click(screen.getByRole("button", { name: lk.paste }));
    let dlg = screen.getByRole("dialog", { name: lk.title });
    fireEvent.change(within(dlg).getByLabelText(lk.presetName), { target: { value: "Warm" } });
    fireEvent.click(within(dlg).getByRole("button", { name: lk.save }));
    expect(within(dlg).getByTestId("preset-status").textContent).toBe(fmt(lk.saved, { name: "Warm" }));
    expect(localStorage.getItem(presetStoreKey("user-1"))).toContain("Warm");
    cleanup();
    mount();
    fireEvent.click(item("clip", "c2"));
    fireEvent.click(screen.getByRole("button", { name: lk.paste }));
    dlg = await screen.findByRole("dialog", { name: lk.title });
    fireEvent.click(within(dlg).getByRole("radio", { name: "Warm" }));
    fireEvent.click(within(dlg).getByRole("button", { name: fmt(lk.to.one, { n: 1 }) }));
    expect(vclips(await save())[1].vignette).toBe(0.3);
    cleanup();
    localStorage.setItem(presetStoreKey("user-1"), '{"v":1,"presets":[{"name":"x","look":{"mask":{"shape":"rect","x":"<img>"}}},');
    mount();
    fireEvent.click(screen.getByRole("button", { name: lk.paste }));
    dlg = screen.getByRole("dialog", { name: lk.title });
    expect(within(dlg).getByText(lk.noPresets)).toBeTruthy();
  });
});

describe("the shortcuts help and the three languages", () => {
  it("lists the selection keys with their labels", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: te.view.shortcuts }));
    const dlg = screen.getByRole("dialog", { name: te.view.shortcutsTitle });
    for (const label of Object.values(te.reuse.keys)) expect(within(dlg).getByText(label)).toBeTruthy();
    expect(within(dlg).getAllByText(te.reuse.keyAlt, { selector: "kbd" }).length).toBeGreaterThan(0);
  });

  it("every string is in all three languages, with the same placeholders; Uzbek and Russian on screen", () => {
    const flat = (o: unknown, p = ""): [string, string][] =>
      typeof o === "string" ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k));
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    const e = new Map(flat(en.editor.reuse));
    for (const d of [ru, uz]) {
      const o = new Map(flat(d.editor.reuse));
      expect([...o.keys()].sort()).toEqual([...e.keys()].sort());
      for (const [k, v] of e) {
        expect(o.get(k)!.trim().length, k).toBeGreaterThan(0);
        expect(holes(o.get(k)!), k).toEqual(holes(v));
      }
    }
    const all = [...flat(en.editor.reuse), ...flat(ru.editor.reuse), ...flat(uz.editor.reuse)].map(([, v]) => v).join(" ");
    expect(all).not.toMatch(/\beng (yaxshi|zoʻr|tez|arzon|kuchli)\b|premiere|adobe|capcut/i);
    // Uzbek uses the turned comma, as the rest of the Uzbek copy does
    expect(flat(uz.editor.reuse).map(([, v]) => v).join(" ")).not.toMatch(/[a-z]'[a-z]/i);
    mount(doc3(), "uz");
    expect(screen.getByRole("button", { name: uz.editor.reuse.select.mode })).toBeTruthy();
    expect(screen.getByRole("button", { name: fmt(uz.editor.reuse.sync.lock, { lane: uz.editor.reuse.sync.lanes.texts }) })).toBeTruthy();
    cleanup();
    mount(doc3(), "ru");
    expect(screen.getByRole("button", { name: ru.editor.reuse.select.forward })).toBeTruthy();
  });
});
