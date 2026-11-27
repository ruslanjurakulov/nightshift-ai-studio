// @vitest-environment jsdom
/**
 * The shared prompt box (components/prompt/PromptBox.tsx). What would break without these: the landing's idea box drifting from its
 * contract when the app's start box changes the shared field (testids, a field with no `name`, the no-script form to /signup), and
 * the two boxes refusing an empty idea or counting differently.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IdeaBox } from "@/components/landing/home/IdeaBox";
import { homeEn } from "@/lib/i18n/home/en";
import { IDEA_BOX_MARKUP } from "./fixtures/idea-box-markup";

afterEach(cleanup);

describe("the landing's idea box on the shared PromptBox", () => {
  it("draws exactly the landing's pinned markup: empty, refused when empty, near the limit, full", () => {
    const { container } = render(<IdeaBox copy={homeEn.hero.idea} thumb="/hero-poster-sm.webp" />);
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[0]);
    fireEvent.click(screen.getByTestId("idea-submit"));
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[1]);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "y ".repeat(950) } });
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[2]);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "z".repeat(2000) } });
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[3]);
  });

  it("is one line that sends with Enter through the form itself, once, and draws no thumbnail it was not given", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    try {
      const { container } = render(<IdeaBox copy={homeEn.hero.idea} />);
      const field = screen.getByTestId("idea-field");
      expect(field.tagName).toBe("INPUT");
      expect(field.getAttribute("type")).toBe("text");
      expect(field.hasAttribute("name")).toBe(false);
      expect(container.querySelector(".hm-idea-thumb")).toBeNull();
      fireEvent.change(field, { target: { value: "A lighthouse keeper's last night" } });
      // Enter in a one-line field is the form's implicit submit; no key handler of its own may send a second time beside it.
      fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
      expect(assign).not.toHaveBeenCalled();
      fireEvent.submit(container.querySelector("form")!);
      expect(assign).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("IdeaBox is a thin wrapper: the field lives in PromptBox, and the landing path pulls in no Studio module", () => {
    const src = readFileSync(path.join(__dirname, "../components/landing/home/IdeaBox.tsx"), "utf8");
    expect(src).toContain('from "@/components/prompt/PromptBox"');
    expect(src).not.toMatch(/<textarea/);
    const box = readFileSync(path.join(__dirname, "../components/prompt/PromptBox.tsx"), "utf8");
    const imports = [...box.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/components/ds/button-class", "@/lib/i18n/core", "@/lib/site/idea-handoff", "lucide-react", "react"].sort());
  });
});
