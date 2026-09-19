import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import { isGithubConfigured } from "@/lib/server/github-secrets";
import { isWritableVariable, putVariable, readVariables } from "@/lib/server/github-variables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read and write the pipeline's routing variables (GitHub Actions variables).
 *
 * GET returns whether forwarding is configured and the current values of the
 * allowlisted variables — variables are not secret, so showing them is safe and
 * is what lets the board reflect the live selection.
 *
 * POST takes `{ variables: { NAME: value } }` and writes each allowlisted name.
 * These are plain config switches (a provider id, an on/off flag), never a
 * credential — a value here is printed into the workflow log by design.
 */

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isGithubConfigured) return NextResponse.json({ configured: false, variables: {} });
  try {
    const variables = await readVariables();
    return NextResponse.json({ configured: true, variables });
  } catch {
    // A read failure must not blank the board; report configured with no values
    // so the UI shows "config default" rather than a hard error.
    return NextResponse.json({ configured: true, variables: {} });
  }
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Changing which generator the pipeline uses is an owner/admin action.
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

  let body: { variables?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const entries = Object.entries(body.variables ?? {});
  if (entries.length === 0) return NextResponse.json({ error: "no_variables" }, { status: 400 });
  if (entries.length > 8) return NextResponse.json({ error: "too_many" }, { status: 400 });

  // Every name must be allow-listed and every value a short string — these are
  // switches (a provider id, "1"/"0"), never free text.
  for (const [name, value] of entries) {
    if (!isWritableVariable(name))
      return NextResponse.json({ error: "variable_not_allowed", name }, { status: 400 });
    if (typeof value !== "string" || value.length > 64)
      return NextResponse.json({ error: "bad_value", name }, { status: 400 });
  }

  try {
    for (const [name, value] of entries) {
      await putVariable(name, value as string);
    }
    // Audit the write — variable names only (best-effort, never throws).
    await logAudit({ action: "variable.write", detail: { names: entries.map(([n]) => n) } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_write_failed";
    const status = reason === "github_unauthorized" ? 403 : reason === "github_repo_not_found" ? 404 : 502;
    return NextResponse.json({ error: reason }, { status });
  }
}
