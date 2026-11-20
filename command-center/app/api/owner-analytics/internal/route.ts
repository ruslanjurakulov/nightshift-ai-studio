import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { createClient, getUser } from "@/lib/supabase/server";
import { ownerAccess } from "@/lib/server/owner-analytics";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Flag a workspace as internal / test, or clear the flag. It changes only what the analytics hub counts by default — never
 * the workspace, its credits or its payments. The database checks the owner and the second factor itself (0182, 0107); this
 * route checks first so a stranger makes the server do no work.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  if (!(await getUser())) return json({ error: "unauthorized" }, 401);
  if ((await ownerAccess()) !== "owner") return json({ error: "forbidden" }, 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const b = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const org = typeof b.org === "string" ? b.org.trim() : "";
  const on = b.on === true;
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!UUID.test(org) || (on && (reason.length < 1 || reason.length > 200))) return json({ error: "invalid_request" }, 400);
  const supabase = await createClient();
  if (!supabase) return json({ error: "unavailable" }, 503);
  const { error } = await supabase.rpc("owner_analytics_set_internal", { p_org: org, p_internal: on, p_reason: on ? reason : null });
  if (error) {
    if (error.code === "NS401") return json({ error: "mfa_required" }, 401);
    if (error.code === "42501") return json({ error: "forbidden" }, 403);
    if (error.code === "22023") return json({ error: "invalid_request" }, 400);
    return json({ error: "not_saved" }, 503);
  }
  return json({ ok: true, on }, 200);
});
