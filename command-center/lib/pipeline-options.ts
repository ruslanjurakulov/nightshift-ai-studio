import { ttsLanguageCode, type VerifiedTtsLanguage } from "@/lib/tts-language-code";

/**
 * The operator's per-run routing choices on the Create form: which video, image and narration model a run in the
 * operator's own organization may ask for. Only the shape lives here. The lists (vendor names, our generator ids, the
 * narration vendor's model ids and which languages each speaks) are built on the server (lib/server/pipeline-options.ts)
 * and passed to the operator's page only: the form used to carry them itself, so they were in the customers' create page
 * chunk, which anyone can download.
 */
export interface PipelineChoice {
  id: string;
  name: string;
}

export interface PipelineTtsOption {
  id: string;
  label: string;
  deprecated: boolean;
  /** The run queue accepts it (render_job_params_valid). A model it does not is listed switched off. */
  onQueue: boolean;
  /** The languages it was verified to speak (lib/ttsLanguages.ts), or null when the model was never checked. */
  speaks: readonly VerifiedTtsLanguage[] | null;
}

export interface PipelineOptions {
  video: PipelineChoice[];
  image: PipelineChoice[];
  tts: PipelineTtsOption[];
  /** The day the language table was read from the vendor's documentation, for the hint under the picker. */
  ttsReadOn: string;
}

export type TtsBlock = { reason: "not_on_queue" } | { reason: "language"; language: VerifiedTtsLanguage };

/**
 * Why a narration model cannot be picked for a video in `language`, or null when it can: the browser's half of
 * ttsModelBlock (lib/ttsModels.ts), over the option the server built. "language" only on a verified no; an unknown
 * language or an unchecked model disables nothing (rule 5: unknown is not no). tests/pipeline-options.test.ts holds the two
 * equal for every model and language.
 */
export function ttsOptionBlock(option: PipelineTtsOption, language: unknown): TtsBlock | null {
  if (!option.onQueue) return { reason: "not_on_queue" };
  const code = ttsLanguageCode(language);
  if (code && option.speaks && !option.speaks.includes(code)) return { reason: "language", language: code };
  return null;
}
