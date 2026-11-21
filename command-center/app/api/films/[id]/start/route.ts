import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { FILM_CREATE_RATE } from "@/lib/server/web-rate";
import { NO_STORE, filmFail, filmGateFor, filmRate, filmRefusal, readFilmBody } from "@/lib/server/films";
import { IDEM_RE, parseFilmId } from "@/lib/films";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTE_RE = /^fq-[0-9]{1,9}-[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Only what the screen reads (BR-790-01). start_film answers the whole segment, and on a replay after a worker claimed it that carries
 * worker_id, heartbeat_at and credit_ref, which 0171's column grant withholds from members. A named allow-list, never the raw object,
 * until a later migration makes start_film's own answer member-safe.
 */
function memberSafeStart(d: Record<string, unknown>) {
  const out: Record<string, unknown> = { ok: d.ok === true };
  if (typeof d.replayed === "boolean") out.replayed = d.replayed;
  if (typeof d.reason === "string" && REASON_RE.test(d.reason)) out.reason = d.reason;
  if (typeof d.id === "string" && UUID_RE.test(d.id)) out.id = d.id;
  if (typeof d.status === "string" && REASON_RE.test(d.status)) out.status = d.status;
  if (typeof d.confirmed_credits === "number" && Number.isFinite(d.confirmed_credits)) out.confirmed_credits = d.confirmed_credits;
  return out;
}

/**
 * POST `{ quote_id, idem }`: 0171's start_film at the quote the person confirmed. The database re-prices, holds the credits in the
 * admin's own session (reserve_credits) and queues the film; the worker captures on success and refunds on failure. The browser calls
 * this once per press with one idempotency key, so a double press or a retry answers the first start (`replayed`), never a second hold.
 * A refusal that counted (insufficient credits, an expired or changed quote, a full slot) comes back as `{ ok: false, reason }`.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await filmGateFor(id);
  if (!gate.ok) return gate.response;
  const filmId = parseFilmId(id);
  if (!filmId) return filmFail("not_found", 404);
  const b = await readFilmBody(request, 1_000);
  if (!b || typeof b.quote_id !== "string" || !QUOTE_RE.test(b.quote_id) || typeof b.idem !== "string" || !IDEM_RE.test(b.idem)) {
    return filmFail("bad_request", 400);
  }
  const limited = await filmRate(gate.userId, FILM_CREATE_RATE);
  if (limited) return limited;
  const { data, error } = await gate.supabase.rpc("start_film", { p_film: filmId, p_quote_id: b.quote_id, p_idempotency_key: b.idem });
  if (error) {
    // Two of start_film's raised refusals are states the Timeline must name (the switch is off; the film already started), not
    // "failed": 0166's word list does not carry them, so they are answered here as the start's own `ok: false` rows.
    const word = (error.message ?? "").trim();
    if (error.code === "NS409" && (word === "film_studio_disabled" || word === "film_not_startable")) {
      return NextResponse.json({ start: { ok: false, reason: word } }, { headers: NO_STORE });
    }
    // A reference deleted after the quote bumps no version, so the same quote would be refused forever (BR-790-02): named, so the
    // screen says what to fix and asks for a new price.
    if (error.code === "NS400" && word === "reference_missing") {
      return NextResponse.json({ start: { ok: false, reason: word } }, { headers: NO_STORE });
    }
    return filmRefusal(error);
  }
  if (!data || typeof data !== "object") return filmFail("failed", 502);
  return NextResponse.json({ start: memberSafeStart(data as Record<string, unknown>) }, { headers: NO_STORE });
});
