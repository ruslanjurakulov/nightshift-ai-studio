import type { CSSProperties } from "react";

/**
 * The mark: the folded-ribbon N, traced from the owner's artwork
 * (brand/logo/nightshift-mark-mono.svg is the same drawing as a file). One
 * colour, `currentColor`, so it follows whatever text colour it sits in and
 * works on the dark and the light theme alike; the fold where the ribbon
 * passes over each pillar is the same shape at half strength, so the mark
 * keeps its depth without a gradient or a second colour.
 *
 * Decorative beside the wordmark, which carries the name (aria-hidden, no
 * accessible name). On its own — no wordmark next to it — pass `title` and it
 * becomes an image named that.
 */
export const BRAND_MARK_OUTLINE =
  "M734.3 881.8L286.1 405.1L286.1 927C286.1 936.1 276.2 941.9 268.2 937.5L108.5 850.2C104.3 847.9 50.5 815.5 27.3 781.2C-0.8 739.8 0.2 707.8 0.2 679.6L0.2 130.4C0.2 49.9 41.9 0.6 130 0.2C209.9 -0.2 247.6 3.6 315.9 73.4L713.1 479.2L713.1 10.9C713.1 1.9 722.5 -3.8 730.8 0.2L837 54.3C873.6 73 934.6 110.6 953.5 132.3C995.2 180.3 999.6 211.8 999.6 261.3L999.6 774.7C999.6 847.5 974.5 901.1 905.8 928.5C844.8 952.5 781.4 932.1 734.3 881.8ZM116 224.3L286.1 405.1L286.1 515.7L138.7 358.9ZM713.1 479.2L999.6 771.9L999.6 663.7L713.1 370.9Z";
export const BRAND_MARK_FOLDS =
  "M116 224.3L286.1 405.1L286.1 515.7L138.7 358.9ZM713.1 479.2L999.6 771.9L999.6 663.7L713.1 370.9Z";

/** The mark's drawing is 1000 x 938 units. */
export const BRAND_MARK_RATIO = 938 / 1000;

export function BrandMark({
  className,
  size = 22,
  title,
}: {
  className?: string;
  /** Width in CSS pixels; the height follows the drawing's proportions. */
  size?: number;
  /** An accessible name, for the mark standing alone. Omit it beside the wordmark. */
  title?: string;
}) {
  const style: CSSProperties = { flexShrink: 0 };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1000 938"
      width={size}
      height={Math.round(size * BRAND_MARK_RATIO * 100) / 100}
      className={className}
      style={style}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      <path fill="currentColor" fillRule="evenodd" d={BRAND_MARK_OUTLINE} />
      <path fill="currentColor" fillOpacity={0.5} d={BRAND_MARK_FOLDS} />
    </svg>
  );
}
