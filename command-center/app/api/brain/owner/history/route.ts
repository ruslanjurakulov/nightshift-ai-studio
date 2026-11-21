import { createClient, getUser } from "@/lib/supabase/server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped } from "@/lib/server/json-body";
import { ownerAccess } from "@/lib/server/owner-analytics";
import { brainJson, notFound } from "@/lib/server/brain/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner's stored Nightshift AI conversations (0209), for the history panel on /owner/ai.
 *   GET    ?before=<iso>       one page of sessions, newest activity first (owner_ai_session_list)
 *   GET    ?session=<uuid>     one session's messages (owner_ai_session_messages)
 *   PATCH  {session, title}    rename (owner_ai_session_rename)
 *   DELETE ?session=<uuid>     soft delete (owner_ai_session_delete)
 * Only the 0209 security-definer functions are called, with the signed-in person's own session (anon key + their JWT): the database
 * checks owner and second factor again, so this route's owner check is a fast 404, not the lock. Nothing here spends or acts.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Not exported: a route module may export only handlers and route config, or `next build` fails.
const PAGE = 30;
const TITLE_MAX = 60;

type RpcError = { code?: string } | null;

/** The database's refusal, named so the panel can say the remedy. A session that is gone (deleted elsewhere, or not this person's)
 *  is "gone", distinct from "not_found" (not the owner), so the panel can drop just that row. */
function refusal(error: RpcError) {
  const code = error?.code;
  if (code === "42883" || code === "PGRST202") return brainJson({ error: "not_enabled", needs: "0209" }, 503);
  if (code === "NS401") return brainJson({ error: "second_factor" }, 401);
  if (code === "42501") return notFound();
  if (code === "P0002") return brainJson({ error: "gone" }, 404);
  if (code === "22023") return brainJson({ error: "invalid_title", limit: TITLE_MAX }, 400);
  console.error("owner ai history: rpc_failed", code ?? "unknown");
  return brainJson({ error: "unavailable" }, 503);
}

async function ownerClient() {
  if (!(await getUser())) return null;
  if ((await ownerAccess()) !== "owner") return null;
  return createClient();
}

export async function GET(request: Request) {
  const supabase = await ownerClient();
  if (!supabase) return notFound();
  const url = new URL(request.url);
  const session = url.searchParams.get("session");
  if (session !== null) {
    if (!UUID.test(session)) return brainJson({ error: "bad_request" }, 400);
    const { data, error } = await supabase.rpc("owner_ai_session_messages", { p_session: session });
    if (error) return refusal(error);
    const messages = (Array.isArray(data) ? data : []).map((m: Record<string, unknown>) => ({
      role: m.role === "ai" ? "ai" : "owner",
      text: typeof m.text === "string" ? m.text : "",
      as_of: typeof m.as_of === "string" ? m.as_of : null,
    }));
    return brainJson({ messages });
  }
  const before = url.searchParams.get("before");
  if (before !== null && Number.isNaN(Date.parse(before))) return brainJson({ error: "bad_request" }, 400);
  const { data, error } = await supabase.rpc("owner_ai_session_list", { p_limit: PAGE, p_before: before });
  if (error) return refusal(error);
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  const sessions = rows
    .filter((r) => typeof r.id === "string" && typeof r.updated_at === "string")
    .map((r) => ({ id: r.id as string, title: typeof r.title === "string" ? r.title : "", updated_at: r.updated_at as string }));
  // A full page may have more behind it; a short one is the end. The cursor is the database's own timestamp, never the browser's clock.
  return brainJson({ sessions, next_before: rows.length >= PAGE && sessions.length > 0 ? sessions[sessions.length - 1].updated_at : null });
}

export async function PATCH(request: Request) {
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const supabase = await ownerClient();
  if (!supabase) return notFound();
  const body = await readJsonBodyCapped(request, 4_000);
  if (!body.ok) return brainJson({ error: "bad_request" }, 400);
  const b = (body.value ?? {}) as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim() : "";
  if (typeof b.session !== "string" || !UUID.test(b.session)) return brainJson({ error: "bad_request" }, 400);
  if (title.length < 1 || title.length > TITLE_MAX) return brainJson({ error: "invalid_title", limit: TITLE_MAX }, 400);
  const { error } = await supabase.rpc("owner_ai_session_rename", { p_session: b.session, p_title: title });
  if (error) return refusal(error);
  return brainJson({ ok: true, title });
}

export async function DELETE(request: Request) {
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const supabase = await ownerClient();
  if (!supabase) return notFound();
  const session = new URL(request.url).searchParams.get("session");
  if (!session || !UUID.test(session)) return brainJson({ error: "bad_request" }, 400);
  const { error } = await supabase.rpc("owner_ai_session_delete", { p_session: session });
  if (error) return refusal(error);
  return brainJson({ ok: true });
}
