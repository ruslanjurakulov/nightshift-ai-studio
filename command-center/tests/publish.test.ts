import { describe, expect, it } from "vitest";
import {
  acceptedHint,
  coercePublishRequests,
  downloadName,
  CHANNEL_ID_RE,
  latestByTarget,
  parsePublishHint,
  publishBlocker,
  targetKey,
  youtubeWatchUrl,
} from "../lib/publish";
import { buildRenderJobInsert } from "../lib/runBackend";

const ACC = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";

describe("publish hint", () => {
  it("parses only platform:id with safe characters", () => {
    expect(parsePublishHint(`tiktok:${ACC}`)).toEqual({ platform: "tiktok", id: ACC });
    expect(parsePublishHint("youtube:finance")).toEqual({ platform: "youtube", id: "finance" });
    for (const bad of ["myspace:x", "tiktok:", "tiktok:a b", "tiktok:<script>", 42, null, "x".repeat(300)])
      expect(parsePublishHint(bad)).toBeNull();
  });
  it("keeps a hint only when it names one of the organization's accounts", () => {
    const accounts = [{ platform: "instagram" as const, id: ACC }, { platform: "youtube" as const, id: "finance" }];
    expect(acceptedHint(`instagram:${ACC}`, accounts)).toBe(`instagram:${ACC}`);
    expect(acceptedHint(`tiktok:${ACC}`, accounts)).toBeNull();
    expect(acceptedHint("youtube:other", accounts)).toBeNull();
  });
  it("rides on the render job as params.publish_hint, and is dropped when malformed", () => {
    expect(buildRenderJobInsert("finance", { publishHint: `tiktok:${ACC}` }, "u1").params.publish_hint).toBe(`tiktok:${ACC}`);
    expect(buildRenderJobInsert("finance", { publishHint: "evil:1" }, "u1").params).not.toHaveProperty("publish_hint");
    expect(buildRenderJobInsert("finance", {}, "u1").params).toEqual({});
  });
});

describe("publish requests", () => {
  const row = (o: Record<string, unknown>) => ({
    id: 1,
    video_id: "v1",
    account_id: ACC,
    platform: "instagram",
    status: "queued",
    ...o,
  });
  it("coerces rows, drops unknown platforms and non-https result URLs", () => {
    const rows = coercePublishRequests([
      row({ id: 3, status: "published", result_url: "https://www.instagram.com/reel/abc/" }),
      row({ id: 2, platform: "youtube" }),
      row({ id: 1, status: "weird", result_url: "javascript:alert(1)" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([3, 1]);
    expect(rows[0].result_url).toBe("https://www.instagram.com/reel/abc/");
    expect(rows[1].status).toBe("failed");
    expect(rows[1].result_url).toBeNull();
  });
  it("keeps the newest request per target", () => {
    const rows = coercePublishRequests([
      row({ id: 9, status: "failed" }),
      row({ id: 8, platform: "youtube", account_id: null, target_channel_id: "finance", status: "published" }),
      row({ id: 4, status: "published" }),
      row({ id: 3, platform: "youtube", account_id: null, target_channel_id: "finance", status: "failed" }),
    ]);
    const latest = latestByTarget(rows);
    expect(latest.get(ACC)?.id).toBe(9);
    expect(latest.get("youtube:finance")?.id).toBe(8);
  });
  it("accepts a YouTube row only with a target channel and no account", () => {
    const rows = coercePublishRequests([
      row({ id: 5, platform: "youtube", account_id: null, target_channel_id: "finance", privacy: "private" }),
      row({ id: 4, platform: "youtube", account_id: ACC, target_channel_id: "finance" }),
      row({ id: 3, platform: "youtube", account_id: null, target_channel_id: null }),
      row({ id: 2, platform: "tiktok", account_id: ACC, target_channel_id: "finance" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([5]);
    expect(rows[0]).toMatchObject({ platform: "youtube", target_channel_id: "finance", account_id: null, privacy: "private" });
    expect(targetKey(rows[0])).toBe("youtube:finance");
  });
  it("links the own-channel upload only for a YouTube video id; accepts sane channel ids", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeWatchUrl("local-run-123")).toBeNull();
    expect(youtubeWatchUrl(null)).toBeNull();
    expect(CHANNEL_ID_RE.test("extinct-world")).toBe(true);
    expect(CHANNEL_ID_RE.test("a b")).toBe(false);
    expect(CHANNEL_ID_RE.test("x".repeat(129))).toBe(false);
  });
});

describe("publishBlocker mirrors the refusal the database applies", () => {
  it("refuses held, unapproved and rejected videos; allows approved uploads", () => {
    const base = { published_at: "2026-09-01T00:00:00Z", publish_state: null, review_state: "approved" };
    expect(publishBlocker(base)).toBeNull();
    expect(publishBlocker({ ...base, publish_state: "uploaded" })).toBeNull();
    expect(publishBlocker({ ...base, published_at: null })).toBe("not_uploaded");
    expect(publishBlocker({ ...base, publish_state: "blocked" })).toBe("not_uploaded");
    expect(publishBlocker({ ...base, review_state: "pending" })).toBe("not_approved");
    expect(publishBlocker({ ...base, review_state: "rejected" })).toBe("rejected");
  });
});

describe("downloadName", () => {
  it("makes a safe file name", () => {
    expect(downloadName("The Fall of Rome: Part 1/2", "abc")).toBe("The-Fall-of-Rome-Part-12.mp4");
    expect(downloadName(null, "abc123")).toBe("abc123.mp4");
    expect(downloadName("???", "abc123")).toBe("abc123.mp4");
  });
});
