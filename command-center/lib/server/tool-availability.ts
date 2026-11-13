import "server-only";
import { cache } from "react";
import { isOperator } from "@/lib/auth/org-roles";
import { isOperatorOrg } from "@/lib/channel-tokens";
import { withPreviews } from "@/lib/creative/studio";
import { loadOperatorPreviewModels, readStudioModels } from "@/lib/server/creative";
import { availabilityFromModels, UNKNOWN_TOOLS, type ToolAvailability } from "@/lib/tool-availability";

/**
 * Which Studio tools have a model on sale for this request (lib/tool-availability.ts), read once and shared by the layout (the
 * sidebar, the desk bar, Home and Presets read it from the shell) and the pages (React cache: one request, one read).
 *
 * The list is exactly the Studio form's: the member's sellable models (sellable_models(), the owner's switch, the country rule) plus,
 * for the platform operator in the operator's own organization only, the hidden previews (0139) the create page also offers them.
 * No organization to make anything for, or a read that failed: unknown, which draws every tool as before (never "not available" on
 * a guess). Read-only, the member's own session; nothing is priced or started.
 */
export const readToolAvailability = cache(async (orgId: string | null): Promise<ToolAvailability> => {
  if (!orgId) return UNKNOWN_TOOLS;
  try {
    const models = await readStudioModels();
    if (models === null) return UNKNOWN_TOOLS;
    // Asked only for the operator's own organization, like the create page: one call fewer for everyone else.
    const previews = isOperatorOrg(orgId) && (await isOperator()) ? await loadOperatorPreviewModels(orgId) : [];
    return availabilityFromModels(withPreviews(models, previews));
  } catch {
    return UNKNOWN_TOOLS;
  }
});
