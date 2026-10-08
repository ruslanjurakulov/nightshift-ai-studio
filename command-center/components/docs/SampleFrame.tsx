import type { SceneKind } from "@/lib/dev/mcp-landing";
import { SampleImg, type SampleId } from "@/components/site/samples";
import type { ClipId } from "@/components/site/clip-assets";

/**
 * The example frame behind each scene kind of the /mcp examples carousel (components/site/samples.tsx): stock photographs by
 * Pexels contributors (credited on each card, lib/site/media.ts), six different pictures, none of them one the page shows
 * anywhere else (the sixth is a looped clip). The box (an aspect-ratio box in the stylesheet) decides the layout; `position` is where each picture is
 * framed in the tall card.
 */
export const SCENE_SAMPLE: Record<SceneKind, { id: SampleId; position: string; clip?: ClipId }> = {
  hills: { id: "valley", position: "30% 50%" },
  waves: { id: "lighthouse", position: "58% 50%" },
  city: { id: "market", position: "32% 50%" },
  stars: { id: "moon", position: "90% 50%" },
  rings: { id: "library", position: "50% 50%" },
  // The one card that moves: a camel caravan on the sand, the same footage /solutions plays (a different page), framed on the camels.
  dunes: { id: "caravan", position: "36% 50%", clip: "caravan" },
};

/** An example frame for a sample card. `alt` is descriptive: the picture stands alone in the examples carousel. */
export function Scene({ kind, alt = "" }: { kind: SceneKind; alt?: string }) {
  const s = SCENE_SAMPLE[kind];
  return <SampleImg id={s.id} alt={alt} className="ml-scene" position={s.position} sizes="288px" />;
}
