import { runApi } from "@/lib/server/public-api";
import { getJob } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/jobs/{id} — a video job's status and what it was charged. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runApi(request, (caller) => getJob(caller, id));
}
