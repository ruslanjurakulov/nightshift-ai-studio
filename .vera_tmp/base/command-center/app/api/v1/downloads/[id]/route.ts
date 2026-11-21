import { runApi } from "@/lib/server/public-api";
import { getDownload } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/downloads/{id} — an HD download's status; file_url once it is ready. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runApi(request, (caller) => getDownload(caller, id));
}
