/**
 * Server-side provider adapter boundary, Phase 3 / inactive.
 *
 * Model providers are original developers (Ideogram, BytePlus), never Krea or
 * Higgsfield resale endpoints. This module deliberately has NO fetch or
 * credentials. It can only prepare and refuse requests until a licensed,
 * audited execution implementation is explicitly enabled in a later PR.
 */
import "server-only";
import { z } from "zod";
import { PROVIDERS, type DirectProvider } from "@/lib/agent-providers";

const RequestSchema = z.object({
  provider: z.enum(["ideogram", "byteplus"]),
  modelId: z.string().trim().min(1).max(100),
  capability: z.enum(["video", "vector"]),
  prompt: z.string().trim().min(1).max(4000),
  requestId: z.string().uuid(),
  ownerId: z.string().uuid(),
  assetIds: z.array(z.string().uuid()).max(16),
}).strict();
export type AdapterRequest = z.infer<typeof RequestSchema>;

export type AdapterRefusal =
  | "invalid_request"
  | "capability_mismatch"
  | "model_not_approved"
  | "provider_terms_unverified"
  | "cost_not_authorized"
  | "execution_disabled";

export type AdapterDecision =
  | { ok: false; error: AdapterRefusal }
  | { ok: true; executionReady: false; provider: DirectProvider; requestId: string; gates: readonly string[] };

type ApprovedModel = { id: string; provider: DirectProvider; capability: "video" | "vector"; enabled: boolean; termsApproved: boolean };
export type ProviderRegistry = ReadonlyArray<ApprovedModel>;

/** Prepared data only: no side effects, no provider POST, no reservations. */
export function inspectAdapterRequest(input: unknown, approvedModels: ProviderRegistry = []): AdapterDecision {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const data = parsed.data;
  if (!(PROVIDERS[data.provider].capabilities as readonly string[]).includes(data.capability))
    return { ok: false, error: "capability_mismatch" };
  const model = approvedModels.find(m =>
    m.id === data.modelId && m.provider === data.provider && m.capability === data.capability && m.enabled);
  if (!model) return { ok: false, error: "model_not_approved" };
  if (!model.termsApproved) return { ok: false, error: "provider_terms_unverified" };
  return {
    ok: true,
    executionReady: false,
    provider: data.provider,
    requestId: data.requestId,
    gates: [
      "Server-only authorized user/asset ownership",
      "Live provider quote and guaranteed max-charge ceiling",
      "Atomic credit hold, idempotent dispatch and refund reconciliation",
      "Authenticated human review and explicit submit",
      "Provider API implementation must be separately approved",
    ],
  };
}

/** Strictly denied even for an otherwise valid and approved model. */
export async function executeAdapterRequest(_input: AdapterRequest): Promise<never> {
  throw new Error("nightshift_agent_provider_execution_disabled");
}
