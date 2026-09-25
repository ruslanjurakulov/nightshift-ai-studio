import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { Captions } from "./components/Captions";
import { EvidenceCard, type EvidenceItem } from "./components/EvidenceCard";
import { IMAGE_RECIPES, ImageScene } from "./components/ImageScene";
import { LowerThird } from "./components/LowerThird";
import { MapScene } from "./components/MapScene";
import { QuoteCard } from "./components/QuoteCard";
import { StatCard } from "./components/StatCard";
import { Timeline } from "./components/Timeline";
import { TitleCard, type TitleVariant } from "./components/TitleCard";
import { Transition } from "./components/Transition";
import { VideoScene } from "./components/VideoScene";
import { resolveStyle } from "./style";
import {
  cleanNarration,
  extractQuoteParts,
  extractTimeline,
  firstSentence,
  humanize,
  parseStat,
  type Stat,
  type TimelineEvent,
} from "./text";
import type { MapFocus, SceneAsset, SceneClaim, SceneProps } from "./types";

// Maps, not object literals: a prop value like "constructor" must not hit
// Object.prototype.
const TITLE_RECIPES = new Map<string, TitleVariant>([
  ["title_card", "title"],
  ["chapter_card", "chapter"],
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
  | { component: "QuoteCard"; text: string; attribution: string | null }
  | { component: "StatCard"; stat: Stat; label: string }
  | { component: "Timeline"; events: TimelineEvent[]; heading: string }
  | { component: "EvidenceCard"; items: EvidenceItem[] }
  | { component: "MapScene"; asset: SceneAsset; focus: MapFocus | null; label: string | null }
  | { component: "VideoScene"; asset: SceneAsset }
  | { component: "ImageScene"; recipe: string; asset: SceneAsset | null };

/** Plans that show a picture — the only ones a lower third is drawn over. */
const PICTURE_PLANS = new Set<Plan["component"]>(["ImageScene", "VideoScene", "MapScene"]);

const firstOf = (assets: SceneAsset[] | null | undefined, kind: string): SceneAsset | null =>
  (assets ?? []).find((a) => a && a.kind === kind && typeof a.path === "string" && a.path.length > 0) ?? null;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A focus point only when both coordinates are real numbers (clamped later). */
const mapFocus = (props: SceneProps): MapFocus | null => {
  const f = props.map?.focus;
  return f && isNum(f.x) && isNum(f.y) ? { x: f.x, y: f.y } : null;
};

/**
 * The scene's claims: the `claims` prop, else the scene's own `claims`; when
 * the scene lists `claim_ids`, only those. Rows without text are dropped.
 */
export const sceneClaims = (props: SceneProps): EvidenceItem[] => {
  const source: SceneClaim[] = Array.isArray(props.claims)
    ? props.claims
    : Array.isArray(props.scene.claims)
      ? props.scene.claims
      : [];
  const ids = new Set((props.scene.claim_ids ?? []).map(String));
  return source
    .filter((c) => c && typeof c.text === "string" && c.text.trim().length > 0)
    .filter((c) => ids.size === 0 || (c.id != null && ids.has(String(c.id))))
    .map((c) => ({ text: cleanNarration(c.text), status: typeof c.status === "string" ? c.status : null }));
};

/**
 * Choose the component from `scene.shot.recipe` (a modules/shot_recipes id),
 * then the scene type, then the available assets. A recipe whose content
 * cannot be derived (no number, no quotation, no year, no map image) degrades
 * to its catalogue fallback, `slow_push`, exactly as
 * modules/shot_recipes.resolve_for_backends — footage when the scene has it.
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

  switch (recipe) {
    case "quote_card": {
      const quote = extractQuoteParts(narration);
      return quote ? { component: "QuoteCard", text: quote.text, attribution: quote.attribution } : fallback;
    }
    case "stat_counter": {
      const stat = parseStat(narration);
      return stat ? { component: "StatCard", stat, label: humanize(scene.name) } : fallback;
    }
    case "timeline": {
      const events = extractTimeline(narration);
      return events.length > 0 ? { component: "Timeline", events, heading: humanize(scene.name) } : fallback;
    }
    case "evidence_card": {
      const claims = sceneClaims(props);
      if (claims.length > 0) return { component: "EvidenceCard", items: claims };
      // No claims supplied: a neutral card whose status stays unknown.
      const text = firstSentence(narration);
      return text ? { component: "EvidenceCard", items: [{ text, status: null }] } : fallback;
    }
    case "map_zoom": {
      // A static map image only (no tiles, no network). Without one there is
      // no map to draw, so the catalogue fallback applies.
      if (!image) return fallback;
      const label = typeof props.map?.label === "string" && props.map.label.trim() ? props.map.label.trim() : null;
      return { component: "MapScene", asset: image, focus: mapFocus(props), label };
    }
    case "broll_cut":
      return fallback;
  }

  const variant = TITLE_RECIPES.get(recipe) ?? (recipe ? undefined : TITLE_TYPES.get(type));
  if (variant) {
    const heading = humanize(scene.name) || narration;
    return heading ? { component: "TitleCard", variant, heading } : fallback;
  }
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
  const lowerThird = props.lowerThird;
  const lowerThirdName = typeof lowerThird?.name === "string" ? lowerThird.name.trim() : "";

  let body: React.ReactNode;
  switch (plan.component) {
    case "TitleCard":
      body = <TitleCard variant={plan.variant} heading={plan.heading} style={style} />;
      break;
    case "QuoteCard":
      body = <QuoteCard text={plan.text} attribution={plan.attribution} style={style} />;
      break;
    case "StatCard":
      body = <StatCard stat={plan.stat} label={plan.label} style={style} />;
      break;
    case "Timeline":
      body = <Timeline events={plan.events} heading={plan.heading} style={style} />;
      break;
    case "EvidenceCard":
      body = <EvidenceCard items={plan.items} style={style} />;
      break;
    case "MapScene":
      body = <MapScene src={src(plan.asset)} focus={plan.focus} label={plan.label} style={style} />;
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
      {lowerThirdName && PICTURE_PLANS.has(plan.component) ? (
        <LowerThird name={lowerThirdName} label={lowerThird?.label} style={style} />
      ) : null}
      {props.words && props.words.length > 0 ? (
        <Captions words={props.words} sceneStart={sceneStart} style={style} />
      ) : null}
    </AbsoluteFill>
  );
};
