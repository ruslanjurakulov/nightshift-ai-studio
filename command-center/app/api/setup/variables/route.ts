import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { requireOperator } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { isGithubConfigured } from "@/lib/server/github-secrets";
import { isWritableVariable, putVariable, readVariables } from "@/lib/server/github-variables";
import { guardAdminPost } from "@/lib/server/admin-post-guard";
import { MAX_EMAIL_CHARS, validateVariableValue } from "@/lib/server/secret-validators";
import { VARIABLE_WRITE_RATE, logAdminWrite, rateLimitRefusal } from "@/lib/server/secret-write";
import { requireRecentMfa } from "@/lib/security/admin-mfa-server";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read and write the pipeline's routing variables (GitHub Actions variables).
 *
 * GET returns whether forwarding is configured and the current values of the
 * allowlisted variables — not secret, but the operator's own pipeline
 * configuration (which providers it pays for), so only the operator reads
 * them; that is what lets the board reflect the live selection.
 *
 * POST takes `{ variables: { NAME: value } }` and writes each allowlisted name.
 * These are plain config switches (a provider id, an on/off flag), never a
 * credential — a value here is printed into the workflow log by design.
 *
 * Each value is checked against its NAME (lib/server/secret-validators.ts): a provider id from the closed list,
 * an on/off flag, exactly one valid alert e-mail address. A refused value answers 400 `bad_value` with the name and
 * a reason code. Writes are rate limited per person, and in NIGHTSHIFT_ADMIN_MFA=enforce an aal2 session must
 * have typed its code recently (401 `mfa_recent_required`).
 */

export async function GET() {
  const access = await requireOperator();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
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
  const refused = await guardAdminPost(request, user);
  if (refused) return refused;
  const stale = await requireRecentMfa(user);
  if (stale) return stale;
  const limited = rateLimitRefusal(user.id, VARIABLE_WRITE_RATE);
  if (limited) return limited;
  if (!isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

  let body: { variables?: Record<string, unknown> };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const entries = Object.entries(body.variables ?? {});
  if (entries.length === 0) return NextResponse.json({ error: "no_variables" }, { status: 400 });
  if (entries.length > 8) return NextResponse.json({ error: "too_many" }, { status: 400 });

  // Every name must be allow-listed and every value the shape its name expects — these are
  // switches (a provider id, "1"/"0") and two addresses, never free text.
  const checked: { name: string; value: string }[] = [];
  for (const [name, value] of entries) {
    if (!isWritableVariable(name))
      return NextResponse.json({ error: "variable_not_allowed", name }, { status: 400 });
    if (typeof value !== "string" || value.length > MAX_EMAIL_CHARS)
      return NextResponse.json({ error: "bad_value", name }, { status: 400 });
    const check = validateVariableValue(name, value);
    if (!check.ok) return NextResponse.json({ error: "bad_value", name, reason: check.reason }, { status: 400 });
    checked.push({ name, value: check.value });
  }

  try {
    for (const { name, value } of checked) {
      await putVariable(name, value);
    }
    logAdminWrite("variable", user.id, checked);
    // Audit the write — variable names only (best-effort, never throws).
    await logAudit({ action: "variable.write", detail: { names: entries.map(([n]) => n) } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_write_failed";
    const status = reason === "github_unauthorized" ? 403 : reason === "github_repo_not_found" ? 404 : 502;
    return NextResponse.json({ error: reason }, { status });
  }
}
