/**
 * /pricing hands the plan finder (a Client Component) only the final credits per unit: `{ unit, credits }`. The page's props
 * are serialized into its RSC payload, which any visitor downloads, so a margin or a note in them is published.
 *
 * What would break without this: the page passing the price list itself (`"video_minute":{"creditsPerUnit":60,"margin":0,
 * "note":null,…}`, what it shipped before), which is harmless at margin 0 and publishes the markup the day the operator sets
 * one. And: the numbers changing when the margin is folded in on the server instead of in the browser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePrices, chargedPrices, estimateRunCredits, type PriceMap } from "@/lib/credits";
import { youtubeVideoCredits, type PlanFinderData } from "@/lib/plan-finder";

vi.mock("server-only", () => ({}));

const state: { list: PriceMap; publicList: PriceMap; signedIn: boolean; props: Record<string, unknown> | null } = {
  list: {},
  publicList: {},
  signedIn: true,
  props: null,
};

vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ t: en, locale: "en" }) };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.signedIn ? { id: "u1" } : null } }) } }),
}));
vi.mock("@/lib/server/credits", () => ({
  readCreditPrices: async () => ({ supported: true, failed: false, prices: state.list }),
}));
vi.mock("@/lib/server/payments", () => ({ sitePricing: () => ({}), sitePlanMatrix: () => [] }));
vi.mock("@/lib/server/public-catalog", () => ({ readPublicPlanCatalog: async () => ({ state: "unsupported" }) }));
vi.mock("@/lib/server/plans", () => ({ readPlanCatalog: async () => ({ state: "unsupported" }), planValue: () => null }));
vi.mock("@/lib/creative/registry", () => ({ readSellableModels: async () => ({ status: "failed" }) }));
vi.mock("@/lib/server/model-discovery", () => ({ readCustomerModels: async () => ({ status: "failed" }) }));
vi.mock("@/lib/server/api-prices", () => ({ readPublicApiPrices: async () => null }));
vi.mock("@/lib/server/referrals", () => ({ readReferralTerms: async () => ({ state: "unsupported" }) }));
vi.mock("@/lib/server/public-rates", () => ({
  readPublicCreditRates: async () => null,
  readPublicVideoPrices: async () => state.publicList,
}));
vi.mock("@/lib/landing", () => ({ moneyAnchor: () => null, runtimeSiteOrigin: () => "https://x.test", shareMetadata: () => ({}) }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: async () => false }));
vi.mock("@/lib/server/owner-view", () => ({ viewingAsOperator: async () => false }));
vi.mock("@/components/legal/PublicShell", () => ({ PublicShell: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/pricing/PricingView", () => ({
  PricingView: (props: Record<string, unknown>) => {
    state.props = props;
    return null;
  },
}));

async function finderProps(): Promise<PlanFinderData> {
  state.props = null;
  const { default: PricingPage } = await import("../app/pricing/page");
  // The page's element tree: PublicShell (mocked to its children) around PricingView. Calling the shell's child element's
  // type with its props is what React would do; it records the props the browser would be sent.
  const tree = (await PricingPage()) as { props: { children: { type: (p: unknown) => unknown; props: Record<string, unknown> } } };
  const view = tree.props.children;
  view.type(view.props);
  expect(state.props).not.toBeNull();
  return state.props!.finder as PlanFinderData;
}

// The operator's base list as credit_prices holds it: a margin on the per-minute rate and on the flat floor, and a note. A
// member never reads this (credit_rates(), 0084, folds the margin), but a page must not be one refactor away from passing it.
const BASE = parsePrices([
  { unit: "video_minute", credits_per_unit: 10, margin: 0.25, note: "internal: vendor cost x2", updated_at: "2026-11-03T10:00:00Z" },
  { unit: "job_minimum", credits_per_unit: 30, margin: 0.5, note: "floor", updated_at: "2026-10-01T10:00:00Z" },
  { unit: "tts_characters", credits_per_unit: 0.002, margin: 0.2 },
]);

describe("/pricing: the plan finder's props carry the final credits only", () => {
  beforeEach(() => {
    state.signedIn = true;
    state.list = BASE;
    state.publicList = {};
  });

  it("no margin, no note, no date, no other unit: { unit, credits } for the two units a video is quoted from", async () => {
    const finder = await finderProps();
    const wire = JSON.stringify(finder.video);
    expect(wire).not.toMatch(/margin|note|updatedAt|creditsPerUnit|tts_characters/);
    expect(finder.video).toEqual({ video_minute: { unit: "video_minute", credits: 12.5 }, job_minimum: { unit: "job_minimum", credits: 30 } });
    // The date is still said, worked out on the server from the list's own updated_at.
    expect(finder.videoStamp).toEqual({ kind: "set", at: "2026-11-03T10:00:00Z" });
  });

  it("prints the same quote Run now holds for the list (the numbers did not move)", async () => {
    const finder = await finderProps();
    for (const seconds of [60, 300, 420, 3600]) {
      const hold = estimateRunCredits({ prices: chargedPrices(BASE), durationS: seconds, videos: [] }).credits;
      expect(youtubeVideoCredits(finder.video, seconds), `${seconds}s`).toBe(hold);
    }
  });

  it("signed out: the public pair, shaped the same way", async () => {
    state.signedIn = false;
    state.publicList = parsePrices([{ unit: "video_minute", credits_per_unit: 12.5 }, { unit: "job_minimum", credits_per_unit: 30 }]);
    const finder = await finderProps();
    expect(JSON.stringify(finder.video)).not.toMatch(/margin|note|updatedAt/);
    expect(finder.video).toEqual({ video_minute: { unit: "video_minute", credits: 12.5 }, job_minimum: { unit: "job_minimum", credits: 30 } });
    expect(finder.videoStamp?.kind).toBe("read");
  });
});
