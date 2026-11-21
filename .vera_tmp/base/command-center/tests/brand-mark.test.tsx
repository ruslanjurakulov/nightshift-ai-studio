// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "@/components/site/BrandMark";
import { BRAND_MARK_ART } from "@/components/site/brandMarkArt";

/**
 * The mark is the owner's picture: the folded-ribbon N, white with soft fold
 * shadows, on a black square, in the framing of the supplied 1254 px image.
 * Three things must stay true: the inline mark is the very drawing the brand kit
 * ships as a file (so a re-trace cannot update one and not the other); it is
 * decorative beside the wordmark and named when it stands alone; and several
 * marks on one page cannot steal each other's gradients.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

afterEach(cleanup);

const stopsOf = (root: Element | Document, gradientIdSuffix: string) =>
  [...root.querySelectorAll("linearGradient")]
    .find((g) => g.id.endsWith(gradientIdSuffix))!
    .querySelectorAll("stop");

describe("inline mark", () => {
  it("is the same drawing as brand/logo/nightshift-app-icon.svg", () => {
    const file = new DOMParser().parseFromString(read("brand/logo/nightshift-app-icon.svg"), "image/svg+xml");
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    const fileSvg = file.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe(fileSvg.getAttribute("viewBox"));
    expect(svg.getAttribute("viewBox")).toBe("0 0 1254 1254");
    // the silhouette
    expect([...svg.querySelectorAll("path")].map((p) => p.getAttribute("d"))).toEqual(
      [...fileSvg.querySelectorAll("path")].map((p) => p.getAttribute("d")),
    );
    // the tile and where the artwork puts the mark in it
    expect(svg.querySelector(":scope > rect")!.getAttribute("fill")).toBe(fileSvg.querySelector(":scope > rect")!.getAttribute("fill"));
    const place = (el: Element) => el.querySelector("g[transform]")!.getAttribute("transform");
    expect(place(svg)).toBe(place(fileSvg));
    // every fold-shadow gradient stop
    for (const suffix of ["lu", "ru", "lv", "rv", "rb"]) {
      const mine = [...stopsOf(svg, suffix)].map((s) => [s.getAttribute("offset"), s.getAttribute("stop-opacity")]);
      const theirs = [...stopsOf(fileSvg, suffix)].map((s) => [s.getAttribute("offset"), s.getAttribute("stop-opacity")]);
      expect(mine.map(([o, a]) => [Number(o), Number(a)])).toEqual(theirs.map(([o, a]) => [Number(o), Number(a)]));
    }
  });

  it("keeps the owner's proportions: the N is 37.9% of the tile, centred as in the image", () => {
    const { scale, ox, oy, tile } = BRAND_MARK_ART;
    const markW = 1000 * scale;
    const markH = BRAND_MARK_ART.vbH * scale;
    expect(markW / tile).toBeCloseTo(475.4 / 1254, 3);
    expect(Math.abs(ox + markW / 2 - tile / 2)).toBeLessThan(1);
    expect(Math.abs(oy + markH / 2 - tile / 2)).toBeLessThan(1);
  });

  it("is a black tile with the soft-shaded white mark, not a flat or currentColor drawing", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector(":scope > rect")!.getAttribute("fill")).toBe("#030303");
    expect(svg.querySelectorAll("linearGradient").length).toBe(5);
    expect(svg.innerHTML).not.toContain("currentColor");
  });

  it("gives every instance its own gradient ids, so many marks can share a page", () => {
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark size={28} />
        <BrandMark size={44} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBe(3 * 8);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll("svg")) {
      // every url(#...) resolves inside its own svg
      for (const m of svg.innerHTML.matchAll(/url\(#([^)]+)\)/g)) expect(svg.querySelector(`[id="${m[1]}"]`)).not.toBeNull();
    }
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

  it("is square at any size", () => {
    const { container } = render(<BrandMark size={32} />);
    const svg = container.querySelector("svg")!;
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["32", "32"]);
  });
});

describe("brand kit", () => {
  it("ships the four SVG masters", () => {
    for (const f of ["nightshift-mark", "nightshift-mark-mono", "nightshift-mark-dark", "nightshift-app-icon"]) {
      const svg = read(`brand/logo/${f}.svg`);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("<title");
    }
  });

  it("the transparent masters have no background rectangle", () => {
    for (const f of ["nightshift-mark", "nightshift-mark-mono", "nightshift-mark-dark"]) {
      expect(read(`brand/logo/${f}.svg`)).not.toMatch(/<rect[^>]*fill="#0/);
    }
  });

  it("the mono master has no gradient", () => {
    expect(read("brand/logo/nightshift-mark-mono.svg")).not.toMatch(/gradient|mask/i);
  });

  it("the tab icon is the mark on a black tile, not the old lamp", () => {
    const svg = read("app/icon.svg");
    expect(svg).toContain('fill="#030303"');
    expect(svg).not.toContain("<circle");
  });
});
