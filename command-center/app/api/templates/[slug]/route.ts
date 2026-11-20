import { NextResponse } from "next/server";
import { getLocale } from "@/lib/i18n/server";
import { loadTemplates, statusCode } from "@/lib/templates/server";
import { SLUG_RE, parseListQuery } from "@/lib/templates/trends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/templates/<slug>?locale= — one published template, or 404. A draft answers 404 too: RLS never hands it out. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const query = parseListQuery(new URL(request.url).searchParams);
  if (!query.ok) return NextResponse.json({ error: query.error }, { status: 400 });
  const locale = query.locale ?? (await getLocale());
  const result = await loadTemplates({ locale, slug, limit: 1 });
  const headers = { "Cache-Control": "private, no-store" };
  if (result.status !== "ok") return NextResponse.json({ error: result.status }, { status: statusCode(result.status), headers });
  const template = result.templates[0];
  if (!template) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  return NextResponse.json({ status: "ok", locale, template }, { headers });
}
