import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import { dispatchWorkflow, isGithubConfigured } from "@/lib/server/github-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Refresh provider balances — dispatches the read-only `provider_balances.yml`
 * workflow, which asks each provider with a balance API what is left and writes
 * a snapshot. The API keys stay in GitHub Actions; the site never sees them.
 */
export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isGithubConfigured) return NextResponse.json({ error: "github_not_configured" }, { status: 503 });
  try {
    await dispatchWorkflow("provider_balances.yml");
    await logAudit({ action: "billing.refresh" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_dispatch_failed";
    const status = reason === "github_unauthorized" ? 403 : reason === "github_workflow_not_found" ? 404 : 502;
    return NextResponse.json({ error: reason }, { status });
  }
}
