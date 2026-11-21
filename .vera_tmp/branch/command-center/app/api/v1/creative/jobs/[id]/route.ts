import { runApi } from "@/lib/server/public-api";
import { getCreativeJob } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/creative/jobs/{id} — a generation this key started (scope creative:read). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runApi(request, (caller) => getCreativeJob(caller, id));
}
