import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { requireOperator } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import {
  GITHUB_REPO,
  fetchPublicKey,
  isGithubConfigured,
  isWritableSecretName,
  putSecret,
} from "@/lib/server/github-secrets";
import { guardAdminPost } from "@/lib/server/admin-post-guard";
import { validateSecretValue } from "@/lib/server/secret-validators";
import { SECRET_WRITE_RATE, logAdminWrite, rateLimitRefusal } from "@/lib/server/secret-write";
import { requireRecentMfa } from "@/lib/security/admin-mfa-server";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Forward typed keys to the bot repository as Actions secrets.
 *
 * GET reports whether forwarding is configured at all, and to which
 * repository, so the wizard can show the operator what to set up instead of
 * failing at the last step. Operator only: the repository name is the
 * operator's configuration, not a customer's business.
 *
 * POST takes `{ secrets: { NAME: value } }`, seals each value to the
 * repository's public key and writes it. Nothing is persisted here: the values
 * live for the length of this function call. The response says which names were
 * written and whether each was created or updated — never a value, never a
 * prefix of one, never its length.
 *
 * Every value is checked against the shape its NAME expects before anything is
 * sealed (lib/server/secret-validators.ts: a Slack URL on Slack's host, a Resend
 * key, Google OAuth JSON that names only Google's endpoints, a plain token with
 * no whitespace or env syntax). A refused value answers 400 `bad_value` with the
 * name and a reason code, never the value. Writes are rate limited per person,
 * and in NIGHTSHIFT_ADMIN_MFA=enforce an aal2 session must have typed its code
 * recently (401 `mfa_recent_required`: sign out and in). Each written name leaves
 * one server log line with the name and the outcome (accepted, or rejected with the
 * reason code), never anything derived from the value.
 */

export async function GET() {
  const access = await requireOperator();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  return NextResponse.json({ configured: isGithubConfigured, repo: GITHUB_REPO });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Writing a provider credential is an owner/admin action.
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const crossSite = await guardAdminPost(request, user);
  if (crossSite) return crossSite;
  const stale = await requireRecentMfa(user);
  if (stale) return stale;
  const limited = rateLimitRefusal(user.id, SECRET_WRITE_RATE);
  if (limited) return limited;
  if (!isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

  let body: { secrets?: Record<string, string> };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Empty values are dropped rather than written: a blank field means "leave
  // this secret alone", never "replace it with nothing".
  const entries = Object.entries(body.secrets ?? {}).filter(([, v]) => typeof v === "string" && v.trim());
  if (entries.length === 0)
    return NextResponse.json({ error: "no_secrets" }, { status: 400 });
  if (entries.length > 12) return NextResponse.json({ error: "too_many" }, { status: 400 });

  const refused = entries.map(([n]) => n).filter((n) => !isWritableSecretName(n));
  if (refused.length)
    return NextResponse.json({ error: "secret_not_allowed", names: refused }, { status: 400 });

  // Shape per name, before GitHub is called: nothing is written unless every value passes.
  const checked: { name: string; value: string }[] = [];
  for (const [name, raw] of entries) {
    const check = validateSecretValue(name, raw);
    if (!check.ok) {
      logAdminWrite("secret", user.id, name, { outcome: "rejected", reason: check.reason });
      return NextResponse.json({ error: "bad_value", name, reason: check.reason }, { status: 400 });
    }
    checked.push({ name, value: check.value });
  }

  try {
    const key = await fetchPublicKey();
    const written: { name: string; result: "created" | "updated" }[] = [];
    for (const { name, value } of checked) {
      written.push({ name, result: await putSecret(name, value, key) });
      logAdminWrite("secret", user.id, name, { outcome: "accepted" });
    }
    // Audit the write — names only, never a value (best-effort, never throws).
    await logAudit({ action: "secret.write", detail: { names: written.map((w) => w.name) } });
    return NextResponse.json({ ok: true, repo: GITHUB_REPO, written });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_write_failed";
    const status = reason === "github_unauthorized" ? 403 : reason === "github_repo_not_found" ? 404 : 502;
    return NextResponse.json({ error: reason }, { status });
  }
}
