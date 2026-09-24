import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { Captions } from "./components/Captions";
import { IMAGE_RECIPES, ImageScene } from "./components/ImageScene";
import { StatCard } from "./components/StatCard";
import { TitleCard, type TitleVariant } from "./components/TitleCard";
import { Transition } from "./components/Transition";
import { VideoScene } from "./components/VideoScene";
import { resolveStyle } from "./style";
import { cleanNarration, extractQuote, humanize, parseStat, type Stat } from "./text";
import type { SceneAsset, SceneProps } from "./types";

// Maps, not object literals: a prop value like "constructor" must not hit
// Object.prototype.
const TITLE_RECIPES = new Map<string, TitleVariant>([
  ["title_card", "title"],
  ["chapter_card", "chapter"],
  ["quote_card", "quote"],
]);
const TITLE_TYPES = new Map<string, TitleVariant>([
  ["title", "title"],
  ["intro", "title"],
  ["opening", "title"],
  ["chapter", "chapter"],
]);

/** What the scene renders as — a pure function of the props. */
export type Plan =
  | { component: "TitleCard"; variant: TitleVariant; heading: string }
  | { component: "StatCard"; stat: Stat; label: string }
  | { component: "VideoScene"; asset: SceneAsset }
  | { component: "ImageScene"; recipe: string; asset: SceneAsset | null };

const firstOf = (assets: SceneAsset[] | null | undefined, kind: string): SceneAsset | null =>
  (assets ?? []).find((a) => a && a.kind === kind && typeof a.path === "string" && a.path.length > 0) ?? null;

/**
 * Choose the component from `scene.shot.recipe` (a modules/shot_recipes id),
 * then the scene type, then the available assets. A graphic recipe whose text
 * cannot be derived (no number, no quotation) degrades to its catalogue
 * fallback, `slow_push`, exactly as modules/shot_recipes.resolve_for_backends.
 */
export const planScene = (props: SceneProps): Plan => {
  const { scene, assets } = props;
  const recipe = String(scene.shot?.recipe ?? "").trim().toLowerCase();
  const type = String(scene.type ?? "").trim().toLowerCase();
  const narration = cleanNarration(scene.narration);
  const image = firstOf(assets, "image");
  const video = firstOf(assets, "video");
  const fallback: Plan = video
    ? { component: "VideoScene", asset: video }
    : { component: "ImageScene", recipe: "slow_push", asset: image };

  const variant = TITLE_RECIPES.get(recipe) ?? (recipe ? undefined : TITLE_TYPES.get(type));
  if (variant === "quote") {
    const quote = extractQuote(narration);
    return quote ? { component: "TitleCard", variant, heading: quote } : fallback;
  }
  if (variant) {
    const heading = humanize(scene.name) || narration;
    return heading ? { component: "TitleCard", variant, heading } : fallback;
  }
  if (recipe === "stat_counter") {
    const stat = parseStat(narration);
    return stat ? { component: "StatCard", stat, label: humanize(scene.name) } : fallback;
  }
  if (recipe === "broll_cut") return fallback;
  if ((IMAGE_RECIPES as readonly string[]).includes(recipe)) {
    return { component: "ImageScene", recipe, asset: image };
  }
  return fallback;
};

const src = (asset: SceneAsset): string =>
  /^https?:\/\//.test(asset.path) ? asset.path : staticFile(asset.path.replace(/^\/+/, ""));

export const SceneComposition: React.FC<SceneProps> = (props) => {
  const style = resolveStyle(props.style);
  const plan = planScene(props);
  const sceneStart = typeof props.scene.start_s === "number" ? props.scene.start_s : 0;

  let body: React.ReactNode;
  switch (plan.component) {
    case "TitleCard":
      body = <TitleCard variant={plan.variant} heading={plan.heading} style={style} />;
      break;
    case "StatCard":
      body = <StatCard stat={plan.stat} label={plan.label} style={style} />;
      break;
    case "VideoScene":
      body = <VideoScene src={src(plan.asset)} style={style} />;
      break;
    default:
      body = <ImageScene src={plan.asset ? src(plan.asset) : null} recipe={plan.recipe} style={style} />;
  }

  return (
    <AbsoluteFill style={{ backgroundColor: style.palette.background }}>
      <Transition kind={props.transition} background={style.palette.background}>
        {body}
      </Transition>
      {props.words && props.words.length > 0 ? (
        <Captions words={props.words} sceneStart={sceneStart} style={style} />
      ) : null}
    </AbsoluteFill>
  );
};
