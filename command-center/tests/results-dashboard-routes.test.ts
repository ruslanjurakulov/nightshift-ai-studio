/**
 * /api/results: dark by default, signed in, read only, and one organization at a time.
 * What would break without these: the route answering while the switch is off, an anonymous read, another organization's
 * channel, video title, publish request or connected account showing up for a member who is not in it (through the explicit
 * organization checks even when RLS and the query filters both failed to narrow), a channel id of another tenant answering
 * differently from one that does not exist, a failed read drawn as an empty dashboard, and a page render that calls a platform.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const h = vi.hoisted(() => ({
  user: { id: "user-a" } as { id: string } | null,
  org: { supported: true, orgs: [], current: { id: "11111111-1111-4111-8111-111111111111", name: "A", slug: "a", role: "viewer", is_default: false } } as {
    supported: boolean;
    orgs: unknown[];
    current: { id: string } | null;
  },
  channels: [] as Row[],
  tokens: { available: true, rows: [] as Row[] },
  db: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  /** Tables whose filters the fake ignores: a broad policy that returned too much. */
  leaky: new Set<string>(),
  /** When set, only rows this predicate allows are visible: RLS. */
  rls: null as null | ((table: string, row: Row) => boolean),
  calls: [] as string[],
  getUser: vi.fn(),
}));

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let max = Infinity;
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain;
  q.eq = (col: string, val: unknown) => (filters.push((r) => r[col] === val), q);
  q.in = (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), q);
  q.not = (col: string, _op: string, val: unknown) => (filters.push((r) => r[col] !== val), q);
  q.gte = (col: string, val: string) => (filters.push((r) => String(r[col] ?? "") >= val), q);
  q.order = chain;
  q.limit = (n: number) => ((max = n), q);
  q.then = (resolve: (v: unknown) => unknown) => {
    h.calls.push(table);
    const err = h.errors[table];
    if (err) return resolve({ data: null, error: err });
    let rows = (h.db[table] ?? []).filter((r) => (h.rls ? h.rls(table, r) : true));
    if (!h.leaky.has(table)) rows = rows.filter((r) => filters.every((f) => f(r)));
    return resolve({ data: rows.slice(0, max).map((r) => ({ ...r })), error: null });
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => {
    h.getUser();
    return h.user;
  },
  createClient: async () => ({ from: (table: string) => builder(table) }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => h.org }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: async () => ({ channels: h.channels, credentials: [] }) }));
vi.mock("@/lib/server/channel-tokens", () => ({ fetchTokenStatuses: async () => h.tokens }));

const channel = (id: string, org: string, name: string): Row => ({ channel_id: id, name, niche: "", status: "ACTIVE", org_id: org, credential_ref: {} });
const vid = (id: string, ch: string, title: string, ageDays = 2): Row => ({ video_id: id, channel_id: ch, title, topic: null, published_at: iso(NOW - ageDays * DAY), privacy: "private", video_format: "long" });
const snapshot = (id: string, views: number, date = "2026-10-24"): Row => ({
  video_id: id,
  snapshot_date: date,
  views,
  likes: 1,
  comment_count: 0,
  watch_time_minutes: 60,
  average_view_duration_seconds: 100,
  impressions: null,
});
const request = (id: number, org: string, ch: string, video: string, over: Row = {}): Row => ({
  id,
  org_id: org,
  channel_id: ch,
  video_id: video,
  account_id: "acc-a",
  target_channel_id: null,
  platform: "instagram",
  status: "published",
  reason: null,
  privacy: null,
  result_url: "https://example.com/p",
  created_at: iso(NOW - DAY),
  finished_at: iso(NOW - DAY + 1000),
  ...over,
});

function seed() {
  h.user = { id: "user-a" };
  h.org = { supported: true, orgs: [], current: { id: ORG_A } };
  h.channels = [channel("chanA1", ORG_A, "Alpha"), channel("chanA2", ORG_A, "Alpha two")];
  h.tokens = { available: true, rows: [{ channel_id: "chanA1", connected: true }] };
  h.db = {
    videos: [vid("vidA000001", "chanA1", "Alpha video"), vid("vidA000002", "chanA2", "Alpha two video"), vid("vidB000001", "chanB1", "SECRET Bravo video")],
    metrics_snapshots: [snapshot("vidA000001", 100), snapshot("vidA000002", 40), snapshot("vidB000001", 777777)],
    publish_requests: [request(1, ORG_A, "chanA1", "vidA000001"), request(2, ORG_B, "chanB1", "vidB000001", { account_id: "acc-b" })],
    social_accounts: [
      { id: "acc-a", org_id: ORG_A, platform: "instagram", username: "alpha_ig", display_name: null, status: "connected" },
      { id: "acc-b", org_id: ORG_B, platform: "tiktok", username: "bravo_tt", display_name: "SECRET Bravo TikTok", status: "connected" },
    ],
  };
  h.errors = {};
  h.leaky = new Set();
  h.rls = null;
  h.calls = [];
  h.getUser.mockReset();
}

const get = async (qs = "") => {
  const { GET } = await import("@/app/api/results/route");
  return GET(new Request(`http://x/api/results${qs}`));
};
const json = async (res: Response) => (await res.json()) as Record<string, any>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  delete process.env.NIGHTSHIFT_RESULTS_DASHBOARD;
  seed();
});

describe("the switch and the session", () => {
  it("is a 404 while the switch is off, and asks nobody anything", async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it("stays a 404 for an unrecognised value", async () => {
    for (const v of ["", "off", "0", "false", "enabled", " "]) {
      process.env.NIGHTSHIFT_RESULTS_DASHBOARD = v;
      expect((await get()).status).toBe(404);
    }
    expect(h.calls).toEqual([]);
  });

  it("requires a signed-in member", async () => {
    process.env.NIGHTSHIFT_RESULTS_DASHBOARD = "on";
    h.user = null;
    const res = await get();
    expect(res.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it("refuses a period that is not 7, 28 or 90 and a channel id that is not an id, before reading anything", async () => {
    process.env.NIGHTSHIFT_RESULTS_DASHBOARD = "on";
    for (const qs of ["?range=30", "?range=abc", "?channel=../x", "?channel=a%20b", `?channel=${"x".repeat(200)}`]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("fails closed when organizations are not set up, and asks for an organization when there is none", async () => {
    process.env.NIGHTSHIFT_RESULTS_DASHBOARD = "on";
    h.org = { supported: false, orgs: [], current: null };
    expect((await get()).status).toBe(503);
    h.org = { supported: true, orgs: [], current: null };
    const res = await get();
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "org_required" });
    expect(h.calls).toEqual([]);
  });
});

describe("what a member of organization A gets", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_RESULTS_DASHBOARD = "on";
  });

  it("answers the workspace's videos, figures, history, platforms and a 'not collected' for subscribers, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body.rangeDays).toBe(28);
    expect(body.selected).toBe("all");
    expect(body.channels).toEqual([
      { id: "chanA1", name: "Alpha", connected: true },
      { id: "chanA2", name: "Alpha two", connected: false },
    ]);
    expect(body.videos.map((v: Row) => v.videoId).sort()).toEqual(["vidA000001", "vidA000002"]);
    expect(body.kpis.views).toEqual({ value: 140, known: 2, of: 2 });
    expect(body.subscribers).toBe("not_collected");
    expect(body.freshness).toMatchObject({ asOf: "2026-10-24", stale: false });
    const kinds = body.history.map((e: Row) => e.key).sort();
    expect(kinds).toEqual(["rq:1", "up:vidA000001", "up:vidA000002"]);
    expect(body.history.find((e: Row) => e.key === "rq:1").target).toBe("@alpha_ig");
    const cards = Object.fromEntries(body.platforms.map((c: Row) => [c.id, c]));
    expect(cards.youtube).toMatchObject({ state: "live", connected: 1 });
    expect(cards.instagram).toMatchObject({ state: "connected_results_coming", connected: 1 });
    expect(cards.tiktok).toMatchObject({ state: "not_connected", connected: 0 });
    expect(cards.x.state).toBe("coming");
    expect(cards.facebook.state).toBe("coming");
  });

  it("narrows to one channel and to the period asked for", async () => {
    h.db.videos.push(vid("vidA000003", "chanA1", "Old Alpha video", 20));
    h.db.metrics_snapshots.push(snapshot("vidA000003", 5, "2026-10-06"));
    const week = await json(await get("?channel=chanA1&range=7"));
    expect(week.selected).toBe("chanA1");
    expect(week.videos.map((v: Row) => v.videoId)).toEqual(["vidA000001"]);
    const month = await json(await get("?channel=chanA1&range=28"));
    expect(month.videos.map((v: Row) => v.videoId).sort()).toEqual(["vidA000001", "vidA000003"]);
  });

  it("never sends a field the page does not draw (no token, no email, no org id of another tenant)", async () => {
    const text = JSON.stringify(await json(await get()));
    expect(text).not.toMatch(/token|secret|password|email|@gmail/i);
    expect(text).not.toContain(ORG_B);
  });
});

describe("one organization at a time", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_RESULTS_DASHBOARD = "on";
  });

  const leakFree = (text: string) => {
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("chanB1");
    expect(text).not.toContain("vidB000001");
    expect(text).not.toContain("777777");
    expect(text).not.toContain("bravo");
  };

  it("with RLS doing its job, A sees nothing of B", async () => {
    h.rls = (table, row) => (table === "videos" ? row.channel_id !== "chanB1" : table === "metrics_snapshots" ? row.video_id !== "vidB000001" : row.org_id === ORG_A);
    leakFree(JSON.stringify(await json(await get())));
  });

  it("with the context handing over B's channel as well, the loader still serves only A's channels", async () => {
    h.channels = [...h.channels, channel("chanB1", ORG_B, "SECRET Bravo")];
    const res = await get();
    expect(res.status).toBe(200);
    leakFree(JSON.stringify(await json(res)));
  });

  it("with a channel that names no organization, it is nobody's but the platform's: not served", async () => {
    h.channels = [...h.channels, { channel_id: "chanX", name: "Orphan", org_id: null, status: "ACTIVE", credential_ref: {} }];
    h.db.videos.push(vid("vidX000001", "chanX", "Orphan video"));
    const text = JSON.stringify(await json(await get()));
    expect(text).not.toContain("Orphan");
  });

  it("with every table ignoring its filters (a broad policy), the explicit checks still drop B's rows", async () => {
    h.channels = [...h.channels, channel("chanB1", ORG_B, "SECRET Bravo")];
    h.leaky = new Set(["videos", "metrics_snapshots", "publish_requests", "social_accounts"]);
    // a newer reading of B's video, and a request of B's organization that names A's channel: neither may count
    h.db.metrics_snapshots.push(snapshot("vidB000001", 5, "2026-10-25"));
    h.db.publish_requests.push(request(3, ORG_B, "chanA1", "vidA000001", { platform: "tiktok", account_id: "acc-b" }));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await json(res);
    leakFree(JSON.stringify(body));
    expect(body.kpis.views.value).toBe(140);
    expect(body.freshness.asOf).toBe("2026-10-24");
    expect(body.history.map((e: Row) => e.key)).not.toContain("rq:3");
    expect(body.platforms.find((c: Row) => c.id === "tiktok")).toMatchObject({ state: "not_connected", connected: 0 });
  });

  it("answers another organization's channel exactly like a channel that does not exist, and reads no rows", async () => {
    h.channels = [...h.channels, channel("chanB1", ORG_B, "SECRET Bravo")];
    const other = await get("?channel=chanB1");
    const missing = await get("?channel=no-such-channel");
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await json(other)).toEqual(await json(missing));
    expect(h.calls).toEqual([]);
  });

  it("user B, asking from organization B, gets B's rows and none of A's", async () => {
    h.user = { id: "user-b" };
    h.org = { supported: true, orgs: [], current: { id: ORG_B } };
    h.channels = [channel("chanB1", ORG_B, "SECRET Bravo")];
    const body = await json(await get());
    expect(body.videos.map((v: Row) => v.videoId)).toEqual(["vidB000001"]);
    expect(body.kpis.views.value).toBe(777777);
    const text = JSON.stringify(body);
    expect(text).not.toContain("Alpha");
    expect(text).not.toContain("vidA000001");
    expect(text).not.toContain("alpha_ig");
    // and A's channel is a 404 for B
    expect((await get("?channel=chanA1")).status).toBe(404);
  });
});

describe("a read that fails is never an empty dashboard", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_RESULTS_DASHBOARD = "on";
  });

  it("answers 502 when the videos, the readings or the channels cannot be read", async () => {
    h.errors = { videos: { message: "boom" } };
    expect((await get()).status).toBe(502);
    h.errors = { metrics_snapshots: { message: "boom" } };
    const res = await get();
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: "failed" });
  });

  it("names a missing cross-post table instead of hiding it, and keeps the rest", async () => {
    h.errors = { publish_requests: { code: "42P01", message: 'relation "publish_requests" does not exist' } };
    const body = await json(await get());
    expect(body.sources.requests).toBe("unavailable");
    expect(body.history.map((e: Row) => e.kind)).toEqual(["upload", "upload"]);
    expect(body.kpis.views.value).toBe(140);
  });

  it("an unreadable accounts table makes Instagram and TikTok 'unknown', not 'not connected'", async () => {
    h.errors = { social_accounts: { message: "boom" } };
    const body = await json(await get());
    expect(body.sources.accounts).toBe("failed");
    const cards = Object.fromEntries(body.platforms.map((c: Row) => [c.id, c.state]));
    expect(cards).toMatchObject({ youtube: "live", instagram: "unknown", tiktok: "unknown", x: "coming", facebook: "coming" });
  });

  it("counts only connected accounts: an expired or revoked one is not a connection", async () => {
    h.db.social_accounts = [
      { id: "acc-a", org_id: ORG_A, platform: "instagram", username: "alpha_ig", display_name: null, status: "expired" },
      { id: "acc-t", org_id: ORG_A, platform: "tiktok", username: "alpha_tt", display_name: null, status: "revoked" },
    ];
    const cards = Object.fromEntries((await json(await get())).platforms.map((c: Row) => [c.id, c]));
    expect(cards.instagram).toMatchObject({ state: "not_connected", connected: 0 });
    expect(cards.tiktok).toMatchObject({ state: "not_connected", connected: 0 });
  });

  it("says when the history is cut: one more than the limit is 'truncated', exactly the limit is not", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => request(100 + i, ORG_A, "chanA1", "vidA000001", { finished_at: iso(NOW - 3600_000 - i * 1000), created_at: iso(NOW - 7200_000 - i * 1000) }));
    h.db.publish_requests = many(100);
    // 100 requests + 2 uploads = 102 entries: cut
    const cut = await json(await get());
    expect(cut.history).toHaveLength(100);
    expect(cut.truncated.history).toBe(true);
    h.db.publish_requests = many(97);
    const whole = await json(await get());
    expect(whole.history).toHaveLength(99);
    expect(whole.truncated.history).toBe(false);
  });

  it("a workspace with no channel is an answer, not an error", async () => {
    h.channels = [];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.channels).toEqual([]);
    expect(body.videos).toEqual([]);
    expect(body.kpis.views.value).toBeNull();
    expect(h.calls).not.toContain("videos");
  });
});

describe("read only", () => {
  it("exports a GET and nothing that writes", async () => {
    const mod = await import("@/app/api/results/route");
    expect(Object.keys(mod).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    expect(typeof mod.GET).toBe("function");
  });

  it("the route and loader never reach for a write, an RPC, a service key or a platform", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["app/api/results/route.ts", "lib/server/results-dashboard.ts"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, file).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
      expect(src, file).not.toMatch(/SERVICE_KEY|service_role|googleapis|graph\.facebook|api\.tiktok|api\.x\.com|youtube\.com\/youtube|fetch\(/i);
    }
  });
});
