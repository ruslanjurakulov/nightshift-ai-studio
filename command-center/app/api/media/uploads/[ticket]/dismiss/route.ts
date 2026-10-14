import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { logAudit } from "@/lib/server/audit";
import { DISMISS_META_KEY, isDismissableStatus, parseDismissed, withDismissed } from "@/lib/media-dismiss";
import { mapMediaError, parseMediaId } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * Dismiss a refused or expired upload card (lib/media-dismiss.ts).
 *
 * POST /api/media/uploads/<ticket>/dismiss, no body.
 *
 * The ledger itself cannot be changed by a member (migration 0038 grants
 * SELECT only), and this route does not try: it hides the card for the person
 * who asked, by adding the ticket to the list in their own auth user_metadata.
 * Everything runs as that person (anon key + session); the service key is not
 * involved and nothing in the database changes.
 *
 * 1. Signed in, from our own page.
 * 2. The ticket is read under the person's session. RLS only returns tickets
 *    of organizations they belong to, so another organization's ticket and a
 *    made-up id are the same 404 and nothing about it is revealed.
 * 3. Only a ticket that ended badly (rejected or expired) goes: one still on
 *    its way (requested, receiving, uploaded, ingesting) or already turned
 *    into a file (ingested) is a 409, so a card that is still working, or a
 *    ticket whose bytes are still counted, can never be waved away.
 * 4. The id is put first on the person's list (kept short, see DISMISS_MAX).
 *    Dismissing twice is the same as once.
 */
export async function POST(request: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const user = await getUser();
  if (!user) return fail("unauthorized", 401);
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return fail("forbidden", 403);

  const { ticket: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return fail("bad_request", 400);

  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);

  const { data, error } = await supabase.from("media_uploads").select("id, status").eq("id", id).maybeSingle();
  if (error) {
    const mapped = mapMediaError(error);
    return fail(mapped.error, mapped.status);
  }
  const row = data as { id?: unknown; status?: unknown } | null;
  if (!row || row.id !== id) return fail("not_found", 404);
  if (!isDismissableStatus(row.status)) return fail("not_dismissable", 409);

  const next = withDismissed(parseDismissed(user.user_metadata), id);
  try {
    const { error: writeError } = await supabase.auth.updateUser({ data: { [DISMISS_META_KEY]: next } });
    if (writeError) return fail("failed", 502);
  } catch {
    return fail("failed", 502);
  }
  await logAudit({ action: "media.upload_dismiss", target: id, detail: { status: row.status } });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
