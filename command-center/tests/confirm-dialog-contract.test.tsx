// @vitest-environment jsdom
/**
 * What the shared confirm sheet promises every caller, pinned so the Marketing page's changes to it (a `multiline` detail,
 * a scrollable panel, opening at the top) cannot change an existing caller:
 *  - a default detail is a short value set right beside its label, bold and right-aligned (the money sheets),
 *  - Cancel has the focus and a stray Enter backs out,
 *  - the work runs ONCE for a double tap, because of the lock, not only because the button is disabled,
 *  - a long sheet opens at the top, with the focus not scrolling it down to the Cancel key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { useConfirm, type ConfirmOptions } from "../components/feedback/ConfirmDialog";

function Harness({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button type="button" onClick={async () => onDone(await confirm(opts))}>
        ask
      </button>
      {dialog}
    </>
  );
}
const open = async (opts: ConfirmOptions) => {
  const done = vi.fn();
  render(<Harness opts={opts} onDone={done} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
  });
  return done;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a default (non-multiline) detail, as the money sheets use it", () => {
  it("keeps its label and short value on one row, value bold and right-aligned, no full-width line", async () => {
    await open({ title: "Give 500 credits?", message: "m", confirmLabel: "Give", details: [{ label: "Organization", value: "Acme" }] });
    const dd = within(screen.getByRole("alertdialog")).getByText("Acme");
    expect(dd.tagName).toBe("DD");
    expect(dd.className).toContain("text-right");
    expect(dd.className).toContain("font-semibold");
    expect(dd.className).toContain("tnum");
    expect(dd.className).not.toContain("basis-full");
    expect(dd.className).not.toContain("whitespace-pre-wrap");
  });

  it("a multiline detail is its own left-aligned line that keeps its line breaks", async () => {
    await open({ title: "t", message: "m", confirmLabel: "Go", details: [{ label: "Text", value: "one\ntwo", multiline: true }] });
    const dd = screen.getByRole("alertdialog").querySelector("dd")!;
    expect(dd.className).toContain("basis-full");
    expect(dd.className).toContain("whitespace-pre-wrap");
    expect(dd.className).toContain("text-left");
    expect(dd.textContent).toBe("one\ntwo");
  });

  it("Cancel has the focus, and Escape backs out without running anything", async () => {
    const run = vi.fn(async () => true);
    const done = await open({ title: "t", message: "m", confirmLabel: "Go", run });
    expect(document.activeElement).toBe(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("alertdialog").parentElement!, { key: "Escape" });
    });
    expect(run).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(false);
  });
});

describe("the double-tap lock", () => {
  it("two clicks in the same tick, before React can disable the key, run the work once", async () => {
    let finish: (v: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    await open({ title: "t", message: "m", confirmLabel: "Go", run });
    const go = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Go" });
    // Native clicks inside one act(): both reach the handler with the button still enabled in React's props, so only the
    // lock ref (not the disabled attribute) can stop the second one.
    await act(async () => {
      go.click();
      go.click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a typed word that does not match never runs the work, even by Enter in the field", async () => {
    const run = vi.fn(async () => true);
    await open({ title: "t", message: "m", confirmLabel: "Go", run, typeToConfirm: "publish" });
    const box = within(screen.getByRole("alertdialog")).getByRole("textbox");
    fireEvent.change(box, { target: { value: "nope" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a long sheet opens at the top", () => {
  it("focuses Cancel without scrolling to it, and resets the panel to the top", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const tops: number[] = [];
    let current = 480; // a panel that kept an old scroll position
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (v: number) {
      current = v;
      tops.push(v);
    });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() => current);
    const long = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`).join("\n");
    await open({
      title: "Publish to @chan?",
      message: "This goes public.",
      confirmLabel: "Approve",
      details: [
        { label: "Uzbek", value: long, multiline: true },
        { label: "Russian", value: long, multiline: true },
        { label: "English", value: long, multiline: true },
      ],
    });
    const cancel = within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel });
    const call = focus.mock.calls.find((_c, i) => focus.mock.contexts[i] === cancel);
    expect(call, "Cancel was focused").toBeTruthy();
    expect(call![0]).toEqual({ preventScroll: true });
    expect(tops).toContain(0);
    expect(current).toBe(0);
    // the words and "this goes public" are what is at the top
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent!.indexOf("This goes public.")).toBeLessThan(dlg.textContent!.indexOf("line 1"));
    // and the panel itself scrolls, so a tall sheet is never cut off on a short phone screen
    expect(dlg.className).toContain("overflow-y-auto");
    expect(dlg.className).toContain("max-h-");
  });
});
