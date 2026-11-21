/**
 * The video a channel run made (lib/server/run-video.ts), for the live view's "Open video → Send to platforms" link. What would
 * break without these: a link to another run's video, a guessed id while the row has not synced, or a non-video row read as one.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { readRunVideo } = await import("../lib/server/run-video");

type Row = Record<string, unknown>;
function client(rows: { held_at: Row[]; published_at: Row[] }, fail = false) {
  const calls: { col: string; filters: [string, unknown][] }[] = [];
  return {
    calls,
    from: (table: string) => {
      expect(table).toBe("videos");
      const filters: [string, unknown][] = [];
      let col = "";
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        gte: (k: string, v: unknown) => ((col = k), filters.push([`>=${k}`, v]), q),
        lte: (k: string, v: unknown) => (filters.push([`<=${k}`, v]), q),
        order: () => q,
        limit: async () => {
          calls.push({ col, filters });
          return fail ? { data: null, error: { code: "42501" } } : { data: rows[col as "held_at" | "published_at"], error: null };
        },
      };
      return q;
    },
  };
}

const FROM = "2026-11-21T10:00:00.000Z";
const UNTIL = "2026-11-21T13:00:00.000Z";

describe("the run's video", () => {
  it("is the channel's newest row held or uploaded inside the run's window, read with the person's client", async () => {
    const c = client({
      held_at: [{ video_id: "held-abc", held_at: "2026-11-21T10:40:00Z", published_at: null }],
      published_at: [{ video_id: "yt12345678a", held_at: null, published_at: "2026-11-21T10:55:00Z" }],
    });
    expect(await readRunVideo(c as never, "ch-alpha", FROM, UNTIL)).toEqual({ id: "yt12345678a", state: "uploaded" });
    for (const call of c.calls) {
      expect(call.filters).toContainEqual(["channel_id", "ch-alpha"]);
      expect(call.filters).toContainEqual([`>=${call.col}`, FROM]);
      expect(call.filters).toContainEqual([`<=${call.col}`, UNTIL]);
    }
  });

  it("a held row is held; none, or a read RLS refuses, is null: never a guess", async () => {
    expect(await readRunVideo(client({ held_at: [{ video_id: "held-abc", held_at: "2026-11-21T10:40:00Z", published_at: null }], published_at: [] }) as never, "ch-alpha", FROM, UNTIL)).toEqual({ id: "held-abc", state: "held" });
    expect(await readRunVideo(client({ held_at: [], published_at: [] }) as never, "ch-alpha", FROM, UNTIL)).toBeNull();
    expect(await readRunVideo(client({ held_at: [], published_at: [] }, true) as never, "ch-alpha", FROM, UNTIL)).toBeNull();
    expect(await readRunVideo(client({ held_at: [{ video_id: "", held_at: "2026-11-21T10:40:00Z" }, { video_id: 7, held_at: "x" }], published_at: [] }) as never, "ch-alpha", FROM, UNTIL)).toBeNull();
  });
});
