import { runApi } from "@/lib/server/public-api";
import { getBalance } from "@/lib/api/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/balance — the prepaid API balance (US cents) and this month's spend. */
export function GET(request: Request) {
  return runApi(request, (caller) => getBalance(caller));
}
