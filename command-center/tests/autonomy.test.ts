import { describe, expect, it } from "vitest";
import {
  WINDOW_MIN_VIDEOS,
  autonomousActions,
  autonomyHealth,
  autonomyPosture,
  duplicateTopics,
  failureLearning,
  normalizeTopic,
  publishingWindow,
  qualityGate,
} from "@/lib/autonomy";
import type { MetricsSnapshotRow, SystemEventRow, VideoRow } from "@/lib/types";

let seq = 0;
function ev(over: Partial<SystemEventRow> & { event: string; ts: string }): SystemEventRow {
  seq += 1;
  return {
    event_key: over.event_key ?? `k${seq}`,
    event: over.event,
    ts: over.ts,
    video_id: over.video_id ?? null,
    job_id: over.job_id ?? null,
    agent: over.agent ?? null,
    status: over.status ?? null,
    duration_ms: over.duration_ms ?? null,
    metadata: over.metadata ?? null,
    channel_id: over.channel_id ?? null,
  };
}

function video(over: Partial<VideoRow> & { video_id: string }): VideoRow {
  return {
    video_id: over.video_id,
    channel_id: over.channel_id ?? "default",
    topic: over.topic ?? null,
    title: over.title ?? null,
    slug: null,
    published_at: over.published_at ?? null,
    privacy: null,
    category_id: null,
    local_path: null,
    thumbnail_variant: over.thumbnail_variant ?? null,
    title_variant: over.title_variant ?? null,
    hook_variant: over.hook_variant ?? null,
    video_format: over.video_format ?? "long",
    parent_video_id: over.parent_video_id ?? null,
    preview_path: null,
    script_text: null,
    review_state: "pending",
  };
}

function snap(over: Partial<MetricsSnapshotRow> & { video_id: string }): MetricsSnapshotRow {
  return {
    video_id: over.video_id,
    snapshot_date: over.snapshot_date ?? "2026-09-11T00:00:00Z",
    views: over.views ?? 100,
    likes: null,
    comment_count: null,
    watch_time_minutes: null,
    average_view_duration_seconds: null,
    impressions: null,
    impression_ctr: null,
  };
}

describe("autonomyPosture", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");

  it("reports publishing as unconditional and controls as not configured", () => {
    const posture = autonomyPosture([], now);
    const by = Object.fromEntries(posture.map((p) => [p.key, p.state]));
    // main.py uploads without consulting the approval flag.
    expect(by.publishing).toBe("unconditional");
    // approve_run.py exists but only records.
    expect(by.approval).toBe("records_only");
    // No backend mechanism exists for any of these.
    expect(by.autonomyMode).toBe("not_configured");
    expect(by.emergencyStop).toBe("not_configured");
    expect(by.limits).toBe("not_configured");
  });

  it("only claims automatic analysis when a recent real event proves it", () => {
    const stale = [ev({ event: "system.heartbeat", ts: "2026-08-01T00:00:00Z" })];
    expect(autonomyPosture(stale, now).find((p) => p.key === "analytics")?.state).toBe("not_configured");

    const fresh = [
      ev({ event: "system.heartbeat", ts: "2026-09-04T06:00:00Z" }),
      ev({ event: "feedback.generated", ts: "2026-09-04T06:01:00Z" }),
    ];
    const posture = autonomyPosture(fresh, now);
    expect(posture.find((p) => p.key === "analytics")?.state).toBe("automatic");
    expect(posture.find((p) => p.key === "learning")?.state).toBe("automatic");
    expect(posture.find((p) => p.key === "analytics")?.evidenceTs).toBe("2026-09-04T06:00:00Z");
  });
});

describe("autonomousActions", () => {
  it("includes only agent-attributed events", () => {
    const events = [
      ev({ event: "system.heartbeat", ts: "2026-09-04T10:00:00Z", agent: "intelligence_poll", status: "running" }),
      ev({ event: "some.infra", ts: "2026-09-04T09:00:00Z" }), // no agent
    ];
    const actions = autonomousActions(events);
    expect(actions).toHaveLength(1);
    expect(actions[0].agent).toBe("intelligence_poll");
    expect(actions[0].outcome).toBe("running");
  });

  it("maps status to a real outcome", () => {
    const events = [
      ev({ event: "a.completed", ts: "2026-09-04T10:00:00Z", agent: "x", status: "completed" }),
      ev({ event: "b.failed", ts: "2026-09-04T09:00:00Z", agent: "y", status: "failed" }),
    ];
    const [a, b] = autonomousActions(events);
    expect(a.outcome).toBe("ok");
    expect(b.outcome).toBe("failed");
  });
});

describe("autonomyHealth", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");

  it("counts only agent events inside the window and never invents interventions", () => {
    const events = [
      ev({ event: "a.completed", ts: "2026-09-04T11:00:00Z", agent: "x", status: "completed" }),
      ev({ event: "b.failed", ts: "2026-09-04T10:00:00Z", agent: "x", status: "failed" }),
      ev({ event: "c.completed", ts: "2026-09-01T10:00:00Z", agent: "x", status: "completed" }), // outside
    ];
    const h = autonomyHealth(events, 24, now);
    expect(h.successful).toBe(1);
    expect(h.failed).toBe(1);
    // Nothing records human interventions yet — null, not a misleading 0.
    expect(h.humanInterventions).toBeNull();
  });
});

describe("qualityGate", () => {
  it("is not ready when stages are missing", () => {
    const g = qualityGate([]);
    expect(g.ready).toBe(false);
    expect(g.items.every((i) => !i.ok)).toBe(true);
  });

  it("is ready only when every stage completed and nothing failed", () => {
    const done = [
      "script.completed",
      "voice.completed",
      "media.completed",
      "thumbnail.completed",
      "render.completed",
      "upload.completed",
    ].map((e) => ev({ event: e, ts: "2026-09-04T10:00:00Z", video_id: "v1" }));
    expect(qualityGate(done).ready).toBe(true);

    const withFailure = [...done, ev({ event: "render.failed", ts: "2026-09-04T10:05:00Z", status: "failed" })];
    const g = qualityGate(withFailure);
    expect(g.ready).toBe(false);
    expect(g.failures).toBe(1);
  });
});

describe("failureLearning", () => {
  it("groups real failures and only reports a recorded cause", () => {
    const events = [
      ev({ event: "render.failed", ts: "2026-09-04T10:00:00Z", agent: "compositor", status: "failed", metadata: { error: "ffmpeg missing" } }),
      ev({ event: "render.failed", ts: "2026-09-03T10:00:00Z", agent: "compositor", status: "failed" }),
      ev({ event: "upload.failed", ts: "2026-09-02T10:00:00Z", agent: "youtube_uploader", status: "failed" }),
    ];
    const groups = failureLearning(events);
    expect(groups[0].event).toBe("render.failed");
    expect(groups[0].count).toBe(2);
    expect(groups[0].cause).toBe("ffmpeg missing");
    // No metadata.error recorded -> no invented cause.
    expect(groups.find((g) => g.event === "upload.failed")?.cause).toBeNull();
  });

  it("is empty when nothing failed", () => {
    expect(failureLearning([ev({ event: "a.completed", ts: "2026-09-04T10:00:00Z", status: "completed" })])).toEqual([]);
  });
});

describe("publishingWindow", () => {
  it("returns null below the evidence floor — no universal best time", () => {
    const videos = [video({ video_id: "v1", published_at: "2026-09-01T18:00:00Z" })];
    expect(publishingWindow(videos, [snap({ video_id: "v1" })])).toBeNull();
  });

  it("reports the best observed window once enough real videos exist", () => {
    const videos: VideoRow[] = [];
    const snaps: MetricsSnapshotRow[] = [];
    // Four low performers published Monday 09:00 UTC (2026-09-07 is a Monday).
    for (let i = 0; i < 4; i++) {
      videos.push(video({ video_id: `low${i}`, published_at: "2026-09-07T09:00:00Z" }));
      snaps.push(snap({ video_id: `low${i}`, snapshot_date: "2026-09-17T00:00:00Z", views: 100 }));
    }
    // Two strong performers published Thursday 18:00 UTC (2026-09-10 is a Thursday).
    for (let i = 0; i < 2; i++) {
      videos.push(video({ video_id: `high${i}`, published_at: "2026-09-10T18:00:00Z" }));
      snaps.push(snap({ video_id: `high${i}`, snapshot_date: "2026-09-20T00:00:00Z", views: 5000 }));
    }
    const w = publishingWindow(videos, snaps);
    expect(w).not.toBeNull();
    expect(w!.weekday).toBe(4); // Thursday
    expect(w!.hour).toBe(18);
    expect(w!.evidence).toBe(2);
    expect(videos.length).toBeGreaterThanOrEqual(WINDOW_MIN_VIDEOS);
  });
});

describe("duplicate detection", () => {
  it("normalizes topics for comparison", () => {
    expect(normalizeTopic("The  Mystery, of Egypt!")).toBe("the mystery of egypt");
  });

  it("only reports topics genuinely covered more than once", () => {
    const videos = [
      video({ video_id: "v1", topic: "Ancient Egypt" }),
      video({ video_id: "v2", topic: "ancient  egypt!" }),
      video({ video_id: "v3", topic: "Roman Empire" }),
    ];
    const dupes = duplicateTopics(videos);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].count).toBe(2);
    expect(dupes[0].videoIds.sort()).toEqual(["v1", "v2"]);
  });

  it("is empty with no repetition", () => {
    expect(duplicateTopics([video({ video_id: "v1", topic: "A" })])).toEqual([]);
  });
});
