// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StateBlock } from "@/components/states/StateBlock";

describe("StateBlock", () => {
  it("renders the title, the body and the one next step", () => {
    render(
      <StateBlock tone="warn" title="Could not read this" actions={<button type="button">Retry</button>}>
        The backend did not answer.
      </StateBlock>,
    );
    expect(screen.getByText("Could not read this")).toBeTruthy();
    expect(screen.getByText("The backend did not answer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("never hides a message passed in, with or without a title", () => {
    const { rerender } = render(<StateBlock role="alert" tone="fail">Specific failure text</StateBlock>);
    expect(screen.getByRole("alert").textContent).toContain("Specific failure text");
    rerender(
      <StateBlock role="alert" tone="fail" title="Title">
        Specific failure text
      </StateBlock>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Specific failure text");
  });

  it("marks the lamp decorative so the words carry the state", () => {
    const { container } = render(<StateBlock tone="ok" title="All clear" />);
    expect(container.querySelector(".ns-lamp")?.getAttribute("aria-hidden")).toBe("true");
  });
});
