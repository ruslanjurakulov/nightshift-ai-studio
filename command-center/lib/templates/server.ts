import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readSellableModels } from "@/lib/creative/registry";
import type { Locale } from "@/lib/i18n/core";
import { coerceTemplateRows, toDto, type MediaManifest, type TemplateCategory, type TemplateDto } from "@/lib/templates/trends";
import mediaManifest from "@/lib/templates/media-manifest.json";

const MANIFEST: MediaManifest = mediaManifest;

/**
 * The trend templates (0183), read under the caller's own session (anon or signed in) — RLS hands out published rows only, and
 * no service key is involved. Availability is the signed-in viewer's sellable_models() answer, asked once per request; a viewer
 * the registry cannot answer for gets "unknown", never a guessed true.
 */
export type TemplatesStatus = "ok" | "not_enabled" | "not_configured" | "error";

export interface TemplatesResult {
  status: TemplatesStatus;
  templates: TemplateDto[];
}

function missingTable(error: { code?: string; message?: string }): boolean {
  // Codes only: a "column ... does not exist" (42703) is a broken schema, an error, not "not switched on here" (rule 5).
  return error.code === "42P01" || error.code === "PGRST205";
}

export async function loadTemplates(opts: {
  locale: Locale;
  category?: TemplateCategory | null;
  slug?: string;
  limit?: number;
}): Promise<TemplatesResult> {
  const supabase = await createClient();
  if (!supabase) return { status: "not_configured", templates: [] };
  try {
    let q = supabase
      .from("creative_templates")
      .select(
        "slug,title,description,category,kind,prompt_template,model_id,aspect,duration_s,quality,director,sort",
      )
      // RLS already limits an API role to published rows; asked again so a policy edit cannot show a draft.
      .eq("published", true)
      .order("sort", { ascending: true })
      .order("id", { ascending: true });
    if (opts.category) q = q.eq("category", opts.category);
    if (opts.slug) q = q.eq("slug", opts.slug);
    q = q.limit(opts.limit ?? 50);
    const { data, error } = await q;
    if (error) return { status: missingTable(error) ? "not_enabled" : "error", templates: [] };
    const rows = coerceTemplateRows(data);
    if (rows.length === 0) return { status: "ok", templates: [] };

    const {
      data: { user },
    } = await supabase.auth.getUser();
    let sellable: { t2v: Set<string>; t2i: Set<string> } | null = null;
    if (user) {
      const [video, image] = await Promise.all([readSellableModels(supabase, "t2v"), readSellableModels(supabase, "t2i")]);
      if (video.status === "ok" && image.status === "ok") {
        sellable = { t2v: new Set(video.models.map((m) => m.id)), t2i: new Set(image.models.map((m) => m.id)) };
      }
    }
    return { status: "ok", templates: rows.map((r) => toDto(r, opts.locale, sellable, MANIFEST)) };
  } catch {
    return { status: "error", templates: [] };
  }
}

export function statusCode(status: TemplatesStatus): number {
  return status === "ok" ? 200 : status === "error" ? 502 : 503;
}
