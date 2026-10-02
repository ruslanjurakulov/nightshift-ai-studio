/**
 * Subscription plans (migration 0034) — the pure, client-safe half: the plan
 * catalog as the database holds it, this deployment's plan prices, the
 * pricing matrix, and the billing summary the account panel and Credits page
 * show. Unit-tested in tests/plans.test.ts.
 *
 * What a plan grants and unlocks is DATA (plans, plan_entitlements,
 * entitlement_keys). Nothing here branches on a plan's name: the only place a
 * plan id is spelled out is PLAN_ENV below, because Next inlines a public env
 * var into the browser only when it is named literally (and the Docker build
 * passes each one by name).
 *
 * Honest by construction: the matrix lists only entitlement keys whose status
 * is `enforced` — what the platform actually checks today. A `planned` key is
 * stored per plan but never advertised.
 */

import { PADDLE_PRICE_ID_RE, type PaddleEnvironment } from "@/lib/paddle";
import { readDisplayPrice } from "@/lib/pricing";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { UNIT_JOB_MINIMUM, UNIT_VIDEO_MINUTE, isCreditExempt, roundUpCredits, type PriceMap } from "@/lib/credits";

// ── the catalog ──────────────────────────────────────────────────────────────

export type EntitlementType = "bool" | "int" | "tier";
export type EntitlementValue = boolean | number | string;

export interface PlanRow {
  id: string;
  name: string;
  sortOrder: number;
  monthlyCredits: number;
  isDefault: boolean;
  isPublic: boolean;
}

export interface EntitlementKey {
  key: string;
  valueType: EntitlementType;
  defaultValue: EntitlementValue;
  exemptValue: EntitlementValue;
  enforced: boolean;
  sortOrder: number;
}

export interface PlanCatalog {
  /** Public plans, cheapest first (sort_order). */
  plans: PlanRow[];
  /** Every key, in display order (enforced and planned). */
  keys: EntitlementKey[];
  /** plan id -> key -> value, defaults already applied. */
  values: Record<string, Record<string, EntitlementValue>>;
  /** How long a top-up pack's credits last (credit_lot_policies); null = never expire, undefined = unknown. */
  packValidMonths?: number | null;
  /** The policy could not be read (its query failed, or the pack row is malformed): the
   *  expiry is UNKNOWN, never "do not expire" (BR-L-131). Absent when there is no policy table. */
  packExpiryUnknown?: boolean;
}

const PLAN_ID_RE = /^[a-z][a-z0-9_]{1,30}$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const TIERS = ["none", "basic", "premium", "all"] as const;
export type Tier = (typeof TIERS)[number];

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A jsonb value of the key's type, or null when it is not one. */
export function entitlementValue(type: EntitlementType, v: unknown): EntitlementValue | null {
  if (type === "bool") return typeof v === "boolean" ? v : null;
  if (type === "int") return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  return typeof v === "string" && (TIERS as readonly string[]).includes(v) ? v : null;
}

/**
 * The catalog from the three tables' rows (anything malformed is dropped, not
 * guessed). Null when the plans table could not be read at all — 0034 not
 * applied, or the database unreachable — so the page says so instead of
 * showing an empty offer.
 */
export function coercePlanCatalog(
  planRows: unknown,
  keyRows: unknown,
  valueRows: unknown,
  policyRows?: unknown,
): PlanCatalog | null {
  if (!Array.isArray(planRows)) return null;
  const plans: PlanRow[] = planRows.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const credits = num(o.monthly_credits);
    if (!PLAN_ID_RE.test(id) || typeof o.name !== "string" || credits === null || credits < 0) return [];
    if (o.is_public === false) return [];
    return [
      {
        id,
        name: o.name.trim().slice(0, 40) || id,
        sortOrder: num(o.sort_order) ?? 0,
        monthlyCredits: credits,
        isDefault: o.is_default === true,
        isPublic: true,
      },
    ];
  });
  plans.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  const keys: EntitlementKey[] = (Array.isArray(keyRows) ? keyRows : []).flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const type = o.value_type;
    if (typeof o.key !== "string" || !KEY_RE.test(o.key) || (type !== "bool" && type !== "int" && type !== "tier")) return [];
    const def = entitlementValue(type, o.default_value);
    const ex = entitlementValue(type, o.exempt_value);
    if (def === null || ex === null) return [];
    return [
      {
        key: o.key,
        valueType: type,
        defaultValue: def,
        exemptValue: ex,
        enforced: o.status === "enforced",
        sortOrder: num(o.sort_order) ?? 0,
      },
    ];
  });
  keys.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));

  const byKey = new Map(keys.map((k) => [k.key, k]));
  const values: PlanCatalog["values"] = {};
  for (const p of plans) values[p.id] = Object.fromEntries(keys.map((k) => [k.key, k.defaultValue]));
  for (const r of Array.isArray(valueRows) ? valueRows : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const plan = typeof o.plan_id === "string" ? values[o.plan_id] : undefined;
    const key = typeof o.key === "string" ? byKey.get(o.key) : undefined;
    if (!plan || !key) continue;
    const v = entitlementValue(key.valueType, o.value);
    if (v !== null) plan[key.key] = v;
  }
  let packValidMonths: number | null | undefined;
  let packExpiryUnknown = false;
  for (const r of Array.isArray(policyRows) ? policyRows : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (o.source !== "pack") continue;
    const m = num(o.valid_months);
    packValidMonths = o.valid_months === null ? null : m !== null && Number.isInteger(m) && m >= 1 && m <= 120 ? m : undefined;
    // A pack row whose term is not a whole number of months in range says
    // nothing usable: unknown, not "never" (BR-L-131).
    packExpiryUnknown = packValidMonths === undefined;
  }
  return packExpiryUnknown ? { plans, keys, values, packValidMonths, packExpiryUnknown } : { plans, keys, values, packValidMonths };
}

// ── this deployment's plan prices ────────────────────────────────────────────

/** The public env this reads. Literal names only (see the file comment). */
export interface PlanEnv {
  NEXT_PUBLIC_PADDLE_PLAN_CREATOR?: string;
  NEXT_PUBLIC_PADDLE_PLAN_PRO?: string;
  NEXT_PUBLIC_PADDLE_PLAN_STUDIO?: string;
  NEXT_PUBLIC_PLAN_DISPLAY_CREATOR?: string;
  NEXT_PUBLIC_PLAN_DISPLAY_PRO?: string;
  NEXT_PUBLIC_PLAN_DISPLAY_STUDIO?: string;
}

/** plan id -> its env var names. A plan the database adds later without an
 *  entry here is listed with "price at checkout" and cannot be bought yet. */
export const PLAN_ENV_VARS: Record<string, { price: keyof PlanEnv; display: keyof PlanEnv }> = {
  creator: { price: "NEXT_PUBLIC_PADDLE_PLAN_CREATOR", display: "NEXT_PUBLIC_PLAN_DISPLAY_CREATOR" },
  pro: { price: "NEXT_PUBLIC_PADDLE_PLAN_PRO", display: "NEXT_PUBLIC_PLAN_DISPLAY_PRO" },
  studio: { price: "NEXT_PUBLIC_PADDLE_PLAN_STUDIO", display: "NEXT_PUBLIC_PLAN_DISPLAY_STUDIO" },
};

export interface PlanPrice {
  priceId: string | null;
  displayPrice: string | null;
}

/** A plan's Paddle price id and display price from env (each null when unset or malformed). */
export function planPrice(env: PlanEnv, planId: string): PlanPrice {
  const vars = PLAN_ENV_VARS[planId];
  if (!vars) return { priceId: null, displayPrice: null };
  const raw = (env[vars.price] ?? "").trim();
  return {
    priceId: PADDLE_PRICE_ID_RE.test(raw) ? raw : null,
    displayPrice: readDisplayPrice(env[vars.display]),
  };
}

// ── the matrix ───────────────────────────────────────────────────────────────

export interface MatrixColumn {
  id: string;
  name: string;
  monthlyCredits: number;
  isDefault: boolean;
  priceId: string | null;
  displayPrice: string | null;
}

export interface MatrixRow {
  key: string;
  type: EntitlementType;
  cells: EntitlementValue[];
}

export interface PlanMatrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  /** When at least one paid plan can be subscribed to here (a valid price id, Paddle configured). */
  purchasable: boolean;
  paddle: { environment: PaddleEnvironment; clientToken: string } | null;
}

/**
 * The /pricing matrix: every public plan as a column (the default/free plan
 * first by sort order), and one row per ENFORCED entitlement key. A price id
 * is kept only when Paddle is configured — a checkout that cannot open is not
 * an offer.
 */
export function planMatrix(
  catalog: PlanCatalog | null,
  env: PlanEnv,
  paddle: { environment: PaddleEnvironment; clientToken: string } | null,
): PlanMatrix | null {
  if (!catalog || catalog.plans.length === 0) return null;
  const columns = catalog.plans.map((p) => {
    const price = p.isDefault ? { priceId: null, displayPrice: null } : planPrice(env, p.id);
    return {
      id: p.id,
      name: p.name,
      monthlyCredits: p.monthlyCredits,
      isDefault: p.isDefault,
      priceId: paddle ? price.priceId : null,
      displayPrice: price.displayPrice,
    };
  });
  const rows = catalog.keys
    .filter((k) => k.enforced)
    .map((k) => ({ key: k.key, type: k.valueType, cells: catalog.plans.map((p) => catalog.values[p.id][k.key]) }));
  const purchasable = columns.some((c) => !c.isDefault && c.priceId !== null);
  return { columns, rows, purchasable, paddle: purchasable ? paddle : null };
}

/** Is there anything to show on the pricing page (a paid plan with a price or checkout)? */
export function plansOnSale(matrix: PlanMatrix | null): boolean {
  return Boolean(matrix?.columns.some((c) => !c.isDefault && (c.priceId !== null || c.displayPrice !== null)));
}

export type PlanPriceView =
  | { kind: "free" }
  | { kind: "preview"; text: string }
  | { kind: "display"; text: string }
  | { kind: "pending" }
  | { kind: "at_checkout" }
  | { kind: "unpublished" };

/** The price a column shows: Paddle's preview, else the owner's display price. */
export function columnPrice(col: MatrixColumn, preview: Record<string, string> | null, loading: boolean): PlanPriceView {
  if (col.isDefault) return { kind: "free" };
  const previewed = col.priceId && preview ? preview[col.priceId] : undefined;
  if (previewed) return { kind: "preview", text: previewed };
  if (col.displayPrice) return { kind: "display", text: col.displayPrice };
  if (!col.priceId) return { kind: "unpublished" };
  return loading ? { kind: "pending" } : { kind: "at_checkout" };
}

// ── the organization's billing ───────────────────────────────────────────────

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "paused", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
const LIVE: readonly SubscriptionStatus[] = ["active", "trialing", "past_due"];

export interface BillingSummary {
  exempt: boolean;
  plan: { id: string; name: string; monthlyCredits: number; isDefault: boolean } | null;
  subscription: {
    planId: string;
    status: SubscriptionStatus;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    manageable: boolean;
    live: boolean;
  } | null;
  credits: { subscription: number; pack: number; other: number; held: number };
  nextExpiry: { at: string; credits: number } | null;
  runSlots: { limit: number | null; active: number } | null;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * True when billing_summary()'s `credits` object carries all four figures as
 * numbers. coerceBillingSummary() reads a missing figure as 0 to stay total;
 * a caller that shows those figures must check this first, so a malformed
 * answer is an unknown, never "0 credits".
 */
export function billingCreditsReadable(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const c = (data as Record<string, unknown>).credits;
  if (!c || typeof c !== "object") return false;
  return ["subscription", "pack", "other", "held"].every((k) => num((c as Record<string, unknown>)[k]) !== null);
}

/** billing_summary()'s jsonb, or null when it is not one (not a member, 0034 missing). */
export function coerceBillingSummary(data: unknown): BillingSummary | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const p = (d.plan ?? null) as Record<string, unknown> | null;
  const plan =
    p && typeof p.id === "string" && typeof p.name === "string"
      ? { id: p.id, name: p.name, monthlyCredits: num(p.monthly_credits) ?? 0, isDefault: p.is_default === true }
      : null;
  const s = (d.subscription ?? null) as Record<string, unknown> | null;
  const status = s && (SUBSCRIPTION_STATUSES as readonly unknown[]).includes(s.status) ? (s.status as SubscriptionStatus) : null;
  const subscription =
    s && status && typeof s.plan_id === "string"
      ? {
          planId: s.plan_id,
          status,
          periodEnd: isoOrNull(s.current_period_end),
          cancelAtPeriodEnd: s.cancel_at_period_end === true,
          manageable: s.manageable === true,
          live: LIVE.includes(status),
        }
      : null;
  const c = (d.credits ?? {}) as Record<string, unknown>;
  const credits = {
    subscription: num(c.subscription) ?? 0,
    pack: num(c.pack) ?? 0,
    other: num(c.other) ?? 0,
    held: num(c.held) ?? 0,
  };
  const n = (d.next_expiry ?? null) as Record<string, unknown> | null;
  const at = n ? isoOrNull(n.at) : null;
  const nextExpiry = at && n && num(n.credits) !== null ? { at, credits: num(n.credits) as number } : null;
  const r = (d.run_slots ?? null) as Record<string, unknown> | null;
  const runSlots = r ? { limit: num(r.limit), active: num(r.active) ?? 0 } : null;
  return { exempt: d.exempt === true, plan, subscription, credits, nextExpiry, runSlots };
}

export type SubscribeAccess = "hidden" | "admin_only" | "allowed" | "manage";

/**
 * What the Credits page offers for plans. The exempt operator organization
 * never pays; nothing is offered without a checkout; an organization that
 * already has a live subscription manages it (Paddle's portal) instead of
 * buying a second one; and choosing a plan is the workspace owner's act, like
 * buying credits. A self-serve customer has no team roles (migration 0033):
 * the person who created the workspace owns it, which the database records as
 * the owner role — so the check below still reads the role, but nothing shown
 * to a customer names one ("workspace owner" is all they see).
 */
export function subscribeAccess(
  orgId: string | null | undefined,
  role: Role | null | undefined,
  matrix: PlanMatrix | null,
  summary: BillingSummary | null,
): SubscribeAccess {
  if (!orgId || isCreditExempt(orgId) || summary?.exempt) return "hidden";
  const admin = Boolean(role && atLeast(role, "admin"));
  if (summary?.subscription?.live) return admin && summary.subscription.manageable ? "manage" : "hidden";
  if (!matrix?.purchasable) return "hidden";
  return admin ? "allowed" : "admin_only";
}

/** A credit lot as the Credits page lists it. */
export interface CreditLot {
  id: number;
  source: "subscription" | "pack" | "grant" | "adjustment";
  amount: number;
  remaining: number;
  held: number;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
  note: string | null;
}

const SOURCES = ["subscription", "pack", "grant", "adjustment"] as const;

/**
 * Lots as the Credits page lists them: those still holding credits first, in
 * the order they will be spent (subscription first, then soonest-expiring,
 * never-expiring last — 0034's spend order), then the emptied or expired ones,
 * newest first.
 */
export function sortLots(lots: readonly CreditLot[]): CreditLot[] {
  const live = (l: CreditLot) => l.remaining > 0 && !l.expired;
  const exp = (l: CreditLot) => (l.expiresAt ? Date.parse(l.expiresAt) : Number.POSITIVE_INFINITY);
  return [...lots].sort((a, b) => {
    if (live(a) !== live(b)) return live(a) ? -1 : 1;
    if (live(a)) {
      const sa = a.source === "subscription" ? 0 : 1;
      const sb = b.source === "subscription" ? 0 : 1;
      return sa - sb || exp(a) - exp(b) || a.id - b.id;
    }
    return b.id - a.id;
  });
}

export function coerceLots(rows: unknown, now: number = Date.now()): CreditLot[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = num(o.id);
    const amount = num(o.amount);
    const remaining = num(o.remaining);
    const held = num(o.held) ?? 0;
    if (id === null || amount === null || remaining === null || !(SOURCES as readonly unknown[]).includes(o.source)) return [];
    const expiresAt = isoOrNull(o.expires_at);
    return [
      {
        id,
        source: o.source as CreditLot["source"],
        amount,
        remaining,
        held,
        expiresAt,
        expired: expiresAt !== null && Date.parse(expiresAt) <= now,
        createdAt: typeof o.created_at === "string" ? o.created_at : "",
        note: typeof o.note === "string" && o.note ? o.note : null,
      },
    ];
  });
}

// Each variable is read by its literal name: Next inlines NEXT_PUBLIC_* only
// for a direct reference.
export const PLAN_ENV: PlanEnv = {
  NEXT_PUBLIC_PADDLE_PLAN_CREATOR: process.env.NEXT_PUBLIC_PADDLE_PLAN_CREATOR,
  NEXT_PUBLIC_PADDLE_PLAN_PRO: process.env.NEXT_PUBLIC_PADDLE_PLAN_PRO,
  NEXT_PUBLIC_PADDLE_PLAN_STUDIO: process.env.NEXT_PUBLIC_PADDLE_PLAN_STUDIO,
  NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: process.env.NEXT_PUBLIC_PLAN_DISPLAY_CREATOR,
  NEXT_PUBLIC_PLAN_DISPLAY_PRO: process.env.NEXT_PUBLIC_PLAN_DISPLAY_PRO,
  NEXT_PUBLIC_PLAN_DISPLAY_STUDIO: process.env.NEXT_PUBLIC_PLAN_DISPLAY_STUDIO,
};

// ── the Credits page: what credits buy, and where they are ───────────────────

/**
 * One sellable model as far as pricing needs it: the structural half of
 * lib/creative/registry.ts SellableModel (that module is server-only; the
 * page maps its rows to this before anything reaches the browser).
 */
export interface PricedModel {
  capabilities: readonly string[];
  /** The model's plan entitlement; null / "any" = usable without one. */
  entitlement: string | null;
  /** Credits per unit as charged: the margin is already in it (sellable_models, 0084). */
  creditsPerUnit: number;
  spec: { unit: string; durationsS: readonly number[] };
}

/**
 * What the cheapest generally-usable generation of each kind costs right now,
 * priced the way migration 0036's creative_price() prices a quote:
 * ceil_cent(quantity × credits_per_unit × (1 + margin)) — the model's rate as
 * charged, which is what sellable_models() returns (0084) — raised to the
 * job_minimum when positive. Null when nothing of that kind is sellable and
 * priced — the page then leaves that equivalent out, never invents one.
 */
export interface GenerationRates {
  /** Credits for one image. */
  image: number | null;
  /** Credits for the shortest clip a video model offers, and its length. */
  shortVideo: { credits: number; seconds: number } | null;
  /** Credits per finished minute of channel video (video_minute × (1 + margin)). */
  videoMinute: number | null;
}

function quoteLike(qty: number, m: Pick<PricedModel, "creditsPerUnit">, minimum: number): number | null {
  if (!(qty > 0) || !(m.creditsPerUnit > 0)) return null;
  const price = roundUpCredits(Math.round(qty * m.creditsPerUnit * 1e6) / 1e6);
  return price > 0 ? Math.max(price, minimum) : null;
}

/**
 * Only models anyone can use count: a model behind an entitlement (or behind a
 * first purchase, "paid") would make the equivalent a promise the plan does
 * not keep.
 */
function openToAll(m: PricedModel): boolean {
  return m.entitlement === null || m.entitlement === "any";
}

export function generationRates(models: readonly PricedModel[] | null, prices: PriceMap): GenerationRates {
  const floor = prices[UNIT_JOB_MINIMUM];
  const minimum = floor && floor.creditsPerUnit > 0 ? roundUpCredits(floor.creditsPerUnit) : 0;
  let image: number | null = null;
  let shortVideo: GenerationRates["shortVideo"] = null;
  for (const m of models ?? []) {
    if (!openToAll(m)) continue;
    if (m.capabilities.includes("t2i") && m.spec.unit === "image") {
      const c = quoteLike(1, m, minimum);
      if (c !== null && (image === null || c < image)) image = c;
    }
    if (m.capabilities.includes("t2v") && m.spec.unit === "second") {
      const seconds = Math.min(...m.spec.durationsS.filter((d) => Number.isInteger(d) && d > 0));
      if (!Number.isFinite(seconds)) continue;
      const c = quoteLike(seconds, m, minimum);
      if (c !== null && (shortVideo === null || c < shortVideo.credits)) shortVideo = { credits: c, seconds };
    }
  }
  const minute = prices[UNIT_VIDEO_MINUTE];
  const videoMinute = minute && minute.creditsPerUnit > 0 ? roundUpCredits(minute.creditsPerUnit * (1 + minute.margin)) : null;
  return { image, shortVideo, videoMinute };
}

/** "≈ N images · M short videos · K min of video" for an amount of credits; each part only when priced and ≥ 1. */
export interface CreditEquivalents {
  images: number | null;
  videos: { count: number; seconds: number } | null;
  minutes: number | null;
}

export function creditEquivalents(credits: number, rates: GenerationRates | null): CreditEquivalents | null {
  if (!rates || !Number.isFinite(credits) || credits <= 0) return null;
  const count = (per: number | null) => {
    if (per === null || !(per > 0)) return null;
    const n = Math.floor(credits / per + 1e-9);
    return n >= 1 ? n : null;
  };
  const images = count(rates.image);
  const v = rates.shortVideo ? count(rates.shortVideo.credits) : null;
  const videos = v !== null && rates.shortVideo ? { count: v, seconds: rates.shortVideo.seconds } : null;
  const minutes = count(rates.videoMinute);
  return images === null && videos === null && minutes === null ? null : { images, videos, minutes };
}

/**
 * The saving of a yearly price over twelve monthly ones, in whole percent
 * (rounded down: "save 17%" must never overstate). Null unless both prices are
 * positive amounts in the same currency unit and yearly is actually cheaper.
 *
 * The plan data carries monthly prices only today (PLAN_ENV), so the Credits
 * page shows no Monthly / Yearly toggle; this is the rule it uses once a
 * yearly price exists.
 */
export function yearlySavingPercent(monthly: number, yearly: number): number | null {
  if (!Number.isFinite(monthly) || !Number.isFinite(yearly) || monthly <= 0 || yearly <= 0) return null;
  const full = monthly * 12;
  if (yearly >= full) return null;
  const pct = Math.floor(((full - yearly) / full) * 100 + 1e-9);
  return pct >= 1 ? pct : null;
}

/** One line of the balance breakdown: credits available from one source, and when the soonest of them expire. */
export interface BalanceSource {
  source: "plan" | "pack" | "other";
  credits: number;
  /** Soonest expiry among this source's live lots; null = never / unknown. */
  expiresAt: string | null;
}

export interface BalanceSplit {
  /** Spendable now (balance − on hold); null = unknown. */
  available: number | null;
  /** Held by jobs in progress; null = unknown. */
  held: number | null;
  /** Everything in the account, held included; null = unknown. */
  total: number | null;
  /** Available credits by source; null when the source split could not be read (or 0034 is not applied). */
  sources: BalanceSource[] | null;
}

/**
 * The Credits page's balance, from what was actually read:
 *  - account (0020 credit_accounts): available / held / total, or null when
 *    that read failed — then the held figure falls back to billing_summary's
 *    own count of held credits, which is a separate read;
 *  - summary (0034 billing_summary): available credits by source;
 *  - lots (0034 credit_lots): when each source's soonest credits expire.
 * A source with nothing in it is left out (a free account is not shown
 * "Plan credits 0"), except plan credits while a subscription is live.
 */
export function balanceSplit(
  account: { balance: number; reserved: number; available: number } | null,
  summary: BillingSummary | null,
  lots: readonly CreditLot[] | null,
): BalanceSplit {
  const held = account ? account.reserved : summary ? summary.credits.held : null;
  const soonest = (pick: (l: CreditLot) => boolean): string | null => {
    let best: string | null = null;
    for (const l of lots ?? []) {
      if (!pick(l) || l.expired || l.remaining - l.held <= 0 || !l.expiresAt) continue;
      if (best === null || Date.parse(l.expiresAt) < Date.parse(best)) best = l.expiresAt;
    }
    return best;
  };
  let sources: BalanceSource[] | null = null;
  if (summary) {
    const c = summary.credits;
    const live = Boolean(summary.subscription?.live);
    sources = [];
    if (c.subscription > 0 || live) {
      sources.push({
        source: "plan",
        credits: c.subscription,
        expiresAt: soonest((l) => l.source === "subscription") ?? (c.subscription > 0 ? (summary.subscription?.periodEnd ?? null) : null),
      });
    }
    if (c.pack > 0) sources.push({ source: "pack", credits: c.pack, expiresAt: soonest((l) => l.source === "pack") });
    if (c.other > 0) {
      sources.push({ source: "other", credits: c.other, expiresAt: soonest((l) => l.source === "grant" || l.source === "adjustment") });
    }
  }
  return {
    available: account ? account.available : null,
    held,
    total: account ? account.balance : null,
    sources,
  };
}

/**
 * How long top-up credits last, as a public page may state it.
 *
 * - "months" / "never": what the plan catalog's pack policy says (0034's
 *   credit_lot_policies, read), or the operator's NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS.
 * - "never" also when there is no catalog to read at all (no backend, 0034
 *   not applied) and the env is empty: then nothing expires credits.
 * - "unknown": the catalog read FAILED (or timed out) and the env is empty —
 *   the database may well hold a term, so the page points to the Terms rather
 *   than promising "do not expire" (BR-L-100).
 */
export type PackExpiry = { kind: "months"; months: number } | { kind: "never" } | { kind: "unknown" };

export function packExpiry(
  read:
    | { state: "ok"; value: { packValidMonths?: number | null; packExpiryUnknown?: boolean } }
    | { state: "unsupported" }
    | { state: "failed" }
    | null,
  envMonths: number | null,
): PackExpiry {
  if (read?.state === "ok" && read.value.packExpiryUnknown) {
    // The policy exists but could not be read: only the operator's env may speak (BR-L-131).
    return envMonths !== null ? { kind: "months", months: envMonths } : { kind: "unknown" };
  }
  if (read?.state === "ok" && read.value.packValidMonths !== undefined) {
    return read.value.packValidMonths === null ? { kind: "never" } : { kind: "months", months: read.value.packValidMonths };
  }
  if (envMonths !== null) return { kind: "months", months: envMonths };
  return read?.state === "failed" ? { kind: "unknown" } : { kind: "never" };
}
