/**
 * Geometry for a style's "palette preview" tile — pure, so it is testable and
 * the same on the server and in the browser.
 *
 * The tile is drawn from nothing but the style's swatch and its motif: a few
 * flat shapes in the palette's colours with a texture laid over them. It is a
 * colour-and-texture swatch, not a sample picture, and the page labels it so.
 * Nothing here makes up an image of what a model will produce.
 */

import type { LibraryStyle } from "@/lib/styles/library";

/** FNV-1a: a small, stable string hash. The same id always draws the same tile. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a seeded generator in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Relative luminance (WCAG) of #rrggbb, 0..1. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function darkest(swatch: readonly string[]): string {
  return [...swatch].sort((a, b) => luminance(a) - luminance(b))[0];
}

export function lightest(swatch: readonly string[]): string {
  return [...swatch].sort((a, b) => luminance(b) - luminance(a))[0];
}

export const TILE_W = 160;
export const TILE_H = 120;

export interface TileShapes {
  ground: string;
  disc: { cx: number; cy: number; r: number; fill: string };
  band: { y: number; h: number; fill: string };
  wedge: { points: string; fill: string };
  dot: { cx: number; cy: number; r: number; fill: string };
  /** Ink for line and dot textures: the darkest of the palette. */
  ink: string;
  /** Paper for grid lines and highlights: the lightest of the palette. */
  paper: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The flat shapes of a tile, placed from the style's id and coloured from its swatch. */
export function tileShapes(style: Pick<LibraryStyle, "id" | "swatch">): TileShapes {
  const next = rng(hashSeed(style.id));
  const s = style.swatch;
  const at = (i: number) => s[i % s.length];
  const wedgeY = 40 + next() * 30;
  return {
    ground: at(0),
    disc: { cx: round(46 + next() * 70), cy: round(34 + next() * 30), r: round(24 + next() * 16), fill: at(1) },
    band: { y: round(80 + next() * 10), h: TILE_H, fill: at(2) },
    wedge: {
      points: `${round(next() * 60)},${TILE_H} ${round(70 + next() * 50)},${round(wedgeY)} ${round(110 + next() * 50)},${TILE_H}`,
      fill: at(3),
    },
    dot: { cx: round(14 + next() * 132), cy: round(14 + next() * 40), r: round(5 + next() * 6), fill: at(s.length - 1) },
    ink: darkest(s),
    paper: lightest(s),
  };
}
