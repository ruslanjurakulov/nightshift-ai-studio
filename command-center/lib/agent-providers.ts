/**
 * Nightshift direct-developer provider planning registry.
 * NO provider API calls; no reseller endpoints or invented unit prices.
 */
import { z } from "zod";

export const CAPABILITIES = ["image", "video", "vector"] as const;
export const PROVIDERS = {
  ideogram: {
    developer: "Ideogram", capabilities: ["vector"] as const,
    apiState: "verification_required" as const,
    licensingState: "unverified_for_resale" as const,
    pricingMode: "provider_quote_required" as const,
  },
  byteplus: {
    developer: "ByteDance / BytePlus ModelArk", capabilities: ["video"] as const,
    apiState: "verification_required" as const,
    licensingState: "unverified_for_resale" as const,
    pricingMode: "token_metered_quote_required" as const,
  },
} as const;
export type DirectProvider = keyof typeof PROVIDERS;
export type Capability = typeof CAPABILITIES[number];
export type ProviderPlan = {
  provider: DirectProvider;
  capability: Capability;
  modelId: string | null;
  status: "review_required";
  estimate: null;
  currency: null;
  requiresUserApproval: true;
  canExecute: false;
  blockers: string[];
};
const Selection = z.object({
  provider: z.enum(["ideogram", "byteplus"]),
  capability: z.enum(CAPABILITIES),
  modelId: z.string().max(100).optional(),
}).strict();

export function planProviderSelection(input: unknown): ProviderPlan | { error: string } {
  const result = Selection.safeParse(input);
  if (!result.success) return { error: "invalid_selection" };
  const { provider, capability } = result.data;
  const row = PROVIDERS[provider];
  if (!(row.capabilities as readonly string[]).includes(capability))
    return { error: "capability_not_supported_by_provider" };
  // Never trust a user-entered modelId as an executable provider model alias.
  return {
    provider, capability, modelId: result.data.modelId ?? null,
    status: "review_required", estimate: null, currency: null,
    requiresUserApproval: true, canExecute: false,
    blockers: [
      "Provider commercial API/redistribution rights must be verified.",
      "Exact model version, region and retirement must be confirmed.",
      "Live provider pricing/dry-run is required before showing a quote.",
      "Credit reservation and release accounting are not connected.",
      "Runtime execution requires a separate security and owner approval gate.",
    ],
  };
}

export type ProviderCostQuote = {
  amountMinor: number;
  currency: "USD";
  source: "provider_api";
  modelId: string;
  units: number;
  retrievedAt: string;
  expiresAt: string;
};

/** A quote is presentable only when based on bounded real provider data. */
export function validateProviderCostQuote(input: unknown): ProviderCostQuote | null {
  const parsed = z.object({
    amountMinor: z.number().int().min(0).max(10_000_000),
    currency: z.literal("USD"),
    source: z.literal("provider_api"),
    modelId: z.string().trim().min(1).max(100),
    units: z.number().positive().finite(),
    retrievedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  }).strict().safeParse(input);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (Date.parse(item.expiresAt) <= Date.parse(item.retrievedAt)) return null;
  return item;
}
