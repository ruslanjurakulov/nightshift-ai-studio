// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BRAND_MARK_FOLDS, BRAND_MARK_OUTLINE, BrandMark } from "@/components/site/BrandMark";

/**
 * The folded-ribbon N is the owner's artwork, traced to vector. Three things
 * must stay true: the inline mark is the very drawing the brand kit ships as a
 * file (so a re-trace cannot update one and not the other); it is decorative
 * beside the wordmark and named when it stands alone; and the icons the app
 * serves are real images of the sizes browsers and iOS ask for.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p));

afterEach(cleanup);

describe("inline mark", () => {
  it("is the same drawing as brand/logo/nightshift-mark-mono.svg", () => {
    const svg = read("brand/logo/nightshift-mark-mono.svg").toString("utf8");
    const paths = [...svg.matchAll(/<path [^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toEqual([BRAND_MARK_OUTLINE, BRAND_MARK_FOLDS]);
    expect(svg).toContain('viewBox="0 0 1000 938"');
  });

  it("is one colour, currentColor, with no gradient or id that could collide when repeated", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.innerHTML).not.toMatch(/gradient|url\(|id=/i);
    const fills = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
    expect(fills).toEqual(["currentColor", "currentColor"]);
  });

  it("is hidden from assistive technology beside the wordmark", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.getAttribute("aria-label")).toBeNull();
  });

  it("is an image with an accessible name when it stands alone", () => {
    const { getByRole } = render(<BrandMark title="Nightshift" />);
    const img = getByRole("img", { name: "Nightshift" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });

  it("keeps the drawing's proportions at any size", () => {
    const { container } = render(<BrandMark size={32} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("32");
    expect(Number(svg.getAttribute("height"))).toBeCloseTo(30.02, 1);
  });
});

/** Width/height of a PNG from its IHDR, colour type 2 = RGB (no alpha). */
function pngInfo(buf: Buffer) {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25] };
}

describe("served icons (Next.js file convention)", () => {
  it("icon.png is 512 square", () => {
    const i = pngInfo(read("app/icon.png"));
    expect([i.w, i.h]).toEqual([512, 512]);
  });

  it("apple-icon.png is 180 square with no transparency", () => {
    const i = pngInfo(read("app/apple-icon.png"));
    expect([i.w, i.h]).toEqual([180, 180]);
    expect(i.colorType).toBe(2); // RGB: a transparent corner would render black-on-black-or-white on iOS
  });

  it("favicon.ico holds 16, 32 and 48 px images", () => {
    const ico = read("app/favicon.ico");
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const n = ico.readUInt16LE(4);
    const sizes = Array.from({ length: n }, (_, k) => ico[6 + 16 * k]);
    expect(sizes).toEqual([16, 32, 48]);
    for (let k = 0; k < n; k++) {
      const len = ico.readUInt32LE(6 + 16 * k + 8);
      const off = ico.readUInt32LE(6 + 16 * k + 12);
      expect(pngInfo(ico.subarray(off, off + len)).w).toBe(sizes[k]);
    }
  });

  it("icon.svg is the mark on a black tile", () => {
    const svg = read("app/icon.svg").toString("utf8");
    expect(svg).toContain("<title");
    expect(svg).toContain('fill="#000"');
    expect(svg).not.toContain("<circle"); // the old lamp-in-bezel
  });
});

describe("brand kit", () => {
  it("ships the four SVG masters", () => {
    for (const f of ["nightshift-mark", "nightshift-mark-mono", "nightshift-mark-dark", "nightshift-app-icon"]) {
      const svg = read(`brand/logo/${f}.svg`).toString("utf8");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("<title");
    }
  });

  it("the transparent masters have no background rectangle", () => {
    for (const f of ["nightshift-mark", "nightshift-mark-mono", "nightshift-mark-dark"]) {
      expect(read(`brand/logo/${f}.svg`).toString("utf8")).not.toMatch(/<rect[^>]*fill="#0/);
    }
  });

  it("the mono master has no gradient", () => {
    expect(read("brand/logo/nightshift-mark-mono.svg").toString("utf8")).not.toMatch(/gradient|mask/i);
  });

  it("maskable PNGs are 192 and 512", () => {
    expect(pngInfo(read("brand/logo/png/nightshift-maskable-192.png")).w).toBe(192);
    expect(pngInfo(read("brand/logo/png/nightshift-maskable-512.png")).w).toBe(512);
  });
});
