import { describe, expect, it } from "vitest";
import { isSceneId, pendingSceneRequests, sceneRepairIntent } from "@/lib/sceneRepair";

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
