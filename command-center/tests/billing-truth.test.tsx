/**
 * The Billing page never shows a failed read as a number. Before: a failed `video_costs` read became `?? []`, which
 * computed to "$0 burn" and "not in use" (the old "lasts never"); a negative ledger became "0 days"; Anthropic and OpenAI,
 * whose spend is not recorded at all, read as "used nothing"; a provider that tops itself up got a days-left alarm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { EMPTY, FAILED, esc, type StubResult } from "./helpers/supabaseStub";
import { arg, has as called, recordingSupabase, type Call, type Res } from "./helpers/recordingStub";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/billing" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client, getUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope } = await import("../lib/channels");
  const scope = unscopedScope();
  return { getChannelContext: async () => ({ selection: scope.selection, channels: [], scope }) };
});
vi.mock("@/lib/auth/org-roles", () => ({ guardOperatorPage: async () => true }));
vi.mock("@/lib/server/github-secrets", () => ({ isGithubConfigured: false, listConfiguredSecretNames: async () => [] }));

const { default: BillingPage } = await import("../app/(app)/[channel]/billing/page");

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const has = (html: string, text: string) => html.includes(esc(text));

type Tables = Record<string, StubResult>;
/** What a `video_costs` page request resolves to; defaults to the table's scripted answer. */
let costPage: ((calls: Call[]) => Res) | null = null;
let stub = recordingSupabase(() => ({ data: [], error: null }));
async function page(tables: Tables): Promise<string> {
  stub = recordingSupabase((table, calls) => {
    if (table === "video_costs" && costPage) return costPage(calls);
    return (tables[table] as Res | undefined) ?? (EMPTY as Res);
  });
  state.client = stub.client;
  return renderToStaticMarkup(await BillingPage());
}
const ok = (data: unknown[]): StubResult => ({ data, error: null });

beforeEach(() => {
  costPage = null;
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

/** What the "Lasts" line of a provider card says. */
function lasts(html: string, name: string): string {
  const text = card(html, name).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = text.match(new RegExp(`${en.billing.lasts}\\s+(.*?)\\s+(Price per|Save)`));
  expect(m, `${name} lasts`).toBeTruthy();
  return m![1].trim();
}

/** The text inside the card of one provider (from its heading to the next heading). */
function card(html: string, name: string): string {
  const i = html.indexOf(`>${name}</h3>`);
  expect(i, `${name} card`).toBeGreaterThan(-1);
  const j = html.indexOf("</li>", i);
  return html.slice(i, j);
}

describe("a failed read is unknown, never $0 and never 'not in use'", () => {
  it("spend ledger failed: the page says so, every card is unknown, nothing computes to zero", async () => {
    const html = await page({ video_costs: FAILED, provider_topups: ok([{ provider: "kling", amount_usd: 50, paid_at: iso(5) }]) });
    expect(has(html, en.ownerTruth.billingReadFailed)).toBe(true);
    expect(html).toContain("data-read-error");
    expect(has(html, en.billing.never)).toBe(false);
    // the 30-day figure is "unknown", not $0
    expect(html).toContain(`>${en.common.unknown}<`);
    expect(lasts(html, "Kling")).toBe(en.billing.unknown);
    // no dollar total of nothing: the planner total is a dash while no provider has a price
    expect(html).not.toMatch(/\$0\.00/);
  });
  it("prices failed: usage in dollars is unknown too", async () => {
    const html = await page({ provider_billing_settings: FAILED, video_costs: ok([{ unit: "video_gen_clips", quantity: 3, stage: "broll:kling", recorded_at: iso(1), video_id: "v1", channel_id: "c" }]) });
    expect(has(html, en.ownerTruth.billingReadFailed)).toBe(true);
    expect(has(card(html, "Kling"), en.billing.unknown)).toBe(true);
  });
  it("snapshots failed: ElevenLabs panel says could not read, not 'no data yet'", async () => {
    const html = await page({ provider_balances: FAILED });
    expect(has(html, en.ownerTruth.billingReadFailed)).toBe(true);
    expect(has(html, en.billing.elevenNoData)).toBe(false);
    expect(has(html, en.common.couldNotRead)).toBe(true);
  });
  it("everything readable but empty: no error banner, and still no 'not in use' for a balance nobody knows", async () => {
    const html = await page({});
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.billing.never)).toBe(false);
    expect(has(card(html, "Kling"), en.billing.unknown)).toBe(true);
  });
});

describe("days left", () => {
  const kling = { unit: "video_gen_clips", quantity: 10, stage: "broll:kling", recorded_at: iso(2), video_id: "v1", channel_id: "c" };
  it("a negative ledger is unknown, not '0 days'", async () => {
    const html = await page({
      video_costs: ok([kling, { ...kling, quantity: 100, recorded_at: iso(1), video_id: "v2" }]),
      provider_billing_settings: ok([{ provider: "kling", usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 }]),
      provider_topups: ok([{ provider: "kling", amount_usd: 20, paid_at: iso(5) }]),
    });
    expect(lasts(html, "Kling")).toBe(en.billing.unknown);
  });
  it("Anthropic and OpenAI say 'not tracked', never 'not in use'", async () => {
    const html = await page({});
    for (const name of ["Anthropic Claude", "OpenAI"]) {
      expect(lasts(html, name)).toBe(en.ownerTruth.notTracked);
      expect(has(card(html, name), en.billing.never)).toBe(false);
    }
  });
  it("a provider that tops itself up gets no days-left alarm", async () => {
    const html = await page({
      video_costs: ok([kling]),
      provider_billing_settings: ok([{ provider: "kling", usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: true, auto_recharge_on_provider: true, low_balance_days: 3 }]),
      provider_topups: ok([{ provider: "kling", amount_usd: 5, paid_at: iso(5) }]),
    });
    expect(lasts(html, "Kling")).toBe(en.ownerTruth.autoRechargeOn);
  });
  it("a young ledger is averaged over its own age", async () => {
    const html = await page({
      video_costs: ok([{ unit: "tts_characters", quantity: 30000, stage: "voice", recorded_at: iso(3), video_id: "v1", channel_id: "c" }]),
      provider_billing_settings: ok([{ provider: "elevenlabs", usd_per_unit: 0.3, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 }]),
      provider_topups: ok([{ provider: "elevenlabs", amount_usd: 100, paid_at: iso(3) }]),
    });
    // $0.30 per 1000 credits: 30,000 in 3 days = 10,000/day = $3/day. Averaged over a fixed 30 days it would be $0.30/day.
    expect(card(html, "ElevenLabs")).toContain("$3.00");
  });
});

describe("the spend read is paged and says when it was cut", () => {
  /** A ledger of `n` rows with unique ids, answering exactly the range asked (like PostgREST with a big max_rows). */
  const ledger = (n: number) => (calls: Call[]): Res => {
    const [from, to] = (calls.find(([m]) => m === "range")?.[1] ?? [0, 499]) as [number, number];
    const data = [];
    for (let i = from; i <= Math.min(to, n - 1); i++) data.push({ id: n - i, unit: "tts_characters", quantity: 1, stage: "voice", recorded_at: iso(1 + i / 100000), video_id: `v${i}`, channel_id: "c", synced_at: iso(0.1) });
    return { data, error: null, count: n };
  };
  it("a ledger bigger than the ceiling (20,000 rows) prints the 'cut at N rows' note, with the rows it did read", async () => {
    costPage = ledger(30000);
    const html = await page({});
    expect(html).toMatch(/cut at 20,000 rows/);
  });
  it("a ledger of 1,800 rows is read whole in four pages (500, 500, 500, 300) with no cut note", async () => {
    costPage = ledger(1800);
    const html = await page({});
    expect(html).not.toMatch(/cut at/);
    const pages = stub.of("video_costs", "range");
    expect(pages.map((q) => arg(q, "range"))).toEqual([0, 500, 1000, 1500]);
    // the exact total is asked for on the first page only (a count is a scan)
    expect(pages.map((q) => JSON.stringify(q.calls.find(([m]) => m === "select")?.[1][1] ?? null))).toEqual([JSON.stringify({ count: "exact" }), "null", "null", "null"]);
  });
  it("a short ledger prints no note", async () => {
    const html = await page({ video_costs: ok([]) });
    expect(html).not.toMatch(/cut at/);
  });
});

describe("what the page asks the database (recorded)", () => {
  it("video_costs: newest first with the id tie-break, 500 a page with the exact count, since 90 days", async () => {
    await page({});
    const [first] = stub.of("video_costs");
    expect(called(first, "order", "recorded_at", { ascending: false })).toBe(true);
    expect(called(first, "order", "id", { ascending: false })).toBe(true);
    expect(first.calls.find(([m]) => m === "range")?.[1]).toEqual([0, 499]);
    expect(JSON.stringify(first.calls.find(([m]) => m === "select")?.[1][1])).toBe(JSON.stringify({ count: "exact" }));
    expect(String(first.calls.find(([m]) => m === "select")?.[1][0])).toContain("id,");
    const since = Date.parse(String(arg(first, "gte", 1)));
    expect(Math.abs(since - (NOW - 90 * 86_400_000))).toBeLessThan(2000);
  });
  it("it reads back to the earliest top-up (so its balance is true)", async () => {
    await page({ provider_topups: ok([{ provider: "kling", amount_usd: 50, paid_at: iso(120) }]) });
    const since = Date.parse(String(arg(stub.of("video_costs")[0], "gte", 1)));
    expect(Math.abs(since - (NOW - 120 * 86_400_000))).toBeLessThan(2000);
  });
  it("but never past 180 days, and says so; the balance that depends on the older top-up is unknown", async () => {
    const html = await page({
      provider_topups: ok([{ provider: "kling", amount_usd: 50, paid_at: iso(300) }]),
      provider_billing_settings: ok([{ provider: "kling", usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 }]),
    });
    const since = Date.parse(String(arg(stub.of("video_costs")[0], "gte", 1)));
    expect(Math.abs(since - (NOW - 180 * 86_400_000))).toBeLessThan(2000);
    expect(has(html, en.ownerTruth.spendHorizon.replace("{n}", "180"))).toBe(true);
    expect(lasts(html, "Kling")).toBe(en.billing.unknown);
  });
});

describe("the ledger is only as fresh as the nightly mirror", () => {
  const row = (syncedDaysAgo: number) => ({ id: 1, unit: "video_gen_clips", quantity: 3, stage: "broll:kling", recorded_at: iso(1), video_id: "v1", channel_id: "c", synced_at: iso(syncedDaysAgo) });
  it("says when it last synced", async () => {
    const html = await page({ video_costs: ok([row(0.2)]) });
    expect(html).toMatch(/last sync (today|yesterday) \d\d:\d\d/);
  });
  it("no rows at all is 'no rows yet', never a measured $0.00", async () => {
    const html = await page({ video_costs: ok([]) });
    expect(has(html, en.ownerTruth.noRowsYet)).toBe(true);
    expect(html).not.toMatch(/\$0\.00/);
  });
  it("a young provider's figures are labelled with their own window ('last 2 days'), not 30", async () => {
    const html = await page({
      video_costs: ok([
        { id: 2, unit: "tts_characters", quantity: 1, stage: "voice", recorded_at: iso(25), video_id: "v0", channel_id: "c", synced_at: iso(0.2) },
        { id: 1, unit: "video_gen_clips", quantity: 10, stage: "broll:kling", recorded_at: iso(2), video_id: "v1", channel_id: "c", synced_at: iso(0.2) },
      ]),
      provider_billing_settings: ok([{ provider: "kling", usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 }]),
    });
    expect(has(card(html, "Kling"), en.ownerTruth.usedLastDays.replace("{n}", "2"))).toBe(true);
    // 10 clips in 2 days at $1 is $5 a day, not $0.33
    expect(card(html, "Kling")).toContain("$5.00");
  });
});

describe("the headline", () => {
  const settings = (...ids: string[]) =>
    ok(ids.map((provider) => ({ provider, usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 })));
  const full = (stage: string, n: number, d: number, id: number) => ({ id, unit: "video_gen_clips", quantity: n, stage, recorded_at: iso(d), video_id: `v${id}`, channel_id: "c", synced_at: iso(0.1) });
  const stat = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("mixed windows (one provider with 30 days, one with 2): it is a 'pace', never 'last 30 days', and the shortest window rules", async () => {
    const html = await page({
      video_costs: ok([full("broll:minimax", 30, 29, 1), full("broll:minimax", 30, 1, 2), full("broll:kling", 10, 2, 3), full("broll:kling", 5, 0.5, 4)]),
      provider_billing_settings: settings("minimax", "kling"),
    });
    const text = stat(html);
    expect(text).toContain(en.ownerTruth.spendPace);
    expect(text).not.toContain(en.billing.statBurn30);
    expect(text).toContain(en.ownerTruth.basedOnDays.replace("{n}", "2"));
  });
  it("every contributing provider with a full 30-day window keeps 'Spend, last 30 days'", async () => {
    const html = await page({
      video_costs: ok([full("broll:minimax", 30, 29.9, 1), full("broll:minimax", 30, 1, 2), full("broll:kling", 10, 29.9, 3), full("broll:kling", 5, 0.5, 4)]),
      provider_billing_settings: settings("minimax", "kling"),
    });
    expect(stat(html)).toContain(en.billing.statBurn30);
    expect(stat(html)).not.toContain(en.ownerTruth.spendPace);
  });
  it("a single day of history reads 'last 1 day', not 'last 1 days'", async () => {
    const html = await page({ video_costs: ok([full("broll:kling", 5, 0.3, 1)]), provider_billing_settings: settings("kling") });
    expect(has(html, en.ownerTruth.usedLastDay.replace("{n}", "1"))).toBe(true);
    expect(stat(html)).not.toMatch(/last 1 days/);
  });
  it("'Nothing is running out' only when every provider is known not to be", async () => {
    const html = await page({});
    const text = stat(html);
    expect(text).not.toContain(en.billing.statFirstOutNone);
    expect(text).toContain(en.billing.statFirstOut);
  });
  it("...and says it when they all are (never used with a balance, tops itself up, not tracked)", async () => {
    const providers = ["elevenlabs", "gemini", "minimax", "kling", "veo", "seedance", "wan", "higgsfield", "leonardo"];
    const html = await page({
      video_costs: ok([full("broll:other", 1, 1, 1)]),
      provider_billing_settings: ok(providers.map((provider) => ({ provider, usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: true, auto_recharge_on_provider: true, low_balance_days: 3 }))),
    });
    expect(stat(html)).toContain(en.billing.statFirstOutNone);
  });
});

describe("a ledger that was cut: the window never reaches before the oldest row read", () => {
  it("burn is averaged only over what was read", async () => {
    // 30,000 rows of one clip each; the newest 20,000 are read, covering only the last ~2 days of a long ledger.
    const total = 30000;
    costPage = (calls) => {
      const [from, to] = (calls.find(([m]) => m === "range")?.[1] ?? [0, 499]) as [number, number];
      const data = [];
      for (let i = from; i <= Math.min(to, total - 1); i++) data.push({ id: total - i, unit: "video_gen_clips", quantity: 1, stage: "broll:kling", recorded_at: new Date(NOW - (i / 10000) * 86_400_000).toISOString(), video_id: `v${i}`, channel_id: "c", synced_at: iso(0.1) });
      return { data, error: null, count: total };
    };
    const html = await page({
      provider_billing_settings: ok([{ provider: "kling", usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 }]),
    });
    // 20,000 clips over the ~2 days actually read = about 10,000 a day at $1 (not 20,000 / 30 = 667)
    expect(card(html, "Kling")).toMatch(/\$10,0\d\d\.\d\d\/day/);
  });
  it("a provider with an old top-up and no usage in the part that was read is labelled with the window actually read (2 days), not 30", async () => {
    const total = 30000;
    costPage = (calls) => {
      const [from, to] = (calls.find(([m]) => m === "range")?.[1] ?? [0, 499]) as [number, number];
      const data = [];
      for (let i = from; i <= Math.min(to, total - 1); i++) data.push({ id: total - i, unit: "tts_characters", quantity: 1, stage: "voice", recorded_at: new Date(NOW - (i / 10000) * 86_400_000).toISOString(), video_id: `v${i}`, channel_id: "c", synced_at: iso(0.1) });
      return { data, error: null, count: total };
    };
    const html = await page({
      provider_topups: ok([{ provider: "kling", amount_usd: 50, paid_at: iso(100) }]),
      provider_billing_settings: ok([{ provider: "kling", usd_per_unit: 1, include_in_bulk: true, card_saved_on_provider: false, auto_recharge_on_provider: false, low_balance_days: 3 }]),
    });
    expect(has(card(html, "Kling"), en.ownerTruth.usedLastDays.replace("{n}", "2"))).toBe(true);
  });
});
