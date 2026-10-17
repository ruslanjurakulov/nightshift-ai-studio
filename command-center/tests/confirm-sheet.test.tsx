// @vitest-environment jsdom
/**
 * The shared confirm sheet (ConfirmDialog + useConfirm) that every owner money
 * and access action goes through: it names the object and the number, the
 * danger key is a readable solid key, a second tap while the work runs does
 * nothing, Cancel changes nothing, a failure shows in the sheet and brings the
 * keys back, and a large figure has to be typed back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { grantTier, priceChangeTier, typedFigure, typedMatches, memberBlock, GRANT_TYPED_ABOVE } from "../lib/confirm-tier";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: toast.success, error: toast.error, info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
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

function open(opts: ConfirmOptions) {
  const done = vi.fn();
  render(<Harness opts={opts} onDone={done} />);
  fireEvent.click(screen.getByRole("button", { name: "ask" }));
  return done;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the sheet", () => {
  it("names the object and shows the number, with Cancel left of the danger key", () => {
    open({
      title: "Give 5,000 credits to “Acme”?",
      message: "Added at once.",
      confirmLabel: "Give credits",
      details: [
        { label: "Organization", value: "Acme" },
        { label: "Credits", value: "5,000 credits" },
      ],
    });
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toContain("Give 5,000 credits to “Acme”?");
    expect(dlg.textContent).toContain("Acme");
    expect(dlg.textContent).toContain("5,000 credits");
    const buttons = Array.from(dlg.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual([en.ux.confirmCancel, "Give credits"]);
    // the destructive key is the solid, readable danger key (contrast is pinned in danger-contrast.test.ts)
    expect(buttons[1].className).toContain("btn-danger");
    // focus starts on Cancel, so a stray Enter backs out
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("a non-destructive sheet uses the primary key, not red", () => {
    open({ message: "m", confirmLabel: "Go", tone: "primary" });
    expect(screen.getByRole("button", { name: "Go" }).className).toContain("btn-primary");
  });

  it("a sheet with no job (the five older callers) answers yes on the key and no on Cancel", async () => {
    const yes = open({ message: "m", confirmLabel: "Remove" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(yes).toHaveBeenCalledWith(true);
    cleanup();
    const no = open({ message: "m", confirmLabel: "Remove" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.ux.confirmCancel }));
    });
    expect(no).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Cancel and Escape never start the job", async () => {
    const run = vi.fn(async () => true);
    const done = open({ message: "m", confirmLabel: "Remove", run });
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await act(async () => {});
    expect(done).toHaveBeenCalledWith(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a double tap runs the job once, locks both keys, and closes with yes plus a success toast", async () => {
    let finish: (v: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    const done = open({ message: "m", confirmLabel: "Remove", run, successMessage: "Removed." });
    const key = screen.getByRole("button", { name: "Remove" });
    fireEvent.click(key);
    fireEvent.click(key);
    fireEvent.click(key);
    expect(run).toHaveBeenCalledTimes(1);
    // busy: the key shows the working label, both keys are disabled, Cancel and Escape do nothing
    expect(screen.getByRole("button", { name: en.ownerSafety.confirmWorking }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: en.ux.confirmCancel }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await act(async () => finish(true));
    expect(done).toHaveBeenCalledWith(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Removed.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a failure shows in the sheet, keeps it open, brings the keys back, and allows a retry", async () => {
    const run = vi.fn<() => Promise<boolean | string>>().mockResolvedValueOnce("Could not save.").mockResolvedValueOnce(true);
    const done = open({ message: "m", confirmLabel: "Remove", run, successMessage: "Removed." });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Could not save.");
    expect(done).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    const key = screen.getByRole("button", { name: "Remove" });
    expect(key.hasAttribute("disabled")).toBe(false);
    // focus returns to the safe key
    expect(document.activeElement).toBe(screen.getByRole("button", { name: en.ux.confirmCancel }));
    await act(async () => {
      fireEvent.click(key);
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledWith(true);
  });

  it("a thrown error is a failure too, with the generic message", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    open({ message: "m", confirmLabel: "Remove", run });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(en.ownerSafety.actionFailed);
    expect(screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(false);
  });

  it("false from the job is a failure and shows the generic message", async () => {
    open({ message: "m", confirmLabel: "Remove", run: async () => false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(en.ownerSafety.actionFailed);
  });

  it("a figure to type keeps the key off until it matches (case, spaces and ʻ ignored)", async () => {
    const run = vi.fn(async () => true);
    open({ message: "m", confirmLabel: "Remove", typeToConfirm: "OʻCHIR", run });
    const key = screen.getByRole("button", { name: "Remove" });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.click(key);
    expect(run).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " ochir " } });
    expect(key.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(key);
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("tiers", () => {
  it("a grant above the threshold is tier 3, at or below it tier 2", () => {
    expect(grantTier(GRANT_TYPED_ABOVE)).toBe(2);
    expect(grantTier(GRANT_TYPED_ABOVE + 1)).toBe(3);
  });
  it("a first price is tier 2, a swing over 30% is tier 3", () => {
    expect(priceChangeTier(null, 50)).toBe(2);
    expect(priceChangeTier(40, 45)).toBe(2);
    expect(priceChangeTier(40, 53)).toBe(3);
    expect(priceChangeTier(40, 20)).toBe(3);
  });
  it("types back plain digits", () => {
    expect(typedFigure(5000)).toBe("5000");
    expect(typedFigure(0.1 + 0.2)).toBe("0.3");
    expect(typedMatches("5 000", "5000")).toBe(true);
    expect(typedMatches("", "")).toBe(false);
  });
  it("blocks your own row and the last owner, nobody else", () => {
    const rows = [
      { id: "1", user_id: "u1", email: "me@a.uz", role: "owner" },
      { id: "2", user_id: "u2", email: "b@a.uz", role: "admin" },
      { id: "3", user_id: null, email: "c@a.uz", role: "editor" },
    ];
    const me = { userId: "u2", email: "b@a.uz" };
    expect(memberBlock(rows[0], rows, me)).toBe("last_owner");
    expect(memberBlock(rows[1], rows, me)).toBe("self");
    expect(memberBlock(rows[2], rows, me)).toBeNull();
    // two owners: the first is no longer "last", and is not me either
    const two = [...rows, { id: "4", user_id: "u4", email: "d@a.uz", role: "owner" }];
    expect(memberBlock(two[0], two, me)).toBeNull();
    expect(memberBlock({ ...two[3] }, two, { userId: "u4", email: "d@a.uz" })).toBe("self");
  });
});
