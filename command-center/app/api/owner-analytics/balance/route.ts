import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { createClient, getUser } from "@/lib/supabase/server";
import { ownerAccess } from "@/lib/server/owner-analytics";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * The owner types in a provider balance the provider's API does not report (migration 0184). Stored as source = 'manual', so the
 * page never presents it as the provider's own reading. This calls no provider and touches no key.
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
  const provider = typeof b.provider === "string" ? b.provider.trim() : "";
  const metric = typeof b.metric === "string" ? b.metric.trim() : "";
  const unit = typeof b.unit === "string" ? b.unit.trim() : "";
  const remaining = typeof b.remaining === "number" ? b.remaining : NaN;
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(provider) || !/^[a-z][a-z0-9_]{0,39}$/.test(metric) || !/^[a-z][a-z0-9_]{0,19}$/.test(unit)
      || !Number.isFinite(remaining) || remaining < 0 || remaining > 1e12) {
    return json({ error: "invalid_request" }, 400);
  }
  const supabase = await createClient();
  if (!supabase) return json({ error: "unavailable" }, 503);
  const { error } = await supabase.rpc("owner_analytics_balance_enter", { p_provider: provider, p_metric: metric, p_remaining: remaining, p_unit: unit });
  if (error) {
    if (error.code === "NS401") return json({ error: "mfa_required" }, 401);
    if (error.code === "54000") return json({ error: "rate_limited" }, 429);
    if (error.code === "42501") return json({ error: "forbidden" }, 403);
    if (error.code === "22023") return json({ error: "invalid_request" }, 400);
    return json({ error: "not_saved" }, 503);
  }
  return json({ ok: true }, 200);
});
