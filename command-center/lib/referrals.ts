/**
 * The referral programme (migration 0165) — the pure half: the shapes the Credits page, the operator panel and the public
 * /referral terms read, and the operator form's ranges.
 *
 * The rule lives in the database (referral_settle_locked): a friend who joined through the person's link (0092's rules) makes
 * a first payment of at least `minCredits` within `qualifyDays`; the reward is held `holdDays`, void if the payment is refunded
 * meanwhile, then paid as a grant, at most `monthlyCap` a month per person and `dailyCap` a day platform-wide, and taken back
 * after a later refund. Nothing here decides any of it, and no number here is a default: each one is what the database said,
 * or the screen says it is unknown.
 *
 * Client-safe and unit-tested (tests/referrals.test.ts); the server half is lib/server/referrals.ts.
 */

import { normalizeInviteToken } from "@/lib/friend-invites";

/** ok / unsupported (0165 not applied: the page falls back to 0092's card) / failed (unknown: never zeros in its place). */
export type ReferralRead<T> = { state: "ok"; value: T } | { state: "unsupported" } | { state: "failed" };

/** The date the wording of the terms page was last changed (its numbers are dated by the database, `updatedAt`). */
export const REFERRAL_TERMS_DATE = "2026-11-14";

function finite(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function count(v: unknown): number | null {
  const n = finite(v);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
}

function isoOrNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined;
}

/** The programme's numbers, as every reader gets them. */
export interface ReferralNumbers {
  /** The operator's switch: closed, no new referral qualifies (held ones are still paid). */
  enabled: boolean;
  /** Credits per friend whose payment cleared the hold. */
  credits: number;
  /** The smallest payment (in credits) that qualifies a friend. */
  minCredits: number;
  holdDays: number;
  /** Days after joining within which the friend's first payment must come. */
  qualifyDays: number;
  /** Rewards per person per calendar month (UTC). */
  monthlyCap: number;
}

function coerceNumbers(r: Record<string, unknown>): ReferralNumbers | null {
  const credits = finite(r.credits);
  const minCredits = finite(r.min_credits);
  const holdDays = count(r.hold_days);
  const qualifyDays = count(r.qualify_days);
  const monthlyCap = count(r.monthly_cap);
  if (typeof r.enabled !== "boolean" || credits === null || credits <= 0 || minCredits === null || minCredits <= 0) return null;
  if (holdDays === null || qualifyDays === null || monthlyCap === null) return null;
  return { enabled: r.enabled, credits, minCredits, holdDays, qualifyDays, monthlyCap };
}

/** my_referrals() / claim_referral_rewards(): the person's own link and counts. Counts only — never who. */
export interface MyReferrals extends ReferralNumbers {
  link: { token: string; createdAt: string } | null;
  /** New, confirmed accounts that joined through the link. */
  joined: number;
  /** Friends whose payment is on hold now. */
  held: number;
  /** Of those, past their hold and waiting for room under a cap. */
  due: number;
  /** When the next hold ends (null when nothing is on hold, or everything held is already due). */
  nextReleaseAt: string | null;
  /** Rewards paid and still standing. */
  paid: number;
  /** Credits those paid rewards added. */
  earned: number;
  /** Rewards paid this calendar month (counts toward `monthlyCap`, taken back or not). */
  paidThisMonth: number;
  /** Rewards taken back after a refund, and the credits that came back. */
  clawed: number;
  clawedCredits: number;
  /** Referrals that will never pay (refunded during the hold, or the same payer). */
  void: number;
  /** 0092's one-off sign-up reward, when it was paid to this person. */
  milestoneCredits: number | null;
}

export function coerceMyReferrals(raw: unknown): MyReferrals | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nums = coerceNumbers(r);
  if (!nums) return null;
  let link: MyReferrals["link"] = null;
  if (r.link !== null && r.link !== undefined) {
    if (typeof r.link !== "object") return null;
    const l = r.link as Record<string, unknown>;
    const token = normalizeInviteToken(l.token);
    if (!token) return null;
    link = { token, createdAt: typeof l.created_at === "string" ? l.created_at : "" };
  }
  const c = {
    joined: count(r.joined),
    held: count(r.held),
    due: count(r.due),
    paid: count(r.paid),
    paidThisMonth: count(r.paid_this_month),
    clawed: count(r.clawed),
    void: count(r.void),
  };
  const earned = finite(r.earned);
  const clawedCredits = finite(r.clawed_credits);
  const next = isoOrNull(r.next_release_at);
  if (Object.values(c).some((v) => v === null) || earned === null || earned < 0 || clawedCredits === null || clawedCredits < 0) return null;
  if (next === undefined) return null;
  const milestone = r.milestone_credits === null || r.milestone_credits === undefined ? null : finite(r.milestone_credits);
  return {
    ...nums,
    link,
    ...(c as Record<keyof typeof c, number>),
    // A count of "due" above "held" is a database that broke its promise: never shown as more waiting than there is.
    due: Math.min(c.due as number, c.held as number),
    nextReleaseAt: next,
    earned,
    clawedCredits,
    milestoneCredits: milestone,
  };
}

/** Is there anything to list beyond the link? (The empty state says so in words, not with a row of zeros.) */
export function hasReferrals(m: MyReferrals): boolean {
  return m.joined > 0 || m.held > 0 || m.paid > 0 || m.clawed > 0 || m.void > 0;
}

/** referral_terms(): the public terms page's numbers. */
export interface ReferralTerms extends ReferralNumbers {
  /** Payouts across the platform per UTC day; a due reward waits for the next day with room. */
  dailyCap: number;
  /** Joins one link takes per hour (0092). */
  linkHourlyCap: number;
  /** How new an account must be when it joins (0092's join rule): made at most this many days before. */
  newAccountDays: number;
  /** When a number a referrer is promised last changed. */
  updatedAt: string | null;
}

export function coerceReferralTerms(raw: unknown): ReferralTerms | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nums = coerceNumbers(r);
  const dailyCap = count(r.daily_cap);
  const linkHourlyCap = count(r.link_hourly_cap);
  const newAccountDays = count(r.new_account_days);
  const updatedAt = isoOrNull(r.updated_at);
  if (!nums || dailyCap === null || linkHourlyCap === null || newAccountDays === null || updatedAt === undefined) return null;
  return { ...nums, dailyCap, linkHourlyCap, newAccountDays, updatedAt };
}

/** referral_admin(): the operator's numbers and the platform's counts. */
export interface ReferralAdmin extends ReferralNumbers {
  milestoneEnabled: boolean;
  dailyCap: number;
  updatedAt: string | null;
  links: number;
  joins: number;
  held: number;
  due: number;
  paid: number;
  paidToday: number;
  creditsMonth: number;
  creditsTotal: number;
  voidRefunded: number;
  voidSamePayer: number;
  clawed: number;
  clawShortfall: number;
  milestoneRewards: number;
}

export function coerceReferralAdmin(raw: unknown): ReferralAdmin | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nums = coerceNumbers(r);
  const ints = {
    dailyCap: count(r.daily_cap),
    links: count(r.links),
    joins: count(r.joins),
    held: count(r.held),
    due: count(r.due),
    paid: count(r.paid),
    paidToday: count(r.paid_today),
    voidRefunded: count(r.void_refunded),
    voidSamePayer: count(r.void_same_payer),
    clawed: count(r.clawed),
    milestoneRewards: count(r.milestone_rewards),
  };
  const money = { creditsMonth: finite(r.credits_month), creditsTotal: finite(r.credits_total), clawShortfall: finite(r.claw_shortfall) };
  const updatedAt = isoOrNull(r.updated_at);
  if (!nums || typeof r.milestone_enabled !== "boolean" || updatedAt === undefined) return null;
  if (Object.values(ints).some((v) => v === null) || Object.values(money).some((v) => v === null)) return null;
  return {
    ...nums,
    milestoneEnabled: r.milestone_enabled,
    updatedAt,
    ...(ints as Record<keyof typeof ints, number>),
    ...(money as Record<keyof typeof money, number>),
  };
}

/** The operator form's text fields. */
export interface ReferralSettingsInput {
  credits: string;
  minCredits: string;
  holdDays: string;
  qualifyDays: string;
  monthlyCap: string;
  dailyCap: string;
}

export interface ReferralSettings {
  credits: number;
  minCredits: number;
  holdDays: number;
  qualifyDays: number;
  monthlyCap: number;
  dailyCap: number;
}

/** What the form sends; null when any number is outside the database's own ranges (set_referral_settings refuses those too). */
export function parseReferralSettings(input: ReferralSettingsInput): ReferralSettings | null {
  const whole = (s: string) => (/^\d{1,7}$/.test(s.trim()) ? Number(s.trim()) : null);
  const amount = (s: string) => (/^\d{1,7}(\.\d{1,2})?$/.test(s.trim()) ? Number(s.trim()) : null);
  const credits = amount(input.credits);
  const minCredits = amount(input.minCredits);
  const holdDays = whole(input.holdDays);
  const qualifyDays = whole(input.qualifyDays);
  const monthlyCap = whole(input.monthlyCap);
  const dailyCap = whole(input.dailyCap);
  if (credits === null || credits <= 0 || credits > 100000) return null;
  if (minCredits === null || minCredits < 1 || minCredits > 1000000) return null;
  // A reward above the payment that earns it would make paying for a friend's account a way to mint credits.
  if (credits > minCredits) return null;
  if (holdDays === null || holdDays < 7 || holdDays > 180) return null;
  if (qualifyDays === null || qualifyDays < 1 || qualifyDays > 365) return null;
  if (monthlyCap === null || monthlyCap < 1 || monthlyCap > 1000) return null;
  if (dailyCap === null || dailyCap > 10000) return null;
  return { credits, minCredits, holdDays, qualifyDays, monthlyCap, dailyCap };
}

/** Telegram's own share address (a link, not an integration): it opens Telegram with the text and the link filled in. */
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
