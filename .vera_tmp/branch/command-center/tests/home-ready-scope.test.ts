/**
 * Home reads the same waiting storyboards /videos lists (listWaitingStoryboards),
 * for the whole organization being viewed (orgWide) and never beyond it: the
 * query is narrowed to that organization's channel ids and to status 'ready'.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/credits", () => ({
  creditsEnforced: true,
  estimateForChannel: vi.fn(),
  isCreditsMissing: (e: { code?: string }) => e?.code === "42P01",
  readCreditPrices: vi.fn(),
}));

import { buildChannelScope, orgWide } from "../lib/channels";
import { listWaitingStoryboards } from "../lib/server/storyboards";

function stub(result: { data: unknown; error: unknown }) {
  const log: Record<string, unknown[]> = { eq: [], in: [], limit: [] };
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (...a: unknown[]) => (log.eq.push(a), q);
  q.in = (...a: unknown[]) => (log.in.push(a), q);
  q.order = () => q;
  q.limit = (...a: unknown[]) => (log.limit.push(a), Promise.resolve(result));
  return { client: { from: (t: string) => ((log.table = [t]), q) } as never, log };
}

const row = (id: string, channel: string) => ({
  id,
  channel_id: channel,
  slug: "s",
  topic: "t",
  title: null,
  scenes: [{ n: 1, text: "x" }],
  duration_s: 300,
  status: "ready",
  created_at: "2026-10-01T00:00:00Z",
  decided_at: null,
  credits_held: null,
  render_job_id: null,
});
const org = { supported: true, current: { is_default: false } };

describe("listWaitingStoryboards for Home", () => {
  it("with a channel selected in the URL, Home still asks for the whole organization's channels, and only the waiting ones", async () => {
    const scope = buildChannelScope("c1", [{ channel_id: "c1" }, { channel_id: "c2" }], org);
    const { client, log } = stub({ data: [], error: null });
    await listWaitingStoryboards(client, orgWide(scope));
    expect(log.eq).toContainEqual(["status", "ready"]);
    expect(log.in).toEqual([["channel_id", ["c1", "c2"]]]);
    expect(log.table).toEqual(["storyboards"]);
  });

  it("an organization with no channels matches nothing: it is never widened to every row RLS lets through", async () => {
    const scope = buildChannelScope("all-channels", [], org);
    const { client, log } = stub({ data: [], error: null });
    await listWaitingStoryboards(client, orgWide(scope));
    // scopeQuery's sentinel: an id no channel has, so the filter matches nothing.
    expect(log.in).toEqual([["channel_id", ["__none__"]]]);
  });

  it("a failed read is null (unknown), not an empty list; a database without 0057 has none waiting", async () => {
    const scope = orgWide(buildChannelScope("all-channels", [{ channel_id: "c1" }], org));
    expect(await listWaitingStoryboards(stub({ data: null, error: { code: "XX000" } }).client, scope)).toBeNull();
    expect(await listWaitingStoryboards(stub({ data: null, error: { code: "42P01" } }).client, scope)).toEqual([]);
  });

  it("returns the waiting storyboards as views, with their channel", async () => {
    const scope = orgWide(buildChannelScope("all-channels", [{ channel_id: "c1" }], org));
    const out = await listWaitingStoryboards(stub({ data: [row("11111111-1111-4111-8111-111111111111", "c1")], error: null }).client, scope);
    expect(out).toHaveLength(1);
    expect(out?.[0].channelId).toBe("c1");
  });
});
