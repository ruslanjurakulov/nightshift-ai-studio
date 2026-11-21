// @vitest-environment jsdom
/**
 * NumField: live commit while typing, and the box says the number again when the number changes from outside.
 * What would break without these: an undo that changes the picture while the box still shows the half-typed text (the number and the
 * picture disagree), or the opposite: a value clamped by the box itself (a 5 where 16 is the minimum) wiping what is being typed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumField } from "../components/imageEditor/NumField";

afterEach(cleanup);
const box = () => screen.getByLabelText("W") as HTMLInputElement;
const mount = (value: number, onCommit = vi.fn()) => {
  const r = render(<NumField id="w" label="W" value={value} min={16} max={400} onCommit={onCommit} />);
  const again = (v: number) => r.rerender(<NumField id="w" label="W" value={v} min={16} max={400} onCommit={onCommit} />);
  return { onCommit, again };
};

describe("NumField", () => {
  it("commits a valid number as it is typed, clamped to its range, and lets the box be empty meanwhile", () => {
    const { onCommit } = mount(100);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(box().value).toBe("");
    fireEvent.change(box(), { target: { value: "250" } });
    fireEvent.change(box(), { target: { value: "9999" } });
    fireEvent.change(box(), { target: { value: "-5" } });
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual([250, 400, 16]);
    fireEvent.change(box(), { target: { value: "abc" } });
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it("a value clamped by the box itself does not wipe what is being typed (5 -> 16 -> keep '5' on screen -> '50')", () => {
    const { again } = mount(100);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "5" } });
    again(16); // the parent applied the clamped 16
    expect(box().value).toBe("5");
    fireEvent.change(box(), { target: { value: "50" } });
    again(50);
    expect(box().value).toBe("50");
  });

  it("when the number changes from OUTSIDE (an undo, a keyboard nudge) the half-typed text is dropped and the box shows the number", () => {
    const { again } = mount(100);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "12" } });
    again(100); // parent kept 100 for some reason; nothing changed
    expect(box().value).toBe("12");
    again(300); // an undo set it to 300
    expect(box().value).toBe("300");
    fireEvent.change(box(), { target: { value: "30" } });
    again(120); // clamped by the parent to something the box did not ask for
    expect(box().value).toBe("120");
  });

  it("shows the parent's number when not focused and after blur", () => {
    const { again } = mount(100);
    expect(box().value).toBe("100");
    again(200);
    expect(box().value).toBe("200");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "17" } });
    fireEvent.blur(box());
    expect(box().value).toBe("200");
  });
});
