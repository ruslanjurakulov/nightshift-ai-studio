// @vitest-environment jsdom
/**
 * lib/site/motion.ts motionTap and the landing's reel (components/landing/home/HomePage.tsx). The reel's row is focusable so a
 * keyboard can scroll it, and "anything focusable" counts as a control a tap belongs to. What would break without this: a tap on
 * any clip in the reel paused nothing (WCAG 2.2.2), the main moving section left without its pointer pause, because the owner
 * wants no visible pause button and a tap is the pointer's only way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionTap, setMotionPaused } from "@/lib/site/motion";

const paused = () => document.documentElement.getAttribute("data-motion") === "paused";
const tap = (el: Element) => {
  const ev = new MouseEvent("click", { bubbles: true, button: 0, detail: 1 });
  Object.defineProperty(ev, "target", { value: el });
  motionTap(ev);
};

beforeEach(() => setMotionPaused(false));
afterEach(() => {
  document.body.innerHTML = "";
  setMotionPaused(false);
});

function reel(attrs: string) {
  document.body.innerHTML = `<ul tabindex="0" ${attrs}><li><div data-clip="sample"><img alt="" id="pic"></div><a href="/x" id="link">x</a></li></ul>`;
  return { pic: document.getElementById("pic")!, link: document.getElementById("link")! };
}

describe("a tap inside a keyboard-scrollable row", () => {
  it("pauses when the row is marked data-scroll-region (the reel)", () => {
    const { pic } = reel('data-scroll-region=""');
    tap(pic);
    expect(paused()).toBe(true);
  });

  it("a link inside the row is still a control: no pause", () => {
    const { link } = reel('data-scroll-region=""');
    tap(link);
    expect(paused()).toBe(false);
  });

  it("any other focusable ancestor still takes the tap (unchanged)", () => {
    const { pic } = reel("");
    tap(pic);
    expect(paused()).toBe(false);
  });
});
