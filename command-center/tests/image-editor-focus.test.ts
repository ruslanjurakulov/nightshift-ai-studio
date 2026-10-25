// @vitest-environment jsdom
/**
 * Which focused controls keep the browser's own undo. What would break without this: Ctrl+Z in a text box undoing the PICTURE (and
 * not the typed word), or Ctrl+Z on a slider doing nothing at all.
 */
import { describe, expect, it } from "vitest";
import { isTextEntry } from "../lib/imageEditor/focus";

const input = (type?: string) => {
  const el = document.createElement("input");
  if (type) el.type = type;
  return el;
};

describe("isTextEntry", () => {
  it("text-like inputs and textareas keep the browser's undo", () => {
    for (const type of [undefined, "text", "search", "number", "email", "url", "tel", "password"]) expect(isTextEntry(input(type)), String(type)).toBe(true);
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTextEntry(div)).toBe(true);
  });

  it("a range, a colour, a checkbox, a select, a button, the canvas and nothing at all do not", () => {
    for (const type of ["range", "color", "checkbox", "radio", "button"]) expect(isTextEntry(input(type)), type).toBe(false);
    for (const tag of ["select", "button", "div", "a"]) expect(isTextEntry(document.createElement(tag)), tag).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(window)).toBe(false);
  });
});
