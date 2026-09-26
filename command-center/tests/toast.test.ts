import { describe, expect, it } from "vitest";
import { MAX_TOASTS, TOAST_DURATION, makeToast, toastReducer, type Toast } from "@/lib/toast";

const t = (id: string, message = id, variant: Toast["variant"] = "success"): Toast =>
  makeToast({ variant, message }, id);

describe("makeToast", () => {
  it("gives errors longer on screen than successes, so the fix can be read", () => {
    expect(makeToast({ variant: "error", message: "x" }, "a").duration).toBe(TOAST_DURATION.error);
    expect(TOAST_DURATION.error).toBeGreaterThan(TOAST_DURATION.success);
  });

  it("falls back to the variant default for a zero, negative or non-finite duration", () => {
    for (const duration of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(makeToast({ variant: "info", message: "x", duration }, "a").duration).toBe(TOAST_DURATION.info);
    }
    expect(makeToast({ variant: "info", message: "x", duration: 1234 }, "a").duration).toBe(1234);
  });

  it("omits an empty title rather than rendering a dangling colon", () => {
    expect("title" in makeToast({ variant: "info", message: "x", title: "" }, "a")).toBe(false);
  });
});

describe("toastReducer", () => {
  it("appends new toasts after the ones already showing", () => {
    const s = toastReducer(toastReducer([], { type: "add", toast: t("a") }), { type: "add", toast: t("b") });
    expect(s.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("drops the oldest when the stack would cover the screen", () => {
    let s: Toast[] = [];
    for (let i = 0; i < MAX_TOASTS + 2; i++) s = toastReducer(s, { type: "add", toast: t(`t${i}`) });
    expect(s).toHaveLength(MAX_TOASTS);
    expect(s[s.length - 1].id).toBe(`t${MAX_TOASTS + 1}`);
    expect(s[0].id).toBe("t2");
  });

  it("a double click refreshes the same message instead of stacking a copy", () => {
    let s = toastReducer([], { type: "add", toast: t("a", "Saved") });
    s = toastReducer(s, { type: "add", toast: t("b", "Saved") });
    expect(s.map((x) => x.id)).toEqual(["b"]);
  });

  it("keeps the same text under different variants apart", () => {
    let s = toastReducer([], { type: "add", toast: t("a", "Done", "success") });
    s = toastReducer(s, { type: "add", toast: t("b", "Done", "error") });
    expect(s).toHaveLength(2);
  });

  it("dismisses by id, and a stale id leaves state untouched", () => {
    const s = [t("a"), t("b")];
    expect(toastReducer(s, { type: "dismiss", id: "a" }).map((x) => x.id)).toEqual(["b"]);
    expect(toastReducer(s, { type: "dismiss", id: "gone" })).toBe(s);
  });

  it("clears everything, returning the same array when already empty", () => {
    expect(toastReducer([t("a")], { type: "clear" })).toEqual([]);
    const empty: Toast[] = [];
    expect(toastReducer(empty, { type: "clear" })).toBe(empty);
  });
});
