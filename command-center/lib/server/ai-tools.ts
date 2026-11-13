import "server-only";
import { loadSellableModels } from "@/lib/creative/registry";
import { IMPROVE_STUDIO_TOOLS, sellableToolList } from "@/lib/creative/improve";
import { withPreviews, type StudioModel } from "@/lib/creative/studio";
import { loadOperatorPreviewModels, loadStudioModels } from "@/lib/server/creative";
import { isOperator } from "@/lib/auth/org-roles";
import { isOperatorOrg } from "@/lib/channel-tokens";

/**
 * Which "Improve with AI" tools this deployment sells a model for, as the
 * database answers it (sellable_models: verified, priced, no open terms gate).
 * Nothing is priced or started here. [] = nothing is sold (or the registry is
 * not set up): every tool reads "not available yet". null = the read failed:
 * unknown, so the tools are still offered and the Studio says what it finds.
 */
export async function loadAiToolAvailability(): Promise<string[] | null> {
  try {
    const out = await loadSellableModels();
    if (out.status === "ok") return sellableToolList(out.models.flatMap((m) => m.capabilities));
    if (out.status === "not_enabled" || out.status === "not_configured") return [];
    return null;
  } catch {
    return null;
  }
}

/**
 * The models "Improve with AI" may offer to pick: exactly the Studio's list (app/(app)/[channel]/create/page.tsx) —
 * the member's sellable models, the owner's switched-off ones and a country's forbidden ones already taken out — plus,
 * for the platform operator in the operator's own organization only, the hidden previews (0139). Trimmed to the
 * models of the tools the panel offers. Picking one only fills the Studio's link: the Studio re-checks it against
 * its own list and the database prices it. null = could not be read; the panel then leaves the pick to the Studio.
 */
export async function loadImproveModels(orgId: string | null): Promise<StudioModel[] | null> {
  try {
    const models = await loadStudioModels();
    // Asked only for the operator's own organization, like the create page: one call fewer for everyone else.
    const previews = orgId && isOperatorOrg(orgId) && (await isOperator()) ? await loadOperatorPreviewModels(orgId) : [];
    const tools = new Set<string>(IMPROVE_STUDIO_TOOLS);
    return withPreviews(models, previews).filter((m) => m.capabilities.some((c) => tools.has(c)));
  } catch {
    return null;
  }
}
