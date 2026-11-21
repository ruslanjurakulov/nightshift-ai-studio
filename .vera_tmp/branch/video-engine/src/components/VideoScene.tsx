import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";
import type { StyleBible } from "../types";

type Props = {
  /** Resolved src (staticFile(...)). */
  src: string;
  style: StyleBible;
};

/**
 * Footage played as-is (recipe `broll_cut`), cover-cropped to the frame and
 * muted — narration and music are muxed by the assembly step, not here. A clip
 * shorter than the scene holds on the palette background once it ends, so the
 * IR compiler should hand this scene footage at least as long as the scene.
 */
export const VideoScene: React.FC<Props> = ({ src, style }) => (
  <AbsoluteFill style={{ backgroundColor: style.palette.background }}>
    <OffthreadVideo src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  </AbsoluteFill>
);
