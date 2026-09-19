import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import {
  GITHUB_REPO,
  fetchPublicKey,
  isGithubConfigured,
  isWritableSecretName,
  putSecret,
} from "@/lib/server/github-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Forward typed keys to the bot repository as Actions secrets.
 *
 * GET reports whether forwarding is configured at all, so the wizard can show
 * the operator what to set up instead of failing at the last step.
 *
 * POST takes `{ secrets: { NAME: value } }`, seals each value to the
 * repository's public key and writes it. Nothing is persisted here: the values
 * live for the length of this function call. The response says which names were
 * written and whether each was created or updated — never a value, never a
 * prefix of one, never its length.
 */

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ configured: isGithubConfigured, repo: GITHUB_REPO });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Writing a provider credential is an owner/admin action.
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

  let body: { secrets?: Record<string, string> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Empty values are dropped rather than written: a blank field means "leave
  // this secret alone", never "replace it with nothing".
  const entries = Object.entries(body.secrets ?? {}).filter(([, v]) => v && v.trim());
  if (entries.length === 0)
    return NextResponse.json({ error: "no_secrets" }, { status: 400 });
  if (entries.length > 12) return NextResponse.json({ error: "too_many" }, { status: 400 });

  const refused = entries.map(([n]) => n).filter((n) => !isWritableSecretName(n));
  if (refused.length)
    return NextResponse.json({ error: "secret_not_allowed", names: refused }, { status: 400 });

  try {
    const key = await fetchPublicKey();
    const written: { name: string; result: "created" | "updated" }[] = [];
    for (const [name, value] of entries) {
      written.push({ name, result: await putSecret(name, value.trim(), key) });
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
