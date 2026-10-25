/**
 * Which link clicks count as "leaving the page with unsaved edits".
 * What would break without these: a confirm on Ctrl+click (a new tab keeps the editor), on a same-page anchor, on a
 * download or on a link to another site (the browser asks for that one itself); or NO confirm for a plain click on the Library link.
 */
import { describe, expect, it } from "vitest";
import { INSTANT_DIALOG_MS, afterConfirm, leavesThePage } from "../lib/imageEditor/leave";

const HERE = "https://app.example/chronos/editor/image/abc?x=1";
const plain = {};

describe("leavesThePage", () => {
  it("a plain click on another page of the app leaves", () => {
    expect(leavesThePage({ href: "/chronos/library" }, plain, HERE)).toBe(true);
    expect(leavesThePage({ href: "https://app.example/chronos/home" }, plain, HERE)).toBe(true);
    expect(leavesThePage({ href: "../abc?x=2" }, plain, HERE)).toBe(true);
    expect(leavesThePage({ href: "/chronos/library", target: "_self" }, { button: 0 }, HERE)).toBe(true);
  });

  it("the same page, a same-page anchor and a different origin do not (the last one is the browser's own prompt)", () => {
    expect(leavesThePage({ href: "/chronos/editor/image/abc?x=1" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "#top" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "/chronos/editor/image/abc?x=1#top" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "https://other.example/x" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "mailto:a@b.c" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "javascript:void(0)" }, plain, HERE)).toBe(false);
  });

  it("a different query on the same path does leave", () => {
    expect(leavesThePage({ href: "/chronos/editor/image/abc?x=2" }, plain, HERE)).toBe(true);
  });

  it("a new tab, a download, a non-primary button or an already-cancelled click do not", () => {
    for (const click of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
      expect(leavesThePage({ href: "/chronos/library" }, click, HERE), JSON.stringify(click)).toBe(false);
    }
    expect(leavesThePage({ href: "/chronos/library", target: "_blank" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "/chronos/library", download: true }, plain, HERE)).toBe(false);
  });

  it("an address that cannot be read never asks", () => {
    expect(leavesThePage({ href: "http://[bad" }, plain, HERE)).toBe(false);
    expect(leavesThePage({ href: "/x" }, plain, "not a url")).toBe(false);
  });
});



describe("afterConfirm (browsers that block dialogs)", () => {
  const fresh = { instant: 0 };

  it("a yes lets the click go; a no that took time keeps the person on the page", () => {
    expect(afterConfirm(fresh, true, 3).stay).toBe(false);
    expect(afterConfirm(fresh, false, 2000)).toEqual({ stay: true, guard: { instant: 0 } });
    expect(afterConfirm(fresh, false, INSTANT_DIALOG_MS).stay).toBe(true);
  });

  it("an instant no stays once, and the second instant no in a row lets the click through (the dialog was never shown)", () => {
    const first = afterConfirm(fresh, false, 1);
    expect(first).toEqual({ stay: true, guard: { instant: 1 } });
    const second = afterConfirm(first.guard, false, 1);
    expect(second).toEqual({ stay: false, guard: { instant: 0 } });
    expect(afterConfirm(second.guard, false, 1).stay).toBe(true);
  });

  it("a slow no or a yes in between starts the count again", () => {
    const first = afterConfirm(fresh, false, 1);
    expect(afterConfirm(first.guard, false, 900).guard.instant).toBe(0);
    expect(afterConfirm(first.guard, true, 1).guard.instant).toBe(0);
    expect(afterConfirm(afterConfirm(first.guard, false, 900).guard, false, 1).stay).toBe(true);
  });
});
