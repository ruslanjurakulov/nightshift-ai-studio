/**
 * The video a channel run made (lib/server/run-video.ts), for the live view's "Open video: Publish to platforms" link. What would
 * break without these: a link to the run's own Short, a repurpose clip or a repaired older video instead of the run's long video,
 * a guessed id while the row has not synced, or a non-video row read as one.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { readRunVideo } = await import("../lib/server/run-video");

type Row = Record<string, unknown>;
/** A tiny in-memory PostgREST: applies the filters the reader sends, so a row it should never pick is really in the table. */
function client(table: Row[], fail = false) {
  const sent: string[][] = [];
  return {
    sent,
    from: (name: string) => {
      expect(name).toBe("videos");
      const preds: ((r: Row) => boolean)[] = [];
      const log: string[] = [];
      let order = "";
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (log.push(`eq ${k}`), preds.push((r) => r[k] === v), q),
        is: (k: string, v: null) => (log.push(`is ${k}`), preds.push((r) => (r[k] ?? null) === v), q),
        or: (f: string) => {
          log.push(`or ${f}`);
          expect(f).toBe("publish_state.is.null,publish_state.neq.repaired_awaiting_review");
          preds.push((r) => r.publish_state == null || r.publish_state !== "repaired_awaiting_review");
          return q;
        },
        gte: (k: string, v: string) => (log.push(`gte ${k}`), preds.push((r) => typeof r[k] === "string" && (r[k] as string) >= v), q),
        lte: (k: string, v: string) => (log.push(`lte ${k}`), preds.push((r) => typeof r[k] === "string" && (r[k] as string) <= v), q),
        order: (k: string) => ((order = k), q),
        limit: async () => {
          sent.push(log);
          if (fail) return { data: null, error: { code: "42501" } };
          const rows = table.filter((r) => preds.every((p) => p(r))).sort((a, b) => String(b[order] ?? "").localeCompare(String(a[order] ?? "")));
          return { data: rows, error: null };
        },
      };
      return q;
    },
  };
}

const FROM = "2026-11-21T10:00:00Z";
const UNTIL = "2026-11-21T13:00:00Z";
const long = (over: Row): Row => ({ channel_id: "ch-alpha", video_format: "long", parent_video_id: null, publish_state: "uploaded", held_at: null, published_at: null, ...over });

describe("the run's video", () => {
  it("is the run's long video, not its Short uploaded a minute later, a repurpose clip, or a repaired older video", async () => {
    const c = client([
      long({ video_id: "yt-long0001", slug: "rome", published_at: "2026-11-21T10:50:00Z" }),
      long({ video_id: "yt-short001", slug: "rome", video_format: "short", parent_video_id: "yt-long0001", published_at: "2026-11-21T10:51:00Z" }),
      long({ video_id: "run-clip-01", slug: "rome-c1", video_format: "short", parent_video_id: "yt-long0001", publish_state: "held", held_at: "2026-11-21T10:55:00Z" }),
      long({ video_id: "run-repair1", slug: "carthage", publish_state: "repaired_awaiting_review", held_at: "2026-11-21T10:58:00Z" }),
      long({ video_id: "yt-other001", channel_id: "ch-beta", published_at: "2026-11-21T10:59:00Z" }),
    ]);
    expect(await readRunVideo(c as never, "ch-alpha", FROM, UNTIL)).toEqual({ id: "yt-long0001", state: "uploaded" });
  });

  it("a queue run names its video by slug (0189 result_slug), so another video of the channel in the window is not it", async () => {
    const c = client([
      long({ video_id: "run-held-rome", slug: "rome", publish_state: "held", held_at: "2026-11-21T10:20:00Z" }),
      long({ video_id: "yt-carthage1", slug: "carthage", published_at: "2026-11-21T10:30:00Z" }),
    ]);
    expect(await readRunVideo(c as never, "ch-alpha", FROM, UNTIL, "rome")).toEqual({ id: "run-held-rome", state: "held" });
  });

  it("a slug reused by an earlier run of the same topic is not this run's: the window still holds", async () => {
    const c = client([
      long({ video_id: "yt-rome-old1", slug: "rome", published_at: "2026-11-19T15:00:00Z" }),
      long({ video_id: "run-held-rome", slug: "rome", publish_state: "held", held_at: "2026-11-21T10:20:00Z" }),
    ]);
    expect(await readRunVideo(c as never, "ch-alpha", FROM, UNTIL, "rome")).toEqual({ id: "run-held-rome", state: "held" });
    expect(c.sent.every((l) => l.includes("eq slug") && l.some((x) => x.startsWith("gte")))).toBe(true);
  });

  it("an uploaded row wins over a held one of the same run; none, or a read RLS refuses, is null: never a guess", async () => {
    const both = client([
      long({ video_id: "run-held-rome", slug: "rome", publish_state: "held", held_at: "2026-11-21T10:40:00Z" }),
      long({ video_id: "yt-rome00001", slug: "rome", published_at: "2026-11-21T10:50:00Z" }),
    ]);
    expect(await readRunVideo(both as never, "ch-alpha", FROM, UNTIL, "rome")).toEqual({ id: "yt-rome00001", state: "uploaded" });
    expect(await readRunVideo(client([]) as never, "ch-alpha", FROM, UNTIL)).toBeNull();
    expect(await readRunVideo(client([], true) as never, "ch-alpha", FROM, UNTIL)).toBeNull();
    expect(await readRunVideo(client([long({ video_id: "", held_at: "2026-11-21T10:40:00Z", publish_state: "held" })]) as never, "ch-alpha", FROM, UNTIL)).toBeNull();
  });
});
