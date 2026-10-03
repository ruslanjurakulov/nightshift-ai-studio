import { useId, type CSSProperties } from "react";
import { BRAND_MARK_ART as A } from "@/components/site/brandMarkArt";

/**
 * The mark, exactly as the owner drew it: the folded-ribbon N in white, with its
 * soft fold shadows, centred on a black square. The tile is the owner's image —
 * the same 1254 px square, the N in the same place at the same proportion (37.9%
 * of the tile's width) — traced to vector (brand/logo/nightshift-app-icon.svg is
 * the same drawing as a file, and tests/brand-mark.test.tsx holds the two equal).
 *
 * The tile is black in both themes, so the white N never meets a light page; on a
 * dark page a hairline ring keeps its edge visible. Gradient and clip ids are
 * unique per instance (useId), so any number of marks can share a page.
 *
 * Decorative beside the wordmark, which carries the name (aria-hidden, no
 * accessible name). On its own — no wordmark next to it — pass `title` and it
 * becomes an image named that.
 */
export function BrandMark({
  className,
  size = 36,
  title,
}: {
  className?: string;
  /** The tile's width and height in CSS pixels. */
  size?: number;
  /** An accessible name, for the mark standing alone. Omit it beside the wordmark. */
  title?: string;
}) {
  const id = `ns${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const style: CSSProperties = {
    flexShrink: 0,
    borderRadius: `${(A.tileRx / A.tile) * 100}%`,
    // A hairline that only shows against a dark page; on a light one the black tile stands alone.
    boxShadow: "0 0 0 1px rgba(255,255,255,0.14)",
  };
  const grad = (gid: string, x1: number, y1: number, x2: number, y2: number, stops: readonly (readonly [number, number])[], color: string) => (
    <linearGradient id={`${id}${gid}`} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
      {stops.map(([o, a]) => (
        <stop key={o} offset={o} stopColor={color} stopOpacity={a} />
      ))}
    </linearGradient>
  );
  const u = A.unit;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${A.tile} ${A.tile}`}
      width={size}
      height={size}
      className={className}
      style={style}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      <defs>
        <clipPath id={`${id}n`}>
          <path d={A.outline} />
        </clipPath>
        {grad("lu", 0, 0, 0, 170, A.lu, "#000")}
        {grad("ru", 0, 0, 0, 200, A.ru, "#000")}
        {grad("lv", -130, 0, 150, 0, A.lv, "#fff")}
        {grad("rv", -100, 0, 200, 0, A.rv, "#fff")}
        {grad("rb", A.rbX[0], 0, A.rbX[1], 0, A.rb, "#000")}
        <mask id={`${id}lm`} maskUnits="userSpaceOnUse" x={-200} y={-10} width={400} height={200}>
          <rect x={-200} y={-10} width={400} height={200} fill={`url(#${id}lv)`} />
        </mask>
        <mask id={`${id}rm`} maskUnits="userSpaceOnUse" x={-110} y={-10} width={360} height={230}>
          <rect x={-110} y={-10} width={360} height={230} fill={`url(#${id}rv)`} />
        </mask>
      </defs>
      <rect width={A.tile} height={A.tile} fill={A.bg} />
      <g transform={`translate(${A.ox} ${A.oy}) scale(${A.scale})`}>
        <path d={A.outline} fill="#FAFAFA" />
        <g clipPath={`url(#${id}n)`}>
          <rect x={-100} y={-100} width={1300} height={1200} fill={`url(#${id}rb)`} />
          <g transform={`translate(${A.n1[0]} ${A.n1[1]}) rotate(${A.n1[2]}) scale(${u})`}>
            <rect x={-200} y={0} width={400} height={170} fill={`url(#${id}lu)`} mask={`url(#${id}lm)`} />
          </g>
          <g transform={`translate(${A.n2[0]} ${A.n2[1]}) rotate(${A.n2[2]}) scale(${u} ${-u})`}>
            <rect x={-110} y={0} width={360} height={200} fill={`url(#${id}ru)`} mask={`url(#${id}rm)`} />
          </g>
        </g>
      </g>
    </svg>
  );
}
