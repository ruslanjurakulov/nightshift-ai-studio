/**
 * The owner's "prices and budget" view (/{channel}/models?view=budget): every registry model with the vendor's price as
 * schemas/model_registry.json states it, and a calculator that turns a dollar amount into "how many videos / images /
 * minutes" at that price.
 *
 * Pure and client-safe: the page builds BudgetModel rows on the server from model_registry_admin() (the synced registry
 * file, refused by the database to anyone but a platform admin; the page narrows it further to the platform owner) and the
 * owner's price list, and the browser only does arithmetic on them.
 *
 * Nothing here invents a price (CLAUDE.md #5): a model whose registry entry has no positive price for any option is
 * "no price in the registry", never 0 and never a neighbour's price. Every count is rounded DOWN, so the figure is what
 * the amount surely covers at the list price, not a promise. The registry marks every price with `confirmed`; an
 * unconfirmed one is an estimate and the view says so.
 */
import { MODEL_ID_RE, isAvailability, type Availability } from "@/lib/models-admin";
import { discoverySpec, priceVariants, publicSpecOf, rateOf, type PriceUnit } from "@/lib/models-discovery";

export type BudgetKind = "video" | "image" | "audio" | "other";
export const BUDGET_KINDS: readonly BudgetKind[] = ["video", "image", "audio", "other"];

/** The registry's `pricing.variants.by` values (schemas/model_registry.schema.json). */
export type VariantsBy = "resolution" | "image_size" | "upscale_target" | "quality" | "audio" | "resolution_audio";
const VARIANTS_BY: readonly string[] = ["resolution", "image_size", "upscale_target", "quality", "audio", "resolution_audio"];

/** The `base` option: `pricing.provider_usd_per_unit` itself. Every other option key is a `pricing.variants.prices` key. */
export const BASE = "base";

export interface BudgetOption {
  /** BASE, or the registry's own variant key ("720p", "1K", "low", "720p_audio", ...). */
  key: string;
  /** USD per unit, as the registry states it. Always positive and finite: an unpriced variant is never an option. */
  usd: number;
  /** Credits per unit a customer is charged for this option (the price list with its markup), or null when there is none. */
  customerCredits: number | null;
}

/** Why the calculator starts on the option it starts on; the view says it in words. */
export type DefaultWhy = "default_resolution" | "base" | "cheapest_variant";

export interface BudgetModel {
  id: string;
  displayName: string;
  provider: string;
  kind: BudgetKind;
  unit: PriceUnit | null;
  /** The sale state of 0035 (null when the row carried none we know). */
  availability: Availability | null;
  /** spec.terms_gate: the vendor's terms are not yet cleared, so the model cannot be sold. */
  termsGate: string | null;
  /** spec.shutdown.on: the vendor's announced shutdown date, and whether it has passed. */
  shutdownOn: string | null;
  pastShutdown: boolean;
  /** pricing.confirmed is false: the registry calls its figure unconfirmed. */
  estimate: boolean;
  /** pricing.as_of: the day the price was read. */
  asOf: string | null;
  variantsBy: VariantsBy | null;
  /** Priced options, base first. Empty = no price in the registry. */
  options: BudgetOption[];
  /** The variant keys that equal the base price (shown beside "base price"). */
  baseMatches: string[];
  /** Variant keys the registry lists with no price: never offered as an option. */
  unpricedVariants: string[];
  defaultOption: string | null;
  defaultWhy: DefaultWhy | null;
  /** spec.durations_s, ascending (videos and tracks are made in these lengths only). */
  durations: number[];
  /** Seconds the vendor bills a job at least, when the registry states one (only for per-second units). */
  floorSeconds: number | null;
  /** The price list could not be read: customer prices are unknown, not missing. */
  customerUnread: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** A registry price: a positive, finite number, or null. 0 is no price (a division by it would be "infinitely many"). */
export const positivePrice = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

const UNITS: readonly string[] = ["image", "second", "character", "request"];

export function kindOf(output: unknown): BudgetKind {
  return output === "video" || output === "image" || output === "audio" ? output : "other";
}

/**
 * The billing floor, in seconds, when the registry's own words state one ("a 10-second billing floor", "10 s billing
 * floor"). The schema has no field for it, so it lives in the notes; tests/test_sonilo.py pins that wording. A model whose
 * notes say nothing has no floor here: the calculator never assumes one.
 */
export function floorSecondsOf(spec: unknown): number | null {
  if (!isObj(spec)) return null;
  const pricing = isObj(spec.pricing) ? spec.pricing : {};
  if (pricing.unit !== "second") return null;
  const api = isObj(spec.api_documented) ? spec.api_documented : {};
  for (const note of [pricing.note, api.note]) {
    if (typeof note !== "string") continue;
    const m = /(\d{1,4})(?:-second| ?s) billing floor/i.exec(note);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

/** The customer's rate per option, read the way the quote reads the price list (lib/models-discovery.ts priceVariants). */
function customerRates(
  creditUnit: string | null,
  spec: Obj,
  charged: Record<string, number> | null,
): (key: string) => number | null {
  if (!creditUnit || charged === null) return () => null;
  const variants = priceVariants(creditUnit, discoverySpec(publicSpecOf(spec)));
  if (!variants) {
    // One flat row for the model: every option is charged the same.
    const flat = rateOf(charged, creditUnit);
    return () => flat;
  }
  const byKey = new Map(variants.map((v) => [v.parts.join("_"), rateOf(charged, v.key)]));
  // A variant-priced model is charged per variant row; the base row is not what any job of it pays.
  return (key) => (key === BASE ? null : (byKey.get(key) ?? null));
}

/**
 * One model_registry_admin() row as the view's model, or null when the row is not a model at all. `charged` is the price
 * list AS CHARGED (unit -> credits per unit, markup folded in), or null when it could not be read. `today` is YYYY-MM-DD.
 */
export function budgetModelOf(row: unknown, charged: Record<string, number> | null, today: string): BudgetModel | null {
  if (!isObj(row)) return null;
  const id = str(row.id);
  const provider = str(row.provider);
  if (!id || !MODEL_ID_RE.test(id) || !provider) return null;
  const spec = isObj(row.spec) ? row.spec : {};
  const pricing = isObj(spec.pricing) ? spec.pricing : {};
  const unit = typeof pricing.unit === "string" && UNITS.includes(pricing.unit) ? (pricing.unit as PriceUnit) : null;
  const base = positivePrice(pricing.provider_usd_per_unit);
  const rawVariants = isObj(pricing.variants) ? pricing.variants : null;
  const variantsBy = rawVariants && typeof rawVariants.by === "string" && VARIANTS_BY.includes(rawVariants.by) ? (rawVariants.by as VariantsBy) : null;
  const prices = variantsBy && rawVariants && isObj(rawVariants.prices) ? rawVariants.prices : {};
  const rate = customerRates(str(row.credit_unit), spec, charged);

  const priced: BudgetOption[] = [];
  const unpricedVariants: string[] = [];
  for (const [key, v] of Object.entries(prices)) {
    const usd = positivePrice(v);
    if (usd === null) unpricedVariants.push(key);
    else priced.push({ key, usd, customerCredits: rate(key) });
  }
  const baseMatches = base === null ? [] : priced.filter((o) => o.usd === base).map((o) => o.key);

  // The option the calculator starts on: the registry's default resolution when it is priced; else the base price (or the
  // one variant that IS the base price, so its own customer row applies); else the cheapest priced variant.
  let defaultOption: string | null = null;
  let defaultWhy: DefaultWhy | null = null;
  const defaultRes = str(spec.default_resolution);
  if (unit !== null) {
    if (variantsBy === "resolution" && defaultRes && priced.some((o) => o.key === defaultRes)) {
      defaultOption = defaultRes;
      defaultWhy = "default_resolution";
    } else if (base !== null) {
      defaultOption = baseMatches.length === 1 ? baseMatches[0] : BASE;
      defaultWhy = "base";
    } else if (priced.length) {
      defaultOption = priced.reduce((a, b) => (b.usd < a.usd ? b : a)).key;
      defaultWhy = "cheapest_variant";
    }
  }
  // "base" is its own option only when no single variant already says the same price.
  const options = unit === null ? [] : [...(base !== null && baseMatches.length !== 1 ? [{ key: BASE, usd: base, customerCredits: rate(BASE) }] : []), ...priced];

  const shutdown = isObj(spec.shutdown) ? spec.shutdown : null;
  const shutdownOn = shutdown ? str(shutdown.on) : null;
  const durations = Array.isArray(spec.durations_s)
    ? [...new Set(spec.durations_s.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d > 0))].sort((a, b) => a - b)
    : [];

  return {
    id,
    displayName: str(row.display_name) ?? id,
    provider,
    kind: kindOf(spec.output),
    unit,
    availability: isAvailability(row.availability) ? row.availability : null,
    termsGate: str(spec.terms_gate),
    shutdownOn,
    pastShutdown: shutdownOn !== null && shutdownOn <= today,
    estimate: pricing.confirmed !== true,
    asOf: str(pricing.as_of),
    variantsBy,
    options,
    baseMatches,
    unpricedVariants,
    defaultOption,
    defaultWhy,
    durations,
    floorSeconds: floorSecondsOf(spec),
    customerUnread: charged === null,
  };
}

/** Every row, grouped by kind in the view's order, each group by provider then name. Rows that are not models are dropped. */
export function budgetModelsFrom(rows: unknown, charged: Record<string, number> | null, today: string): Record<BudgetKind, BudgetModel[]> {
  const out: Record<BudgetKind, BudgetModel[]> = { video: [], image: [], audio: [], other: [] };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const m = budgetModelOf(r, charged, today);
    if (m) out[m.kind].push(m);
  }
  for (const k of BUDGET_KINDS) out[k].sort((a, b) => a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName));
  return out;
}

// ── the calculator ────────────────────────────────────────────────────────────

/** The largest amount the calculator takes. Past it the figures stop meaning anything; it reads as invalid. */
export const MAX_BUDGET_USD = 1_000_000_000;

/**
 * A typed amount in dollars, or null for anything that is not one: empty, words, a negative, zero, more than one
 * separator, past MAX_BUDGET_USD. A comma is a decimal separator too ("10,5"): Russian and Uzbek write it that way.
 */
export function parseBudget(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 && raw <= MAX_BUDGET_USD ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^\$\s*/, "");
  if (!/^\d{1,10}(?:[.,]\d{1,6})?$/.test(s)) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 && n <= MAX_BUDGET_USD ? n : null;
}

/**
 * Round down, forgiving the floating-point dust of a division that is exact on paper ($10 / $0.00004 is 249999.99999999997
 * in binary, and is 250 000 characters). The tolerance is relative and far below one unit of anything counted here.
 */
export function floorCount(x: number): number {
  // Not a number stays not a number, so computeBudget can refuse it; it must never read as "0 videos".
  if (!Number.isFinite(x)) return Number.NaN;
  if (x <= 0) return 0;
  return Math.floor(x * (1 + 1e-9));
}

/** Minutes, rounded down to one decimal. */
export function floorMinutes(seconds: number): number {
  return floorCount((seconds / 60) * 10) / 10;
}

export type BudgetResult =
  /** Nothing typed, or not an amount: the view shows nothing. */
  | { kind: "empty" }
  /** The registry has no price for this model (or this option): the view says so, and never a number. */
  | { kind: "no_price" }
  /** A video model with set lengths: `count` clips of `durationS` (each billed `billedS`), `minutes` of video in all. */
  | { kind: "videos"; count: number; durationS: number; billedS: number; minutes: number }
  /** Per second with no set length (video edits, dubbing, voice change, transcription), or audio: minutes in all, and
   *  for audio with set lengths, how many of the chosen length. */
  | { kind: "seconds"; minutes: number; clips: { count: number; durationS: number; billedS: number } | null; floorSeconds: number | null }
  | { kind: "images"; count: number }
  | { kind: "characters"; count: number }
  | { kind: "requests"; count: number };

export interface BudgetInput {
  budget: unknown;
  kind: BudgetKind;
  unit: PriceUnit | null;
  /** The chosen option's USD per unit. */
  usdPerUnit: unknown;
  /** The chosen length in seconds (video and audio with set lengths), or null. */
  durationS?: number | null;
  floorSeconds?: number | null;
}

/** What `budget` dollars buy at `usdPerUnit`, rounded down. Never NaN or Infinity: the answer is a count or a kind with none. */
export function computeBudget(input: BudgetInput): BudgetResult {
  const budget = parseBudget(input.budget);
  if (budget === null) return { kind: "empty" };
  const price = positivePrice(input.usdPerUnit);
  if (price === null || input.unit === null) return { kind: "no_price" };
  const floor = typeof input.floorSeconds === "number" && Number.isInteger(input.floorSeconds) && input.floorSeconds > 0 ? input.floorSeconds : null;
  const d = typeof input.durationS === "number" && Number.isInteger(input.durationS) && input.durationS > 0 ? input.durationS : null;

  let out: BudgetResult;
  switch (input.unit) {
    case "image":
      out = { kind: "images", count: floorCount(budget / price) };
      break;
    case "character":
      out = { kind: "characters", count: floorCount(budget / price) };
      break;
    case "request":
      out = { kind: "requests", count: floorCount(budget / price) };
      break;
    case "second": {
      // A job shorter than the floor is billed the floor.
      const billed = d === null ? null : Math.max(d, floor ?? 0);
      if (input.kind === "video" && d !== null && billed !== null) {
        const count = floorCount(budget / (billed * price));
        out = { kind: "videos", count, durationS: d, billedS: billed, minutes: floorMinutes(count * d) };
      } else {
        const clips = d !== null && billed !== null ? { count: floorCount(budget / (billed * price)), durationS: d, billedS: billed } : null;
        out = { kind: "seconds", minutes: floorMinutes(budget / price), clips, floorSeconds: floor };
      }
      break;
    }
    default:
      out = { kind: "no_price" };
  }
  const numbers = Object.values(out).flatMap((v) => (typeof v === "number" ? [v] : isObj(v) ? Object.values(v).filter((x) => typeof x === "number") : []));
  return numbers.every((n) => Number.isFinite(n)) ? out : { kind: "no_price" };
}

/** The option of a model by key, or null. */
export function optionOf(m: Pick<BudgetModel, "options">, key: string | null): BudgetOption | null {
  return key === null ? null : (m.options.find((o) => o.key === key) ?? null);
}

/** The length the calculator starts on: the shortest the model makes, which is also the cheapest job. */
export function defaultDuration(m: Pick<BudgetModel, "durations">): number | null {
  return m.durations.length ? m.durations[0] : null;
}

/** The model's own starting answer for an amount: its default option and shortest length. */
export function computeForModel(m: BudgetModel, budget: unknown, optionKey: string | null = m.defaultOption, durationS: number | null = defaultDuration(m)): BudgetResult {
  const opt = optionOf(m, optionKey);
  if (parseBudget(budget) === null) return { kind: "empty" };
  if (!opt) return { kind: "no_price" };
  return computeBudget({ budget, kind: m.kind, unit: m.unit, usdPerUnit: opt.usd, durationS, floorSeconds: m.floorSeconds });
}
