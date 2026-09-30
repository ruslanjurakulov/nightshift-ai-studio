import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isMissingFunction } from "@/lib/orgs";

/**
 * The models a signed-in user may be offered, read under their own session
 * through the security-definer sellable_models() (migration 0035). No service
 * key, no provider key: the database decides what is sellable — beta/ga, a
 * recorded successful probe (verified_at), a positive credit_prices row, and
 * no open vendor-terms gate — and returns only the public half of each spec.
 *
 * Honest degradation: without 0035 the answer is "not_enabled", never an empty
 * list that reads as "no models exist"; a malformed row is dropped, never
 * shown with a guessed price (CLAUDE.md #5).
 */

export const CAPABILITIES = ["t2i", "edit", "t2v", "i2v", "tts", "sfx"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Surface = "web" | "api" | "mcp";

export type RegistryStatus =
  /** Rows read (possibly none sellable yet). */
  | "ok"
  /** Migration 0035 is not applied on this deployment. */
  | "not_enabled"
  /** Supabase is not configured for this build. */
  | "not_configured"
  /** No signed-in session: sellable_models is not granted to anon. */
  | "signed_out"
  /** Any other failure; say so rather than show "no models". */
  | "error";

export interface Attribution {
  text: string;
  url: string;
}

export interface PublicSpec {
  output: "image" | "video" | "audio";
  imageRefsMax: number;
  aspectRatios: string[];
  aspectRatiosByCapability: Partial<Record<Capability, string[]>>;
  imageSizes: string[];
  resolutions: string[];
  durationsS: number[];
  audioOut: boolean;
  isAsync: boolean;
  /** What credits_per_unit counts: an image, a second, a character, a request. */
  unit: "image" | "second" | "character" | "request";
  /** Vendor-required credit line (Runway, Ideogram) — the UI must show it. */
  attribution: Attribution | null;
  apiExposure: "any" | "web_only";
  maxPromptChars: number;
  maxConcurrentPerOrg: number;
  qualityTier: number;
  speedTier: number;
}

export interface SellableModel {
  id: string;
  displayName: string;
  provider: string;
  capabilities: Capability[];
  availability: "beta" | "ga";
  verifiedAt: string;
  creditUnit: string;
  /** The plan entitlement a model needs (0034 key, e.g. models_video:premium); null = none. */
  entitlement: string | null;
  creditsPerUnit: number;
  margin: number;
  spec: PublicSpec;
}

export interface SellableModels {
  status: RegistryStatus;
  models: SellableModel[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const isCapability = (v: string): v is Capability => (CAPABILITIES as readonly string[]).includes(v);

function coerceSpec(v: unknown): PublicSpec | null {
  if (!isObj(v)) return null;
  const output = v.output;
  const unit = v.unit;
  if (output !== "image" && output !== "video" && output !== "audio") return null;
  if (unit !== "image" && unit !== "second" && unit !== "character" && unit !== "request") return null;
  const limits = isObj(v.limits) ? v.limits : {};
  const maxPromptChars = posInt(limits.max_prompt_chars);
  const maxConcurrentPerOrg = posInt(limits.max_concurrent_per_org);
  if (maxPromptChars === null || maxConcurrentPerOrg === null) return null;
  const inputs = isObj(v.inputs) ? v.inputs : {};
  const refs = typeof inputs.image_refs_max === "number" && inputs.image_refs_max >= 0 ? inputs.image_refs_max : 0;
  const byCap: Partial<Record<Capability, string[]>> = {};
  if (isObj(v.aspect_ratios_by_capability)) {
    for (const [k, list] of Object.entries(v.aspect_ratios_by_capability)) {
      if (isCapability(k)) byCap[k] = strings(list);
    }
  }
  const attr = v.attribution;
  const attribution =
    isObj(attr) && typeof attr.text === "string" && typeof attr.url === "string" && attr.url.startsWith("https://")
      ? { text: attr.text, url: attr.url }
      : null;
  return {
    output,
    imageRefsMax: refs,
    aspectRatios: strings(v.aspect_ratios),
    aspectRatiosByCapability: byCap,
    imageSizes: strings(v.image_sizes),
    resolutions: strings(v.resolutions),
    durationsS: Array.isArray(v.durations_s) ? v.durations_s.filter((d): d is number => posInt(d) !== null) : [],
    audioOut: v.audio_out === true,
    isAsync: v.async === true,
    unit,
    attribution,
    apiExposure: v.api_exposure === "web_only" ? "web_only" : "any",
    maxPromptChars,
    maxConcurrentPerOrg,
    qualityTier: posInt(v.quality_tier) ?? 1,
    speedTier: posInt(v.speed_tier) ?? 1,
  };
}

/**
 * Rows from sellable_models() as typed models. Defence in depth: a row that is
 * not beta/ga, has no verified_at, or has no positive price is dropped even
 * though the SQL already filters it — an unverified or unpriced model must
 * never reach a screen because a function was edited.
 */
export function coerceSellableModels(rows: unknown): SellableModel[] {
  if (!Array.isArray(rows)) return [];
  const out: SellableModel[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const { id, display_name, provider, availability, verified_at, credit_unit, entitlement } = r;
    if (typeof id !== "string" || typeof display_name !== "string" || typeof provider !== "string") continue;
    if (availability !== "beta" && availability !== "ga") continue;
    if (typeof verified_at !== "string" || verified_at === "") continue;
    if (typeof credit_unit !== "string" || credit_unit === "") continue;
    const credits = Number(r.credits_per_unit);
    const margin = Number(r.margin ?? 0);
    if (!Number.isFinite(credits) || credits <= 0 || !Number.isFinite(margin) || margin < 0) continue;
    const capabilities = strings(r.capabilities).filter(isCapability);
    if (capabilities.length === 0) continue;
    const spec = coerceSpec(r.spec);
    if (!spec) continue;
    out.push({
      id,
      displayName: display_name,
      provider,
      capabilities,
      availability,
      verifiedAt: verified_at,
      creditUnit: credit_unit,
      entitlement: typeof entitlement === "string" && entitlement !== "" ? entitlement : null,
      creditsPerUnit: credits,
      margin,
      spec,
    });
  }
  return out;
}

/** The one call this module makes; a session client satisfies it. */
export interface RpcClient {
  rpc(
    fn: "sellable_models",
    args: { p_capability: Capability | null; p_surface: Surface },
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/** Read with an existing session client (routes, server components, tests). */
export async function readSellableModels(
  supabase: RpcClient,
  capability?: Capability,
  surface: Surface = "web",
): Promise<SellableModels> {
  try {
    const { data, error } = await supabase.rpc("sellable_models", {
      p_capability: capability ?? null,
      p_surface: surface,
    });
    if (error) {
      if (isMissingFunction(error)) return { status: "not_enabled", models: [] };
      // 42501: the role may not execute it — only anon lacks the grant.
      if (error.code === "42501") return { status: "signed_out", models: [] };
      return { status: "error", models: [] };
    }
    return { status: "ok", models: coerceSellableModels(data) };
  } catch {
    return { status: "error", models: [] };
  }
}

/** The signed-in user's sellable models for this request. */
export async function loadSellableModels(capability?: Capability, surface: Surface = "web"): Promise<SellableModels> {
  const supabase = await createClient();
  if (!supabase) return { status: "not_configured", models: [] };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed_out", models: [] };
  return readSellableModels(supabase, capability, surface);
}
