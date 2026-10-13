import { describe, expect, it } from "vitest";
import { SHORTCUT_HELP, focusKind, resolveShortcut } from "@/lib/editor-shortcuts";

describe("what has focus", () => {
  it("a text field, a select and an editable area keep every key", () => {
    expect(focusKind({ tag: "INPUT", inputType: "text" })).toBe("text");
    expect(focusKind({ tag: "INPUT", inputType: "number" })).toBe("text");
    expect(focusKind({ tag: "TEXTAREA" })).toBe("text");
    expect(focusKind({ tag: "SELECT" })).toBe("text");
    expect(focusKind({ tag: "DIV", editable: true })).toBe("text");
  });
  it("sliders, radios, buttons and links are controls with their own keys", () => {
    expect(focusKind({ tag: "INPUT", inputType: "range" })).toBe("slider");
    expect(focusKind({ tag: "INPUT", inputType: "radio" })).toBe("slider");
    expect(focusKind({ tag: "SPAN", role: "slider" })).toBe("slider");
    expect(focusKind({ tag: "INPUT", inputType: "checkbox" })).toBe("control");
    expect(focusKind({ tag: "BUTTON" })).toBe("control");
    expect(focusKind({ tag: "A" })).toBe("control");
    expect(focusKind({ tag: "DIV", role: "button" })).toBe("control");
    expect(focusKind({ tag: "BODY" })).toBe("other");
    expect(focusKind(null)).toBe("other");
  });
});

describe("a key press", () => {
  const k = (key: string, extra = {}) => resolveShortcut({ key, ...extra }, "other");
  it("maps the editor keys", () => {
    expect(k(" ")).toBe("play");
    expect(k("s")).toBe("split");
    expect(k("S")).toBe("split");
    expect(k("Delete")).toBe("remove");
    expect(k("Backspace")).toBe("remove");
    expect(k("ArrowLeft")).toBe("left");
    expect(k("ArrowRight")).toBe("right");
    expect(k("ArrowLeft", { shiftKey: true })).toBe("leftBig");
    expect(k("ArrowRight", { shiftKey: true })).toBe("rightBig");
    expect(k("+")).toBe("zoomIn");
    expect(k("=")).toBe("zoomIn");
    expect(k("-")).toBe("zoomOut");
    expect(k("0")).toBe("zoomFit");
    expect(k("q")).toBeNull();
  });
  it("is never used in a text field", () => {
    for (const key of [" ", "s", "Delete", "Backspace", "ArrowLeft", "+", "-"])
      expect(resolveShortcut({ key }, "text")).toBeNull();
  });
  it("leaves Ctrl / Cmd / Alt combos to the browser and to undo, redo and save", () => {
    expect(k("s", { ctrlKey: true })).toBeNull();
    expect(k("z", { metaKey: true })).toBeNull();
    expect(k("-", { ctrlKey: true })).toBeNull();
    expect(k("ArrowLeft", { altKey: true })).toBeNull();
  });
  it("leaves Space to a focused button and the arrows to a focused slider or radio", () => {
    expect(resolveShortcut({ key: " " }, "control")).toBeNull();
    expect(resolveShortcut({ key: " " }, "slider")).toBeNull();
    expect(resolveShortcut({ key: "ArrowLeft" }, "slider")).toBeNull();
    // but a focused button still lets S, Delete and zoom through, and the arrows move the playhead
    expect(resolveShortcut({ key: "s" }, "control")).toBe("split");
    expect(resolveShortcut({ key: "ArrowRight" }, "control")).toBe("right");
    expect(resolveShortcut({ key: "+" }, "slider")).toBe("zoomIn");
  });
  it("ignores a key another handler already used, and a held Space, S or Delete", () => {
    expect(k("ArrowLeft", { defaultPrevented: true })).toBeNull();
    expect(k(" ", { repeat: true })).toBeNull();
    expect(k("s", { repeat: true })).toBeNull();
    expect(k("Delete", { repeat: true })).toBeNull();
    // holding an arrow keeps stepping
    expect(k("ArrowRight", { repeat: true })).toBe("right");
  });
});

describe("the help list", () => {
  it("lists every action once", () => {
    const actions = SHORTCUT_HELP.map((r) => r.action);
    expect(new Set(actions).size).toBe(actions.length);
    for (const a of ["play", "split", "remove", "left", "leftBig", "zoomIn", "zoomFit", "undo", "redo", "save"])
      expect(actions).toContain(a);
  });
});
