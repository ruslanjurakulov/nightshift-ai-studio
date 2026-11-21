/**
 * How the preview draws an animated caption style — an APPROXIMATION.
 *
 * The export writes the style with libass (modules/ass_captions.py); the
 * browser cannot draw the same pixels, so this follows the same timings
 * (which word is lit when, the pop, the slide, the typed letters) with CSS.
 * The words' times are the export's own rule (wordSpansMs), the typewriter's
 * runs are its own schedule (typedAtoms), and the numbers below are the ones
 * the ASS tags use. What differs: glow, outline and box edges are CSS, a
 * karaoke fill snaps to a colour instead of sweeping, and the text wraps where
 * the browser wraps it. The panel and the preview both say so.
 *
 * Pure: the same inputs give the same CSS.
 */
import type { CSSProperties } from "react";
import {
  MAX_STYLED_WORDS,
  cueLines,
  isCaptionStyleId,
  styleDef,
  textOn,
  typedAtoms,
  wordSpansMs,
  type CaptionStyleId,
} from "@/lib/captionStyleTable";
import { FONT_FAMILY, cqw, rgba, ring } from "@/lib/editorTextLookPreview";

/** The numbers the export's tags use (modules/ass_captions.py). */
export const BOXED_OPACITY = 0.75;
export const BOXED_PADDING_EM = 0.15;
export const LOWER_THIRD_OPACITY = 0.9;
export const BOX_PADDING_EM = 0.25;

export interface PreviewSegment {
  text: string;
  style?: CSSProperties;
}

export interface StyledPreview {
  /** The absolutely placed, animated box. */
  box: CSSProperties;
  /** Lines of segments; segments sit side by side. */
  lines: PreviewSegment[][];
}

export interface PreviewInput {
  style: {
    preset?: unknown;
    color: string;
    highlight_color?: string;
    outline_color: string;
    outline_width: number;
    size: number;
    y: number;
    font: keyof typeof FONT_FAMILY;
    bold: boolean;
  };
  text: string;
  startS: number;
  endS: number;
  /** The playhead, seconds on the timeline. */
  t: number;
  /** The frame's width in output pixels (the unit of `size`). */
  frameWidth: number;
  /** False when the export writes this cue without lit words (perWordCueIds); default true. */
  perWord?: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The export's \fad: in and out each at most half of a short cue. */
function fade(eMs: number, durMs: number, inMs: number, outMs: number): number {
  const half = Math.floor(durMs / 2);
  const a = Math.min(inMs, half);
  const b = Math.min(outMs, half);
  const fin = a > 0 ? clamp01(eMs / a) : 1;
  const fout = b > 0 ? clamp01((durMs - eMs) / b) : 1;
  return Math.min(fin, fout);
}

/** The pop's scale: 60 % → 118 % in 130 ms, back to 100 % by 250 ms. */
export function popScale(eMs: number): number {
  if (eMs < 130) return 0.6 + 0.58 * (eMs / 130);
  if (eMs < 250) return 1.18 - 0.18 * ((eMs - 130) / 120);
  return 1;
}

/** A style's CSS for the cue at the playhead. null when `preset` is not a style. */
export function previewStyledCaption(inp: PreviewInput): StyledPreview | null {
  const id = inp.style.preset;
  if (!isCaptionStyleId(id)) return null;
  const def = styleDef(id);
  const st = inp.style;
  const hi = st.highlight_color && /^#[0-9a-fA-F]{6}$/.test(st.highlight_color) ? st.highlight_color : def.highlight_color;
  const durMs = Math.max(10, Math.round((inp.endS - inp.startS) * 100) * 10);
  const eMs = Math.min(durMs, Math.max(0, (inp.t - inp.startS) * 1000));
  const w = inp.frameWidth;
  const lines = cueLines(inp.text);
  const words = lines.flat();
  const styled = (inp.perWord ?? true) && words.length > 0 && words.length <= MAX_STYLED_WORDS;
  const spans = wordSpansMs(words, durMs);
  const outline = ring(st.outline_color, st.outline_width, w).join(", ");

  const box: CSSProperties = {
    position: "absolute",
    left: `${def.x * 100}%`,
    top: `${st.y * 100}%`,
    maxWidth: "92%",
    fontFamily: FONT_FAMILY[st.font] ?? FONT_FAMILY["DejaVu Sans"],
    fontWeight: st.bold ? 700 : 400,
    fontSize: cqw(st.size, w),
    lineHeight: 1.15,
    color: st.color,
    whiteSpace: "pre-wrap",
    textAlign: def.anchor === "bottom-left" ? "left" : "center",
    textShadow: outline || "none",
    opacity: 1,
  };
  const anchorShift = def.anchor === "center" ? "translate(-50%, -50%)" : def.anchor === "bottom-left" ? "translate(0, -100%)" : "translate(-50%, -100%)";
  box.transform = anchorShift;

  /** Each word as a segment, the given look for the lit one. */
  const perWord = (look: (k: number, lit: boolean, done: boolean) => CSSProperties | undefined): PreviewSegment[][] => {
    let k = 0;
    return lines.map((ln) => {
      const row: PreviewSegment[] = [];
      ln.forEach((word, j) => {
        const [a, b] = spans[k] ?? [0, 0];
        const lit = styled && eMs >= a && (eMs < b || k === words.length - 1);
        const done = styled && eMs >= b;
        row.push({ text: word, style: styled ? look(k, lit, done) : undefined });
        if (j + 1 < ln.length) row.push({ text: " " });
        k += 1;
      });
      return row;
    });
  };
  const plain = (): PreviewSegment[][] => lines.map((ln) => [{ text: ln.join(" ") }]);

  const out = (id2: CaptionStyleId): StyledPreview => {
    switch (id2) {
      case "karaoke": {
        box.opacity = fade(eMs, durMs, 80, 80);
        // Half-way through a word it is filled: the export sweeps, the preview snaps.
        return { box, lines: perWord((k) => ({ color: eMs >= (spans[k][0] + spans[k][1]) / 2 ? hi : st.color })) };
      }
      case "pop_in": {
        box.opacity = fade(eMs, durMs, 70, 100);
        box.transform = `${anchorShift} scale(${popScale(eMs).toFixed(3)})`;
        box.transformOrigin = "50% 100%";
        return { box, lines: plain() };
      }
      case "boxed": {
        box.opacity = fade(eMs, durMs, 80, 80);
        box.textShadow = "none";
        const pad = `0 ${BOXED_PADDING_EM}em`;
        return {
          box,
          lines: perWord((_k, lit) => ({
            backgroundColor: lit ? hi : rgba(st.outline_color, BOXED_OPACITY),
            color: lit ? textOn(hi) : st.color,
            padding: pad,
          })),
        };
      }
      case "big_centre": {
        box.opacity = fade(eMs, durMs, 60, 60);
        return { box, lines: perWord((_k, lit) => ({ color: lit ? hi : st.color })) };
      }
      case "lower_third": {
        const p = clamp01(eMs / Math.min(240, durMs));
        box.opacity = fade(eMs, durMs, 150, 120);
        box.transform = `${anchorShift} translateX(${cqw(-48 * (1 - p), w)})`;
        box.textShadow = "none";
        return {
          box,
          lines: lines.map((ln) => [
            {
              text: ln.join(" "),
              style: { backgroundColor: rgba(hi, LOWER_THIRD_OPACITY), padding: `${BOX_PADDING_EM}em`, boxDecorationBreak: "clone" as const },
            },
          ]),
        };
      }
      case "outlined": {
        box.opacity = fade(eMs, durMs, 60, 60);
        box.textShadow = ring(hi, st.outline_width, w).join(", ") || "none";
        return { box, lines: plain() };
      }
      case "neon": {
        box.opacity = fade(eMs, durMs, 120, 120);
        const halo = [0.2, 0.45, 0.8].map((k) => `0 0 ${cqw(st.size * k, w)} ${hi}`);
        box.textShadow = [...ring(hi, Math.max(1, Math.round(st.size * 0.03)), w), ...halo].join(", ");
        return { box, lines: plain() };
      }
      case "typewriter": {
        const atoms = lines.reduce((n, ln, i) => n + (i ? 1 : 0) + Array.from(ln.join(" ")).length, 0);
        let left = typedAtoms(atoms, durMs, eMs);
        const hidden: CSSProperties = { color: "transparent", textShadow: "none" };
        const rows = lines.map((ln, i) => {
          const chars = Array.from(ln.join(" "));
          if (i > 0) left -= 1; // the line break is an atom too
          const shown = Math.max(0, Math.min(chars.length, left));
          left -= chars.length;
          const row: PreviewSegment[] = [{ text: chars.slice(0, shown).join("") }];
          if (shown < chars.length) row.push({ text: chars.slice(shown).join(""), style: hidden });
          return row;
        });
        return { box, lines: rows };
      }
      case "line_slide": {
        const p = clamp01(eMs / Math.min(260, durMs));
        box.opacity = fade(eMs, durMs, 180, 140);
        box.transform = `${anchorShift} translateY(${cqw(Math.round(st.size * 0.6) * (1 - p), w)})`;
        return { box, lines: plain() };
      }
      default: {
        // clean: light text, soft shadow, no outline
        box.opacity = fade(eMs, durMs, 150, 150);
        box.textShadow = `${cqw(2, w)} ${cqw(2, w)} 0 ${rgba("#000000", 0.5)}`;
        return { box, lines: plain() };
      }
    }
  };
  return out(id);
}
