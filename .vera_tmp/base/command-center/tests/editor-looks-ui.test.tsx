// @vitest-environment jsdom
/**
 * Cross-fade styles and text looks in the editor (UI half): a picker of
 * blend styles next to the cross-fade control, and a gallery of text looks in
 * the text inspector. What would break without these: a style offered where
 * there is no cross-fade, a choice that is more than one undo step, a look that
 * leaves another look's box behind, a preview that draws a look the export does
 * not, a key under 44px, a sentence missing in a language, or a document
 * (Save, the #434 draft) that does not carry the choice. Nothing here renders,
 * spends or publishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import { glyphStyle } from "@/components/editor/TransitionStylePicker";
import {
  DRAFT_DEBOUNCE_MS,
  allowDraftWrites,
  draftKey,
  readDraft,
} from "@/lib/editor-draft";
import {
  XFADE_STYLES,
  addClip,
  addText,
  newDocForAsset,
  setCrossfade,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";
import { TEXT_LOOKS } from "@/lib/editorTextLook";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const VIDEO2: EditorAsset = { id: B, kind: "video", name: "city.mp4", durationS: 4, width: 1920, height: 1080, viewUrl: "/v/b", thumbUrl: null };

function twoClipDoc(crossfade = 0, style?: string): TimelineDoc {
  let m = addClip(toModel(newDocForAsset(VIDEO)!), VIDEO2);
  if (crossfade) m = setCrossfade(m, "c2", crossfade);
  const doc = toDoc(m);
  if (style) (doc.tracks[0].clips[1].transition as Record<string, unknown>).style = style;
  return doc;
}
function textDoc(): TimelineDoc {
  const m = addText(toModel(newDocForAsset(VIDEO)!), 0, "Day one")!.model;
  return toDoc(m);
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT"
      ? json({ id: PID, rev: 2 })
      : json({ error: "failed" }, 502),
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

function mount(doc: TimelineDoc, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [B]: VIDEO2 }} videos={[VIDEO, VIDEO2]} userId="user-1" />
    </I18nProvider>,
  );
}
const clips = () => within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
const putBody = () => {
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
  return put ? JSON.parse(String((put[1] as RequestInit).body)) : null;
};
const pickClip2 = () => fireEvent.click(clips()[1]);
const styleGroup = (l = en) => screen.queryByRole("group", { name: l.editor.looks.styleLegend });
const style = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("the blend style picker", () => {
  it("is not offered for a cut, the first clip, or a clip that cannot cross-fade", () => {
    mount(twoClipDoc());
    expect(styleGroup()).toBeNull();
    pickClip2();
    expect(styleGroup()).toBeNull();
  });

  it("appears with a cross-fade: one native radio per style, plain fade on, a 44px key each", () => {
    mount(twoClipDoc(1));
    pickClip2();
    const group = styleGroup()!;
    expect(group).toBeTruthy();
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual([...XFADE_STYLES]);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["fade"]);
    for (const r of radios) {
      expect(r.name).toBe(radios[0].name);
      expect(r.getAttribute("aria-label")).toBe(en.editor.looks.styles[r.value as keyof typeof en.editor.looks.styles]);
      expect(r.parentElement!.className).toContain("ns-chip");   // data-radio chips are 44px at every width (globals.css)
      expect(r.parentElement!.hasAttribute("data-radio")).toBe(true);
    }
    expect(within(group).getByText(new RegExp(en.editor.looks.styleHint.slice(0, 30)))).toBeTruthy();
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("opens on a saved style", () => {
    mount(twoClipDoc(1, "circleopen"));
    pickClip2();
    expect(style(en.editor.looks.styles.circleopen).checked).toBe(true);
    expect(style(en.editor.looks.styles.fade).checked).toBe(false);
  });

  it("choosing a style is saved with the document, and the plain fade removes the field", async () => {
    mount(twoClipDoc(1));
    pickClip2();
    fireEvent.click(style(en.editor.looks.styles.wipeleft));
    expect(style(en.editor.looks.styles.wipeleft).checked).toBe(true);
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    const doc = putBody().doc as TimelineDoc;
    expect(doc.tracks[0].clips[1].transition).toEqual({ type: "crossfade", duration_s: 1, style: "wipeleft" });
    expect(validateTimeline(doc)).toEqual([]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/exports"))).toBe(false);
    fireEvent.click(style(en.editor.looks.styles.fade));
    expect(toDoc(toModel(doc)).tracks[0].clips[1].transition).toEqual({ type: "crossfade", duration_s: 1, style: "wipeleft" });
  });

  it("a choice is one undo step and redo brings it back", () => {
    mount(twoClipDoc(1));
    pickClip2();
    const undo = screen.getByRole("button", { name: te.undo });
    fireEvent.click(style(en.editor.looks.styles.radial));
    fireEvent.click(style(en.editor.looks.styles.zoomin));
    fireEvent.click(undo);
    expect(style(en.editor.looks.styles.radial).checked).toBe(true);
    fireEvent.click(undo);
    expect(style(en.editor.looks.styles.fade).checked).toBe(true);
    expect(screen.getByText(te.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(style(en.editor.looks.styles.radial).checked).toBe(true);
  });

  it("choosing the style that is on is not an undo step", () => {
    mount(twoClipDoc(1));
    pickClip2();
    fireEvent.click(style(en.editor.looks.styles.fade));
    expect(screen.getByText(te.saved)).toBeTruthy();
    expect(screen.getByRole("button", { name: te.undo })).toHaveProperty("disabled", true);
  });

  it("keeps the style when the length changes and drops it with the cross-fade", () => {
    mount(twoClipDoc(1, "slideup"));
    pickClip2();
    const len = screen.getByRole("spinbutton", { name: te.crossfadeLength });
    fireEvent.change(len, { target: { value: "0.6" } });
    fireEvent.keyDown(len, { key: "Enter" });
    expect(style(en.editor.looks.styles.slideup).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: te.cut }));
    expect(styleGroup()).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: te.crossfade }));
    expect(style(en.editor.looks.styles.fade).checked).toBe(true);
  });

  it("arrow keys move through the group like any native radio group (they are inputs in one named group)", () => {
    mount(twoClipDoc(1));
    pickClip2();
    const radios = within(styleGroup()!).getAllByRole("radio") as HTMLInputElement[];
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.every((r) => r.type === "radio" && !r.disabled)).toBe(true);
    // the whole group is one tab stop in a real browser: the checked radio (native behaviour)
    expect(radios.filter((r) => r.tabIndex === 0).length).toBe(radios.length);
  });

  it("every key has a drawing of the middle of its blend, and no two are the same", () => {
    const drawings = XFADE_STYLES.map((s) => JSON.stringify(glyphStyle(s)));
    expect(new Set(drawings).size).toBe(XFADE_STYLES.length);
  });

  it("is carried by the #434 draft and offered back", async () => {
    vi.useFakeTimers();
    mount(twoClipDoc(1));
    pickClip2();
    fireEvent.click(style(en.editor.looks.styles.circleclose));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    const back = readDraft("user-1", PID, 1);
    expect(back?.doc.tracks[0].clips[1].transition).toEqual({ type: "crossfade", duration_s: 1, style: "circleclose" });
    expect(validateTimeline(back!.doc)).toEqual([]);
    expect(draftKey("user-1", PID, 1)).toBeTruthy();
  });
});

describe("the text look gallery", () => {
  const group = () => screen.getByRole("group", { name: en.editor.looks.lookLegend });
  const look = (id: string) =>
    within(group()).getByRole("radio", { name: en.editor.looks.looks[id as keyof typeof en.editor.looks.looks] }) as HTMLInputElement;
  const selectText = () => fireEvent.click(within(screen.getByRole("list", { name: te.textTrack })).getByRole("button"));

  it("offers the eight looks as native radios in the text inspector, none on for a plain text", () => {
    mount(textDoc());
    selectText();
    const radios = within(group()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(TEXT_LOOKS.map((l) => l.id));
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(within(group()).getByText(new RegExp(en.editor.looks.lookNone))).toBeTruthy();
    for (const r of radios) {
      expect(r.parentElement!.className).toContain("ns-chip");
      expect(r.parentElement!.hasAttribute("data-radio")).toBe(true);
    }
  });

  it("is not there when no text is selected", () => {
    mount(textDoc());
    expect(screen.queryByRole("group", { name: en.editor.looks.lookLegend })).toBeNull();
  });

  it("applies a look: the preview draws it, Save sends exactly the look's fields", async () => {
    const { container } = mount(textDoc());
    selectText();
    fireEvent.click(look("highlight"));
    expect(look("highlight").checked).toBe(true);
    // the preview: a box behind the text, in the look's colour
    const boxed = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "Day one" && s.style.backgroundColor,
    ) as HTMLElement;
    expect(boxed).toBeTruthy();
    expect(boxed.style.backgroundColor).toBe("rgb(255, 230, 0)");
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    const doc = putBody().doc as TimelineDoc;
    const t = doc.tracks.find((x) => x.kind === "T")!.clips[0];
    expect(t).toMatchObject({ text: "Day one", ...TEXT_LOOKS.find((l) => l.id === "highlight")!.fields });
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("a look draws a shadow in the preview and no box", () => {
    const { container } = mount(textDoc());
    selectText();
    fireEvent.click(look("shadow"));
    const span = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Day one" && s.style.textShadow) as HTMLElement;
    expect(span.style.textShadow).toContain("rgba(0, 0, 0, 0.6)");
    expect(Array.from(container.querySelectorAll("span")).some((s) => s.textContent === "Day one" && s.style.backgroundColor)).toBe(false);
  });

  it("never leaves the last look's box behind", async () => {
    const { container } = mount(textDoc());
    selectText();
    fireEvent.click(look("lower_third"));
    fireEvent.click(look("title"));
    expect(look("title").checked).toBe(true);
    expect(Array.from(container.querySelectorAll("span")).some((s) => s.textContent === "Day one" && s.style.backgroundColor)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    const t = putBody().doc.tracks.find((x: { kind: string }) => x.kind === "T").clips[0];
    expect("box_color" in t || "box_opacity" in t || "shadow" in t).toBe(false);
  });

  it("is one undo step per choice, and the same look again is none", () => {
    mount(textDoc());
    selectText();
    const undo = screen.getByRole("button", { name: te.undo });
    fireEvent.click(look("title"));
    fireEvent.click(look("title"));
    fireEvent.click(look("label"));
    fireEvent.click(undo);
    expect(look("title").checked).toBe(true);
    fireEvent.click(undo);
    expect(group().querySelectorAll("input:checked")).toHaveLength(0);
    expect(screen.getByText(te.saved)).toBeTruthy();
  });

  it("goes back to Custom after a hand edit", () => {
    mount(textDoc());
    selectText();
    fireEvent.click(look("caption"));
    fireEvent.change(screen.getByRole("slider", { name: new RegExp(`^${te.textSize}`) }), { target: { value: "120" } });
    expect(group().querySelectorAll("input:checked")).toHaveLength(0);
    expect(within(group()).getByText(new RegExp(en.editor.looks.lookNone))).toBeTruthy();
  });

  it("is carried by the #434 draft", () => {
    vi.useFakeTimers();
    mount(textDoc());
    selectText();
    fireEvent.click(look("label"));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    const back = readDraft("user-1", PID, 1);
    const t = back!.doc.tracks.find((x) => x.kind === "T")!.clips[0];
    expect(t).toMatchObject(TEXT_LOOKS.find((l) => l.id === "label")!.fields);
    expect(validateTimeline(back!.doc)).toEqual([]);
  });

  it("a project that never used a look keeps the preview it had", () => {
    const { container } = mount(textDoc());
    const span = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Day one") as HTMLElement;
    expect(span.style.textShadow).toBe("0 0 2px #000000, 0 0 2px #000000, 0 0 3px #000000");
    expect(span.style.backgroundColor).toBe("");
  });
});

describe("every sentence exists in en, ru and uz", () => {
  it("has the same keys, translated, apostrophes as the other Uzbek strings", () => {
    const flat = (o: unknown, trail = ""): [string, string][] =>
      typeof o === "string" ? [[trail, o]] : Object.entries(o as object).flatMap(([k, v]) => flat(v, `${trail}.${k}`));
    const base = flat(en.editor.looks);
    expect(base.length).toBeGreaterThanOrEqual(30);
    for (const [name, dict] of [["ru", ru], ["uz", uz]] as const) {
      const got = flat(dict.editor.looks);
      expect(got.map(([k]) => k)).toEqual(base.map(([k]) => k));
      for (const [k, v] of got) {
        expect(v.length, `${name} ${k}`).toBeGreaterThan(0);
        // placeholders survive the translation
        const want = (base.find(([bk]) => bk === k)![1].match(/\{\w+\}/g) ?? []).sort();
        expect((v.match(/\{\w+\}/g) ?? []).sort(), `${name} ${k}`).toEqual(want);
      }
      // every name differs from the English one (except the sample letters and loanwords)
      const same = got.filter(([k, v]) => v === base.find(([bk]) => bk === k)![1] && !/lookSample$/.test(k));
      expect(same.map(([k]) => k), name).toEqual(name === "uz" ? same.map(([k]) => k).filter((k) => /looks\.(title|caption)|styles\.fade$/.test(k)) : []);
    }
    expect(fmt(en.editor.looks.styleChosen, { name: "X" })).toBe("Blend style: X.");
    expect(uz.editor.looks.lookSample).toMatch(/\S/);
    expect(JSON.stringify(uz.editor.looks)).not.toMatch(/[^ʻ]'[a-z]|’/);
  });

  it("renders the picker and the gallery in ru and uz without a missing key", () => {
    for (const locale of ["ru", "uz"] as const) {
      const dict = locale === "ru" ? ru : uz;
      mount(twoClipDoc(1), locale);
      fireEvent.click(within(screen.getByRole("list", { name: dict.editor.clipsTrack })).getAllByRole("button")[1]);
      expect(screen.getByRole("group", { name: dict.editor.looks.styleLegend })).toBeTruthy();
      expect(screen.getByRole("radio", { name: dict.editor.looks.styles.zoomin })).toBeTruthy();
      cleanup();
      mount(textDoc(), locale);
      fireEvent.click(within(screen.getByRole("list", { name: dict.editor.textTrack })).getByRole("button"));
      expect(screen.getByRole("group", { name: dict.editor.looks.lookLegend })).toBeTruthy();
      expect(screen.getByRole("radio", { name: dict.editor.looks.looks.lower_third })).toBeTruthy();
      cleanup();
    }
  });
});
