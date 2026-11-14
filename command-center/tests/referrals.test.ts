import { describe, expect, it } from "vitest";
import {
  coerceMyReferrals,
  coerceReferralAdmin,
  coerceReferralTerms,
  hasReferrals,
  parseReferralSettings,
  telegramShareUrl,
} from "@/lib/referrals";
import { dictionaries } from "@/lib/i18n";

/**
 * The referral programme's pure half (migration 0165). What would break without these: a missing count read as 0 (a person
 * told "nothing earned" when the read went wrong), a malformed link token shown and shared, more referrals "due" than are on
 * hold, the operator's form sending a reward above the payment that earns it or a hold too short to see a refund, the Telegram
 * link breaking on the link's own characters, and a translation that drops or invents a number the database fills in.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const mine = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  credits: 200,
  min_credits: 1000,
  hold_days: 30,
  qualify_days: 60,
  monthly_cap: 10,
  link: { token: TOKEN, created_at: "2026-11-01T00:00:00Z" },
  joined: 3,
  held: 1,
  due: 0,
  next_release_on: "2026-12-14",
  org: { id: "org-1", name: "Ana Studio" },
  claw_owed: 0,
  paid: 1,
  earned: 200,
  paid_this_month: 1,
  clawed: 0,
  clawed_credits: 0,
  void: 1,
  milestone_credits: null,
  ...over,
});

describe("my_referrals()", () => {
  it("reads the database's counts and numbers as they are", () => {
    const got = coerceMyReferrals(mine({ credits: "250.00", earned: "500.00" }));
    expect(got).toMatchObject({ enabled: true, credits: 250, minCredits: 1000, holdDays: 30, joined: 3, held: 1, paid: 1, earned: 500, void: 1 });
    expect(got?.link).toEqual({ token: TOKEN, createdAt: "2026-11-01T00:00:00Z" });
    expect(got?.milestoneCredits).toBeNull();
  });

  it("is unknown, never zero, when a count or a number is missing or not a count", () => {
    for (const key of ["joined", "held", "due", "paid", "paid_this_month", "clawed", "void", "earned", "clawed_credits", "claw_owed", "credits", "hold_days", "enabled"]) {
      const raw = mine();
      delete (raw as Record<string, unknown>)[key];
      expect(coerceMyReferrals(raw), key).toBeNull();
    }
    expect(coerceMyReferrals(mine({ joined: -1 }))).toBeNull();
    expect(coerceMyReferrals(mine({ held: 1.5 }))).toBeNull();
    expect(coerceMyReferrals(mine({ next_release_on: "2026-12-14T10:00:00Z" }))).toBeNull();
    expect(coerceMyReferrals(mine({ org: { id: 1 } }))).toBeNull();
    expect(coerceMyReferrals(null)).toBeNull();
    expect(coerceMyReferrals("x")).toBeNull();
  });

  it("refuses a link whose token is not the database's shape, and accepts no link", () => {
    expect(coerceMyReferrals(mine({ link: { token: "not-a-token" } }))).toBeNull();
    expect(coerceMyReferrals(mine({ link: "x" }))).toBeNull();
    expect(coerceMyReferrals(mine({ link: null }))?.link).toBeNull();
  });

  it("never shows more referrals past their hold than are on hold", () => {
    expect(coerceMyReferrals(mine({ held: 1, due: 4 }))?.due).toBe(1);
  });

  it("has referrals once anyone joined, and not before", () => {
    expect(hasReferrals(coerceMyReferrals(mine())!)).toBe(true);
    expect(hasReferrals(coerceMyReferrals(mine({ joined: 0, held: 0, paid: 0, void: 0, clawed: 0 }))!)).toBe(false);
  });
});

describe("referral_terms() and referral_admin()", () => {
  const terms = { enabled: false, credits: 200, min_credits: 1000, hold_days: 30, qualify_days: 60, monthly_cap: 10, daily_cap: 50, link_hourly_cap: 10, new_account_days: 3, updated_at: "2026-11-14T08:00:00Z" };

  it("reads the public numbers, and nothing without all of them", () => {
    expect(coerceReferralTerms(terms)).toMatchObject({ enabled: false, credits: 200, dailyCap: 50, linkHourlyCap: 10, updatedAt: "2026-11-14T08:00:00Z" });
    expect(coerceReferralTerms({ ...terms, updated_at: null })?.updatedAt).toBeNull();
    expect(coerceReferralTerms({ ...terms, daily_cap: undefined })).toBeNull();
    expect(coerceReferralTerms({ ...terms, credits: 0 })).toBeNull();
  });

  it("reads the operator's counts, and nothing when one is missing", () => {
    const admin = {
      ...terms, milestone_enabled: false, links: 4, joins: 9, held: 2, due: 1, paid: 3, paid_today: 1, credits_month: "600.00",
      credits_total: 800, void_refunded: 1, void_same_payer: 0, void_member: 0, clawed: 1, claw_owed: 50, milestone_rewards: 0,
      links_open: true, schedule: false, started_at: "2026-11-14T08:00:00Z", runs_failed_24h: 0, reversed_by_event: 0,
      last_run: { at: "2026-11-14T09:00:00Z", links: 3, changed: 1, failed: 0, error: null },
    };
    expect(coerceReferralAdmin(admin)).toMatchObject({ milestoneEnabled: false, links: 4, creditsMonth: 600, clawOwed: 50, schedule: false, lastRun: { links: 3 } });
    expect(coerceReferralAdmin({ ...admin, paid: null })).toBeNull();
    expect(coerceReferralAdmin({ ...admin, milestone_enabled: "no" })).toBeNull();
  });
});

describe("the operator's form", () => {
  const ok = { credits: "200", minCredits: "1000", holdDays: "30", qualifyDays: "60", monthlyCap: "10", dailyCap: "50" };

  it("sends the numbers inside the database's ranges", () => {
    expect(parseReferralSettings(ok)).toEqual({ credits: 200, minCredits: 1000, holdDays: 30, qualifyDays: 60, monthlyCap: 10, dailyCap: 50 });
    expect(parseReferralSettings({ ...ok, dailyCap: "0" })?.dailyCap).toBe(0);
  });

  it("refuses a reward above the payment that earns it, a hold under a week and every other out-of-range number", () => {
    for (const bad of [
      { credits: "1001" },
      { credits: "0" },
      { holdDays: "6" },
      { holdDays: "181" },
      { qualifyDays: "0" },
      { monthlyCap: "0" },
      { dailyCap: "10001" },
      { minCredits: "abc" },
      { credits: "1.234" },
    ]) {
      expect(parseReferralSettings({ ...ok, ...bad }), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("sharing", () => {
  it("puts the link and the text in Telegram's own share address, encoded", () => {
    const url = telegramShareUrl(`https://example.com/i/${TOKEN}`, "Join & make videos?");
    expect(url).toBe(`https://t.me/share/url?url=${encodeURIComponent(`https://example.com/i/${TOKEN}`)}&text=Join%20%26%20make%20videos%3F`);
  });
});

describe("the referral copy in en, ru and uz", () => {
  type Tree = { [k: string]: string | readonly string[] | Tree };
  function walk(node: Tree, path: string, out: Map<string, string>) {
    for (const [k, v] of Object.entries(node)) {
      const p = `${path}.${k}`;
      if (typeof v === "string") out.set(p, v);
      else if (Array.isArray(v)) v.forEach((s, i) => out.set(`${p}[${i}]`, s as string));
      else walk(v as Tree, p, out);
    }
    return out;
  }
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("has every string in all three languages, each filling the same numbers", () => {
    const en = walk(dictionaries.en.referral as unknown as Tree, "referral", new Map());
    for (const loc of ["ru", "uz"] as const) {
      const other = walk(dictionaries[loc].referral as unknown as Tree, "referral", new Map());
      expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, text] of en) {
        expect(other.get(key)?.trim(), `${loc} ${key}`).toBeTruthy();
        expect(vars(other.get(key) ?? ""), `${loc} ${key}`).toEqual(vars(text));
      }
    }
  });

  it("promises no income", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const all = [...walk(dictionaries[loc].referral as unknown as Tree, "referral", new Map()).values()].join(" ");
      expect(all).not.toMatch(/\$\s?\d|passive income|пассивн|passiv daromad|per month you|в месяц вы заработ/i);
    }
  });
});
