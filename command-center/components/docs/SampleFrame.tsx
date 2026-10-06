import type { SceneKind } from "@/lib/dev/mcp-landing";
import { SAMPLES, type SampleId } from "@/components/site/samples";

/** The example stills in the /mcp examples carousel (AI-generated, made for the site; see components/site/samples.tsx). */

/** The example frame behind each scene kind (components/site/samples.tsx): AI-generated stills, shown with
 *  "Example" labels wherever they stand alone. Aspect-ratio boxes in the stylesheet decide the layout. */
const SCENE_SAMPLE: Record<SceneKind, SampleId> = {
  hills: "valley",
  waves: "lighthouse",
  city: "nightmarket",
  stars: "moon",
  rings: "library",
  dunes: "silkroad",
};

/** An example frame for a sample video frame or an example card. `alt` is empty inside the aria-hidden drawn
 *  frames and descriptive where the picture stands alone (the examples carousel). */
export function Scene({ kind, alt = "" }: { kind: SceneKind; alt?: string }) {
  const s = SAMPLES[SCENE_SAMPLE[kind]];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="ml-scene" data-scene={kind} src={s.src} width={s.width} height={s.height} alt={alt} loading="lazy" decoding="async" />
  );
}
