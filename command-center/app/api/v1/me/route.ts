import { runApi } from "@/lib/server/public-api";
import { getMe } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/me — the key's organization, usage tier and limits. */
export function GET(request: Request) {
  return runApi(request, (caller) => getMe(caller));
}
