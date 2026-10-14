/**
 * A rough picture of an overlay's chroma key in the preview. The export keys
 * the overlay file with the `chromakey` filter: a pixel's distance from the key
 * colour is measured in the two chroma planes only (brightness is ignored),
 * `diff = sqrt((du^2 + dv^2) / 2)` with du, dv in 0..1 of the 8-bit range;
 * `diff <= similarity` is removed, and `blend` softens the edge:
 * `alpha = clamp((diff - similarity) / blend)`.
 *
 * The browser has no such filter, so the preview builds the same arithmetic as
 * an SVG filter: a matrix to (du, dv), tables to square them, a matrix to add
 * them (that is diff squared), a table that turns diff squared into alpha, and
 * a composite that multiplies the picture by it. Limited-range video chroma
 * (224 of 255 codes) is allowed for. Colours the browser's own conversion
 * treats differently, fringes and compression noise make it approximate: the
 * exported file is the reference, and the panel says so.
 */
import {
  CHROMA_BLEND_DEFAULT,
  CHROMA_SIMILARITY_DEFAULT,
  type ChromaKey,
} from "@/lib/editor";

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Full-range BT.601 chroma weights (Cb, Cr) of r, g, b in 0..1. */
const CB = [-0.168736, -0.331264, 0.5] as const;
const CR = [0.5, -0.418688, -0.081312] as const;
/** Limited-range video uses 224 of 255 codes for chroma. */
const LIMITED = 224 / 255;
/** Steps of the squaring table and of the alpha table. */
export const SQUARE_STEPS = 33;
export const ALPHA_STEPS = 257;

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
}

/** The key colour's chroma (Cb, Cr), centred on 0. */
export function keyChroma(rgb: readonly [number, number, number]): [number, number] {
  const dot = (w: readonly number[]) => w[0] * rgb[0] + w[1] * rgb[1] + w[2] * rgb[2];
  return [dot(CB), dot(CR)];
}

/** What the filter holds, as the strings of its attributes. */
export interface ChromaSpec {
  /** feColorMatrix 1: (du, dv) of the pixel against the key, each as 0.5 + delta/2. */
  toDistance: string;
  /** feFuncR / feFuncG table: that value to the squared delta. */
  square: string;
  /** feColorMatrix 2: alpha = (du^2 + dv^2) / 2, i.e. diff squared. */
  sum: string;
  /** feFuncA table: diff squared to the alpha the key leaves. */
  alpha: string;
}

export function chromaSpec(chroma: ChromaKey): ChromaSpec | null {
  const rgb = parseHex(chroma.color);
  if (!rgb) return null;
  const sim = chroma.similarity ?? CHROMA_SIMILARITY_DEFAULT;
  const blend = chroma.blend ?? CHROMA_BLEND_DEFAULT;
  const [kcb, kcr] = keyChroma(rgb);
  const row = (w: readonly number[], k: number) =>
    [...w.map((x) => round4((LIMITED * x) / 2)), 0, round4(0.5 - (LIMITED * k) / 2)].join(" ");
  const toDistance = [row(CB, kcb), row(CR, kcr), "0 0 0 0 0", "0 0 0 0 1"].join(" ");
  const square = Array.from({ length: SQUARE_STEPS }, (_, i) => {
    const d = (i / (SQUARE_STEPS - 1) - 0.5) * 2;
    return round4(d * d);
  }).join(" ");
  const sum = ["0 0 0 0 0", "0 0 0 0 0", "0 0 0 0 0", "0.5 0.5 0 0 0"].join(" ");
  const alpha = Array.from({ length: ALPHA_STEPS }, (_, i) => {
    const diff = Math.sqrt(i / (ALPHA_STEPS - 1));
    const a = blend > 0 ? (diff - sim) / blend : diff > sim ? 1 : 0;
    return round4(Math.min(1, Math.max(0, a)));
  }).join(" ");
  return { toDistance, square, sum, alpha };
}

/** The alpha the key leaves for a pixel, by the same arithmetic as the filter
 *  (used to pin the preview to the export's definition in a test). */
export function keyedAlpha(chroma: ChromaKey, pixelHex: string): number {
  const key = parseHex(chroma.color);
  const px = parseHex(pixelHex);
  if (!key || !px) return 1;
  const [kcb, kcr] = keyChroma(key);
  const [pcb, pcr] = keyChroma(px);
  const du = LIMITED * (pcb - kcb);
  const dv = LIMITED * (pcr - kcr);
  const diff = Math.sqrt((du * du + dv * dv) / 2);
  const sim = chroma.similarity ?? CHROMA_SIMILARITY_DEFAULT;
  const blend = chroma.blend ?? CHROMA_BLEND_DEFAULT;
  const a = blend > 0 ? (diff - sim) / blend : diff > sim ? 1 : 0;
  return Math.min(1, Math.max(0, a));
}

/** The id of one overlay's key filter. */
export const chromaFilterId = (overlayId: string) => `ns-chroma-${overlayId}`;
