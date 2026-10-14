import { loadSellableModels } from "@/lib/creative/registry";
import { sellableToolList } from "@/lib/creative/improve";

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
