import React from "react";
import { AbsoluteFill } from "remotion";
import { alpha, mix, type Look } from "./looks";
import { hash01 } from "./motion";

/**
 * What sits under and over every scene and never cuts: the backdrop, a vignette and film grain. Because these stay
 * put while the scenes change, a cut reads as the content changing on one surface rather than the screen flashing.
 */

const TILE = 256;
const grainTile = (seed: number) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE}' height='${TILE}'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='${seed}' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='${TILE}' height='${TILE}' filter='url(#n)'/></svg>`,
  )}")`;
// Three tiles, built once: the browser decodes each image a single time and reuses it on every frame.
const TILES = [grainTile(3), grainTile(7), grainTile(11)];

export const Backdrop: React.FC<{ look: Look }> = ({ look }) => (
  <AbsoluteFill
    style={{
      background: [
        `radial-gradient(ellipse 80% 45% at 50% 46%, ${alpha(mix(look.background2, look.light, 0.25), 0.55)} 0%, transparent 70%)`,
        `linear-gradient(180deg, ${look.background} 0%, ${look.background2} 55%, ${look.background} 100%)`,
      ].join(","),
    }}
  />
);

/**
 * Grain that moves every frame, and a vignette. The noise is a fixed tile re-seeded per frame (one of three seeds) and
 * shifted by a hash of the frame: random-looking, the same on every render, and cheap, where an feTurbulence filter
 * over the whole 1080x1920 frame would be recomputed for every frame of the video.
 */
export const FilmOverlay: React.FC<{ look: Look; frame: number }> = ({ look, frame }) => {
  const dx = Math.floor(hash01(frame, 1) * TILE);
  const dy = Math.floor(hash01(frame, 2) * TILE);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 85% 75% at 50% 48%, transparent 60%, ${alpha("#000000", look.glow >= 0.9 ? 0.5 : 0.18)} 100%)` }} />
      {look.grain > 0 ? (
        <AbsoluteFill style={{ overflow: "hidden" }}>
          <div
            style={{
              position: "absolute",
              left: -dx,
              top: -dy,
              right: -TILE + dx,
              bottom: -TILE + dy,
              backgroundImage: TILES[frame % TILES.length],
              backgroundSize: `${TILE}px ${TILE}px`,
              opacity: 0.09 * look.grain,
              mixBlendMode: "overlay",
            }}
          />
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
