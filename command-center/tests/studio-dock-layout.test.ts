/**
 * Where the canvas's docks and lane sit (components/studio-canvas/studio-canvas.css). What would break without these:
 * - the phone's dock, fixed to the screen, sat on the Nightshift AI panel stacked above the canvas and covered its Upgrade and
 *   Buy credits keys (the remedy for a blocked purchase) — it is sticky to the canvas, so it can never leave the canvas's box;
 * - the desk's floating dock covering the map, or the map covering the dock;
 * - the lane taking the page sideways instead of scrolling inside itself.
 * The layout itself is measured in Chromium by tools/visual-qa/studio-canvas.mjs (elementFromPoint on the panel's last key).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "components/studio-canvas/studio-canvas.css"), "utf8");
const block = (sel: string) => {
  const at = css.indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("the canvas's docks never cover what is not theirs", () => {
  it("the phone's dock is sticky to the canvas, never fixed to the screen", () => {
    const b = block(".cv-flow-dock");
    expect(b).toMatch(/position:\s*sticky/);
    expect(b).not.toMatch(/position:\s*fixed/);
  });
  it("the desk's dock floats inside the board, and the map sits above its band", () => {
    expect(block(".cv-dockwrap")).toMatch(/position:\s*absolute/);
    expect(block(".react-flow__panel.cv-mini")).toMatch(/margin:\s*12px 12px 80px/);
  });
  it("the lane scrolls sideways inside itself", () => {
    expect(block(".cv-lane-scroll")).toMatch(/overflow-x:\s*auto/);
  });
});
