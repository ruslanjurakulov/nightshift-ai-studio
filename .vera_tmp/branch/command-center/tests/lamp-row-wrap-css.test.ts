import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The status lamp row is one line on a desktop, but a long word beside the
// lamp (the "Started ... This page updates by itself" line of the Create
// page) must wrap inside its card on a phone instead of overflowing the page.
const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

/** The body of the first `@media (max-width: <px>px) { ... }` block that holds `needle`. */
function narrowBlock(needle: string): { px: number; body: string } | null {
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(re.lastIndex, i - 1);
    if (body.includes(needle)) return { px: Number(m[1]), body };
  }
  return null;
}

describe("ns-lamp-row on a narrow screen", () => {
  it("keeps the lamp dot fixed so only the text shrinks", () => {
    expect(css).toMatch(/\.ns-lamp\s*\{[^}]*flex-shrink:\s*0/);
  });

  it("allows the label to wrap at phone widths", () => {
    const blk = narrowBlock(".ns-lamp-label");
    expect(blk, "a max-width media block for .ns-lamp-label").not.toBeNull();
    expect(blk!.px).toBeGreaterThanOrEqual(480); // covers 320 and 390
    expect(blk!.px).toBeLessThanOrEqual(767);
    const label = blk!.body.match(/\.ns-lamp-row\s*>\s*\.ns-lamp-label\s*\{([^}]*)\}/);
    expect(label, "label rule").not.toBeNull();
    expect(label![1]).toMatch(/white-space:\s*normal/);
    expect(label![1]).toMatch(/min-width:\s*0/);
    expect(label![1]).toMatch(/overflow-wrap:\s*anywhere/);
    expect(blk!.body).toMatch(/\.ns-lamp-row\s*\{[^}]*max-width:\s*100%/);
  });

  it("does not change the desktop one-line row", () => {
    expect(css).toMatch(/\.ns-lamp-row\s*\{[^}]*white-space:\s*nowrap/);
  });
});
