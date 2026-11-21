// @vitest-environment jsdom
/**
 * The landing's "Write your idea" box and its handoff to the Studio (lib/site/idea-handoff.ts, components/landing/home/IdeaBox.tsx).
 * What would break without these: an idea that reaches the Studio twice (a reload refills the box), one that a shared computer still
 * shows the next person hours later, words carried in the address (history, logs) when this browser could keep them, an idea lost
 * outright when storage is off, and an empty box that sends anyway. The signed-in redirect is tests/idea-handoff-middleware.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IDEA_HREF, IDEA_KEY, IDEA_MAX, IDEA_NEXT, IDEA_TTL_MS, ideaWords, stashIdea, takeIdea } from "@/lib/site/idea-handoff";
import { afterSignupPath, studioNext } from "@/lib/safe-redirect";
import { IdeaBox } from "@/components/landing/home/IdeaBox";
import { homeEn } from "@/lib/i18n/home/en";

/** A Storage stand-in that can be told to refuse. */
function memory(opts: { refuseSet?: boolean; refuseGet?: boolean } = {}) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => {
      if (opts.refuseGet) throw new Error("SecurityError");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.refuseSet) throw new Error("QuotaExceededError");
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
}

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

describe("the words as kept", () => {
  it("drops hidden and bidi characters, folds spaces, keeps paragraphs", () => {
    expect(ideaWords("  a‮b ​ c \r\n\r\n\r\n\r\nnext   line  ")).toBe("a b c\n\nnext line");
    expect(ideaWords(" \n\t​ ")).toBe("");
  });

  it("is at most 2000 characters, cut on a whole word, counted in characters, not UTF-16 units", () => {
    const words = ideaWords("слово ".repeat(500));
    expect(Array.from(words).length).toBeLessThanOrEqual(IDEA_MAX);
    expect(words.endsWith("слово")).toBe(true);
    const emoji = ideaWords("🎬".repeat(IDEA_MAX + 5));
    expect(Array.from(emoji).length).toBe(IDEA_MAX);
  });
});

describe("kept in this browser, taken once", () => {
  it("is read back exactly once: a reload or a second tab finds nothing", () => {
    const s = memory();
    expect(stashIdea("A film about the Aral Sea", s, NOW)).toBe(true);
    expect(takeIdea(s, NOW + 1000)).toBe("A film about the Aral Sea");
    expect(takeIdea(s, NOW + 2000)).toBeNull();
    expect(s.m.has(IDEA_KEY)).toBe(false);
  });

  it("is gone after two hours, and a record dated in the future is not trusted; both are deleted on reading", () => {
    const s = memory();
    stashIdea("old", s, NOW);
    expect(takeIdea(s, NOW + IDEA_TTL_MS + 1)).toBeNull();
    expect(s.m.has(IDEA_KEY)).toBe(false);
    stashIdea("future", s, NOW + 60_000);
    expect(takeIdea(s, NOW)).toBeNull();
    expect(s.m.has(IDEA_KEY)).toBe(false);
  });

  it("a record this module did not write is no idea, and is deleted", () => {
    for (const raw of ["not json", "null", "[]", JSON.stringify({ text: 5, at: NOW }), JSON.stringify({ text: "x" }), JSON.stringify({ text: " ​ ", at: NOW })]) {
      const s = memory();
      s.m.set(IDEA_KEY, raw);
      expect(takeIdea(s, NOW)).toBeNull();
      expect(s.m.has(IDEA_KEY)).toBe(false);
    }
  });

  it("storage that refuses is 'not kept' (the box then sends another way) and 'nothing here' (the Studio shows an empty box)", () => {
    expect(stashIdea("idea", memory({ refuseSet: true }), NOW)).toBe(false);
    expect(stashIdea("idea", null, NOW)).toBe(false);
    expect(stashIdea("   ", memory(), NOW)).toBe(false);
    expect(takeIdea(memory({ refuseGet: true }), NOW)).toBeNull();
    expect(takeIdea(null, NOW)).toBeNull();
  });
});

describe("the way to the Studio", () => {
  it("carries no words in the address, and survives sign-up and /welcome as the Studio form", () => {
    expect(IDEA_NEXT).toBe("/all-channels/create?idea=1");
    expect(IDEA_HREF).toBe(`/signup?next=${encodeURIComponent(IDEA_NEXT)}`);
    expect(studioNext(IDEA_NEXT)).toBe(IDEA_NEXT);
    expect(afterSignupPath(IDEA_NEXT)).toBe(`/welcome?next=${encodeURIComponent(IDEA_NEXT)}`);
  });
});

describe("the box", () => {
  const assign = vi.fn();
  beforeEach(() => {
    assign.mockReset();
    window.localStorage.clear();
    vi.stubGlobal("location", { ...window.location, assign });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("empty: says so at the field and goes nowhere", () => {
    render(<IdeaBox copy={homeEn.hero.idea} />);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "  \n " } });
    fireEvent.click(screen.getByTestId("idea-submit"));
    expect(screen.getByTestId("idea-empty").textContent).toBe(homeEn.hero.idea.empty);
    expect(screen.getByTestId("idea-field").getAttribute("aria-invalid")).toBe("true");
    expect(assign).not.toHaveBeenCalled();
  });

  it("keeps the words in this browser and goes to sign-up with only `idea=1` in the address", () => {
    render(<IdeaBox copy={homeEn.hero.idea} />);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "A short film about a lighthouse keeper" } });
    fireEvent.click(screen.getByTestId("idea-submit"));
    expect(assign).toHaveBeenCalledWith(IDEA_HREF);
    expect(String(assign.mock.calls[0][0])).not.toContain("lighthouse");
    expect(takeIdea()).toBe("A short film about a lighthouse keeper");
  });

  it("with storage refused, the words go in the address instead (cut to fit), never lost", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    render(<IdeaBox copy={homeEn.hero.idea} />);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "A short film about a lighthouse keeper" } });
    fireEvent.click(screen.getByTestId("idea-submit"));
    const href = String(assign.mock.calls[0][0]);
    expect(href.startsWith("/signup?next=")).toBe(true);
    expect(decodeURIComponent(href)).toContain("lighthouse");
    vi.restoreAllMocks();
  });

  it("without script the form still reaches sign-up with the Studio as next, and the field has no name (its words never enter the address)", () => {
    const { container } = render(<IdeaBox copy={homeEn.hero.idea} />);
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/signup");
    expect(form.getAttribute("method")).toBe("get");
    expect((form.querySelector("input[name=next]") as HTMLInputElement).value).toBe(IDEA_NEXT);
    expect(screen.getByTestId("idea-field").hasAttribute("name")).toBe(false);
  });

  it("shows the count only near the limit", () => {
    render(<IdeaBox copy={homeEn.hero.idea} />);
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "x".repeat(100) } });
    expect(screen.queryByTestId("idea-count")).toBeNull();
    fireEvent.change(screen.getByTestId("idea-field"), { target: { value: "x".repeat(IDEA_MAX - 10) } });
    expect(screen.getByTestId("idea-count").textContent).toContain(`${IDEA_MAX - 10} of ${IDEA_MAX}`);
  });
});
