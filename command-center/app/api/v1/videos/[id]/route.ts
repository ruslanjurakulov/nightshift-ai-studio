import { runApi } from "@/lib/server/public-api";
import { getVideo } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/videos/{id} — one video, with its publish requests. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runApi(request, (caller) => getVideo(caller, id));
}
