import { startSocialConnect } from "@/lib/server/social-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Begin connecting a instagram account to the organization being viewed
 *  (org editor+). See lib/server/social-connect.ts. */
export async function GET(request: Request) {
  return startSocialConnect(request, "instagram");
}
