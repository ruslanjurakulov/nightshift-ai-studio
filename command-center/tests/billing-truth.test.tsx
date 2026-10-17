/**
 * The Billing page never shows a failed read as a number. Before: a failed `video_costs` read became `?? []`, which
 * computed to "$0 burn" and "not in use" (the old "lasts never"); a negative ledger became "0 days"; Anthropic and OpenAI,
 * whose spend is not recorded at all, read as "used nothing"; a provider that tops itself up got a days-left alarm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { EMPTY, FAILED, esc, supabaseStub, type StubResult } from "./helpers/supabaseStub";

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
async function page(tables: Tables): Promise<string> {
  state.client = supabaseStub((name) => tables[name] ?? EMPTY);
  return renderToStaticMarkup(await BillingPage());
}
const ok = (data: unknown[]): StubResult => ({ data, error: null });

beforeEach(() => {
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
  it("a ledger bigger than the ceiling prints the 'cut at N rows' note", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ unit: "tts_characters", quantity: 1, stage: "voice", recorded_at: iso(1 + i / 1000), video_id: `v${i}`, channel_id: "c" }));
    const html = await page({ video_costs: ok(full) });
    expect(html).toMatch(/cut at 20,?000 rows/);
  });
  it("a short ledger prints no note", async () => {
    const html = await page({ video_costs: ok([]) });
    expect(html).not.toMatch(/cut at/);
  });
});

