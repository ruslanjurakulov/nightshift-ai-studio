import { runApi } from "@/lib/server/public-api";
import { listAccounts } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/accounts — publish targets: YouTube channels and connected Instagram / TikTok accounts. */
export function GET(request: Request) {
  return runApi(request, (caller) => listAccounts(caller));
}
