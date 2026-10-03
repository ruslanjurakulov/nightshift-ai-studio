/**
 * The plan dialog a refused generation opens — the pure, client-safe half,
 * unit-tested in tests/plan-upsell.test.tsx.
 *
 * Every plan, price and limit it shows is DATA: the plan catalog and
 * entitlements (migration 0034, lib/plans.ts), the owner's display price, and
 * the numbers the database put in the refusal itself. Nothing here invents a
 * price, a discount, a trial or a yearly offer, and nothing here pays: the
 * dialog only links to the Credits page (where the existing checkout lives)
 * and to /pricing.
 *
 * What unlocks what must match the database, or the dialog sells something
 * the next Generate would still refuse:
 *  - a model whose entitlement is `paid` opens after the organization's first
 *    credit PURCHASE (create_creative_job, 0050). A plan's period credits are
 *    a `subscription` transaction, not a purchase, so no plan is offered for
 *    it — only "Buy credits";
 *  - any other model entitlement (`key` or `key:value`) is offered with plan
 *    cards only when that key is `enforced` (what the platform checks today,
 *    the same rule the pricing matrix uses). The models_* tiers are `planned`
 *    in 0034, so today such a model shows no cards rather than a plan that
 *    would not open it;
 *  - run_limit_reached is the enforced `concurrency` key: plans with more runs
 *    at once than the limit the refusal names;
 *  - insufficient_credits is answered with "Buy credits" first, and plans with
 *    a larger monthly allowance than the current one.
 */

import {
  columnPrice,
  planMatrix,
  type BillingSummary,
  type EntitlementType,
  type EntitlementValue,
  type PlanCatalog,
  type PlanEnv,
} from "@/lib/plans";
import type { PaddleEnvironment } from "@/lib/paddle";

/** The refusals that open the dialog (lib/creative/operations CREATIVE_ERRORS). */
export const UPSELL_CODES = ["entitlement_required", "run_limit_reached", "insufficient_credits"] as const;
export type UpsellCode = (typeof UPSELL_CODES)[number];

export function isUpsellCode(v: unknown): v is UpsellCode {
  return typeof v === "string" && (UPSELL_CODES as readonly string[]).includes(v);
}

/** Where the dialog's links go: existing pages only. The Credits page owns every checkout. */
export const UPSELL_LINKS = {
  /** The plan cards on the Credits page (PlanPanel, `id="plans"`). */
  plans: "/credits#plans",
  /** The top-up packs on the Credits page (BuyCredits, `id="topups"`). */
  topups: "/credits#topups",
  /** The extra-credits switch on the Usage page (0094). */
  extraCredits: "/usage#extra",
  /** The public plan comparison. Not channel-scoped. */
  compare: "/pricing",
} as const;

/** How many plan cards the dialog shows at most (cheapest first). */
export const UPSELL_MAX_PLANS = 3;

// ── what the server hands the browser ────────────────────────────────────────

export interface UpsellPlan {
  id: string;
  name: string;
  monthlyCredits: number;
  /** The owner's display price as written; null = the price is shown at checkout. */
  price: string | null;
  /** key -> value, every entitlement key (defaults applied, as lib/plans coerces them). */
  values: Record<string, EntitlementValue>;
}

export interface UpsellKey {
  key: string;
  type: EntitlementType;
  enforced: boolean;
}

export interface UpsellCatalog {
  /**
   * Plans that can be subscribed to here (a checkout exists), cheapest first.
   * null = the catalog could not be read: unknown, never "no plans".
   */
  plans: UpsellPlan[] | null;
  keys: UpsellKey[];
  /** The organization's plan, when its billing summary was read. */
  currentPlanId: string | null;
  /** Its monthly allowance, when known. */
  currentMonthlyCredits: number | null;
  /** billing_summary's parallel-run limit, when known (a fallback for a refusal without one). */
  runLimit: number | null;
}

/**
 * The catalog the dialog may offer from, built on the server from the same
 * reads the Credits page makes. A plan is offered only when this deployment
 * can actually sell it (a Paddle price id with Paddle configured) — the
 * matrix's own rule; the price id itself never reaches the browser.
 * Returns null for an organization that never pays (credit-exempt): it can
 * never be refused for credits or plans, and must never be shown an offer.
 */
export function upsellCatalog(
  catalog: PlanCatalog | null,
  catalogRead: "ok" | "unsupported" | "failed",
  summary: BillingSummary | null,
  env: PlanEnv,
  paddle: { environment: PaddleEnvironment; clientToken: string } | null,
  exempt: boolean,
): UpsellCatalog | null {
  if (exempt || summary?.exempt) return null;
  const currentPlanId = summary?.plan?.id ?? null;
  const base = {
    currentPlanId,
    currentMonthlyCredits: summary?.plan ? summary.plan.monthlyCredits : null,
    runLimit: summary?.runSlots?.limit ?? null,
  };
  if (catalogRead === "failed" || (catalogRead === "ok" && !catalog)) return { ...base, plans: null, keys: [] };
  if (!catalog) return { ...base, plans: [], keys: [] };
  const matrix = planMatrix(catalog, env, paddle);
  const plans: UpsellPlan[] = (matrix?.columns ?? []).flatMap((col) => {
    if (col.isDefault || col.priceId === null) return [];
    const view = columnPrice(col, null, false);
    return [
      {
        id: col.id,
        name: col.name,
        monthlyCredits: col.monthlyCredits,
        price: view.kind === "display" ? view.text : null,
        values: { ...(catalog.values[col.id] ?? {}) },
      },
    ];
  });
  return {
    ...base,
    plans,
    keys: catalog.keys.map((k) => ({ key: k.key, type: k.valueType, enforced: k.enforced })),
  };
}

// ── the refusal ──────────────────────────────────────────────────────────────

export interface Refusal {
  code: UpsellCode;
  /** insufficient_credits: what is spendable and what this needed (0036's own figures). */
  available: number | null;
  needed: number | null;
  /** run_limit_reached: runs in progress and the plan's limit (0034's figures). */
  active: number | null;
  limit: number | null;
  /** The database's sentence, when the route passed one on. */
  detail: string | null;
  /** insufficient_credits: the workspace has extra credits switched OFF (0094), so `available` is what its plan side can pay. */
  extraOff: boolean;
  /** With extraOff: the credits waiting in packs, when the refusal said. */
  extra: number | null;
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The route's error body -> the figures the dialog may show. Anything malformed is unknown, never 0. */
export function refusalFrom(code: UpsellCode, body: unknown): Refusal {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return {
    code,
    available: fin(b.available),
    needed: fin(b.needed),
    active: fin(b.active),
    limit: fin(b.limit),
    detail: typeof b.detail === "string" ? b.detail.slice(0, 300) : null,
    extraOff: b.extra_off === true,
    extra: fin(b.extra),
  };
}

// ── what unlocks what ────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { none: 0, basic: 1, premium: 2, ultra: 3, all: 3 };

/** 0035's entitlement shape: `key` or `key:value` (model_registry_entitlement_check). */
export function parseEntitlement(v: unknown): { key: string; value: string | null } | null {
  if (typeof v !== "string") return null;
  const m = /^([a-z][a-z0-9_]{1,40})(?::([a-z0-9_]{1,20}))?$/.exec(v);
  return m ? { key: m[1], value: m[2] ?? null } : null;
}

/**
 * Does a plan's value grant what a model asks for? The same reading 0034's
 * has_entitlement_internal / model_tier_allowed give: a bool must be true, a
 * number must reach the one asked for (or be positive), a tier must rank at
 * least as high (or be anything but none).
 */
export function grants(type: EntitlementType, have: EntitlementValue | undefined, want: string | null): boolean {
  if (have === undefined) return false;
  if (type === "bool") return have === true;
  if (type === "int") {
    if (typeof have !== "number") return false;
    if (want === null) return have > 0;
    const n = Number(want);
    return Number.isInteger(n) && have >= n;
  }
  if (typeof have !== "string" || !(have in TIER_RANK)) return false;
  if (want === null) return have !== "none";
  return want in TIER_RANK && TIER_RANK[have] >= TIER_RANK[want];
}

export type UpsellReason = "first_purchase" | "plan_feature" | "not_open" | "run_limit" | "credits";

export interface UpsellView {
  reason: UpsellReason;
  /** Plans that unlock it (cheapest first, at most UPSELL_MAX_PLANS); empty = none offered. */
  plans: UpsellPlan[];
  /** The entitlement each card names under its credits, or null (monthly credits only). */
  highlight: UpsellKey | null;
  /** For a plan_feature refusal: the tier/value asked for (e.g. "premium"), when the entitlement names one. */
  wanted: string | null;
  /** Offer "Buy credits" (the Credits page's top-up packs). */
  buyCredits: boolean;
  /** run_limit: the plan's limit, when known. */
  limit: number | null;
  /** credits: the database's figures, when known. */
  available: number | null;
  needed: number | null;
  /** credits: refused because extra credits are off — turning them on is the first answer. */
  extraOff: { extra: number | null } | null;
  /** The plans could not be read: say so instead of showing none. */
  plansUnread: boolean;
}

function offerable(data: UpsellCatalog | null): UpsellPlan[] {
  return (data?.plans ?? []).filter((p) => p.id !== data?.currentPlanId);
}

/**
 * What the dialog says and offers for one refusal. `entitlement` is the
 * refused model's own (0035's model_registry.entitlement through
 * sellable_models()); undefined when it is not known on this page.
 */
export function upsellView(
  refusal: Refusal,
  entitlement: string | null | undefined,
  data: UpsellCatalog | null,
): UpsellView {
  const view: UpsellView = {
    reason: "not_open",
    plans: [],
    highlight: null,
    wanted: null,
    buyCredits: false,
    limit: null,
    available: null,
    needed: null,
    extraOff: null,
    plansUnread: data?.plans === null,
  };
  const take = (plans: UpsellPlan[]) => plans.slice(0, UPSELL_MAX_PLANS);

  if (refusal.code === "insufficient_credits") {
    const floor = data?.currentMonthlyCredits ?? null;
    return {
      ...view,
      reason: "credits",
      buyCredits: true,
      available: refusal.available,
      needed: refusal.needed,
      extraOff: refusal.extraOff ? { extra: refusal.extra } : null,
      plans: take(offerable(data).filter((p) => floor === null || p.monthlyCredits > floor)),
    };
  }

  if (refusal.code === "run_limit_reached") {
    const limit = refusal.limit ?? data?.runLimit ?? null;
    const key = data?.keys.find((k) => k.key === "concurrency" && k.enforced && k.type === "int") ?? null;
    const plans =
      key && limit !== null
        ? offerable(data).filter((p) => typeof p.values.concurrency === "number" && p.values.concurrency > limit)
        : [];
    return { ...view, reason: "run_limit", limit, highlight: key, plans: take(plans) };
  }

  // entitlement_required
  const firstPurchase =
    entitlement === "paid" || (entitlement === undefined && /first credit purchase/i.test(refusal.detail ?? ""));
  if (firstPurchase) return { ...view, reason: "first_purchase", buyCredits: true, plansUnread: false };
  const ent = parseEntitlement(entitlement);
  const key = ent ? (data?.keys.find((k) => k.key === ent.key && k.enforced) ?? null) : null;
  if (!ent || !key) return view;
  const plans = offerable(data).filter((p) => grants(key.type, p.values[key.key], ent.value));
  if (plans.length === 0) return view;
  return { ...view, reason: "plan_feature", highlight: key, wanted: ent.value, plans: take(plans) };
}
