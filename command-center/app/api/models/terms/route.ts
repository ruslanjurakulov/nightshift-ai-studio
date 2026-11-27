import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth/org-roles";
import { isModelId } from "@/lib/models-admin";
import { isMissingFunction } from "@/lib/orgs";
import { guardAdminPost } from "@/lib/server/admin-post-guard";
import { logAudit } from "@/lib/server/audit";
import { parseJsonCapped } from "@/lib/server/json-body";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refusals: Record<string, readonly [number, string]> = {
  "42501": [403, "forbidden"],
  "22023": [400, "bad_confirm"],
  P0002: [404, "not_found"],
  P2271: [403, "bytedance"],
  P2272: [409, "gate_changed"],
  P2273: [409, "not_accepted"],
};

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  const access = await requireOperator();
  if (!access.ok) return refuse(access.status, access.error);
  const crossOrigin = await guardAdminPost(request);
  if (crossOrigin) return crossOrigin;

  let body: unknown;
  try {
    body = await parseJsonCapped(request);
  } catch {
    return refuse(400, "bad_request");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "bad_request");
  }

  const { id, gate, confirm, revoke } = body as Record<string, unknown>;
  if (!isModelId(id)) return refuse(400, "bad_model_id");
  if (revoke !== undefined && (revoke !== true || gate !== undefined || confirm !== undefined)) {
    return refuse(400, "bad_request");
  }
  if (revoke !== true && confirm !== id) return refuse(400, "bad_confirm");
  if (revoke !== true && (typeof gate !== "string" || gate === "")) return refuse(400, "bad_gate");

  const supabase = await createClient();
  if (!supabase) return refuse(503, "not_configured");

  const { error } = revoke === true
    ? await supabase.rpc("owner_revoke_model_terms", { p_model: id })
    : await supabase.rpc("owner_accept_model_terms", { p_model: id, p_gate: gate, p_confirm: confirm });

  if (error) {
    if (error.code === "42501" && error.message === "terms_mfa_required") {
      return refuse(401, "mfa_required");
    }
    const refusal = refusals[error.code];
    if (refusal) return refuse(...refusal);
    if (isMissingFunction(error)) return refuse(503, "not_enabled");
    return refuse(502, "write_failed");
  }

  await logAudit({
    action: revoke === true ? "model.terms_revoke" : "model.terms_accept",
    target: id,
    detail: revoke === true ? undefined : { gate },
  });
  return NextResponse.json({ ok: true, id });
}
