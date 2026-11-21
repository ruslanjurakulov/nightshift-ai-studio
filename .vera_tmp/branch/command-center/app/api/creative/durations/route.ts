import { NextResponse } from "next/server";
import { creativeSession } from "@/lib/server/creative";
import { listDurations, parseModelList } from "@/lib/creative/durations";
import { isUuid } from "@/lib/creative/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET `?org_id=&models=a,b` — how long each model's newest completed jobs (at most 20) took in this organization, in
 * seconds: the Studio placeholder's history for "~N%" (lib/creative/progress.ts). Read with the member's own session,
 * so RLS shows only an organization they belong to; another organization's id answers empty, like one with no jobs.
 * For a model with fewer than 3 finished jobs here, `seeds` adds the platform's own test run of it (0151, platform-wide,
 * no organization's data), read with the same session; left out when 0151 is missing or the read fails.
 * Times only: nothing is priced, started or changed.
 */
export async function GET(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const params = new URL(request.url).searchParams;
  const models = parseModelList(params.get("models"));
  if (!models) return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  const q = params.get("org_id");
  const out = await listDurations(session.db, isUuid(q) ? q : session.defaultOrg, models);
  return NextResponse.json(out.body, { status: out.status });
}
