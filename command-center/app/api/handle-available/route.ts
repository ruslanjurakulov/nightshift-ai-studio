import { NextResponse } from "next/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { handleCheckKey, isHandleAvailablePublic, takeHandleCheck } from "@/lib/server/handle-check";
import { HANDLE_MAX } from "@/lib/handles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/handle-available  { "handle": "ana.k" }  →  { "available": true | false | null }
 *
 * The sign-up form's live username check, asked by a visitor with no account
 * (lib/server/handle-check.ts explains the limits and why a boolean is all it
 * gives away). Our own page only: a request another site makes changes nothing
 * and learns nothing. No cookie, no session, no secret is read or written.
 */
const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!takeHandleCheck(handleCheckKey(request.headers)))
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });

  let handle: unknown;
  try {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 1024) throw new Error("too big");
    handle = ((await request.json()) as { handle?: unknown } | null)?.handle;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  if (typeof handle !== "string" || handle.length > HANDLE_MAX + 8)
    return NextResponse.json({ available: false }, { headers: NO_STORE });

  return NextResponse.json({ available: await isHandleAvailablePublic(handle) }, { headers: NO_STORE });
}
