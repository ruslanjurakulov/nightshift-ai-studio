import "server-only";
import { isCreditExempt } from "@/lib/credits";
import { IMAGE_GENERATORS } from "@/lib/imageProviders";
import { PROVIDERS } from "@/lib/providers";
import type { RoutingOption } from "@/lib/provider-types";
import type { PipelineOptions } from "@/lib/pipeline-options";
import { TTS_LANGUAGE_READ_ON, TTS_MODEL_LANGUAGES } from "@/lib/ttsLanguages";
import { DEPRECATED_TTS_MODELS, TTS_MODEL_LABELS, TTS_PICKER_MODELS, isTtsModel } from "@/lib/ttsModels";

/**
 * The operator's routing choices, built where the vendor lists live (all server-only) and handed to the two operator
 * screens that offer them as props. Each screen used to import the lists itself, so the vendors, our generator ids, the
 * secret names and the narration vendor's model ids sat in static chunks anyone can download — the customers' create page
 * chunk among them (scripts/vendor-bundle-check.mjs). A page calls these only after it knows the viewer is the operator.
 */

/** Higgsfield b-roll talks to a guessed endpoint with a Bearer key (its real API is `Key id:secret`), so it fails closed on
 *  every run. It stays out of the Create form's video-model list until tools/probe_models.py shows it answering; flip this
 *  with that change. The id is still a valid run parameter. */
const HIGGSFIELD_BROLL_PROBED = false;

/** The Create form's video models, in the order and with the labels the form has always shown. */
const CREATE_VIDEO_MODELS: readonly { id: string; name: string; probed?: boolean }[] = [
  { id: "seedance", name: "Seedance" },
  { id: "kling", name: "Kling" },
  { id: "veo", name: "Veo" },
  { id: "higgsfield", name: "Higgsfield", probed: HIGGSFIELD_BROLL_PROBED },
  { id: "wan", name: "Wan" },
  { id: "minimax", name: "MiniMax" },
];

/** The Providers page's routing panel: the video generators and the image generators, each with the key it needs. */
export function routingOptions(): { video: RoutingOption[]; image: RoutingOption[] } {
  return {
    video: PROVIDERS.filter((p) => p.category === "video").map(({ id, name, secretName }) => ({ id, name, secretName })),
    image: IMAGE_GENERATORS.map(({ id, name, secretName }) => ({ id, name, secretName })),
  };
}

/** The Create form's per-run choices for the operator's own runs. No secret name and no default model: it shows names only. */
export function createPipelineOptions(): PipelineOptions {
  return {
    video: CREATE_VIDEO_MODELS.filter((m) => m.probed !== false).map(({ id, name }) => ({ id, name })),
    // Stock first, as it always was; then the generators.
    image: [{ id: "pexels", name: "Pexels (stock)" }, ...IMAGE_GENERATORS.map(({ id, name }) => ({ id, name }))],
    tts: TTS_PICKER_MODELS.map((m) => ({
      id: m,
      label: TTS_MODEL_LABELS[m],
      deprecated: DEPRECATED_TTS_MODELS.includes(m),
      onQueue: isTtsModel(m),
      speaks: TTS_MODEL_LANGUAGES[m] ?? null,
    })),
    ttsReadOn: TTS_LANGUAGE_READ_ON,
  };
}

/**
 * The Create form's choices for this viewer, or null: only when the form will draw them, which is CreateStudio's
 * providerChoice (the route's rule in app/api/agent/run): the operator's frame, in the operator's own organization or none.
 * A platform operator looking at a customer's organization gets null, as a customer does.
 */
export function createPipelineOptionsFor(viewer: { operator: boolean; orgId: string | null }): PipelineOptions | null {
  if (!viewer.operator) return null;
  if (viewer.orgId && !isCreditExempt(viewer.orgId)) return null;
  return createPipelineOptions();
}
