// The client-safe slice: this module is in the browser through components/site/slots.ts (the sign-in stages), and a sample's
// recorded input is all toolSource reads.
import { SHOWCASE_CARDS } from "@/components/site/showcase-assets";

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
 *   customer can make nothing in the Studio today, not a picture, a clip or an animation. Every model-backed line (a capability) is
 *   therefore false, and its tile says "Not available yet" (#735's words). The style library is not a model and is open (its line
 *   says why). A model-backed line flips to true only when the owner opens a model of that capability (PR #736 /
 *   migration 0160 would open Ideogram, MiniMax H3 and Runway for image, video and image-to-video); flip it in the same change.
 *   tests/site-engage-5.test.tsx pins it: every model-backed line false today (only Styles open), and a model-backed line set true
 *   needs a registry model of its capability with no terms gate and not past a shutdown day (schemas/model_registry.json). While
 *   every model-backed line is false the landing's copy says so too (studioToolsOpen below).
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
  // Styles is not a model, so the hidden registry does not close it. Every signed-up user can use it today, for no credits: the
  // Styles page browses the 28 written directions of lib/styles/library.ts with no workspace and no database
  // (app/(app)/[channel]/styles/page.tsx), adds one to the workspace through add_library_style_kit (migration 0065, granted to
  // authenticated), and saves a kit of the user's own 3–12 pictures through save_style_kit (0047, granted to authenticated).
  // None of those calls a model, takes a price or checks tool availability. Applying a kit to a picture or a clip needs an image or
  // clip tool, and those are closed above; the tile says what the library is, not that a picture can be made with it.
  styles: { capability: null, job: null, inStudio: true },
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
  const e = job ? SHOWCASE_CARDS.find((x) => x.jobId === job) : undefined;
  return e && e.kind === "video" && e.input.kind === "operator_job" ? e.input.jobId : null;
}

/**
 * Every sample the wall shows, for the gallery to leave out. The third step's phone and the Approvals band's thumbnail are not the
 * wall's: they show the example topic's own clips (components/site/slots.ts EXAMPLE_JOBS), which the landing leaves out of its
 * gallery the same way (landingPlacedJobs).
 */
export const TOOL_JOBS: string[] = Object.values(TOOL_SAMPLES).flatMap((s) => [s.job, toolSource(s.job)].filter((x): x is string => Boolean(x)));
