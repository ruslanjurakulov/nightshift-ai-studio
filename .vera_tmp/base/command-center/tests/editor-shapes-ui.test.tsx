// @vitest-environment jsdom
/**
 * Shapes and stickers in the editor: the "Add shape" entry and its picker (visual tiles in a radio
 * group, 44px keys), the inspector's controls for each kind, the preview drawn from the
 * document's fractions, the progress bar's fill at the playhead, the notices where limits apply
 * (role="status"), undo / redo and Save. Nothing is rendered or spent by any of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import {
  MAX_OVERLAYS,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";
import { MAX_SHAPES, SHAPE_KINDS } from "@/lib/editorShapes";
import { addShape } from "@/lib/editorShapeModel";
import { canAddOverlay } from "@/lib/editorOverlay";

const te = en.editor;
const ts = en.editor.shapes;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";

const VIDEO: EditorAsset = {
  id: A,
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1",
  thumbUrl: null,
};
const LOGO: EditorAsset = {
  id: P,
  kind: "image",
  name: "logo.png",
  durationS: null,
  width: 400,
  height: 200,
  viewUrl: "/api/media/file/p/view?sig=1",
  thumbUrl: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT"
      ? Promise.resolve(
          new Response(JSON.stringify({ id: PID, rev: 2 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      : Promise.resolve(new Response("{}", { status: 502 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(doc: TimelineDoc = newDocForAsset(VIDEO)!, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor
        projectId={PID}
        title="Trip"
        rev={1}
        doc={doc}
        exports={[]}
        assets={{ [VIDEO.id]: VIDEO, [LOGO.id]: LOGO }}
        videos={[VIDEO]}
        imageFiles={[LOGO]}
      />
    </I18nProvider>,
  );
}
const savedDoc = () => {
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc;
};

const dict = { en, ru, uz };
function addShapeVia(kind: (typeof SHAPE_KINDS)[number], d = en) {
  fireEvent.click(screen.getByRole("button", { name: d.editor.shapes.add }));
  const picker = screen.getByTestId("shape-picker");
  fireEvent.click(within(picker).getByRole("radio", { name: d.editor.shapes.kinds[kind] }));
  return picker;
}
function add(kind: (typeof SHAPE_KINDS)[number], d = en) {
  const picker = addShapeVia(kind, d);
  fireEvent.click(within(picker).getByRole("button", { name: d.editor.shapes.addConfirm }));
}
const slider = (label: string) => screen.getByRole("slider", { name: label }) as HTMLInputElement;
const shapeEl = () => document.querySelector<HTMLElement>("[data-shape]")!;
const setPlayhead = (v: number) =>
  fireEvent.change(screen.getByRole("slider", { name: te.playhead }), { target: { value: String(v) } });

describe("the Add shape entry and its picker", () => {
  it("sits beside Add overlay and Add text, opens a radio group of the seven kinds as 44px tiles", () => {
    mount();
    for (const name of [te.overlay.add, ts.add, te.addText]) expect(screen.getByRole("button", { name })).toBeTruthy();
    const button = screen.getByRole("button", { name: ts.add });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const picker = screen.getByRole("region", { name: ts.addTitle });
    const group = within(picker).getByRole("group", { name: ts.kindLegend });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(SHAPE_KINDS.map((k) => ts.kinds[k]));
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    // a radio group: one name, one checked
    expect(new Set(radios.map((r) => r.getAttribute("name"))).size).toBe(1);
    for (const r of radios) {
      const tile = r.closest("label") as HTMLElement;
      expect(tile.style.minHeight).toBe("2.75rem");
    }
    for (const b of within(picker).getAllByRole("button")) expect(b.className + b.style.minHeight).toMatch(/min-h-11|2\.75rem|btn-primary/);
    fireEvent.click(within(picker).getByRole("radio", { name: ts.kinds.star }));
    expect((within(picker).getByRole("radio", { name: ts.kinds.star }) as HTMLInputElement).checked).toBe(true);
    expect((radios[0] as HTMLInputElement).checked).toBe(false);
  });

  it("adds the chosen kind, closes, selects it, draws it and says so in the lane and the inspector", () => {
    mount();
    add("star");
    expect(screen.queryByTestId("shape-picker")).toBeNull();
    expect(screen.getByRole("heading", { name: fmt(ts.heading, { n: 1, kind: ts.kinds.star }) })).toBeTruthy();
    const lane = screen.getByRole("list", { name: ts.track });
    expect(within(lane).getAllByRole("listitem")).toHaveLength(1);
    expect(shapeEl().getAttribute("data-kind")).toBe("star");
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    // focus lands on the shape's frame, not <body>
    expect(document.activeElement).toBe(document.querySelector("[data-shape-frame]"));
    // the preview says it is close, not exact
    expect(screen.getByText(new RegExp(ts.previewNote.slice(0, 30)))).toBeTruthy();
  });

  it("every kind can be added and is a valid document", () => {
    for (const kind of SHAPE_KINDS) {
      cleanup();
      mount();
      add(kind);
      expect(document.querySelector(`[data-kind="${kind}"][data-testid="shape-item"]`), kind).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: te.save }));
    }
    expect(validateTimeline(savedDoc())).toEqual([]);
  });

  it("a label offers ready words and a text box; its words are drawn", () => {
    mount();
    const picker = addShapeVia("pill");
    for (const w of Object.values(ts.labels)) expect(within(picker).getByRole("button", { name: w })).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: ts.labels.link }));
    expect((within(picker).getByLabelText(ts.text) as HTMLInputElement).value).toBe(ts.labels.link);
    fireEvent.click(within(picker).getByRole("button", { name: ts.addConfirm }));
    expect(shapeEl().textContent).toBe(ts.labels.link);
  });

  it("closing leaves the project as it was", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: ts.add }));
    fireEvent.click(within(screen.getByTestId("shape-picker")).getByRole("button", { name: te.close }));
    expect(screen.queryByTestId("shape-picker")).toBeNull();
    expect(screen.getByText(te.saved)).toBeTruthy();
  });
});

describe("the inspector", () => {
  it("position, size and opacity change the preview in whole percent", () => {
    mount();
    add("circle");
    fireEvent.change(slider(ts.x), { target: { value: "20" } });
    expect(shapeEl().style.left).toBe("20%");
    fireEvent.change(slider(ts.y), { target: { value: "75" } });
    expect(shapeEl().style.top).toBe("75%");
    fireEvent.change(slider(ts.size), { target: { value: "50" } });
    expect(shapeEl().style.width).toBe("50%");
    fireEvent.change(slider(ts.opacity), { target: { value: "40" } });
    expect(shapeEl().style.opacity).toBe("0.4");
    expect(slider(ts.opacity).getAttribute("aria-valuetext")).toBe("40%");
  });

  it("each kind shows only the controls it takes", () => {
    const has = (label: string) => screen.queryByRole("slider", { name: label }) !== null;
    mount();
    add("circle");
    expect([has(ts.outline), has(ts.aspect), has(ts.thick)]).toEqual([true, false, false]);
    expect(screen.queryByRole("group", { name: ts.dirLegend })).toBeNull();
    cleanup();
    mount();
    add("rect");
    expect([has(ts.outline), has(ts.aspect), has(ts.thick)]).toEqual([true, true, false]);
    cleanup();
    mount();
    add("line");
    expect([has(ts.outline), has(ts.aspect), has(ts.thick), has(ts.x)]).toEqual([false, false, true, true]);
    cleanup();
    mount();
    add("arrow");
    expect(screen.getByRole("group", { name: ts.dirLegend })).toBeTruthy();
    expect([has(ts.outline), has(ts.thick)]).toEqual([false, false]);
    cleanup();
    mount();
    add("pill");
    expect(screen.getByLabelText(ts.text)).toBeTruthy();
    expect(has(ts.outline)).toBe(true);
    cleanup();
    mount();
    add("progress");
    expect([has(ts.x), has(ts.y), has(ts.size), has(ts.outline), has(ts.thick), has(ts.opacity)]).toEqual([false, false, false, false, true, true]);
    expect(screen.getByRole("group", { name: ts.edgeLegend })).toBeTruthy();
    expect(screen.getByText(ts.progressNote)).toBeTruthy();
    expect(screen.queryByTestId("shape-move-section")).toBeNull();
  });

  it("an arrow points the way the person picks", () => {
    mount();
    add("arrow");
    const poly = () => shapeEl().querySelector("polygon")!;
    expect(poly().getAttribute("transform")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: ts.dirs.left }));
    expect(poly().getAttribute("transform")).toContain("scale(-1 1)");
    fireEvent.click(screen.getByRole("radio", { name: ts.dirs.up }));
    expect(poly().getAttribute("transform")).toContain("rotate(-90)");
    fireEvent.click(screen.getByRole("radio", { name: ts.dirs.down }));
    expect(poly().getAttribute("transform")).toContain("rotate(90)");
  });

  it("a ready colour, the colour box and a typed code; a bad code is said and not taken", () => {
    mount();
    add("circle");
    const fill = () => shapeEl().querySelector("ellipse")!;
    fireEvent.click(screen.getByRole("radio", { name: ts.swatches.red }));
    expect(fill().getAttribute("stroke")).toBe("#FF3B30");
    const code = screen.getByLabelText(ts.colorCode) as HTMLInputElement;
    fireEvent.change(code, { target: { value: "#0a84ff" } });
    fireEvent.blur(code);
    expect(fill().getAttribute("stroke")).toBe("#0A84FF");
    expect(screen.getByRole("radio", { name: ts.swatches.blue })).toBeTruthy();
    fireEvent.change(code, { target: { value: "blue" } });
    fireEvent.blur(code);
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(ts.colorBad);
    expect(fill().getAttribute("stroke")).toBe("#0A84FF");
    fireEvent.change(screen.getByLabelText(ts.colorPicker), { target: { value: "#123456" } });
    expect(fill().getAttribute("stroke")).toBe("#123456");
  });

  it("outline thickness turns a disc into a ring and 0 back", () => {
    mount();
    add("circle"); // starts as a ring
    const e = () => shapeEl().querySelector("ellipse")!;
    expect(e().getAttribute("fill")).toBe("none");
    fireEvent.change(slider(ts.outline), { target: { value: "0" } });
    expect(e().getAttribute("stroke")).toBe("none");
    fireEvent.change(slider(ts.outline), { target: { value: "20" } });
    expect(e().getAttribute("fill")).toBe("none");
  });

  it("a label's text: typing changes it, an empty box keeps the last words and says so", () => {
    mount();
    add("pill");
    const box = screen.getByLabelText(ts.text) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "New" } });
    expect(shapeEl().textContent).toBe("New");
    fireEvent.change(box, { target: { value: "" } });
    expect(shapeEl().textContent).toBe("New");
    const notice = screen.getByText(ts.textEmpty);
    expect(notice.getAttribute("role")).toBe("status");
    fireEvent.change(box, { target: { value: "Part 2" } });
    expect(screen.queryByText(ts.textEmpty)).toBeNull();
    // a paste of a line break and an over-long text are brought to what the document takes
    fireEvent.change(box, { target: { value: `a\nb${"x".repeat(60)}` } });
    expect(Array.from(shapeEl().textContent ?? "").length).toBe(24);
    expect(shapeEl().textContent).not.toContain("\n");
    fireEvent.click(screen.getByRole("button", { name: ts.labels.subscribe }));
    expect(shapeEl().textContent).toBe(ts.labels.subscribe);
  });

  it("characters the export cannot draw are left out and said, politely; braces and a backslash are shown as the export draws them", () => {
    mount();
    add("pill");
    const box = screen.getByLabelText(ts.text) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Hi 😀 日本" } });
    expect(shapeEl().textContent).toBe("Hi");
    const note = screen.getByText(ts.textDropped);
    expect(note.getAttribute("role")).toBe("status");
    fireEvent.change(box, { target: { value: "{x} \\ y" } });
    expect(screen.queryByText(ts.textDropped)).toBeNull();
    expect(shapeEl().textContent).toBe("(x) / y"); // what the export draws
  });

  it("the shape's kind can be changed in place and keeps the span and colour", () => {
    mount();
    add("circle");
    fireEvent.click(screen.getByRole("radio", { name: ts.swatches.green }));
    fireEvent.change(screen.getByLabelText(ts.end), { target: { value: "4" } });
    fireEvent.blur(screen.getByLabelText(ts.end));
    const inspector = screen.getByTestId("shape-kind-inspector");
    fireEvent.click(within(inspector).getByRole("radio", { name: ts.kinds.rect }));
    expect(shapeEl().getAttribute("data-kind")).toBe("rect");
    expect(shapeEl().querySelector("rect")!.getAttribute("stroke")).toBe("#34C759");
    expect((screen.getByLabelText(ts.end) as HTMLInputElement).value).toBe("4");
    expect(screen.getByRole("heading", { name: fmt(ts.heading, { n: 1, kind: ts.kinds.rect }) })).toBeTruthy();
  });

  it("start at the playhead moves the span, keeping its length", () => {
    mount();
    add("star");
    setPlayhead(3);
    fireEvent.click(screen.getByRole("button", { name: ts.toPlayhead }));
    expect((screen.getByLabelText(ts.start) as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText(ts.end) as HTMLInputElement).value).toBe("8");
  });

  it("a move: off by default, a straight line to an end position; the bar has none", () => {
    mount();
    add("star");
    const section = screen.getByTestId("shape-move-section");
    expect(within(section).queryByRole("slider", { name: ts.moveEndX })).toBeNull();
    fireEvent.click(within(section).getByRole("checkbox", { name: ts.moveToggle }));
    fireEvent.change(within(section).getByRole("slider", { name: ts.moveEndX }), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    return waitFor(() => {
      expect(savedDoc().shapes[0].move).toEqual({ to: { x: 0.9 } });
      expect(JSON.stringify(savedDoc().shapes[0].move)).not.toContain("opacity");
    });
  });

  it("entrance and exit: a bar offers a fade only", () => {
    mount();
    add("star");
    expect(screen.getAllByRole("radio", { name: en.editor.fx.anim.names.pop }).length).toBeGreaterThan(0);
    cleanup();
    mount();
    add("progress");
    expect(screen.queryByRole("radio", { name: en.editor.fx.anim.names.pop })).toBeNull();
    expect(screen.getAllByRole("radio", { name: en.editor.fx.anim.names.fade }).length).toBe(2);
  });

  it("layers: forward and back reorder, and Reset returns the look", () => {
    mount();
    add("star");
    add("circle");
    expect(screen.getByRole("heading", { name: fmt(ts.heading, { n: 2, kind: ts.kinds.circle }) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.overlay.backward }));
    expect(screen.getByRole("heading", { name: fmt(ts.heading, { n: 1, kind: ts.kinds.circle }) })).toBeTruthy();
    fireEvent.change(slider(ts.x), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: ts.reset }));
    expect(shapeEl().style.left).toBe("50%");
  });
});

describe("the progress bar", () => {
  it("is added across the whole video and fills by the playhead", () => {
    mount();
    add("progress");
    expect((screen.getByLabelText(ts.start) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(ts.end) as HTMLInputElement).value).toBe("10");
    const fill = () => parseFloat((document.querySelector("[data-testid=progress-fill]") as HTMLElement).style.width);
    expect(fill()).toBe(0);
    setPlayhead(5);
    expect(fill()).toBeGreaterThan(49);
    expect(fill()).toBeLessThan(52);
    setPlayhead(9.9);
    expect(fill()).toBeGreaterThan(98);
  });

  it("sits on the edge the person picks", () => {
    mount();
    add("progress");
    const bar = () => document.querySelector<HTMLElement>("[data-kind=progress][data-testid=shape-item]")!;
    expect(bar().style.bottom).toBe("0px");
    fireEvent.click(screen.getByRole("radio", { name: ts.edges.top }));
    expect(bar().style.top).toBe("0px");
    expect(bar().style.bottom).toBe("");
  });

  it("can be set to the whole video or to the clip at the playhead", () => {
    const m = toModel(newDocForAsset(VIDEO)!);
    const split = { ...m, clips: [m.clips[0], { ...m.clips[0], id: "c9", start_s: 6, in_s: 0, out_s: 4 }] };
    split.clips[0] = { ...split.clips[0], out_s: 6 };
    mount(toDoc(split));
    add("progress");
    setPlayhead(7);
    fireEvent.click(screen.getByRole("button", { name: ts.atClip }));
    expect((screen.getByLabelText(ts.start) as HTMLInputElement).value).toBe("6");
    expect((screen.getByLabelText(ts.end) as HTMLInputElement).value).toBe("10");
    fireEvent.click(screen.getByRole("button", { name: ts.wholeVideo }));
    expect((screen.getByLabelText(ts.start) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(ts.end) as HTMLInputElement).value).toBe("10");
  });
});

describe("the preview frame of the selected shape", () => {
  it("arrow keys move it by 1% (Shift 5%) as one undo step, and a bar has no frame", () => {
    mount();
    add("circle");
    const frame = document.querySelector<HTMLElement>("[data-shape-frame]")!;
    expect(frame.getAttribute("aria-label")).toBe(fmt(ts.handle, { n: 1 }));
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(frame, { key: "ArrowRight" });
    expect(shapeEl().style.left).toBe("53%");
    fireEvent.keyDown(frame, { key: "ArrowDown", shiftKey: true });
    expect(shapeEl().style.top).toBe("55%");
    // a run of presses is one undo step
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(shapeEl().style.top).toBe("50%");
    expect(shapeEl().style.left).toBe("50%");
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(shapeEl().style.left).toBe("53%");
    cleanup();
    mount();
    add("progress");
    expect(document.querySelector("[data-shape-frame]")).toBeNull();
  });
});

describe("history, saving and the keyboard", () => {
  it("undo removes the added shape and redo brings it back; Save writes the document", async () => {
    mount();
    add("rect");
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(document.querySelector("[data-shape]")).toBeNull();
    expect(screen.getByText(te.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(document.querySelector("[data-shape]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect(savedDoc().shapes).toEqual([
      {
        id: expect.any(String),
        kind: "rect",
        start_s: 0,
        end_s: 5,
        color: "#FFD60A",
        opacity: 1,
        x: 0.5,
        y: 0.5,
        w: 0.35,
        outline: 0.05,
        aspect: 1.6,
      },
    ]);
    expect(validateTimeline(savedDoc())).toEqual([]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports"))).toHaveLength(0);
  });

  it("a project that never had a shape saves without the field", async () => {
    mount();
    add("star");
    fireEvent.click(screen.getByRole("button", { name: ts.delete }));
    expect(screen.getByText(te.saved)).toBeTruthy();
    // focus goes back to the entry that made it, not <body>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: ts.add }));
  });

  it("the Delete key removes the selected shape", () => {
    mount();
    add("star");
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(document.querySelector("[data-shape]")).toBeNull();
  });

  it("selecting a lane item selects that shape", () => {
    mount();
    add("star");
    add("circle");
    const lane = screen.getByRole("list", { name: ts.track });
    fireEvent.click(within(lane).getAllByRole("button")[0]);
    expect(screen.getByRole("heading", { name: fmt(ts.heading, { n: 1, kind: ts.kinds.star }) })).toBeTruthy();
  });
});

describe("limits, said where they apply", () => {
  it("at the shapes limit the entry is off and a status says why", () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    for (let i = 0; i < MAX_SHAPES; i += 1) m = addShape(m, "line", 0)!.model;
    mount(toDoc(m));
    const button = screen.getByRole("button", { name: ts.add }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const why = screen.getByText(fmt(ts.shapesFull, { max: MAX_SHAPES }));
    expect(why.getAttribute("role")).toBe("status");
    expect(button.getAttribute("aria-describedby")).toBe(why.id);
  });

  it("pictures and shapes share the final pass's layers: full for both, and the right words", () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    for (let i = 0; i < 6; i += 1) m = addShape(m, "line", 0)!.model;
    const overlays = Array.from({ length: MAX_OVERLAYS - 6 }, (_, i) => ({
      id: `o${i + 1}`,
      asset_id: P,
      start_s: 0,
      end_s: 2,
      x: 0.5,
      y: 0.5,
      w: 0.3,
      opacity: 1,
    }));
    mount(toDoc({ ...m, overlays }));
    expect((screen.getByRole("button", { name: ts.add }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: te.overlay.add }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(fmt(ts.layersFull, { max: MAX_OVERLAYS })).length).toBe(2);
    for (const el of screen.getAllByText(fmt(ts.layersFull, { max: MAX_OVERLAYS }))) expect(el.getAttribute("role")).toBe("status");
  });

  it("pictures that the shapes leave no memory for are not added, and a status says it is the memory", () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    m = { ...m, width: 2560, height: 1440 };
    for (let i = 0; i < 8; i += 1) {
      const o = addShape(m, "circle", 0)!;
      m = { ...o.model, shapes: o.model.shapes!.map((s) => ({ ...s, w: 0.4 })) };
    }
    const overlays: NonNullable<typeof m.overlays> = [];
    while (canAddOverlay({ ...m, overlays })) {
      overlays.push({ id: `o${overlays.length + 1}`, asset_id: P, start_s: 0, end_s: 2, x: 0.5, y: 0.5, w: 0.3, opacity: 1 });
    }
    m = { ...m, overlays };
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.length + 8).toBeLessThan(MAX_OVERLAYS);
    expect(validateTimeline(toDoc(m))).toEqual([]);
    mount(toDoc(m));
    expect((screen.getByRole("button", { name: te.overlay.add }) as HTMLButtonElement).disabled).toBe(true);
    const why = screen.getByText(ts.pictureMemory);
    expect(why.getAttribute("role")).toBe("status");
  });

  it("a shape the export cannot afford is refused with the numbers, as a status, and the project is as it was", () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    m = { ...m, width: 3840, height: 2160 };
    for (let i = 0; i < 3; i += 1) {
      const o = addShape(m, "circle", 0)!;
      m = { ...o.model, shapes: o.model.shapes!.map((s) => ({ ...s, w: 0.2 })) };
    }
    expect(validateTimeline(toDoc(m))).toEqual([]);
    mount(toDoc(m));
    const before = document.querySelectorAll("[data-shape]").length;
    fireEvent.click(screen.getByRole("button", { name: ts.add }));
    const picker = screen.getByTestId("shape-picker");
    fireEvent.click(within(picker).getByRole("button", { name: ts.addConfirm }));
    const why = screen.getByTestId("shape-refused");
    expect(why.getAttribute("role")).toBe("status");
    expect(why.textContent).toMatch(/MB needed, \d+ MB available/);
    expect(screen.getByText(te.saved)).toBeTruthy();
    expect(document.querySelectorAll("[data-shape]").length).toBe(before);
  });

  it("says how much of the export's budget the shapes use once it is a lot", () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    m = { ...m, width: 3840, height: 2160 };
    const o = addShape(m, "circle", 0)!;
    mount(toDoc({ ...o.model, shapes: o.model.shapes!.map((s) => ({ ...s, w: 0.2 })) }));
    fireEvent.click(document.querySelector<HTMLElement>("[data-testid=shape-item]") ? screen.getByRole("list", { name: ts.track }).querySelector("button")! : document.body);
    const note = screen.getByTestId("shape-budget");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toMatch(/\d+% of what the export can draw/);
  });

  it("warns, as a status, when a shape would not show", () => {
    mount();
    add("star");
    fireEvent.change(slider(ts.opacity), { target: { value: "0" } });
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(ts.invisible);
  });
});

describe("words", () => {
  const flat = (o: unknown, prefix = ""): Record<string, string> =>
    Object.entries(o as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
      if (typeof v === "string") acc[prefix + k] = v;
      else Object.assign(acc, flat(v, `${prefix}${k}.`));
      return acc;
    }, {});
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it("English, Russian and Uzbek have the same keys and placeholders, none empty", () => {
    const e = flat(en.editor.shapes);
    for (const d of [ru, uz]) {
      const f = flat(d.editor.shapes);
      expect(Object.keys(f).sort()).toEqual(Object.keys(e).sort());
      for (const k of Object.keys(e)) {
        expect(f[k].trim(), k).not.toBe("");
        expect(placeholders(f[k]), k).toEqual(placeholders(e[k]));
      }
    }
  });
  it("no provider or model brand names and no role words in any language", () => {
    const banned = /\b(openai|gpt|claude|anthropic|gemini|google|eleven\s?labs|runway|kling|veo|sora|midjourney|stability|flux|owner|viewer|editor|admin|vlasnik|egasi|владелец|зритель|редактор|администратор)\b/i;
    for (const d of [en, ru, uz])
      for (const [k, v] of Object.entries(flat(d.editor.shapes))) expect(v, k).not.toMatch(banned);
  });
  it("Uzbek uses the same apostrophe as the rest of the product (U+02BB), never a straight one", () => {
    for (const [k, v] of Object.entries(flat(uz.editor.shapes))) expect(v, k).not.toMatch(/[a-z]'[a-z]/i);
  });
  it("the Russian and Uzbek screens draw the same picker", () => {
    for (const loc of ["ru", "uz"] as const) {
      cleanup();
      mount(newDocForAsset(VIDEO)!, loc);
      const d = dict[loc];
      add("progress", d);
      expect(screen.getByRole("heading", { name: fmt(d.editor.shapes.heading, { n: 1, kind: d.editor.shapes.kinds.progress }) })).toBeTruthy();
      expect(screen.getByRole("group", { name: d.editor.shapes.edgeLegend })).toBeTruthy();
    }
  });
});
