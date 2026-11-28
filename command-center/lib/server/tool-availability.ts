import "server-only";
import { cache } from "react";
import { viewingAsOperator } from "@/lib/server/owner-view";
import { isOperatorOrg } from "@/lib/channel-tokens";
import { withPreviews } from "@/lib/creative/studio";
import { loadOperatorPreviewModels, readStudioModels } from "@/lib/server/creative";
import { readCustomerModels } from "@/lib/server/model-discovery";
import { createClient } from "@/lib/supabase/server";
import { availabilityFromModels, onlyOpenToSome, onlyPriced, UNKNOWN_TOOLS, type ToolAvailability } from "@/lib/tool-availability";

/**
 * The catalog's own verdict per model (lib/models-discovery fromSellableRow, the Models page's read): which models the price list,
 * when it was read, has no rate for. Those read "Not on sale yet" on the Models page, so the marks must not call their tool available.
 * Unread (no client, an error, no migration): null, and nothing is taken out on a guess.
 */
export const readCatalogStates = cache(async (orgId: string): Promise<{ id: string; state: string }[] | null> => {
  try {
    const supabase = await createClient();
    if (!supabase) return null;
    const read = await readCustomerModels(supabase, orgId);
    return read.status === "ok" && read.pricesRead ? read.models.map((m) => ({ id: m.id, state: m.state })) : null;
  } catch {
    return null;
  }
});

/**
 * Which Studio tools have a model on sale for this request (lib/tool-availability.ts), read once and shared by the layout (the
 * sidebar, the desk bar, Home and Presets read it from the shell) and the pages (React cache: one request, one read).
 *
 * The list is the Studio form's: the member's sellable models (sellable_models(), the owner's switch, the country rule), less any the
 * Models catalog calls "Not on sale yet" (no rate in the price list), plus, for the platform operator in the operator's own
 * organization only, the hidden previews (0139) the create page also offers them. No organization to make anything for, or a read
 * that failed: unknown, which draws every tool as before (never "not available" on a guess). Read-only, the member's own session;
 * nothing is priced or started.
 */
export const readToolAvailability = cache(async (orgId: string | null): Promise<ToolAvailability> => {
  if (!orgId) return UNKNOWN_TOOLS;
  try {
    // Asked only for the operator's own organization, like the create page: one call fewer for everyone else.
    const previewsFor = async () => (isOperatorOrg(orgId) && (await viewingAsOperator()) ? await loadOperatorPreviewModels(orgId) : []);
    const [models, catalog, previews] = await Promise.all([readStudioModels(), readCatalogStates(orgId), previewsFor()]);
    if (models === null) return UNKNOWN_TOOLS;
    // Less any model no organization can buy (a plan-tier entitlement: creative_price refuses it for everyone).
    return availabilityFromModels(withPreviews(onlyOpenToSome(onlyPriced(models, catalog)), previews));
  } catch {
    return UNKNOWN_TOOLS;
  }
});
