import { runApi } from "@/lib/server/public-api";
import { listChannels } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/channels — the organization's channels (what POST /videos takes). */
export function GET(request: Request) {
  return runApi(request, (caller) => listChannels(caller));
}
