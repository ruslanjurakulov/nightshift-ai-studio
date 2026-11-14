import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";

/**
 * What each tool on the landing's "What Nightshift can make" wall shows (components/landing/CapabilityWall.tsx), one line per tool:
 *
 * - `capability`: the Studio capability the tool is (registry `capabilities`), or null for one that is not a model (the style
 *   library). A tile's sample must be a job of that capability (tests/site-engage-5.test.tsx).
 * - `job`: a real output of that tool, a showcase sample (lib/site/showcase.json) made by our team in the Studio (an operator job, not
 *   a customer's). Shown, labelled AI-generated, whether or not the tool is open; only while the sample's entry and files are merged;
 *   otherwise the tile shows the tool's icon. Never a drawing of a result. For Animate, the picture the clip was made from
 *   is not typed here: it is the sample's own recorded input (`input.jobId`, toolSource below), so it cannot point at the wrong still.
 * - `inStudio`: whether a customer can use the tool today. HAND-SET. The live answer is lib/tool-availability.ts (#735), but it needs
 *   an organization to read sellable_models() for, and the landing is signed out, so the public site cannot compute it.
 *   LIVE FACT, 2026-11-13 (read-only check of the production database): all 82 model_registry rows are availability='hidden', so a
 *   customer can make nothing in the Studio today, not a picture, a clip or an animation. Every line is therefore false, and every
 *   tile says "Not available yet" (#735's words). A line flips to true only when the owner opens a model of that capability (PR #736 /
 *   migration 0160 would open Ideogram, MiniMax H3 and Runway for image, video and image-to-video); flip it in the same change.
 *   tests/site-engage-5.test.tsx pins it: every line false today, and a line set true needs a registry model of its capability with
 *   no terms gate and not past a shutdown day (schemas/model_registry.json). While every line is false the landing's copy says so
 *   too (studioToolsOpen below).
 *
 * The page leaves these samples out of its gallery, so no clip is on it twice.
 */
export type ToolSample = { capability: string | null; job: string | null; inStudio: boolean };

export const TOOL_SAMPLES: Record<string, ToolSample> = {
  image: { capability: "t2i", job: "28f164dc-809f-49a3-b2e2-ef0bdf88519b", inStudio: false },
  video: { capability: "t2v", job: "b72e18cd-d9e5-4535-9fea-f24fbd8c3fd9", inStudio: false },
  // Before and after: the clip the Studio animated, and (from its own input) the perfume still it started from.
  animate: { capability: "i2v", job: "fc1fad12-16de-4cd5-9cd9-e77ed245f469", inStudio: false },
  // Voice: every text-to-speech model in the registry needs the vendor's Scale plan (terms_gate plan_required:scale), so none is
  // offered.
  voice: { capability: "tts", job: null, inStudio: false },
  // Edit: the registry lists twelve edit-capable models. Nine are terms-gated (terms_review_required for the Gemini, Krea and
  // Grounded models, written_consent_required for Qwen). The three OpenAI GPT Image models carry no terms gate here (GPT Image 2
  // has an announced shutdown, 2027-02-10); what keeps them off sale is in the database (not sold to customers, or no rate in the
  // price list, on 2026-11-13), which the public site cannot read. Flip this line when one is sold.
  edit: { capability: "edit", job: null, inStudio: false },
  // Upscale: Ideogram Upscale has no terms gate in the registry, but it was not sold to customers on 2026-11-13 (database, as above).
  upscale: { capability: "upscale", job: null, inStudio: false },
  // Cut-out: no registry model has the remove_bg capability.
  cutout: { capability: "remove_bg", job: null, inStudio: false },
  // The style library is applied to the image and clip tools; it is not a model and costs nothing, but with no image or clip tool
  // open there is nothing to apply it to.
  styles: { capability: null, job: null, inStudio: false },
};

/**
 * Whether any Studio tool that is a model is open to customers (any line above with a capability and inStudio true). While none is,
 * the landing's first sentence, the prompt bar's note and the Studio showcase say that nothing can be made there today, instead of
 * "make clips and pictures" (CLAUDE.md: nothing is shown as available that is not).
 */
export function studioToolsOpen(): boolean {
  return Object.values(TOOL_SAMPLES).some((s) => s.capability !== null && s.inStudio);
}

/**
 * The picture a tool's sample was made from, when the sample is a clip animated from another sample's picture (its recorded input,
 * checked back to its first picture by the export), else null. Derived, so the before and after on the wall can never disagree.
 */
export function toolSource(job: string | null): string | null {
  const e = job ? SHOWCASE_ENTRIES.find((x) => x.jobId === job) : undefined;
  return e && e.kind === "video" && e.input.kind === "operator_job" ? e.input.jobId : null;
}

/** The sample the third step of "How it works" plays in its phone (a vertical clip, as a channel's short is). */
export const STEP_PHONE_JOB = "a04d5d55-27ef-4cae-95a2-25488503829e";

/**
 * The thumbnail on the Approvals band's drawn approval screen (components/landing/ApprovalCard.tsx): a sample made as a 16:9
 * YouTube thumbnail, so the screen shows a video waiting for approval with the kind of thumbnail a channel uses, and not more sea
 * (the owner found the page read as "all sea", 2026-11-13).
 */
export const APPROVAL_THUMB_JOB = "ced854a6-ba49-4668-b9dd-91ca46b72f6d";

/** Every sample the wall, the steps and the approval screen show, for the gallery to leave out. */
export const TOOL_JOBS: string[] = [
  ...Object.values(TOOL_SAMPLES).flatMap((s) => [s.job, toolSource(s.job)].filter((x): x is string => Boolean(x))),
  STEP_PHONE_JOB,
  APPROVAL_THUMB_JOB,
];
