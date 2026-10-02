import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody, resolveStyleOrg } from "@/lib/server/style-kits";
import { mapStyleError, parseStyleId } from "@/lib/style-kits";
import { parseLibraryAdd } from "@/lib/styles/add";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a built-in library style to the open organization: POST
 * `{ library_id, locale?, org_id? }`.
 *
 * The browser names a library style by id only. The kit's name (in the
 * person's language) and its description come from lib/styles/library.ts on
 * the server, so the page cannot write arbitrary text under a library id.
 * add_library_style_kit() (migration 0065) runs as the signed-in user, checks
 * that they edit this organization, and is idempotent per (organization,
 * library style): a second press returns the same kit with `created: false`.
 *
 * It creates configuration only — a style kit. Nothing is generated, priced,
 * rendered or published here.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonBody(request);
  const input = parseLibraryAdd(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const { org, bad } = await resolveStyleOrg(input.value.orgId);
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("add_library_style_kit", {
    p_org: org,
    p_library_id: input.value.style.id,
    p_name: input.value.name,
    p_description: input.value.style.description,
  });
  if (error) {
    const mapped = mapStyleError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const row = data && typeof data === "object" ? (data as { id?: unknown; created?: unknown }) : {};
  const id = parseStyleId(row.id);
  if (!id || typeof row.created !== "boolean") return NextResponse.json({ error: "failed" }, { status: 502 });
  if (row.created) await logAudit({ action: "style_kit.add_library", target: id, detail: { library_id: input.value.style.id } });
  return NextResponse.json({ id, created: row.created }, { status: row.created ? 201 : 200 });
}
