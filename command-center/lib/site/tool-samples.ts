/**
 * What each tool on the landing's "What Nightshift can make" wall shows (components/landing/CapabilityWall.tsx), one line per tool:
 *
 * - `job`: a real output of that tool, a showcase sample (lib/site/showcase.json) shown with its model's credit. Shown only while
 *   the sample's entry and files are merged; otherwise the tile shows the tool's icon. Never a drawing of a result.
 * - `from`: for Animate, the picture the clip was made from (itself a sample), shown beside the clip: before and after.
 * - `inStudio`: false where no model of the tool is offered to customers today; the tile then says "Not in the Studio yet" and
 *   shows no output. Set from the live database (sellable models per capability), which the public site cannot read (the
 *   `sellable_models` function is for signed-in users): when a model of the tool goes on sale, flip the line.
 *
 * The page leaves these samples out of its gallery, so no clip is on it twice.
 */
export type ToolSample = { job: string | null; from?: string; inStudio: boolean };

export const TOOL_SAMPLES: Record<string, ToolSample> = {
  image: { job: "28f164dc-809f-49a3-b2e2-ef0bdf88519b", inStudio: true },
  video: { job: "b72e18cd-d9e5-4535-9fea-f24fbd8c3fd9", inStudio: true },
  // Before and after: the perfume still, and the clip the Studio animated from it.
  animate: { job: "fc1fad12-16de-4cd5-9cd9-e77ed245f469", from: "e3da9148-f2f8-443e-95b1-8ed36ef3dea4", inStudio: true },
  // As of the 2026-11-13 database: no verified customer model for these (the one edit model is hidden and terms-gated).
  voice: { job: null, inStudio: false },
  edit: { job: null, inStudio: false },
  upscale: { job: null, inStudio: false },
  cutout: { job: null, inStudio: false },
  // The style library is applied to the image and clip tools; it is not a model and costs nothing.
  styles: { job: null, inStudio: true },
};

/** The sample the third step of "How it works" plays in its phone (a vertical clip, as a channel's short is). */
export const STEP_PHONE_JOB = "a04d5d55-27ef-4cae-95a2-25488503829e";

/**
 * The thumbnail on the Approvals band's drawn approval screen (components/landing/ApprovalCard.tsx): a wide picture, as a video's
 * thumbnail is, and a street market rather than more sea (the owner found the page read as "all sea", 2026-11-13).
 */
export const APPROVAL_THUMB_JOB = "1b3d5f4b-f4f2-4e92-84db-77908a36df2a";

/** Every sample the wall, the steps and the approval screen show, for the gallery to leave out. */
export const TOOL_JOBS: string[] = [...Object.values(TOOL_SAMPLES).flatMap((s) => [s.job, s.from].filter((x): x is string => Boolean(x))), STEP_PHONE_JOB, APPROVAL_THUMB_JOB];
