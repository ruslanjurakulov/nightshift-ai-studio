import { describe, expect, it } from "vitest";
import { isSceneId, pendingSceneRequests, sceneRepairEligibility, sceneRepairIntent } from "@/lib/sceneRepair";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

describe("sceneRepairIntent — the only thing the Regenerate scene button writes", () => {
  it("is a review_intents row with action regenerate_scene and the scene id", () => {
    expect(sceneRepairIntent("news", "abc123", "s003")).toEqual({
      channel_id: "news",
      video_id: "abc123",
      action: "regenerate_scene",
      scene_id: "s003",
    });
  });

  it("never files a request for a malformed or missing scene id", () => {
    for (const bad of ["3", "s3", "S003", "s00003", "s003;drop", "", null, undefined]) {
      expect(sceneRepairIntent("news", "abc123", bad as string | null | undefined)).toBeNull();
    }
  });

  it("never files a request without a channel or a video", () => {
    expect(sceneRepairIntent("", "abc123", "s001")).toBeNull();
    expect(sceneRepairIntent("news", "  ", "s001")).toBeNull();
    expect(sceneRepairIntent(null, "abc123", "s001")).toBeNull();
  });

  it("carries no field that could publish, spend or pick a workflow", () => {
    const row = sceneRepairIntent("news", "abc123", "s010")!;
    expect(Object.keys(row).sort()).toEqual(["action", "channel_id", "scene_id", "video_id"]);
  });
});

describe("pendingSceneRequests", () => {
  it("collects only unconsumed regenerate_scene rows with a valid id", () => {
    const pending = pendingSceneRequests([
      { action: "regenerate_scene", scene_id: "s001", consumed_at: null },
      { action: "regenerate_scene", scene_id: "s002", consumed_at: "2026-01-01T00:00:00Z" },
      { action: "regenerate", scene_id: null, consumed_at: null },
      { action: "regenerate_scene", scene_id: "bogus", consumed_at: null },
    ]);
    expect([...pending]).toEqual(["s001"]);
  });

  it("is empty for no rows (migration 0015 not applied reads as none waiting)", () => {
    expect(pendingSceneRequests(null).size).toBe(0);
    expect(pendingSceneRequests([]).size).toBe(0);
  });

  it("isSceneId matches the database check shape", () => {
    expect(isSceneId("s000")).toBe(true);
    expect(isSceneId("s1234")).toBe(true);
    expect(isSceneId("s12345")).toBe(false);
  });
});

describe("sceneRepairEligibility — the button only where a repair run can act", () => {
  const unfinished = { published_at: null, privacy: null };

  it("is repairable for a video that never uploaded (blocked / held / awaiting review)", () => {
    expect(sceneRepairEligibility(unfinished)).toEqual({ repairable: true });
    expect(sceneRepairEligibility({ published_at: "", privacy: "  " }, [])).toEqual({ repairable: true });
    expect(
      sceneRepairEligibility(unfinished, [{ event: "publish.blocked" }, { event: "publish.held" }, { event: null }]),
    ).toEqual({ repairable: true });
  });

  it("is not repairable once uploaded — the run checkpoint is gone", () => {
    const uploaded = { repairable: false, reason: "uploaded" };
    // record_video (only after a successful upload) sets both fields.
    expect(sceneRepairEligibility({ published_at: "2026-09-01T10:00:00", privacy: "private" })).toEqual(uploaded);
    expect(sceneRepairEligibility({ published_at: "2026-09-01T10:00:00", privacy: null })).toEqual(uploaded);
    expect(sceneRepairEligibility({ published_at: null, privacy: "unlisted" })).toEqual(uploaded);
    // An upload/publish event naming the video is enough on its own.
    for (const event of ["upload.completed", "video.published", "short.completed"]) {
      expect(sceneRepairEligibility(unfinished, [{ event: "publish.allowed" }, { event }])).toEqual(uploaded);
    }
  });

  it("is not repairable with no video to judge", () => {
    expect(sceneRepairEligibility(null)).toEqual({ repairable: false, reason: "unknown" });
    expect(sceneRepairEligibility(undefined)).toEqual({ repairable: false, reason: "unknown" });
  });

  it("has the unavailable hint in en/ru/uz", () => {
    for (const d of [en, ru, uz]) {
      expect(d.videoDetail.storyboardRegenerateUnavailable.trim()).not.toBe("");
    }
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(ru.videoDetail)).toEqual(keys(en.videoDetail));
    expect(keys(uz.videoDetail)).toEqual(keys(en.videoDetail));
  });
});
