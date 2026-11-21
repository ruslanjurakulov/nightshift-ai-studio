import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { readBrainFacts } from "@/lib/server/brain-facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET /api/brain/facts: the customer facts of the caller's CURRENT workspace,
 * for the Nightshift Brain dashboard and the Nightshift AI (S5) to read
 * server-side with the person's own session.
 *
 * The org is never taken from the request: it is the workspace the person has
 * open, and brain_org_facts (0196) itself refuses any org they are not a member
 * of. The answer is credits CHARGED by tool, a 14-day series, the plan and its
 * renewal, the org's videos and memory counts. Never another org's rows, a
 * vendor cost, a price list or a margin (tests/security/test_sec_brain_org_facts.py).
 * Read-only: nothing is written, charged or started.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const org = await getOrgContext();
  if (!org.supported || !org.current) return NextResponse.json({ error: "no_org" }, { status: 404, headers: NO_STORE });
  const read = await readBrainFacts(org.current.id);
  if (read.state === "ok") return NextResponse.json({ state: "ok", facts: read.facts }, { headers: NO_STORE });
  const status = read.state === "not_available" ? 503 : read.state === "not_found" ? 404 : 502;
  return NextResponse.json({ state: read.state }, { status, headers: NO_STORE });
}
