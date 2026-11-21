import { finishSocialConnect } from "@/lib/server/social-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The instagram consent screen redirects here with a one-time code. Verifies the
 *  state nonce and the org role again, then seals the tokens into Supabase
 *  Vault (migration 0028). See lib/server/social-connect.ts. */
export async function GET(request: Request) {
  return finishSocialConnect(request, "instagram");
}
