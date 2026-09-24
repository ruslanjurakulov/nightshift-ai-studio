/**
 * Props contract: ONE Video IR scene plus its render context.
 *
 * The scene shape mirrors `modules/video_ir.py` (VideoProject.scenes[]); only
 * the fields this engine reads are typed as required. Times are seconds on the
 * project's audio master clock. `null` means unknown — never 0.
 */

export type Shot = {
  /** A modules/shot_recipes.py catalogue id (e.g. "slow_push"). */
  recipe?: string | null;
  camera?: string | null;
  lighting?: string | null;
  mood?: string | null;
};

export type IRScene = {
  id: string;
  index: number;
  name?: string | null;
  type?: string | null;
  narration?: string | null;
  start_s: number | null;
  end_s: number | null;
  shot?: Shot | null;
  element_ids?: string[];
  asset_ids?: string[];
  claim_ids?: string[];
};

/** One resolved asset for this scene. `path` is relative to the public dir
 * (the renderer passes `assetsBaseDir` as Remotion's --public-dir). */
export type SceneAsset = {
  id: string;
  kind: "image" | "video" | string;
  path: string;
};

/** A word with times on the project clock (Whisper word timestamps). */
export type Word = {
  text: string;
  start_s: number;
  end_s: number;
};

export type Palette = {
  background: string;
  primary: string;
  accent: string;
  text: string;
};

/** modules/style_presets.StyleBible.to_dict() */
export type StyleBible = {
  heading_font: string;
  body_font: string;
  palette: Palette;
  caption_style: "word_highlight" | "sentence" | "none" | string;
  transition: string;
  preferred_recipes?: string[];
};

export type SceneProps = {
  scene: IRScene;
  width: number;
  height: number;
  fps: number;
  /** Informational: the directory the renderer served as --public-dir. */
  assetsBaseDir: string;
  style?: StyleBible | null;
  words?: Word[] | null;
  /** Optional: the scene's resolved assets (first image/video is used). */
  assets?: SceneAsset[] | null;
  /** Optional: transition into this scene ("crossfade" | "dip_to_black" | "hard_cut"). */
  transition?: string | null;
};
