import { NextResponse } from "next/server";
import { getLocale } from "@/lib/i18n/server";
import { loadTemplates, statusCode } from "@/lib/templates/server";
import { parseListQuery } from "@/lib/templates/trends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/templates?category=&locale=&limit= — the published trend templates (0183), in the caller's language.
 *
 * Reads only: it prices nothing and starts nothing. `model_available` is the caller's own sellable_models() answer, so the
 * response is private to the session and never cached in between.
 */
export async function GET(request: Request) {
  const query = parseListQuery(new URL(request.url).searchParams);
  if (!query.ok) return NextResponse.json({ error: query.error }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  const locale = query.locale ?? (await getLocale());
  const result = await loadTemplates({ locale, category: query.category, limit: query.limit });
  const body = result.status === "ok" ? { status: "ok", locale, templates: result.templates } : { error: result.status };
  return NextResponse.json(body, { status: statusCode(result.status), headers: { "Cache-Control": "private, no-store" } });
}
