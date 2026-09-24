import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { SceneComposition } from "./SceneComposition";
import { DEFAULT_STYLE } from "./style";
import { sceneDurationInFrames } from "./timing";
import type { SceneProps } from "./types";

const DEFAULTS = { width: 1920, height: 1080, fps: 30 };

/** A positive even integer (h264 needs even dimensions), else the default. */
const evenDim = (v: unknown, dflt: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  return n > 0 ? n - (n % 2) || dflt : dflt;
};

const calculateMetadata: CalculateMetadataFunction<SceneProps> = ({ props }) => {
  const fps = typeof props.fps === "number" && props.fps > 0 ? props.fps : DEFAULTS.fps;
  return {
    fps,
    width: evenDim(props.width, DEFAULTS.width),
    height: evenDim(props.height, DEFAULTS.height),
    // From the IR's audio-clock times; throws when they are unknown.
    durationInFrames: sceneDurationInFrames(props.scene, fps),
  };
};

/** Studio preview props: a 4 s title card. Renders pass --props instead. */
const defaultProps: SceneProps = {
  scene: {
    id: "s000",
    index: 0,
    name: "the_flannan_isles",
    type: "title",
    narration: "Three men walked into this lighthouse.",
    start_s: 0,
    end_s: 4,
    shot: { recipe: "title_card", camera: null, lighting: null, mood: null },
    element_ids: [],
    asset_ids: [],
    claim_ids: [],
  },
  width: DEFAULTS.width,
  height: DEFAULTS.height,
  fps: DEFAULTS.fps,
  assetsBaseDir: "",
  style: DEFAULT_STYLE,
  words: [
    { text: "Three", start_s: 0.5, end_s: 0.8 },
    { text: "men", start_s: 0.8, end_s: 1.1 },
    { text: "walked", start_s: 1.1, end_s: 1.5 },
    { text: "into", start_s: 1.5, end_s: 1.7 },
    { text: "this", start_s: 1.7, end_s: 1.9 },
    { text: "lighthouse.", start_s: 1.9, end_s: 2.6 },
  ],
  transition: "hard_cut",
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Scene"
    component={SceneComposition}
    durationInFrames={120}
    fps={DEFAULTS.fps}
    width={DEFAULTS.width}
    height={DEFAULTS.height}
    defaultProps={defaultProps}
    calculateMetadata={calculateMetadata}
  />
);
