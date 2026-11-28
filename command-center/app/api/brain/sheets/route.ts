import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { brainJson } from "@/lib/server/brain/session";
import {
  attachSheets, currentSheets, gateFor, makeSheets, markView, quoteSheets, sheetContext, sheetModel,
} from "@/lib/server/brain/ref-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Character reference sheets for a short film's BRIEF (docs/studio/NIGHTSHIFT_AI.md, "Character sheets").
 *   GET  ?session=<id>[&film=<id>]   the sheets with every job's state read again, the model they are drawn with (by name), the
 *                                    database's price for every view that can be made now (summed here, nothing held) with the
 *                                    token of exactly that set, and whether the film's key-frame model can use them (the gate).
 *        &states=1                   the sheets and their job states only: what the panel polls while a picture is being made
 *                                    (no catalogue read, no quote). Writes nothing either way.
 *   POST {session, film?, action}    make (with max_credits and quote_token, the set the person confirmed), approve or redo (one
 *                                    view), attach (the approved views as scene references, only through an open gate).
 * Every picture is one job on the existing creative path (lib/server/brain/ref-sheets): nothing new holds, captures or refunds.
 */

export async function GET(request: Request) {
  const u = new URL(request.url).searchParams;
  const ctx = await sheetContext(u.get("session"), u.get("film") ?? undefined, false);
  if (!ctx.ok) return ctx.res;
  const c = ctx.c;
  const sheets = await currentSheets(c);
  if (u.get("states") === "1") return brainJson({ sheets });
  const pick = await sheetModel(c);
  // No model to draw with is said by name, with the sheets as they are (they may already hold pictures). The gate is not asked
  // then (null, not a guessed "closed for this reason").
  if (!pick.ok) return pick.error === "unavailable" ? pick.res : brainJson({ sheets, model: null, gate: null, quote: null, refusal: "no_sheet_model" });
  const gate = gateFor(c, pick.t2i);
  const q = await quoteSheets(c, pick.model, sheets);
  return brainJson({
    sheets,
    model: { name: pick.model.name, film_own: pick.model.filmOwn },
    gate: gate.open ? { open: true } : { open: false, reason: gate.reason },
    // The database's numbers only; a refusal is passed on by name (rule 6), never turned into a number (rule 5).
    quote: q.ok ? { total: q.total, views: q.views, waiting: q.waiting, token: q.token } : null,
    ...(q.ok ? {} : { refusal: q.body.error ?? "failed", refusal_detail: q.body }),
  });
}

export async function POST(request: Request) {
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const body = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (!body.ok) return brainJson({ error: body.reason === "too_large" ? "payload_too_large" : "bad_request" }, body.reason === "too_large" ? 413 : 400);
  const b = (body.value ?? {}) as Record<string, unknown>;
  if (!["make", "approve", "redo", "attach"].includes(String(b.action))) return brainJson({ error: "bad_request" }, 400);
  const ctx = await sheetContext(b.session, b.film ?? undefined, true);
  if (!ctx.ok) return ctx.res;
  const c = ctx.c;
  if (b.action === "make") {
    const mc = b.max_credits;
    // The set the person saw and confirmed; without it nothing is made (the creative route's own confirm_price rule).
    if (typeof mc !== "number" || !Number.isFinite(mc) || mc < 0 || typeof b.quote_token !== "string") return brainJson({ error: "confirm_price" }, 400);
    const pick = await sheetModel(c);
    if (!pick.ok) return pick.res;
    return makeSheets(c, pick.model, mc, b.quote_token, request.headers);
  }
  if (b.action === "attach") return attachSheets(c);
  return markView(c, { character_id: b.character_id, stage: b.stage, view: b.view }, b.action === "approve" ? "approve" : "redo");
}
