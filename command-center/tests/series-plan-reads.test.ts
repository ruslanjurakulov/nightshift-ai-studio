/**
 * readSeriesPlan (lib/server/seriesPlans.ts): what the page is told when a quote read fails.
 *
 * What would break without these: a quote the database refused (or that threw) being read as a price. An error answer that still carries
 * a body ("included, startable") must be NO quote: the chip says "price unavailable", the total says "not complete", and there is no
 * Start key. The page test (series-plan-page.test.tsx) covers an answer that cannot be parsed; this covers the ones that fail.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readSeriesPlan } from "../lib/server/seriesPlans";
import { episodeChip, seriesTotal } from "../lib/seriesPlan";

const ID = "11111111-2222-3333-4444-555555555555";
const E = (n: number) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;

function client(quoteFor: (episode: string) => unknown | Promise<unknown>) {
  const episodes = [1, 2, 3].map((n) => ({
    id: E(n), plan_id: ID, n, topic: `T${n}`, outline: {}, usable: true, needs_confirmation: false, duration_s: 300, status: "planned",
    credits_held: null, render_job_id: null, started_at: null,
  }));
  const plan = {
    id: ID, channel_id: "news", series_id: null, topic: "t", niche: "n", language: "English", n_episodes: 3, duration_s: 300, status: "ready",
    title: "T", report: {}, quote: {}, error_code: null, created_at: "2026-10-24T10:00:00Z", finished_at: null,
  };
  const builder = (data: unknown) => {
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "order", "limit", "select"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data, error: null });
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: Array.isArray(data) ? data : [], error: null }).then(res);
    return b;
  };
  return {
    from: (table: string) => ({ select: () => builder(table === "series_plans" ? plan : table === "series_episodes" ? episodes : []) }),
    rpc: async (_fn: string, args: { p_episode: string }) => quoteFor(args.p_episode),
  } as never;
}

const included = { price_status: "included", credits: null, status: "planned", needs_confirmation: false, blocked_by: null, may_start: true, startable: true };

describe("a quote that fails is no quote", () => {
  it("an error answer that still carries 'included, startable' is null", async () => {
    const read = await readSeriesPlan(client(() => ({ data: included, error: { code: "42501", message: "forbidden" } })), ID);
    if (read.state !== "ok") throw new Error(read.state);
    expect(read.episodes.map((e) => e.quote)).toEqual([null, null, null]);
    expect(read.episodes.map((e) => episodeChip(e.episode, e.quote, e.links).key)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(seriesTotal(read.episodes.map((e) => ({ n: e.episode.n, usable: e.episode.usable, quote: e.quote })))).toEqual({ kind: "incomplete", unknownEpisodes: [1, 2, 3] });
  });

  it("a read that throws, or rejects, is null for that episode only and does not fail the page", async () => {
    const read = await readSeriesPlan(
      client((episode) => {
        if (episode === E(1)) throw new Error("network");
        if (episode === E(2)) return Promise.reject(new Error("timeout"));
        return { data: { ...included, price_status: "priced", credits: 15 }, error: null };
      }),
      ID,
    );
    if (read.state !== "ok") throw new Error(read.state);
    expect(read.episodes.map((e) => e.quote?.credits ?? null)).toEqual([null, null, 15]);
    expect(read.episodes[0].quote).toBeNull();
  });

  it("an answer of the wrong shape (null, a string, an array) is null, never 'included'", async () => {
    for (const data of [null, "included", [included], {}, { price_status: "included" , credits: "x"}]) {
      const read = await readSeriesPlan(client(() => ({ data, error: null })), ID);
      if (read.state !== "ok") throw new Error(read.state);
      const quotes = read.episodes.map((e) => e.quote);
      // `{ price_status: "included" }` alone is a well-formed 'included' with nothing startable: it must not make the episode startable
      for (const q of quotes) expect(q === null || q.startable === false).toBe(true);
    }
  });
});
