/**
 * The owner's phone strip tells the truth tile by tile (QA M15/M16/B7, backend B-09/B-10, B6):
 *  - a failed read is "unknown" WITH "could not read" under it: never "none" or "idle", never 0 or 0/0;
 *  - "Failed (24h)" and "Published today" are exact counts, not a window of the newest rows;
 *  - "Alerts" leaves out the operator bot's bookkeeping rows and counts a repeated low-balance row once;
 *  - a system that recorded nothing is idle, not a green all-clear;
 *  - a read that never answers becomes "unknown" after the time limit instead of an endless skeleton.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";

const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ tables: {} as Record<string, unknown> }));

type Res = { data: unknown; error: unknown; count?: number | null };
const FAIL: Res = { data: null, error: { message: "boom", code: "XX000" }, count: null };
const rows = (data: unknown[], count?: number): Res => ({ data, error: null, count: count ?? data.length });
const HANG = Symbol("hang");
const rec = vi.hoisted(() => ({ log: [] as { table: string; calls: [string, unknown[]][] }[] }));

function resolveFor(table: string, calls: [string, unknown[]][]): Res | typeof HANG {
  // The freshness read of the cost ledger (newest synced_at) is told apart from today's rows by what it selects.
  if (table === "video_costs" && calls.some(([m, a]) => m === "select" && a[0] === "synced_at")) {
    return (state.tables.video_costs_sync as Res) ?? (state.tables.video_costs === FAIL ? FAIL : { data: [], error: null, count: 0 });
  }
  // The exact-count query of failed events (`head: true`) is told apart from the list read of the same table.
  if (table === "system_events" && calls.some(([m, a]) => m === "select" && (a[1] as { head?: boolean } | undefined)?.head)) {
    return (state.tables["system_events#count"] as Res) ?? (state.tables.system_events as Res) ?? { data: [], error: null, count: 0 };
  }
  return (state.tables[table] as Res) ?? { data: [], error: null, count: 0 };
}

function builder(table: string): unknown {
  const calls: [string, unknown[]][] = [];
  rec.log.push({ table, calls });
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        const result = resolveFor(table, calls);
        if (result === HANG) return () => undefined;
        return (res: (v: Res) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      }
      return (...args: unknown[]) => {
        calls.push([String(prop), args]);
        return q;
      };
    },
    apply: () => q,
  });
  return q;
}

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => builder(table) }),
  getUser: async () => ({ id: "u1" }),
}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/command-center" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope, ALL_CHANNELS } = await import("@/lib/channels");
  return {
    getChannelContext: async () => ({ selection: ALL_CHANNELS, channels: [], scope: unscopedScope() }),
    fetchScopedVideoIds: async () => null,
    fetchTopicScores: async () => [],
  };
});
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: false, orgs: [], current: null }) }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => true, resolveCurrentOrgRole: async () => "owner" }));
vi.mock("@/lib/server/run-backend", () => ({ isRunNowConfigured: false }));
// A short limit, so "a read that never answers" can be tested without waiting eight seconds.
vi.mock("@/lib/server/read-timeout", async (orig) => {
  const actual = await orig<typeof import("../lib/server/read-timeout")>();
  return { ...actual, timed: <R,>(read: PromiseLike<R>) => actual.timed(read, 40) };
});

const { default: CommandCenter } = await import("../app/(app)/[channel]/command-center/page");

/** The tiles by what they are, found through their label. */
const KEY_OF: Record<string, string> = {
  [en.ownerShell.gSpend]: "spend",
  [en.ownerShell.gBalance]: "balance",
  [en.ownerShell.gFailed]: "errors",
  [en.ownerShell.gWaiting]: "waiting",
  [en.ownerShell.gAlerts]: "alerts",
  [en.ownerShell.gWorkers]: "workers",
  [en.dashboard.publishedToday]: "videos",
  [en.dashboard.activeAgents]: "agents",
};

async function glance(): Promise<Record<string, { label: string; value: string; sub: string; tone: string }>> {
  const html = renderToStaticMarkup(await CommandCenter());
  const section = html.slice(html.indexOf("data-owner-glance"));
  const end = section.indexOf("</section>");
  const items = section.slice(0, end).split("<li ").slice(1);
  const out: Record<string, { label: string; value: string; sub: string; tone: string }> = {};
  for (const li of items) {
    const spans = [...li.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    out[KEY_OF[unescape(spans[0] ?? "")] ?? (/^Spent /.test(unescape(spans[0] ?? "")) ? "spend" : spans[0]) ?? "?"] = { label: spans[0] ?? "", value: spans[1] ?? "", sub: spans[2] ?? "", tone: li.match(/border-color:([^;"]*)/)?.[1] ?? "" };
  }
  return out;
}

beforeEach(() => {
  state.tables = {};
  rec.log.length = 0;
});

describe("every read failed", () => {
  it("each tile says unknown with 'could not read' under it, never 0, 0/0, none or idle", async () => {
    for (const t of ["system_events", "videos", "alert_events", "worker_status", "provider_balances", "video_costs", "metrics_snapshots", "feedback_signals"]) state.tables[t] = FAIL;
    const tiles = await glance();
    expect(Object.keys(tiles).sort()).toEqual(["agents", "alerts", "balance", "errors", "spend", "videos", "waiting", "workers"]);
    for (const [key, tile] of Object.entries(tiles)) {
      expect(unescape(tile.value), key).toBe(en.common.unknown);
      expect(unescape(tile.sub), key).toBe(en.common.couldNotRead);
      expect(tile.sub, key).not.toBe(en.common.none);
      expect(tile.sub, key).not.toBe(en.common.idle);
    }
    expect(JSON.stringify(tiles)).not.toContain("0/0");
  });
  it("and the strip offers a Retry", async () => {
    state.tables.system_events = FAIL;
    const html = renderToStaticMarkup(await CommandCenter());
    expect(html).toContain("data-read-error");
  });
});

describe("exact counts, not a window of the newest rows", () => {
  it("Failed (24h) is the database's count even when the newest-200 list is empty", async () => {
    state.tables.system_events = rows([], 7);
    const tiles = await glance();
    expect(tiles.errors.value).toBe("7");
    expect(unescape(tiles.errors.sub)).toBe(en.dashboard.needsAttention);
  });
  it("Published today is the database's count for the owner's day", async () => {
    state.tables.videos = rows([], 4);
    expect((await glance()).videos.value).toBe("4");
  });
});

describe("Alerts tile", () => {
  const at = new Date().toISOString();
  it("leaves out the operator bot's rows and counts a repeated low-balance row once", async () => {
    state.tables.alert_events = rows([
      { kind: "operator.digest", title: "run:1", at },
      { kind: "operator.alert", title: "run:2", at },
      { kind: "operator.mute", title: "run:3", at },
      { kind: "provider.balance_low", title: "ElevenLabs balance is low", at },
      { kind: "provider.balance_low", title: "ElevenLabs balance is low", at },
      { kind: "upload.failed", title: "Upload failed", at },
    ]);
    expect((await glance()).alerts.value).toBe("2");
  });
  it("two different providers low are two alerts", async () => {
    state.tables.alert_events = rows([
      { kind: "provider.balance_low", title: "ElevenLabs balance is low", at },
      { kind: "provider.balance_low", title: "Kling balance is low", at },
    ]);
    expect((await glance()).alerts.value).toBe("2");
  });
});

describe("a system that has recorded nothing", () => {
  it("is idle with 'nothing recorded yet', not a green 'none'", async () => {
    const tiles = await glance();
    expect(tiles.errors.value).toBe("0");
    expect(unescape(tiles.errors.sub)).toBe(en.ownerTruth.noEventsYet);
    expect(tiles.errors.tone).not.toContain("--color-ok");
  });
});

describe("a read that never answers", () => {
  it("becomes unknown after the time limit instead of hanging the page", async () => {
    state.tables.system_events = HANG as unknown as Res;
    state.tables.alert_events = HANG as unknown as Res;
    const tiles = await glance();
    expect(unescape(tiles.errors.value)).toBe(en.common.unknown);
    expect(unescape(tiles.alerts.value)).toBe(en.common.unknown);
    expect(esc(en.common.couldNotRead).length).toBeGreaterThan(0);
  });
});

describe("Spent (the ledger is mirrored nightly: the last COMPLETE day, as of the last sync)", () => {
  // The mirror last ran at 2026-10-17 01:00 Tashkent (= 2026-10-16T20:00Z); the complete day before it is 16 Oct (Tashkent).
  const SYNC = "2026-10-16T20:00:00.000Z";
  const NOW_T = new Date("2026-10-17T08:53:00Z");
  const sync = (iso: string | null = SYNC) => rows(iso ? [{ synced_at: iso }] : []);
  const costs = (r: unknown[], synced: Res | null = sync()) => {
    state.tables.video_costs = { data: r, error: null };
    if (synced) state.tables.video_costs_sync = synced;
  };
  const run = async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW_T });
    try {
      return (await glance()).spend;
    } finally {
      vi.useRealTimers();
    }
  };
  it("sums the priced rows of the last complete day, labelled with that date and the sync time, never 'today'", async () => {
    costs([{ quantity: 10, estimated_usd: 1.25 }, { quantity: 5, estimated_usd: 2 }]);
    const t = await run();
    expect(t.value).toBe("$3.25");
    expect(unescape(t.sub)).toBe("as of last sync today 01:00");
    expect(unescape(t.label)).toBe("Spent 16 Oct");
    expect(t.label).not.toMatch(/today/i);
  });
  it("the rows asked for are exactly that day: [16 Oct 00:00, 17 Oct 00:00) Tashkent, newest first, 1000-row guard", async () => {
    costs([{ quantity: 1, estimated_usd: 1 }]);
    await run();
    const q = rec.log.find((x) => x.table === "video_costs" && x.calls.some(([m]) => m === "lt"));
    expect(q).toBeTruthy();
    const call = (m: string) => q!.calls.find(([x]) => x === m)?.[1];
    expect(call("gte")).toEqual(["recorded_at", "2026-10-15T19:00:00.000Z"]);
    expect(call("lt")).toEqual(["recorded_at", "2026-10-16T19:00:00.000Z"]);
    expect(call("order")).toEqual(["recorded_at", { ascending: false }]);
    expect(call("limit")).toEqual([1000]);
  });
  it("a sync that ran earlier today still speaks for the day before it, not for 'today'", async () => {
    costs([{ quantity: 1, estimated_usd: 4 }], sync("2026-10-17T03:00:00.000Z")); // 08:00 Tashkent, 17 Oct
    const t = await run();
    expect(unescape(t.label)).toBe("Spent 16 Oct");
    expect(unescape(t.sub)).toBe("as of last sync today 08:00");
  });
  it("a stale mirror speaks for an older day, and says so", async () => {
    costs([{ quantity: 1, estimated_usd: 4 }], sync("2026-10-12T20:00:00.000Z"));
    const t = await run();
    expect(unescape(t.label)).toBe("Spent 12 Oct");
    expect(unescape(t.sub)).toContain("as of last sync 13 Oct 01:00");
  });
  it("under $1 it keeps three decimals, and a positive amount too small to show is '<$0.001', never $0.000", async () => {
    costs([{ quantity: 1, estimated_usd: 0.0123 }]);
    expect((await run()).value).toBe("$0.012");
    costs([{ quantity: 1, estimated_usd: 0.0002 }]);
    expect(unescape((await run()).value)).toBe("<$0.001");
  });
  it("some unpriced rows make it a floor and say so", async () => {
    costs([{ quantity: 10, estimated_usd: 1 }, { quantity: 5, estimated_usd: null }]);
    const t = await run();
    expect(t.value).toBe("$1.00");
    expect(unescape(t.sub)).toContain(en.ownerShell.gSpendPartial);
  });
  it("only unpriced rows: no figure, never $0.00, and no Retry for it", async () => {
    costs([{ quantity: 10, estimated_usd: null }]);
    const t = await run();
    expect(unescape(t.value)).toBe(en.common.unknown);
    expect(unescape(t.sub)).toContain(en.ownerShell.gSpendNotPriced);
  });
  it("no sync at all: unknown, 'updates nightly', no spend rows are even asked for", async () => {
    costs([{ quantity: 10, estimated_usd: 5 }], sync(null));
    const t = await run();
    expect(unescape(t.value)).toBe(en.common.unknown);
    expect(unescape(t.sub)).toBe(en.ownerShell.gSpendNightly);
    expect(rec.log.some((x) => x.table === "video_costs" && x.calls.some(([m]) => m === "lt"))).toBe(false);
  });
  it("a sync but no rows that day: 'no rows that day', not a measured $0.00", async () => {
    costs([]);
    const t = await run();
    expect(unescape(t.value)).toBe(en.common.unknown);
    expect(unescape(t.sub)).toContain(en.ownerShell.gSpendNoRows);
    expect(t.value).not.toContain("$");
  });
  it("a day that fills the read (1000 rows) says 'too many rows', not 'could not read'", async () => {
    costs(Array.from({ length: 1000 }, () => ({ quantity: 1, estimated_usd: 1 })));
    const t = await run();
    expect(unescape(t.sub)).toContain(en.ownerShell.gSpendTooMany);
    expect(unescape(t.sub)).not.toContain(en.common.couldNotRead);
  });
  it("a failed ledger read is unknown, could not read", async () => {
    state.tables.video_costs = FAIL;
    const t = await run();
    expect(unescape(t.value)).toBe(en.common.unknown);
    expect(unescape(t.sub)).toBe(en.common.couldNotRead);
  });
});

describe("Retry is offered only for a read that failed", () => {
  it("an owner with no balance feed, nothing synced and nothing priced sees no Retry bar", async () => {
    const html = renderToStaticMarkup(await CommandCenter());
    expect(html).not.toContain("data-read-error");
  });
  it("a failed read does", async () => {
    state.tables.worker_status = FAIL;
    expect(renderToStaticMarkup(await CommandCenter())).toContain("data-read-error");
  });
});

describe("the status chip never says healthy over a failed count", () => {
  it("the failed-count read failing makes the chip 'unreadable' even though the events list read fine", async () => {
    state.tables.system_events = rows([{ id: 1, ts: new Date().toISOString(), event: "x.completed", status: "completed", agent: "a" }]);
    state.tables["system_events#count"] = FAIL;
    const html = renderToStaticMarkup(await CommandCenter());
    expect(html).toContain(en.dashboard.unreadable);
    expect(html).not.toContain(en.dashboard.systemHealthy);
  });
  it("with every read working and an event recorded it is healthy (the control)", async () => {
    state.tables.system_events = rows([{ id: 1, ts: new Date().toISOString(), event: "x.completed", status: "completed", agent: "a" }], 0);
    const html = renderToStaticMarkup(await CommandCenter());
    expect(html).toContain(en.dashboard.systemHealthy);
  });
});

describe("what the page actually asks the database (recorded)", () => {
  const q = (table: string, pred: (calls: [string, unknown[]][]) => boolean) => rec.log.filter((x) => x.table === table && pred(x.calls));
  const call = (calls: [string, unknown[]][], m: string) => calls.find(([x]) => x === m)?.[1];
  it("the owner's reads carry the filters that make the figures true", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T08:53:00Z") });
    try {
      await glance();
    } finally {
      vi.useRealTimers();
    }
    // Alerts: no bot bookkeeping, warn/critical, last 24 h, a row limit
    const alerts = q("alert_events", (c) => c.some(([m]) => m === "not"));
    expect(alerts).toHaveLength(1);
    expect(call(alerts[0].calls, "not")).toEqual(["kind", "like", "operator.%"]);
    expect(call(alerts[0].calls, "in")).toEqual(["severity", ["warn", "critical"]]);
    expect(call(alerts[0].calls, "gte")?.[0]).toBe("at");
    expect(call(alerts[0].calls, "limit")).toEqual([500]);
    // Failed (24h): an exact head count of failed/error events since 24 h ago
    const failed = q("system_events", (c) => c.some(([m, a]) => m === "select" && JSON.stringify(a[1]) === JSON.stringify({ count: "exact", head: true })));
    expect(failed).toHaveLength(1);
    expect(call(failed[0].calls, "or")).toEqual(["status.ilike.failed,status.ilike.error"]);
    expect(call(failed[0].calls, "gte")).toEqual(["ts", "2026-10-16T08:53:00.000Z"]);
    // Published today: an exact head count since the OWNER's midnight (Tashkent 00:00 = 19:00 UTC the evening before)
    const published = q("videos", (c) => c.some(([m, a]) => m === "gte" && a[0] === "published_at"));
    expect(published).toHaveLength(1);
    expect(call(published[0].calls, "gte")).toEqual(["published_at", "2026-10-16T19:00:00.000Z"]);
    expect(JSON.stringify(call(published[0].calls, "select")?.[1])).toBe(JSON.stringify({ count: "exact", head: true }));
    // The freshness read of the cost ledger: the newest synced_at
    const fresh = q("video_costs", (c) => c.some(([m, a]) => m === "select" && a[0] === "synced_at"));
    expect(fresh).toHaveLength(1);
    expect(call(fresh[0].calls, "order")).toEqual(["synced_at", { ascending: false }]);
    expect(call(fresh[0].calls, "limit")).toEqual([1]);
    // the alert read has an ORDER BY under its limit
    expect(call(alerts[0].calls, "order")).toEqual(["at", { ascending: false }]);
  });
  it("at the alert row limit the tile says '500+' (a floor)", async () => {
    state.tables.alert_events = rows(Array.from({ length: 500 }, (_, i) => ({ kind: "upload.failed", title: `t${i}`, at: new Date().toISOString() })));
    expect((await glance()).alerts.value).toBe("500+");
  });
});
