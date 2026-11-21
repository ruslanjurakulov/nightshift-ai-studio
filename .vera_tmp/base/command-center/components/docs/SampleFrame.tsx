import type { SceneKind } from "@/lib/dev/mcp-landing";
import { placeMedia, type PlaceDef, type PlaceMedia } from "@/components/site/slots";
import type { ShowcaseEntry } from "@/lib/site/showcase";

/**
 * The picture behind each scene kind of the /mcp examples carousel, one line each in the same shape as the site's slots
 * (components/site/samples.tsx PlaceDef): `ai` is the showcase job that fills the card (one of our generations, labelled with
 * its model), and the rest is the stock fallback (a Pexels contributor's photograph, credited on the card) kept until that job's
 * files are merged. Six different pictures, none of them one the page shows anywhere else. `position` is where each stock
 * picture is framed in the tall card.
 */
export const SCENE_SAMPLE: Record<SceneKind, PlaceDef> = {
  hills: { ai: "639bbde5-dc70-4954-b71d-54db6a5b3ea9", id: "valley", position: "30% 50%" },
  waves: { ai: "f17146fd-054c-4970-9dac-f7a0dc929bd6", id: "lighthouse", position: "58% 50%" },
  city: { ai: "1b3d5f4b-f4f2-4e92-84db-77908a36df2a", id: "market", position: "32% 50%" },
  stars: { ai: "64a7c2b8-a6c1-4359-9961-a1a2760f1cbf", id: "moon", position: "90% 50%" },
  rings: { ai: "28f164dc-809f-49a3-b2e2-ef0bdf88519b", id: "library", position: "50% 50%" },
  // The sixth card moves (a tall clip); its stock fallback is the caravan footage, framed on the camels.
  dunes: { ai: "5778bf5a-f751-472b-bbc0-c59b10567d32", id: "caravan", position: "36% 50%", clip: "caravan" },
};

/** What a scene's card shows (a sample or the stock fallback). */
export function sceneMedia(kind: SceneKind, entries?: readonly ShowcaseEntry[]): PlaceMedia {
  return placeMedia(SCENE_SAMPLE[kind], null, entries);
}
