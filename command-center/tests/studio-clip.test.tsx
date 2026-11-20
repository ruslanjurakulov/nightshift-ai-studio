// @vitest-environment jsdom
/**
 * components/site/StudioClip.tsx: a landing Studio piece is one MP4. What would break without this: a `<source type="video/webm">`
 * naming a file that does not exist, which every browser that plays WebM requests (and gets a 404 for) before it tries the MP4;
 * or a piece that plays its clip under reduced motion.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StudioClip } from "@/components/site/StudioClip";

class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const media = (reduce: boolean) => (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} });

describe("StudioClip", () => {
  it("lists only the piece's MP4, with its own poster", () => {
    vi.stubGlobal("matchMedia", media(false));
    vi.stubGlobal("IntersectionObserver", IO);
    const { container } = render(<StudioClip slug="language-duo" />);
    const v = container.querySelector("video") as HTMLVideoElement;
    expect(v).not.toBeNull();
    expect(v.getAttribute("poster")).toBe("/showcase/language-duo.webp");
    expect([...v.querySelectorAll("source")].map((s) => [s.getAttribute("type"), s.getAttribute("src")])).toEqual([["video/mp4", "/showcase/language-duo.mp4"]]);
    expect(v.muted).toBe(true);
    expect(v.getAttribute("preload")).toBe("none");
  });

  it("draws no video under reduced motion: the poster under it is the picture", () => {
    vi.stubGlobal("matchMedia", media(true));
    vi.stubGlobal("IntersectionObserver", IO);
    const { container } = render(<StudioClip slug="language-duo" />);
    expect(container.querySelector("video")).toBeNull();
  });
});
