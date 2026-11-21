// @vitest-environment jsdom
/**
 * The shared prompt box (components/prompt/PromptBox.tsx). What would break without these: the landing's idea box drifting from its
 * contract when the app's start box changes the shared field (testids, a field with no `name`, the no-script form to /signup), and
 * the two boxes refusing an empty idea or counting differently.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IdeaBox } from "@/components/landing/home/IdeaBox";
import { homeEn } from "@/lib/i18n/home/en";
import { IDEA_BOX_MARKUP } from "./fixtures/idea-box-markup";

afterEach(cleanup);

describe("the landing's idea box on the shared PromptBox", () => {
  it("draws exactly the markup IdeaBox drew on its own: empty, refused when empty, near the limit, full", () => {
    const { container } = render(<IdeaBox copy={homeEn.hero.idea} />);
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[0]);
    fireEvent.click(screen.getByTestId("idea-submit"));
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[1]);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "y ".repeat(950) } });
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[2]);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "z".repeat(2000) } });
    expect(container.innerHTML).toBe(IDEA_BOX_MARKUP[3]);
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
