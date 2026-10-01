import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOperator } from "@/lib/auth/org-roles";
import { isMissingFunction } from "@/lib/orgs";
import { logAudit } from "@/lib/server/audit";
import { availabilityBlocker, coerceAdminModels, parseAvailabilityRequest } from "@/lib/models-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST `{ id, availability }` — the platform operator moves one model between
 * hidden / beta / ga / disabled (migration 0035).
 *
 * Three locks, each sufficient on its own:
 * 1. requireOperator here (401 / 403): a customer organization's admin never
 *    reaches the database from this route.
 * 2. model_registry_admin() is security definer and raises 42501 for anyone
 *    who is not is_platform_admin() — the row is read through it, so the
 *    database's own check runs before any write.
 * 3. The write is the documented admin path: an UPDATE of the availability
 *    column, which only the platform admin's column grant + RLS policy allow,
 *    and which 0035's CHECKs refuse for beta/ga without a successful probe,
 *    with an open vendor-terms gate or without a credit unit.
 *
 * Everything runs as the signed-in operator's own session. No service key.
 */
export async function POST(request: Request) {
  const access = await requireOperator();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = parseAvailabilityRequest(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: rows, error: readError } = await supabase.rpc("model_registry_admin");
  if (readError) {
    if (readError.code === "42501") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (isMissingFunction(readError)) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
    return NextResponse.json({ error: "read_failed" }, { status: 502 });
  }
  const current = coerceAdminModels(rows).find((m) => m.id === input.id);
  if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (current.availability === input.availability) return NextResponse.json({ ok: true, id: input.id, availability: input.availability });

  const blocker = availabilityBlocker(current, input.availability);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });

  const { data: updated, error: writeError } = await supabase
    .from("model_registry")
    .update({ availability: input.availability })
    .eq("id", input.id)
    .select("id,availability");
  if (writeError) {
    if (writeError.code === "42501") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    // A CHECK (verification, terms, unit) the row no longer meets — e.g. a sync
    // cleared its proof between the read and the write.
    if (writeError.code === "23514") return NextResponse.json({ error: "rejected" }, { status: 409 });
    return NextResponse.json({ error: "write_failed" }, { status: 502 });
  }
  // RLS filters an UPDATE it refuses down to zero rows instead of erroring.
  if (!Array.isArray(updated) || updated.length !== 1) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  await logAudit({
    action: "model.availability",
    target: input.id,
    detail: { from: current.availability, to: input.availability },
  });
  return NextResponse.json({ ok: true, id: input.id, availability: input.availability });
}
