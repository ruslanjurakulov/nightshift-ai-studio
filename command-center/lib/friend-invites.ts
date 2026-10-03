/**
 * Invite friends (migration 0092) — the pure half: the token's shape, the
 * cookie that carries it, and the shapes the Credits page reads.
 *
 * One person has one link. When five new, e-mail-confirmed people have joined
 * through it, the OWNER is paid once (credits, a typed grant on the ledger).
 * The people who join get nothing from this feature, and the owner only ever
 * sees counts — never who joined.
 *
 * Client-safe and unit-tested (tests/friend-invites.test.ts); the server half
 * that talks to Supabase is lib/server/friend-invites.ts.
 */

/** The cookie /i/<token> sets and the auth callback reads once the e-mail is confirmed. */
export const INVITE_COOKIE = "ns_invite";

/** Short-lived: long enough to sign up and open the confirmation mail, no longer. */
export const INVITE_COOKIE_MAX_AGE = 24 * 60 * 60;

/** The database's token: 128 random bits as 32 hex characters. */
const TOKEN_RE = /^[0-9a-f]{32}$/;

/** A token as typed in a URL: hex, either case. Anything else is not one. */
export function normalizeInviteToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return TOKEN_RE.test(token) ? token : null;
}

/** What a visitor is told about a link, as a fixed code in the URL (never text from it). */
export const INVITE_NOTICES = ["invalid", "existing"] as const;
export type InviteNotice = (typeof INVITE_NOTICES)[number];

export function isInviteNotice(value: string | null | undefined): value is InviteNotice {
  return (INVITE_NOTICES as readonly string[]).includes(value ?? "");
}

/** The address an owner shares. `origin` is the site's own, never a header. */
export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/i/${token}`;
}

export interface MyInvite {
  /** The operator's switch: nothing is paid, and no new link is made, while off. */
  enabled: boolean;
  /** Joins needed (5 by default). */
  required: number;
  /** Credits paid to the owner (100 by default). */
  reward: number;
  /** The owner's link, or null before they made one. */
  link: { token: string; createdAt: string } | null;
  /** Counted joins (never above `required`). */
  joined: number;
  paid: boolean;
  /** What was paid, once paid. */
  creditsPaid: number | null;
  /** Earned, waiting for room today (the daily cap) or for the switch. */
  pending: boolean;
}

function finite(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** my_friend_invite() -> MyInvite, or null when the answer is not what the database promises. */
export function coerceMyInvite(raw: unknown): MyInvite | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const required = finite(r.required);
  const reward = finite(r.reward);
  const joined = finite(r.joined);
  if (typeof r.enabled !== "boolean" || required === null || required < 1 || reward === null || joined === null) return null;
  let link: MyInvite["link"] = null;
  if (r.link && typeof r.link === "object") {
    const l = r.link as Record<string, unknown>;
    const token = normalizeInviteToken(l.token);
    if (!token) return null;
    link = { token, createdAt: typeof l.created_at === "string" ? l.created_at : "" };
  }
  const paid = r.paid === true;
  return {
    enabled: r.enabled,
    required,
    reward,
    link,
    joined: Math.max(0, Math.min(joined, required)),
    paid,
    creditsPaid: paid ? finite(r.credits_paid) : null,
    pending: r.pending === true && !paid,
  };
}

/** Why "Create my link" is off, or null when it is on. Plain reasons, not codes. */
export type InviteBlock = "off";

export function inviteBlock(invite: MyInvite): InviteBlock | null {
  if (invite.link) return null;
  return invite.enabled ? null : "off";
}

/** The operator's view (friend_invite_admin()). */
export interface InviteAdmin {
  enabled: boolean;
  requiredJoins: number;
  rewardCredits: number;
  dailyRewardCap: number;
  linkHourlyCap: number;
  links: number;
  joins: number;
  joinsUncounted: number;
  rewards: number;
  rewardsToday: number;
  creditsToday: number;
  creditsTotal: number;
  pending: number;
}

export function coerceInviteAdmin(raw: unknown): InviteAdmin | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (k: string) => finite(r[k]);
  const out = {
    requiredJoins: n("required_joins"),
    rewardCredits: n("reward_credits"),
    dailyRewardCap: n("daily_reward_cap"),
    linkHourlyCap: n("link_hourly_cap"),
    links: n("links"),
    joins: n("joins"),
    joinsUncounted: n("joins_uncounted"),
    rewards: n("rewards"),
    rewardsToday: n("rewards_today"),
    creditsToday: n("credits_today"),
    creditsTotal: n("credits_total"),
    pending: n("pending"),
  };
  if (typeof r.enabled !== "boolean" || Object.values(out).some((v) => v === null)) return null;
  return { enabled: r.enabled, ...(out as Record<keyof typeof out, number>) };
}

/** What the operator's form sends; null when any number is out of the database's range. */
export function parseInviteSettings(input: {
  required: string;
  reward: string;
  dailyCap: string;
}): { required: number; reward: number; dailyCap: number } | null {
  const whole = (s: string) => (/^\d{1,5}$/.test(s.trim()) ? Number(s.trim()) : null);
  const required = whole(input.required);
  const dailyCap = whole(input.dailyCap);
  const reward = /^\d{1,6}(\.\d{1,2})?$/.test(input.reward.trim()) ? Number(input.reward.trim()) : null;
  if (required === null || required < 1 || required > 100) return null;
  if (dailyCap === null || dailyCap > 10000) return null;
  if (reward === null || reward <= 0 || reward > 100000) return null;
  return { required, reward, dailyCap };
}

/** The most credits one day can pay out at these settings: the worst case the operator accepts. */
export function dailyExposure(settings: { dailyRewardCap: number; rewardCredits: number }): number {
  return settings.dailyRewardCap * settings.rewardCredits;
}
