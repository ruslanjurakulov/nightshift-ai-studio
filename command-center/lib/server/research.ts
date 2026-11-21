import "server-only";
import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isMissingFunction } from "@/lib/orgs";
import { parseJsonCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { WRITER_ERRORS } from "@/lib/research";

/**
 * Channel research's routes (migration 0200) each call ONE writer function with the signed-in person's own session (the anon key
 * plus their cookie; never the service key) and stop: the function decides who may, writes a row, and the queue worker makes every
 * YouTube call later (rule 3). A refusal is a route answer with the database's own word, never its message.
 */

const NO_STORE = { "cache-control": "no-store" };

export async function callResearchWriter(name: string, args: Record<string, unknown>): Promise<NextResponse> {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    // 0200 not applied here: the page says "not enabled", and so does the route.
    if (isMissingFunction(error)) return NextResponse.json({ error: "not_enabled" }, { status: 503, headers: NO_STORE });
    // A channel the caller cannot see answers exactly like one that does not exist.
    if (error.code === "P0002") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    if (error.code === "42501") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    return NextResponse.json({ error: "failed" }, { status: 500, headers: NO_STORE });
  }
  const answer = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  if (answer.ok !== true) {
    const word = typeof answer.error === "string" ? answer.error : "failed";
    return NextResponse.json({ error: word in WRITER_ERRORS ? word : "failed" }, { status: WRITER_ERRORS[word] ?? 500, headers: NO_STORE });
  }
  // Only the fields the page needs: ids and closed words, nothing the database did not decide.
  const out: Record<string, unknown> = { ok: true };
  for (const k of ["status", "request_id", "id", "already", "fetched_at", "removed"]) if (k in answer) out[k] = answer[k];
  return NextResponse.json(out, { headers: NO_STORE });
}

export async function researchBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await parseJsonCapped(request, SMALL_BODY_BYTES);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
