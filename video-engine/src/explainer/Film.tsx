import React from "react";
import { AbsoluteFill } from "remotion";
import { alpha, mix, type Look } from "./looks";
import { hash01 } from "./motion";

/**
 * The surface every scene sits on, and the film grain over the drawn scenes.
 *
 * The backdrop (gradient, soft light, vignette) never cuts, so a cut reads as the content changing on one surface
 * rather than the screen flashing. Its vignette is one more gradient of the backdrop, painted under the content, not a
 * layer over the whole frame: in the render's software compositor every full-frame layer is paid on every frame
 * (measured: a 5%-opacity grain over 1080x1920 added ~0.035 s a frame, a third of the budget; docs/VOICE_EXPLAINER.md).
 */

const TILE = 256;
// One tile, built once and decoded once. It is re-placed every frame by a hash of the frame, which reads as fresh grain
// each frame; three seeded tiles toggled per frame were measured slower (a layer brought back from opacity 0 is
// repainted), and so was an overlay blend (it forces the whole scene under it into its own surface).
const NOISE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE}' height='${TILE}'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='7' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='${TILE}' height='${TILE}' filter='url(#n)'/></svg>`,
)}")`;

export const Backdrop: React.FC<{ look: Look }> = ({ look }) => (
  <AbsoluteFill
    style={{
      background: [
        `radial-gradient(ellipse 85% 75% at 50% 48%, transparent 60%, ${alpha("#000000", look.glow >= 0.9 ? 0.5 : 0.15)} 100%)`,
        `radial-gradient(ellipse 80% 45% at 50% 46%, ${alpha(mix(look.background2, look.light, 0.25), 0.55)} 0%, transparent 70%)`,
        `linear-gradient(180deg, ${look.background} 0%, ${look.background2} 55%, ${look.background} 100%)`,
      ].join(","),
    }}
  />
);

/**
 * Grain that moves every frame, over a drawn scene: the noise tile shifted by a hash of the frame. Random-looking,
 * identical on every render and in every chunk, and only a transform changes, so nothing is repainted.
 */
export const Grain: React.FC<{ look: Look; frame: number }> = ({ look, frame }) => {
  if (look.grain <= 0) return null;
  const dx = Math.floor(hash01(frame, 1) * TILE);
  const dy = Math.floor(hash01(frame, 2) * TILE);
  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity: 0.07 * look.grain, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: -TILE,
          bottom: -TILE,
          backgroundImage: NOISE,
          backgroundSize: `${TILE}px ${TILE}px`,
          transform: `translate3d(${-dx}px, ${-dy}px, 0)`,
          willChange: "transform",
        }}
      />
    </AbsoluteFill>
  );
};
