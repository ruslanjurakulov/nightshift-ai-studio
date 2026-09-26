import { describe, expect, it } from "vitest";
import {
  buildRenderJobInsert,
  isRunConfigured,
  resolveRunBackend,
  toQueueJob,
} from "../lib/runBackend";

/**
 * "Run now" picks its backend from a server env var. What must hold:
 * Actions stays the default (a typo must never route runs to a queue nobody
 * drains), and a queued job asks for exactly what the Actions dispatch asks
 * for — never a privacy, a resume or a repair the button cannot request.
 */
describe("resolveRunBackend", () => {
  it("defaults to actions", () => {
    expect(resolveRunBackend({})).toBe("actions");
    expect(resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: "" })).toBe("actions");
  });

  it("uses the queue only for the exact value", () => {
    expect(resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: "queue" })).toBe("queue");
    expect(resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: " Queue " })).toBe("queue");
    for (const typo of ["queu", "vps", "worker", "actions", "true"]) {
      expect(resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: typo }), typo).toBe("actions");
    }
  });
});

describe("isRunConfigured", () => {
  it("actions needs the GitHub wiring, the queue only Supabase", () => {
    expect(isRunConfigured("actions", { github: false, supabase: true })).toBe(false);
    expect(isRunConfigured("actions", { github: true, supabase: true })).toBe(true);
    expect(isRunConfigured("queue", { github: false, supabase: true })).toBe(true);
    expect(isRunConfigured("queue", { github: true, supabase: false })).toBe(false);
  });
});

describe("buildRenderJobInsert", () => {
  it("a plain run is an empty daily job filed by the caller", () => {
    expect(buildRenderJobInsert("news", {}, "user-1")).toEqual({
      channel_id: "news",
      kind: "daily",
      params: {},
      requested_by: "user-1",
    });
  });

  it("forwards the Run now controls, trimmed and capped like the dispatch", () => {
    const row = buildRenderJobInsert(
      "news",
      {
        topic: `  ${"t".repeat(400)}  `,
        niche: " history ",
        duration: 5,
        language: "Arabic",
        visualStyle: " noir ",
        videoProvider: "Kling",
        imageProvider: "leonardo",
      },
      "u",
    );
    expect(row.params).toEqual({
      topic: "t".repeat(300),
      niche: "history",
      duration: 30,
      language: "Arabic",
      visual_style: "noir",
      video_provider: "kling",
      image_provider: "leonardo",
    });
  });

  it("drops providers outside the workflow's choice lists", () => {
    const row = buildRenderJobInsert("news", { videoProvider: "sora", imageProvider: "midjourney" }, "u");
    expect(row.params).toEqual({});
  });

  it("never carries privacy, resume, repair or worker-owned fields", () => {
    const sneaky = {
      privacy: "public",
      resume: true,
      repair_scenes: "3",
      status: "running",
      attempts: 9,
    } as unknown as Parameters<typeof buildRenderJobInsert>[1];
    const row = buildRenderJobInsert("news", sneaky, "u");
    expect(row.params).toEqual({});
    expect(Object.keys(row).sort()).toEqual(["channel_id", "kind", "params", "requested_by"]);
  });
});

describe("toQueueJob", () => {
  it("keeps a known status and reads an unexpected one as unknown", () => {
    expect(toQueueJob({ id: 3, status: "running", attempts: 2 }).status).toBe("running");
    expect(toQueueJob({ id: 3, status: "done" }).status).toBe("unknown");
    expect(toQueueJob({ id: 3 }).error).toBeNull();
  });
});
