import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import {
  coerceInviteAdmin,
  coerceMyInvite,
  dailyExposure,
  inviteBlock,
  inviteUrl,
  isInviteNotice,
  normalizeInviteToken,
  parseInviteSettings,
} from "../lib/friend-invites";

const TOKEN = "0123456789abcdef0123456789abcdef";
const mine = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  required: 5,
  reward: 100,
  link: { token: TOKEN, created_at: "2026-10-01T00:00:00Z", org_id: "o" },
  joined: 2,
  paid: false,
  credits_paid: null,
  pending: false,
  ...over,
});

describe("the token", () => {
  it("is 32 hex characters, either case, and nothing else", () => {
    expect(normalizeInviteToken(TOKEN)).toBe(TOKEN);
    expect(normalizeInviteToken(` ${TOKEN.toUpperCase()} `)).toBe(TOKEN);
    for (const bad of ["", "abc", TOKEN + "0", TOKEN.slice(1), "g".repeat(32), `${TOKEN}\n/x`, null, undefined, 5]) {
      expect(normalizeInviteToken(bad)).toBeNull();
    }
  });
  it("makes a link on the site's own origin, with no double slash", () => {
    expect(inviteUrl("https://nightshift.test/", TOKEN)).toBe(`https://nightshift.test/i/${TOKEN}`);
  });
  it("only two fixed notices exist, so no text from a URL is ever shown", () => {
    expect(isInviteNotice("invalid")).toBe(true);
    expect(isInviteNotice("existing")).toBe(true);
    expect(isInviteNotice("<script>")).toBe(false);
    expect(isInviteNotice(undefined)).toBe(false);
  });
});

describe("what the owner is shown", () => {
  it("reads the database's answer", () => {
    expect(coerceMyInvite(mine())).toEqual({
      enabled: true,
      required: 5,
      reward: 100,
      link: { token: TOKEN, createdAt: "2026-10-01T00:00:00Z" },
      joined: 2,
      paid: false,
      creditsPaid: null,
      pending: false,
    });
  });
  it("never shows more joined than needed, and no 'pending' once paid", () => {
    expect(coerceMyInvite(mine({ joined: 9 }))?.joined).toBe(5);
    const paid = coerceMyInvite(mine({ joined: 5, paid: true, credits_paid: "100.00", pending: true }));
    expect(paid).toMatchObject({ paid: true, creditsPaid: 100, pending: false });
  });
  it("is null, never a guess, for an answer that is not the database's", () => {
    for (const bad of [null, "x", {}, mine({ enabled: "yes" }), mine({ required: 0 }), mine({ link: { token: "nope" } })]) {
      expect(coerceMyInvite(bad)).toBeNull();
    }
  });
  it("keeps no one else's data: the shape has counts only", () => {
    const keys = Object.keys(coerceMyInvite(mine()) ?? {}).sort();
    expect(keys).toEqual(["creditsPaid", "enabled", "joined", "link", "paid", "pending", "required", "reward"]);
  });
  it("explains a disabled button only when there is no link yet and the switch is off", () => {
    expect(inviteBlock(coerceMyInvite(mine({ enabled: false, link: null }))!)).toBe("off");
    expect(inviteBlock(coerceMyInvite(mine({ enabled: true, link: null }))!)).toBeNull();
    expect(inviteBlock(coerceMyInvite(mine({ enabled: false }))!)).toBeNull();
  });
});

describe("the operator's form", () => {
  it("accepts the database's ranges and refuses everything else", () => {
    expect(parseInviteSettings({ required: "5", reward: "100", dailyCap: "20" })).toEqual({ required: 5, reward: 100, dailyCap: 20 });
    expect(parseInviteSettings({ required: "3", reward: "12.50", dailyCap: "0" })).toEqual({ required: 3, reward: 12.5, dailyCap: 0 });
    for (const bad of [
      { required: "0", reward: "100", dailyCap: "20" },
      { required: "101", reward: "100", dailyCap: "20" },
      { required: "5", reward: "0", dailyCap: "20" },
      { required: "5", reward: "-1", dailyCap: "20" },
      { required: "5", reward: "100000.01", dailyCap: "20" },
      { required: "5", reward: "1e3", dailyCap: "20" },
      { required: "5", reward: "100", dailyCap: "10001" },
      { required: "five", reward: "100", dailyCap: "20" },
      { required: "5", reward: "100", dailyCap: "" },
    ]) {
      expect(parseInviteSettings(bad)).toBeNull();
    }
  });
  it("states the worst case a day can pay: daily cap x reward", () => {
    expect(dailyExposure({ dailyRewardCap: 20, rewardCredits: 100 })).toBe(2000);
  });
  it("reads the counts, and refuses a partial answer", () => {
    const admin = {
      enabled: false, required_joins: 5, reward_credits: "100.00", daily_reward_cap: 20, link_hourly_cap: 10,
      links: 3, joins: 7, joins_uncounted: 1, rewards: 1, rewards_today: 1, credits_today: "100.00", credits_total: 100, pending: 0,
    };
    expect(coerceInviteAdmin(admin)).toMatchObject({ enabled: false, rewardCredits: 100, creditsToday: 100, joinsUncounted: 1 });
    expect(coerceInviteAdmin({ ...admin, links: undefined })).toBeNull();
  });
});

describe("the words", () => {
  const LOCALES = { en, ru, uz } as const;
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("every invite string exists in all three languages with the same placeholders", () => {
    for (const key of Object.keys(en.invite) as (keyof typeof en.invite)[]) {
      for (const [code, d] of Object.entries(LOCALES)) {
        expect(typeof d.invite[key], `${code}.invite.${key}`).toBe("string");
        expect(placeholders(d.invite[key]), `${code}.invite.${key}`).toEqual(placeholders(en.invite[key]));
      }
    }
    for (const d of Object.values(LOCALES)) expect(Object.keys(d.invite).sort()).toEqual(Object.keys(en.invite).sort());
  });

  it("the sign-up notices and the menu entry exist in all three languages", () => {
    const keys = ["invitedBanner", "inviteInvalidTitle", "inviteInvalidBody", "inviteCreateAccount", "inviteExistingTitle", "inviteExistingBody", "inviteOpenApp"] as const;
    for (const d of Object.values(LOCALES)) {
      for (const k of keys) expect(d.signup[k].length).toBeGreaterThan(5);
      expect(d.account.inviteFriends.length).toBeGreaterThan(3);
    }
  });

  it("promises the new person nothing, and uses no role words", () => {
    const customer = (d: typeof en) =>
      [d.signup.invitedBanner, d.signup.inviteInvalidBody, d.signup.inviteExistingBody, ...Object.entries(d.invite).filter(([k]) => !k.startsWith("admin")).map(([, v]) => v as string)].join(" ");
    expect(customer(en).toLowerCase()).not.toMatch(/\b(owner|editor|viewer|admin)\b/);
    expect(en.signup.invitedBanner).not.toMatch(/credit|free|\d/i);
    expect(ru.signup.invitedBanner).not.toMatch(/кредит|бесплат|\d/i);
    expect(uz.signup.invitedBanner).not.toMatch(/kredit|bepul|\d/i);
  });
});
