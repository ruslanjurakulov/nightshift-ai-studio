/**
 * The Models screen's catalog — the pure, client-safe half (tests:
 * tests/models-discovery.test.ts).
 *
 * Everything a tile or the detail pane says is read from the registry
 * (migration 0035 and its successors), the live price list (0020's
 * credit_prices) and, for the operator, the probe log. Nothing here invents a
 * setting, a rate or a state: a value the registry does not declare is not
 * shown, a rate the price list does not hold reads as words (never 0), and a
 * state is derived from the same facts the database checks before it sells a
 * model (CLAUDE.md #5).
 *
 * Two readers, two sources:
 *  - a customer sees sellable_models() — only what the database would sell
 *    them — so every model is either available or plan-gated;
 *  - the platform operator sees model_registry_admin() — the whole registry —
 *    so a model can also need a probe or be unavailable, with the reasons.
 */

import { MODEL_ID_RE } from "@/lib/models-admin";

// ── tasks ───────────────────────────────────────────────────────────────────

/** The registry's capabilities (0072's model_registry_capabilities_check). */
export const REGISTRY_CAPABILITIES = [
  "t2i",
  "edit",
  "t2v",
  "i2v",
  "tts",
  "sfx",
  "upscale",
  "remove_bg",
  "voice_change",
  "dub",
  "video_upscale",
  "describe",
  "captions",
] as const;
export type RegistryCapability = (typeof REGISTRY_CAPABILITIES)[number];

export function isRegistryCapability(v: unknown): v is RegistryCapability {
  return typeof v === "string" && (REGISTRY_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * The catalog's categories, by what a person wants done. Several map to one
 * capability on purpose: speech to text and captions are the same call (a
 * recording's words, timed), offered as the two jobs people look for.
 */
export const TASKS = [
  { id: "image", caps: ["t2i"] },
  { id: "edit", caps: ["edit"] },
  { id: "video_text", caps: ["t2v"] },
  { id: "video_image", caps: ["i2v"] },
  { id: "voice", caps: ["tts", "voice_change"] },
  { id: "speech_to_text", caps: ["captions"] },
  { id: "sound", caps: ["sfx"] },
  { id: "upscale", caps: ["upscale", "video_upscale"] },
  { id: "remove_bg", caps: ["remove_bg"] },
  { id: "dub", caps: ["dub"] },
  { id: "describe", caps: ["describe"] },
  { id: "captions", caps: ["captions"] },
] as const satisfies readonly { id: string; caps: readonly RegistryCapability[] }[];
export type TaskId = (typeof TASKS)[number]["id"];

export function isTaskId(v: unknown): v is TaskId {
  return typeof v === "string" && TASKS.some((t) => t.id === v);
}

export function taskCaps(task: TaskId): readonly RegistryCapability[] {
  return TASKS.find((t) => t.id === task)?.caps ?? [];
}

/** The tasks a model does, in catalog order. */
export function tasksOf(capabilities: readonly string[]): TaskId[] {
  return TASKS.filter((t) => t.caps.some((c) => capabilities.includes(c))).map((t) => t.id);
}

// ── what goes in, what comes out ────────────────────────────────────────────

export const INPUT_KINDS = ["text", "image", "video", "audio"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
export const OUTPUT_KINDS = ["image", "video", "audio", "text"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/**
 * What each capability is given — from the parameters the database accepts
 * for it (creative_params_problem / creative_source_problem): words, a library
 * picture, a library video, or a library recording (audio or video).
 */
const CAP_INPUTS: Record<RegistryCapability, readonly InputKind[]> = {
  t2i: ["text"],
  edit: ["image", "text"],
  t2v: ["text"],
  i2v: ["image", "text"],
  tts: ["text"],
  sfx: ["text"],
  upscale: ["image"],
  remove_bg: ["image"],
  voice_change: ["audio", "video"],
  dub: ["audio", "video"],
  video_upscale: ["video"],
  describe: ["image"],
  captions: ["audio", "video"],
};

/**
 * Every kind a model can be given, over all its capabilities. The registry's
 * image_refs_max is not counted: no Studio tool sends reference pictures yet,
 * so a filter on it would promise an input nobody can give.
 */
export function inputKindsOf(m: Pick<DiscoveryModel, "capabilities">): InputKind[] {
  const kinds = new Set<InputKind>();
  for (const c of m.capabilities) for (const k of CAP_INPUTS[c] ?? []) kinds.add(k);
  return INPUT_KINDS.filter((k) => kinds.has(k));
}

/**
 * The file types the database takes as a capability's source, by MIME type —
 * verbatim from the latest creative_picture_problem (0052) and
 * creative_source_problem (0072); tests/models-discovery.test.ts pins them to
 * that SQL. A GIF is refused as a picture source. Words have no file type.
 */
export const PICTURE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export const VIDEO_MIME = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"] as const;
export const RECORDING_MIME = [
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
] as const;
/** dub and captions also take these two (0072). */
export const RECORDING_EXTRA_MIME = ["audio/aac", "audio/webm"] as const;

const MIME_LABEL: Record<string, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "image/heic": "HEIC",
  "image/heif": "HEIF",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "video/webm": "WebM",
  "video/x-matroska": "MKV",
  "audio/mpeg": "MP3",
  "audio/mp4": "M4A",
  "audio/wav": "WAV",
  "audio/ogg": "OGG",
  "audio/flac": "FLAC",
  "audio/aac": "AAC",
  "audio/webm": "WebM",
};

/** The source limits the database enforces (0072), where it states one. */
const SOURCE_LIMITS: Partial<Record<RegistryCapability, { seconds?: number; mb?: number }>> = {
  voice_change: { seconds: 300, mb: 512 },
  dub: { seconds: 1800, mb: 512 },
  captions: { seconds: 1800, mb: 512 },
  video_upscale: { mb: 200 },
  describe: { mb: 15 },
};

export type SourceKind = "picture" | "video" | "recording";

export interface SourceRule {
  kind: SourceKind;
  /** File type names, deduplicated, in the database's order. */
  formats: string[];
  /** The longest source the database or the model takes (the shorter wins); null = none stated. */
  maxSeconds: number | null;
  maxMb: number | null;
}

/** What a capability starts from, if it starts from a file. Words-only capabilities return null. */
export function sourceRule(cap: RegistryCapability, modelMaxSeconds: number | null = null): SourceRule | null {
  let kind: SourceKind;
  let mimes: readonly string[];
  if (cap === "edit" || cap === "i2v" || cap === "upscale" || cap === "remove_bg" || cap === "describe") {
    kind = "picture";
    mimes = PICTURE_MIME;
  } else if (cap === "video_upscale") {
    kind = "video";
    mimes = VIDEO_MIME;
  } else if (cap === "voice_change") {
    kind = "recording";
    mimes = RECORDING_MIME;
  } else if (cap === "dub" || cap === "captions") {
    kind = "recording";
    mimes = [...RECORDING_MIME, ...RECORDING_EXTRA_MIME];
  } else {
    return null;
  }
  const formats = [...new Set(mimes.map((m) => MIME_LABEL[m] ?? m))];
  const limit = SOURCE_LIMITS[cap] ?? {};
  const seconds = [limit.seconds, modelMaxSeconds].filter((s): s is number => typeof s === "number" && s > 0);
  return {
    kind,
    formats,
    maxSeconds: seconds.length ? Math.min(...seconds) : null,
    maxMb: limit.mb ?? null,
  };
}

// ── the model ───────────────────────────────────────────────────────────────

export type PriceUnit = "image" | "second" | "character" | "request";

/**
 * The public half of a model's spec — exactly the keys sellable_models()
 * returns (0072) — as the screen uses them. Lenient on purpose: a key the
 * registry does not give is empty or null, and the screen then shows nothing
 * for it rather than a default that reads like a fact.
 */
export interface DiscoverySpec {
  output: OutputKind | null;
  unit: PriceUnit | null;
  imageRefsMax: number;
  aspectRatios: string[];
  aspectRatiosByCapability: Partial<Record<RegistryCapability, string[]>>;
  imageSizes: string[];
  qualities: string[];
  resolutions: string[];
  defaultResolution: string | null;
  durationsS: number[];
  audioOut: boolean;
  upscaleFactors: number[];
  upscaleTargets: string[];
  languages: string[];
  endFrame: boolean;
  maxSourceSeconds: number | null;
  maxPromptChars: number | null;
  qualityTier: number | null;
  speedTier: number | null;
  priceVariantsBy: string | null;
  attribution: { text: string; url: string } | null;
  webOnly: boolean;
}

export type Stage = "hidden" | "beta" | "ga" | "disabled";
export type DiscoveryState = "available" | "needs_probe" | "plan_gated" | "unavailable";
export const DISCOVERY_STATES: readonly DiscoveryState[] = ["available", "plan_gated", "needs_probe", "unavailable"];

export type Reason =
  | { kind: "not_verified" }
  | { kind: "probe_failed"; code: string | null; at: string }
  | { kind: "terms_gate"; gate: string }
  | { kind: "hidden" }
  | { kind: "disabled" }
  | { kind: "removed" }
  | { kind: "no_unit" }
  | { kind: "unpriced" }
  | { kind: "entitlement"; key: string; value: string | null }
  | { kind: "first_purchase" };

export type PriceView =
  /** The price list could not be read: no rate is shown. */
  | { kind: "unread" }
  /** The model has no credit unit (operator only): it cannot be priced. */
  | { kind: "no_unit" }
  /** One rate per unit; null = the list has no positive price for it. */
  | { kind: "flat"; rate: number | null }
  /** Priced per variant (quality, resolution, soundtrack, upscale size); each null = not priced. */
  | { kind: "variants"; rows: { key: string; parts: string[]; rate: number | null }[]; from: number | null };

export interface DiscoveryModel {
  id: string;
  displayName: string;
  provider: string;
  capabilities: RegistryCapability[];
  stage: Stage;
  state: DiscoveryState;
  /** Why the state is what it is, most important first (an available model may still carry a note, e.g. a failed re-probe). */
  reasons: Reason[];
  entitlement: string | null;
  verifiedAt: string | null;
  /** The newest probe (operator view only); null = none, or not read. */
  probe: { ok: boolean; code: string | null; at: string } | null;
  spec: DiscoverySpec;
  creditUnit: string | null;
  price: PriceView;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const tier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

/**
 * The public half of a FULL spec, for the operator's view: the same keys
 * sellable_models() builds (0072), and nothing else. The full spec carries
 * provider USD costs, vendor ids, evidence and internal notes; this is the
 * only shape of it that may reach a browser.
 */
export function publicSpecOf(spec: unknown): Obj {
  if (!isObj(spec)) return {};
  const pricing = isObj(spec.pricing) ? spec.pricing : {};
  const variants = isObj(pricing.variants) ? pricing.variants : {};
  const out: Obj = {
    output: spec.output,
    inputs: spec.inputs,
    aspect_ratios: spec.aspect_ratios,
    aspect_ratios_by_capability: spec.aspect_ratios_by_capability,
    image_sizes: spec.image_sizes,
    resolutions: spec.resolutions,
    durations_s: spec.durations_s,
    audio_out: spec.audio_out,
    upscale_factors: spec.upscale_factors,
    languages: spec.languages,
    upscale_targets: spec.upscale_targets,
    end_frame: spec.end_frame,
    async: spec.async,
    unit: pricing.unit,
    qualities: spec.qualities,
    default_resolution: spec.default_resolution,
    price_variants_by: variants.by,
    attribution: spec.attribution,
    api_exposure: spec.api_exposure,
    limits: spec.limits,
    quality_tier: spec.quality_tier,
    speed_tier: spec.speed_tier,
  };
  // jsonb_strip_nulls: an absent key and a null one read the same.
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}

/** A public spec (sellable_models()'s, or publicSpecOf's) as the screen reads it. */
export function discoverySpec(raw: unknown): DiscoverySpec {
  const v = isObj(raw) ? raw : {};
  const output = v.output === "image" || v.output === "video" || v.output === "audio" || v.output === "text" ? v.output : null;
  const unit = v.unit === "image" || v.unit === "second" || v.unit === "character" || v.unit === "request" ? v.unit : null;
  const limits = isObj(v.limits) ? v.limits : {};
  const inputs = isObj(v.inputs) ? v.inputs : {};
  const byCap: Partial<Record<RegistryCapability, string[]>> = {};
  if (isObj(v.aspect_ratios_by_capability)) {
    for (const [k, list] of Object.entries(v.aspect_ratios_by_capability)) if (isRegistryCapability(k)) byCap[k] = strings(list);
  }
  const attr = v.attribution;
  return {
    output,
    unit,
    imageRefsMax: posInt(inputs.image_refs_max) ?? 0,
    aspectRatios: strings(v.aspect_ratios),
    aspectRatiosByCapability: byCap,
    imageSizes: strings(v.image_sizes),
    qualities: strings(v.qualities),
    resolutions: strings(v.resolutions),
    defaultResolution: str(v.default_resolution),
    durationsS: Array.isArray(v.durations_s) ? v.durations_s.filter((d): d is number => posInt(d) !== null) : [],
    audioOut: v.audio_out === true,
    upscaleFactors: Array.isArray(v.upscale_factors) ? v.upscale_factors.filter((f): f is number => posInt(f) !== null) : [],
    upscaleTargets: strings(v.upscale_targets),
    languages: strings(v.languages),
    endFrame: v.end_frame === true,
    maxSourceSeconds: posInt(limits.max_source_seconds),
    maxPromptChars: posInt(limits.max_prompt_chars),
    qualityTier: tier(v.quality_tier),
    speedTier: tier(v.speed_tier),
    priceVariantsBy: str(v.price_variants_by),
    attribution:
      isObj(attr) && typeof attr.text === "string" && typeof attr.url === "string" && attr.url.startsWith("https://")
        ? { text: attr.text, url: attr.url }
        : null,
    webOnly: v.api_exposure === "web_only",
  };
}

/** The clip may be made with or without sound, each priced apart (0070). */
export function soundChoice(spec: DiscoverySpec): boolean {
  return spec.audioOut && (spec.priceVariantsBy === "audio" || spec.priceVariantsBy === "resolution_audio");
}

// ── price ───────────────────────────────────────────────────────────────────

/** credit_prices rows as unit -> credits_per_unit; null = the list could not be read. */
export type PriceList = Record<string, number> | null;

/** model_registry.credit_unit_for's suffix rule: lower case, anything else becomes `_`. */
const suffix = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "_");

/**
 * The variant rows a model is priced by, in the same shape the quote reads
 * them (creative_price, 0060 / 0052 / 0070): `<unit>_<quality>`,
 * `<unit>_<upscale size>`, `<unit>_<silent|audio>`, `<unit>_<resolution>`
 * (only when the model pins a default resolution) and
 * `<unit>_<resolution>_<silent|audio>`. null = one flat rate (the base row).
 */
export function priceVariants(creditUnit: string, spec: DiscoverySpec): { key: string; parts: string[] }[] | null {
  const by = spec.priceVariantsBy;
  const row = (parts: string[]) => ({ key: [creditUnit, ...parts.map(suffix)].join("_"), parts });
  const sounds = ["silent", "audio"];
  if (by === "quality" && spec.qualities.length) return spec.qualities.map((q) => row([q]));
  if (by === "upscale_target" && spec.upscaleTargets.length) return spec.upscaleTargets.map((t) => row([t]));
  if (by === "audio") return sounds.map((s) => row([s]));
  if (by === "resolution_audio" && spec.resolutions.length) return spec.resolutions.flatMap((r) => sounds.map((s) => row([r, s])));
  if (by === "resolution" && spec.defaultResolution && spec.resolutions.length) return spec.resolutions.map((r) => row([r]));
  return null;
}

/** A positive, finite rate — or null. Never 0 for "not in the list" (CLAUDE.md #5). */
export function rateOf(prices: Record<string, number>, unit: string): number | null {
  const v = prices[unit];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function priceView(creditUnit: string | null, spec: DiscoverySpec, prices: PriceList): PriceView {
  if (!creditUnit) return { kind: "no_unit" };
  if (prices === null) return { kind: "unread" };
  const variants = priceVariants(creditUnit, spec);
  if (!variants) return { kind: "flat", rate: rateOf(prices, creditUnit) };
  const rows = variants.map((v) => ({ ...v, rate: rateOf(prices, v.key) }));
  const known = rows.map((r) => r.rate).filter((r): r is number => r !== null);
  return { kind: "variants", rows, from: known.length ? Math.min(...known) : null };
}

/**
 * A rate as figures. The credit format rounds to two decimals, which would
 * print a per-character voice rate of 0.004 as "0" — a real price shown as
 * free. Below one credit, three significant digits are kept instead.
 */
export function rateText(v: number, locale = "en"): string {
  if (!Number.isFinite(v)) return "—";
  const opts: Intl.NumberFormatOptions = Math.abs(v) < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 };
  return new Intl.NumberFormat(locale, opts).format(v);
}

/** ISO day (UTC), the same on the server and in any browser, in the counter face. */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : iso;
}

/** The lowest rate a person could pay, or null when none is known. */
export function lowestRate(p: PriceView): number | null {
  if (p.kind === "flat") return p.rate;
  if (p.kind === "variants") return p.from;
  return null;
}

// ── availability ────────────────────────────────────────────────────────────

const ENT_RE = /^([a-z][a-z0-9_]{1,40})(?::([a-z0-9_]{1,20}))?$/;

/**
 * The plan gate the database applies when a job is quoted or made
 * (creative_price / create_creative_job, 0072): `any` (or none) is open,
 * `paid` opens after the organization's first credit purchase, and any other
 * entitlement is refused as entitlement_required. null = not gated.
 */
export function planGate(entitlement: string | null): Reason | null {
  if (!entitlement || entitlement === "any") return null;
  if (entitlement === "paid") return { kind: "first_purchase" };
  const m = ENT_RE.exec(entitlement);
  return { kind: "entitlement", key: m ? m[1] : entitlement, value: m ? (m[2] ?? null) : null };
}

/** A sellable_models() row (already checked by coerceSellableModels) as a catalog model. */
export function fromSellableRow(row: unknown, prices: PriceList): DiscoveryModel | null {
  if (!isObj(row)) return null;
  const id = str(row.id);
  const provider = str(row.provider);
  if (!id || !provider) return null;
  if (row.availability !== "beta" && row.availability !== "ga") return null;
  const capabilities = strings(row.capabilities).filter(isRegistryCapability);
  if (!capabilities.length) return null;
  const spec = discoverySpec(row.spec);
  const creditUnit = str(row.credit_unit);
  // The base rate sellable_models() joined is the fallback when the list
  // itself could not be read: it is the same row, read a moment earlier.
  const base = Number(row.credits_per_unit);
  const list = prices ?? (creditUnit && Number.isFinite(base) && base > 0 && !priceVariants(creditUnit, spec) ? { [creditUnit]: base } : null);
  const entitlement = str(row.entitlement);
  const gate = planGate(entitlement);
  return {
    id,
    displayName: str(row.display_name) ?? id,
    provider,
    capabilities,
    stage: row.availability,
    state: gate ? "plan_gated" : "available",
    reasons: gate ? [gate] : [],
    entitlement,
    verifiedAt: str(row.verified_at),
    probe: null,
    spec,
    creditUnit,
    price: priceView(creditUnit, spec, list),
  };
}

export interface AdminRow {
  id: string;
  displayName: string;
  provider: string;
  capabilities: string[];
  availability: Stage;
  verifiedAt: string | null;
  creditUnit: string | null;
  entitlement: string | null;
  termsGate: string | null;
  removedFromFile: boolean;
  /** publicSpecOf(spec): never the full spec. */
  publicSpec: Obj;
}

/**
 * The operator's view of one registry row: the state the database would give
 * it, with every reason it is not on sale. The order of the checks is the
 * order an operator fixes them in: a disabled model first, then a missing
 * probe (nothing else matters until a real call has worked), then terms,
 * unit, price, and finally the hidden switch and the plan gate.
 */
export function fromAdminRow(
  row: AdminRow,
  probe: { ok: boolean; errorCode: string | null; at: string } | null,
  prices: PriceList,
): DiscoveryModel {
  const spec = discoverySpec(row.publicSpec);
  const price = priceView(row.creditUnit, spec, prices);
  const reasons: Reason[] = [];
  if (row.removedFromFile) reasons.push({ kind: "removed" });
  else if (row.availability === "disabled") reasons.push({ kind: "disabled" });
  if (!row.verifiedAt) reasons.push({ kind: "not_verified" });
  if (probe && !probe.ok) reasons.push({ kind: "probe_failed", code: probe.errorCode, at: probe.at });
  if (row.termsGate) reasons.push({ kind: "terms_gate", gate: row.termsGate });
  if (!row.creditUnit) reasons.push({ kind: "no_unit" });
  // Only a list that was read can say a rate is missing.
  else if ((price.kind === "flat" || price.kind === "variants") && (rateOf(prices ?? {}, row.creditUnit) === null || lowestRate(price) === null))
    reasons.push({ kind: "unpriced" });
  if (row.availability === "hidden") reasons.push({ kind: "hidden" });
  const gate = planGate(row.entitlement);
  if (gate) reasons.push(gate);

  const blocked = reasons.some((r) => r.kind === "removed" || r.kind === "disabled");
  const state: DiscoveryState = blocked
    ? "unavailable"
    : !row.verifiedAt
      ? "needs_probe"
      : reasons.some((r) => r.kind === "terms_gate" || r.kind === "no_unit" || r.kind === "unpriced" || r.kind === "hidden")
        ? "unavailable"
        : gate
          ? "plan_gated"
          : "available";
  return {
    id: row.id,
    displayName: row.displayName,
    provider: row.provider,
    capabilities: row.capabilities.filter(isRegistryCapability),
    stage: row.availability,
    state,
    reasons,
    entitlement: row.entitlement,
    verifiedAt: row.verifiedAt,
    probe: probe ? { ok: probe.ok, code: probe.errorCode, at: probe.at } : null,
    spec,
    creditUnit: row.creditUnit,
    price,
  };
}

// ── plan filter ─────────────────────────────────────────────────────────────

export const PLAN_FILTERS = ["none", "basic", "premium", "ultra", "purchase", "other"] as const;
export type PlanFilter = (typeof PLAN_FILTERS)[number];

/** Which plan access a model asks for, as a filter bucket. */
export function planBucket(entitlement: string | null): PlanFilter {
  const gate = planGate(entitlement);
  if (!gate) return "none";
  if (gate.kind === "first_purchase") return "purchase";
  if (gate.kind === "entitlement" && (gate.value === "basic" || gate.value === "premium" || gate.value === "ultra")) return gate.value;
  return "other";
}

// ── search and filters ──────────────────────────────────────────────────────

export interface Filters {
  task: TaskId | "all";
  q: string;
  input: InputKind | "all";
  output: OutputKind | "all";
  state: DiscoveryState | "all";
  plan: PlanFilter | "all";
}

export const NO_FILTERS: Filters = { task: "all", q: "", input: "all", output: "all", state: "all", plan: "all" };

/** Lower case, accents off, Uzbek ʻ/’ folded to ', so "o'zbek" finds "oʻzbek". */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ʻʼ‘’`]/g, "'")
    .toLowerCase();
}

/** Every word of the query must appear somewhere in the text. An empty query matches everything. */
export function matchesQuery(haystack: string, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(haystack);
  return words.every((w) => hay.includes(w));
}

/** What search reads for a model: its names and ids, plus the caller's words for its tasks and output. */
export function searchText(m: DiscoveryModel, words: readonly string[] = []): string {
  return [m.displayName, m.id, m.provider, providerName(m.provider), ...m.capabilities, ...words].join(" \u0001 ");
}

export function matchesFilters(m: DiscoveryModel, f: Filters, words: readonly string[] = []): boolean {
  if (f.task !== "all" && !taskCaps(f.task).some((c) => m.capabilities.includes(c))) return false;
  if (f.input !== "all" && !inputKindsOf(m).includes(f.input)) return false;
  if (f.output !== "all" && m.spec.output !== f.output) return false;
  if (f.state !== "all" && m.state !== f.state) return false;
  if (f.plan !== "all" && planBucket(m.entitlement) !== f.plan) return false;
  return matchesQuery(searchText(m, words), f.q);
}

const STATE_RANK: Record<DiscoveryState, number> = { available: 0, plan_gated: 1, needs_probe: 2, unavailable: 3 };

/** What can be used first, then by name: no ranking the registry does not give. */
export function sortModels(models: DiscoveryModel[]): DiscoveryModel[] {
  return [...models].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.displayName.localeCompare(b.displayName, "en") || a.id.localeCompare(b.id),
  );
}

/** How many models each task has, over the models the other filters leave. */
export function taskCounts(models: DiscoveryModel[], f: Filters, words: (m: DiscoveryModel) => readonly string[] = () => []): Record<TaskId, number> {
  const out = Object.fromEntries(TASKS.map((t) => [t.id, 0])) as Record<TaskId, number>;
  for (const m of models) {
    if (!matchesFilters(m, { ...f, task: "all" }, words(m))) continue;
    for (const t of tasksOf(m.capabilities)) out[t] += 1;
  }
  return out;
}

/** The filters from a URL query; anything unknown is "all" (a stale link still opens the page). */
export function filtersFromQuery(q: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const task = one("task");
  const input = one("input");
  const output = one("output");
  const state = one("state");
  const plan = one("plan");
  return {
    task: isTaskId(task) ? task : "all",
    q: one("q").slice(0, 80),
    input: (INPUT_KINDS as readonly string[]).includes(input) ? (input as InputKind) : "all",
    output: (OUTPUT_KINDS as readonly string[]).includes(output) ? (output as OutputKind) : "all",
    state: (DISCOVERY_STATES as readonly string[]).includes(state) ? (state as DiscoveryState) : "all",
    plan: (PLAN_FILTERS as readonly string[]).includes(plan) ? (plan as PlanFilter) : "all",
  };
}

/** The query string for filters and a picked model (defaults left out). */
export function queryFor(f: Filters, model: string | null, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (f.task !== "all") p.set("task", f.task);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.input !== "all") p.set("input", f.input);
  if (f.output !== "all") p.set("output", f.output);
  if (f.state !== "all") p.set("state", f.state);
  if (f.plan !== "all") p.set("plan", f.plan);
  if (model) p.set("model", model);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── where a model is used ───────────────────────────────────────────────────

/**
 * The Studio composer's tools (lib/creative/studio COMPOSER_CAPABILITIES;
 * lib/navigation STUDIO_TOOLS mirrors it and a test holds the three equal).
 * Kept here so this module stays free of the Studio's imports.
 */
export const STUDIO_TOOL_CAPS = ["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg", "voice_change", "dub", "describe", "video_upscale"] as const;

export type UseLink =
  /** Opens the Studio with the tool and the model chosen: it fills the form, nothing is priced or spent. */
  | { kind: "studio"; cap: RegistryCapability; href: string }
  /** Captions are made in the Editor, on a project's recording. */
  | { kind: "editor"; cap: RegistryCapability; href: string }
  /** No screen uses this capability yet (sound effects). */
  | { kind: "none"; cap: RegistryCapability };

/** Section-relative (`/create?…`): the caller puts the channel in front. */
export function linkFor(cap: RegistryCapability, modelId: string): UseLink {
  if ((STUDIO_TOOL_CAPS as readonly string[]).includes(cap)) {
    const q = new URLSearchParams({ tool: cap, model: modelId });
    return { kind: "studio", cap, href: `/create?${q.toString()}` };
  }
  if (cap === "captions") return { kind: "editor", cap, href: "/editor" };
  return { kind: "none", cap };
}

/** One link per capability the model has, for the given task (or all its tasks), in catalog order. */
export function linksFor(m: Pick<DiscoveryModel, "id" | "capabilities">, task: TaskId | "all" = "all"): UseLink[] {
  const caps = task === "all" ? REGISTRY_CAPABILITIES.filter((c) => m.capabilities.includes(c)) : taskCaps(task).filter((c) => m.capabilities.includes(c));
  return caps.map((c) => linkFor(c, m.id));
}

/**
 * The model the Studio is asked to start with (`/create?tool=…&model=…`),
 * added to a prefill the tool already produced. Shape only: a model that is
 * not one the Studio offers for that tool is ignored by the panel, which then
 * picks the first it does offer. Without a tool there is no prefill to add to.
 */
export function prefillModel<T extends { model: string }>(initial: T | null, raw: unknown): T | null {
  if (!initial) return initial;
  if (typeof raw !== "string" || !MODEL_ID_RE.test(raw)) return initial;
  return { ...initial, model: raw };
}

// ── identity ────────────────────────────────────────────────────────────────

/**
 * How the registry's provider slugs are written: the companies themselves, as
 * they spell their names. An unknown slug is shown as it is, never guessed.
 * The logged-in app may name them; the public site does not.
 */
const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  google: "Google",
  elevenlabs: "ElevenLabs",
  bfl: "Black Forest Labs",
  ideogram: "Ideogram",
  kling: "Kling",
  minimax: "MiniMax",
  runway: "Runway",
  luma: "Luma",
  bytedance: "ByteDance",
  alibaba: "Alibaba",
};

export function providerName(slug: string): string {
  return PROVIDER_NAMES[slug] ?? slug;
}

/** The shape a tile is drawn in: the model's own first shape, so the sheet is not a row of identical cards. */
export function frameAspect(m: Pick<DiscoveryModel, "spec">): string {
  const first = m.spec.aspectRatios[0] ?? Object.values(m.spec.aspectRatiosByCapability).find((l) => l && l.length)?.[0];
  const parsed = first ? /^(\d{1,2}):(\d{1,2})$/.exec(first) : null;
  if (m.spec.output === "image" || m.spec.output === "video") {
    if (parsed) {
      const w = Number(parsed[1]);
      const h = Number(parsed[2]);
      // A tall shape would make a tile taller than a phone screen: cap it at 4:5.
      return w / h < 0.8 ? "4 / 5" : `${w} / ${h}`;
    }
    return m.spec.output === "video" ? "16 / 9" : "1 / 1";
  }
  // Sound and words have no picture: a strip, like a soundtrack on film.
  return "3 / 1";
}

/** The longest clip the registry lists, in seconds; null = none listed. */
export function longestDuration(spec: DiscoverySpec): number | null {
  return spec.durationsS.length ? Math.max(...spec.durationsS) : null;
}
