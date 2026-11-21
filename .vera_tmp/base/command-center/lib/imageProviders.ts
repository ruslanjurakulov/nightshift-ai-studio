/**
 * Image generators the pipeline can use (modules/image_providers.py). One list
 * for every place that offers or validates a choice: the Create form, the
 * routing panel, the Actions dispatch and the queue row (runBackend). The
 * workflow's `image_provider` options and migration 0023 carry the same ids.
 *
 * `secretName` is the GitHub secret the generator needs; two reuse a key the
 * pipeline already has (OpenAI and Gemini), so no new key for those.
 */
export interface ImageGenerator {
  id: string;
  name: string;
  secretName: string;
  /** The model used when CHRONOS_IMAGE_MODEL is empty. */
  defaultModel: string;
}

export const IMAGE_GENERATORS: readonly ImageGenerator[] = [
  { id: "gpt-image", name: "OpenAI GPT Image 2", secretName: "OPENAI_API_KEY", defaultModel: "gpt-image-2" },
  { id: "nano-banana", name: "Google Nano Banana 2", secretName: "GEMINI_API_KEY", defaultModel: "gemini-3.1-flash-image-preview" },
  { id: "flux", name: "FLUX.2 Pro", secretName: "BFL_API_KEY", defaultModel: "flux-2-pro" },
  { id: "ideogram", name: "Ideogram 3", secretName: "IDEOGRAM_API_KEY", defaultModel: "V_3" },
  { id: "leonardo", name: "Leonardo.Ai", secretName: "LEONARDO_API_KEY", defaultModel: "Kino XL" },
  { id: "fal", name: "fal.ai", secretName: "FAL_KEY", defaultModel: "fal-ai/flux-2-pro" },
];

/** Every accepted `image_provider` value: stock first, then the generators. */
export const IMAGE_PROVIDERS = [
  "pexels",
  "leonardo",
  "gpt-image",
  "nano-banana",
  "flux",
  "ideogram",
  "fal",
] as const;

export function imageGeneratorById(id: string): ImageGenerator | undefined {
  return IMAGE_GENERATORS.find((g) => g.id === id);
}
