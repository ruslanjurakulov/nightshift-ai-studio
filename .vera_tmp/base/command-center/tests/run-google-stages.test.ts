/**
 * runGoogleStages (migration 0196): which stages of a video run go to Google. It must say what the database's
 * render_run_google_stages says for the same run (tests/test_adult_attestation_google_runs_migration.py compares the provider
 * lists of both and the pipeline's). What would break: a run on Google read as "no Google" and dispatched for a person with no
 * adult answer, or an odd provider value read as "not Google".
 */
import { describe, expect, it } from "vitest";
import { GOOGLE_IMAGE_PROVIDERS, GOOGLE_VIDEO_PROVIDERS, IMAGE_PROVIDERS, VIDEO_PROVIDERS, runGoogleStages } from "@/lib/runBackend";

describe("runGoogleStages", () => {
  it("text is Google on every daily run and series plan, whatever the footage", () => {
    expect(runGoogleStages("daily", {})).toEqual(["text"]);
    expect(runGoogleStages("daily", { video_provider: "minimax", image_provider: "pexels" })).toEqual(["text"]);
    expect(runGoogleStages("series_plan", {})).toEqual(["text"]);
  });

  it("Veo and Nano Banana add their stages", () => {
    expect(runGoogleStages("daily", { video_provider: "veo", image_provider: "nano-banana" })).toEqual(["text", "video", "image"]);
  });

  it("fails closed on a repair, an unknown kind and an odd provider shape", () => {
    expect(runGoogleStages("repair", {})).toEqual(["repair"]);
    expect(runGoogleStages("other", {})).toEqual(["unknown"]);
    expect(runGoogleStages("daily", { video_provider: 1, image_provider: { x: 1 } })).toEqual(["text", "video", "image"]);
  });

  it("names only providers the run can choose", () => {
    for (const p of GOOGLE_VIDEO_PROVIDERS) expect(VIDEO_PROVIDERS as readonly string[]).toContain(p);
    for (const p of GOOGLE_IMAGE_PROVIDERS) expect(IMAGE_PROVIDERS as readonly string[]).toContain(p);
  });
});
