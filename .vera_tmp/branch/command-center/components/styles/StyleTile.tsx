"use client";

import { useId } from "react";
import type { LibraryStyle } from "@/lib/styles/library";
import { TILE_H, TILE_W, tileShapes } from "@/lib/styles/tile";

/**
 * A style's palette preview: flat shapes in the style's own colours with its
 * texture motif laid over them (grain, halftone dots, hatching, a blueprint
 * grid, an ikat lattice, tile stars, contact-sheet frames, bands, washes).
 *
 * It is drawn, not generated — no model is involved and it claims nothing
 * about what one will make — so the tile carries a visible "Palette preview"
 * label. The only literal colours are the style's own swatch data, which is
 * the point of the tile; chrome (the label chip) uses the app's tokens.
 */
export function StyleTile({
  style,
  label,
  className = "",
}: {
  style: Pick<LibraryStyle, "id" | "swatch" | "motif">;
  /** The words of the "Palette preview" chip; empty hides it (the detail sheet labels it itself). */
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const g = tileShapes(style);
  const id = (n: string) => `${n}${uid}`;
  const overlay = `url(#${id("m")})`;

  return (
    <div className={`relative overflow-hidden bg-[var(--color-panel-2)] ${className}`}>
      <svg
        viewBox={`0 0 ${TILE_W} ${TILE_H}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
        focusable="false"
        className="block h-full w-full"
      >
        <defs>
          {style.motif === "grain" && (
            <filter id={id("f")} x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
          )}
          {style.motif === "wash" && (
            <filter id={id("b")} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
          )}
          {style.motif === "halftone" && (
            <pattern id={id("m")} width="6" height="6" patternUnits="userSpaceOnUse">
              <circle cx="3" cy="3" r="1.5" fill={g.ink} />
            </pattern>
          )}
          {style.motif === "hatch" && (
            <pattern id={id("m")} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
              <line x1="0" y1="0" x2="0" y2="5" stroke={g.ink} strokeWidth="1.1" />
            </pattern>
          )}
          {style.motif === "grid" && (
            <pattern id={id("m")} width="16" height="16" patternUnits="userSpaceOnUse">
              <path d="M16 0H0V16" fill="none" stroke={g.paper} strokeWidth="0.6" />
            </pattern>
          )}
          {style.motif === "lattice" && (
            <pattern id={id("m")} width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M10 0L20 10L10 20L0 10Z" fill="none" stroke={g.paper} strokeWidth="1.2" />
              <path d="M10 6L14 10L10 14L6 10Z" fill={g.ink} />
            </pattern>
          )}
          {style.motif === "stars" && (
            <pattern id={id("m")} width="26" height="26" patternUnits="userSpaceOnUse">
              <path
                d="M13 2L16 8L22.5 6.5L19 13L22.5 19.5L16 18L13 24L10 18L3.5 19.5L7 13L3.5 6.5L10 8Z"
                fill="none"
                stroke={g.paper}
                strokeWidth="1"
              />
              <circle cx="13" cy="13" r="2" fill={g.ink} />
            </pattern>
          )}
        </defs>

        <rect width={TILE_W} height={TILE_H} fill={g.ground} />
        <circle cx={g.disc.cx} cy={g.disc.cy} r={g.disc.r} fill={g.disc.fill} />
        <rect y={g.band.y} width={TILE_W} height={g.band.h} fill={g.band.fill} />
        <polygon points={g.wedge.points} fill={g.wedge.fill} opacity="0.92" />
        <circle cx={g.dot.cx} cy={g.dot.cy} r={g.dot.r} fill={g.dot.fill} />

        {style.motif === "grain" && (
          <rect width={TILE_W} height={TILE_H} filter={`url(#${id("f")})`} opacity="0.4" style={{ mixBlendMode: "multiply" }} />
        )}
        {(style.motif === "halftone" || style.motif === "hatch") && (
          <rect width={TILE_W} height={TILE_H} fill={overlay} opacity="0.35" />
        )}
        {(style.motif === "grid" || style.motif === "lattice" || style.motif === "stars") && (
          <rect width={TILE_W} height={TILE_H} fill={overlay} opacity={style.motif === "grid" ? 0.7 : 0.55} />
        )}
        {style.motif === "frames" &&
          [0, 1, 2].flatMap((c) =>
            [0, 1].map((r) => (
              <rect
                key={`${c}-${r}`}
                x={8 + c * 50}
                y={8 + r * 56}
                width="46"
                height="50"
                fill="none"
                stroke={g.paper}
                strokeWidth="1.4"
                opacity="0.8"
              />
            )),
          )}
        {style.motif === "bands" &&
          style.swatch.slice(1).map((c, i) => (
            <rect key={i} x={8 + i * 34} y="0" width="9" height={TILE_H} fill={c} opacity="0.55" />
          ))}
        {style.motif === "wash" && (
          <g filter={`url(#${id("b")})`} opacity="0.55">
            <circle cx="40" cy="38" r="26" fill={style.swatch[1 % style.swatch.length]} />
            <circle cx="112" cy="70" r="30" fill={style.swatch[2 % style.swatch.length]} />
            <circle cx="70" cy="104" r="22" fill={style.swatch[3 % style.swatch.length]} />
          </g>
        )}
      </svg>
      {label ? (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-0.5 text-xs font-medium text-[var(--color-muted)]">
          {label}
        </span>
      ) : null}
    </div>
  );
}
