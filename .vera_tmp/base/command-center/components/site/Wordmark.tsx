import type { CSSProperties } from "react";
import { BRAND_MARK_ART as A } from "@/components/site/brandMarkArt";
import { MarkBody, MarkDefs, useMarkId } from "@/components/site/BrandMark";
import { WORDMARK_ART as W } from "@/components/site/wordmarkArt";

/**
 * The product's wordmark, as the owner drew it (brand/logo/source/owner-supplied-wordmark-1842.png):
 * the bare folded-ribbon N, no tile, then NIGHTSHIFT in wide, bold, rounded-square capitals.
 * One inline SVG that draws in `currentColor`, so it follows the theme: the cream N and
 * lettering of the control room, the near-black ones of the proof sheet. The N's fold is
 * `var(--ns-fold)` (black on cream, white on near-black), so it reads grey in both.
 *
 * The proportions are measured from the owner's image: the N is 2.05 times the lettering's
 * cap height, the gap between them 0.62 of it, and both are centred on one line.
 *
 * The size is one number, the N's height. It is `--wm-h` where a parent sets it (so a media
 * query can step the lockup down) and `height` where it does not. The width follows from the
 * drawing, so nothing reflows. `mark` is the bare N, for the collapsed sidebar.
 *
 * The drawing is decorative (aria-hidden): the link around it carries the name. Give that
 * link `aria-label={t.brand.name}`, or put the name beside it in `sr-only`.
 */
const CAP = A.vbH / 2.05; // the lettering's cap height, in the N's 1000-unit space
const SCALE = CAP / W.h;
const GAP = 0.62 * CAP;
const LETTERS_W = W.w * SCALE;
const FULL_W = A.vbW + GAP + LETTERS_W;

/** Width over height of the full lockup, and of the bare N. */
export const WORDMARK_ASPECT = FULL_W / A.vbH;
export const MARK_ASPECT = A.vbW / A.vbH;

export function Wordmark({
  className,
  height = 32,
  mark = false,
}: {
  className?: string;
  /** The N's height in CSS pixels, unless a parent sets `--wm-h`. */
  height?: number;
  /** The N alone, without the lettering. */
  mark?: boolean;
}) {
  const id = useMarkId();
  const h = `var(--wm-h, ${height}px)`;
  const style: CSSProperties = {
    display: "block",
    flexShrink: 0,
    height: h,
    width: `calc(${h} * ${(mark ? MARK_ASPECT : WORDMARK_ASPECT).toFixed(4)})`,
    color: "inherit",
    overflow: "visible",
  };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${mark ? A.vbW : +FULL_W.toFixed(1)} ${A.vbH}`}
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
      data-wordmark={mark ? "mark" : "full"}
    >
      <MarkDefs id={id} fold="var(--ns-fold, #000)" />
      <MarkBody id={id} fill="currentColor" />
      {!mark && (
        <g data-letters transform={`translate(${+(A.vbW + GAP).toFixed(1)} ${+((A.vbH - CAP) / 2).toFixed(1)}) scale(${+SCALE.toFixed(4)})`}>
          <path d={W.path} fill="currentColor" fillRule="evenodd" />
        </g>
      )}
    </svg>
  );
}
