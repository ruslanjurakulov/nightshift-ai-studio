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

const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ tables: {} as Record<string, unknown> }));

type Res = { data: unknown; error: unknown; count?: number | null };
const FAIL: Res = { data: null, error: { message: "boom", code: "XX000" }, count: null };
const rows = (data: unknown[], count?: number): Res => ({ data, error: null, count: count ?? data.length });
const HANG = Symbol("hang");

function builder(result: Res | typeof HANG): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        if (result === HANG) return () => undefined;
        return (res: (v: Res) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      }
      return () => q;
    },
    apply: () => q,
  });
  return q;
}

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => builder((state.tables[table] as Res) ?? { data: [], error: null, count: 0 }) }),
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
  [en.ownerShell.gSpendToday]: "spend",
  [en.ownerShell.gBalance]: "balance",
  [en.ownerShell.gFailed]: "errors",
  [en.ownerShell.gWaiting]: "waiting",
  [en.ownerShell.gAlerts]: "alerts",
  [en.ownerShell.gWorkers]: "workers",
  [en.dashboard.publishedToday]: "videos",
  [en.dashboard.activeAgents]: "agents",
};

async function glance(): Promise<Record<string, { value: string; sub: string; tone: string }>> {
  const html = renderToStaticMarkup(await CommandCenter());
  const section = html.slice(html.indexOf("data-owner-glance"));
  const end = section.indexOf("</section>");
  const items = section.slice(0, end).split("<li ").slice(1);
  const out: Record<string, { value: string; sub: string; tone: string }> = {};
  for (const li of items) {
    const spans = [...li.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    out[KEY_OF[unescape(spans[0] ?? "")] ?? spans[0] ?? "?"] = { value: spans[1] ?? "", sub: spans[2] ?? "", tone: li.match(/border-color:([^;"]*)/)?.[1] ?? "" };
  }
  return out;
}

beforeEach(() => {
  state.tables = {};
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

describe("Spent today", () => {
  const costs = (rows: unknown[]) => {
    state.tables.video_costs = { data: rows, error: null };
  };
  it("sums the priced rows of today", async () => {
    costs([{ quantity: 10, estimated_usd: 1.25 }, { quantity: 5, estimated_usd: 2 }]);
    const t = (await glance()).spend;
    expect(t.value).toBe("$3.25");
    expect(t.sub).toBe("");
  });
  it("some unpriced rows make it a floor and say so", async () => {
    costs([{ quantity: 10, estimated_usd: 1 }, { quantity: 5, estimated_usd: null }]);
    const t = (await glance()).spend;
    expect(t.value).toBe("$1.00");
    expect(unescape(t.sub)).toBe(en.ownerShell.gSpendPartial);
  });
  it("only unpriced rows: no figure, never $0.00", async () => {
    costs([{ quantity: 10, estimated_usd: null }]);
    const t = (await glance()).spend;
    expect(unescape(t.value)).toBe(en.common.unknown);
    expect(unescape(t.sub)).toBe(en.ownerShell.gSpendNotPriced);
  });
  it("a failed ledger read is unknown", async () => {
    state.tables.video_costs = FAIL;
    expect(unescape((await glance()).spend.value)).toBe(en.common.unknown);
  });
});
