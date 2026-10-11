// @vitest-environment jsdom
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BRAND_MARK_ART } from "@/components/site/brandMarkArt";
import { MARK_ASPECT, Wordmark, WORDMARK_ASPECT } from "@/components/site/Wordmark";
import { WORDMARK_ART } from "@/components/site/wordmarkArt";

/**
 * The wordmark is the owner's lockup: the bare N (no tile) and the wide rounded-square
 * NIGHTSHIFT lettering, one inline vector in currentColor. What must stay true: it is the same
 * drawing as the brand kit's nightshift-wordmark.svg; it has no tile; it is decorative (the
 * link around it carries the name); it follows the theme through currentColor; and the
 * proportions are the owner's image's.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

afterEach(cleanup);

describe("brand kit file", () => {
  const svg = read("brand/logo/nightshift-wordmark.svg");

  it("is small, one colour (currentColor), evenodd, with a title", () => {
    expect(statSync(join(ROOT, "brand/logo/nightshift-wordmark.svg")).size).toBeLessThan(8 * 1024);
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain("<title");
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
  });

  it("is the very path the inline lockup draws", () => {
    const file = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(file.querySelector("path")!.getAttribute("d")).toBe(WORDMARK_ART.path);
    expect(file.querySelector("svg")!.getAttribute("viewBox")).toBe(`0 0 ${WORDMARK_ART.w} ${WORDMARK_ART.h}`);
  });

  it("keeps the owner's reference image beside the N's", () => {
    expect(statSync(join(ROOT, "brand/logo/source/owner-supplied-wordmark-1842.png")).size).toBeGreaterThan(100_000);
    expect(statSync(join(ROOT, "brand/logo/source/owner-supplied-N-1254.png")).size).toBeGreaterThan(100_000);
  });
});

describe("inline lockup", () => {
  it("is the bare N then the lettering: no tile, no rounded square, drawn in currentColor", () => {
    const { container } = render(<Wordmark />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("rect[width='1254']")).toBeNull();
    expect(svg.innerHTML).not.toContain("#030303");
    expect(svg.getAttribute("style") ?? "").not.toMatch(/border-radius|box-shadow/);
    const fills = [...svg.querySelectorAll(":scope > path, :scope > g > path")].map((p) => p.getAttribute("fill"));
    expect(fills).toEqual(["currentColor", "currentColor"]); // the N, the lettering
    expect(svg.querySelector("path[fill-rule='evenodd']")!.getAttribute("d")).toBe(WORDMARK_ART.path);
  });

  it("shades the N's fold with the theme's fold colour, so it is grey on cream and on near-black", () => {
    const { container } = render(<Wordmark />);
    const stops = [...container.querySelectorAll("linearGradient")].filter((g) => !/lv|rv/.test(g.id)).flatMap((g) => [...g.querySelectorAll("stop")]);
    expect(stops.length).toBeGreaterThan(10);
    for (const stop of stops) expect(stop.getAttribute("style")).toContain("var(--ns-fold");
  });

  it("is decorative: hidden from assistive technology, not focusable, no name of its own", () => {
    const { container } = render(<Wordmark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.getAttribute("aria-label")).toBeNull();
    expect(svg.querySelector("title")).toBeNull();
  });

  it("takes its name from the link around it", () => {
    const { getByRole } = render(
      <a href="#top" aria-label="Nightshift">
        <Wordmark />
      </a>,
    );
    expect(getByRole("link", { name: "Nightshift" })).toBeTruthy();
  });

  it("has the owner's proportions: N 2.05 x the cap height, gap 0.62 of it, one line", () => {
    const { container } = render(<Wordmark />);
    const svg = container.querySelector("svg")!;
    const [, , vw, vh] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(vh).toBe(BRAND_MARK_ART.vbH);
    expect(vw / vh).toBeCloseTo(WORDMARK_ASPECT, 2);
    const g = svg.querySelector("g[data-letters]")!;
    const [tx, ty] = /translate\(([\d.]+) ([\d.]+)\)/.exec(g.getAttribute("transform")!)!.slice(1).map(Number);
    const s = Number(/scale\(([\d.]+)\)/.exec(g.getAttribute("transform")!)![1]);
    const cap = WORDMARK_ART.h * s;
    expect(BRAND_MARK_ART.vbH / cap).toBeCloseTo(2.05, 1);
    expect((tx - BRAND_MARK_ART.vbW) / cap).toBeCloseTo(0.62, 1);
    expect(ty + cap / 2).toBeCloseTo(BRAND_MARK_ART.vbH / 2, 0); // centred on the N
    expect(tx + WORDMARK_ART.w * s).toBeCloseTo(vw, 0);
  });

  it("is sized by one number, the N's height, and keeps its aspect (var --wm-h, else the prop)", () => {
    const { container } = render(
      <>
        <Wordmark height={30} />
        <Wordmark mark height={30} />
      </>,
    );
    const [full, mark] = [...container.querySelectorAll("svg")];
    expect(full.style.height).toBe("var(--wm-h, 30px)");
    expect(full.style.width).toContain(WORDMARK_ASPECT.toFixed(4));
    expect(mark.style.width).toContain(MARK_ASPECT.toFixed(4));
  });

  it("the bare N has no lettering", () => {
    const { container } = render(<Wordmark mark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("data-wordmark")).toBe("mark");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${BRAND_MARK_ART.vbW} ${BRAND_MARK_ART.vbH}`);
    expect(svg.querySelector("g[data-letters]")).toBeNull();
  });

  it("gives every instance its own ids, so many lockups can share a page", () => {
    const { container } = render(
      <>
        <Wordmark />
        <Wordmark mark />
        <Wordmark height={20} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll("svg")) {
      for (const m of svg.innerHTML.matchAll(/url\(#([^)]+)\)/g)) expect(svg.querySelector(`[id="${m[1]}"]`)).not.toBeNull();
    }
  });
});

describe("where it is used", () => {
  const files = [
    "components/Header.tsx",
    "components/SideNav.tsx",
    "components/shell/CustomerSidebar.tsx",
    "components/auth/AuthShell.tsx",
    "components/oauth/OAuthShell.tsx",
    "components/legal/PublicShell.tsx",
    "components/legal/PublicFooter.tsx",
    "components/welcome/WelcomeFlow.tsx",
  ];
  it.each(files)("%s draws the lockup, not the tile and the condensed text", (f) => {
    const src = read(f);
    expect(src).toContain("<Wordmark");
    expect(src).not.toMatch(/BrandMark|ns-wordmark/);
  });
  it("the old condensed logotype is gone from the CSS", () => {
    for (const f of ["app/globals.css", "app/fonts.css", "components/site/site.css"]) expect(read(f)).not.toMatch(/ns-wordmark|Nightshift Wordmark/);
  });
});
