import { createClient, getUser } from "@/lib/supabase/server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped } from "@/lib/server/json-body";
import { getLocale } from "@/lib/i18n/server";
import { ownerAccess } from "@/lib/server/owner-analytics";
import { buildOwnerFacts, OwnerOnlyError, SecondFactorRequiredError } from "@/lib/server/owner-brain-facts";
import { callChatModel } from "@/lib/server/brain/llm";
import { brainJson, chosenModelState, notFound } from "@/lib/server/brain/session";
import { extractJson } from "@/lib/brain/logic";
import { guardLinks, knownLinks, OWNER_AI_SYSTEM, ownerUserBlock, QUESTION_MAX, readHistory, readOwnerAnswer } from "@/lib/owner-console/ai-prompt";
import { BILLED_PROVIDERS } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A question plus six prior turns at their caps, in 2-byte Cyrillic, with room for the JSON: (2000 + 1200) × 7 × 2 ≈ 45 KB. */
const BODY_BYTES = 64_000;

/** Headroom over the reply the prompt asks for (1200 + 2000 characters of Cyrillic and the JSON around them): a reply cut at the
 *  limit is a failure (output_too_long), never a shorter answer. */
const OWNER_OUTPUT_TOKENS = 3000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 0209's caps, counted in code points as Postgres counts them: a stored message longer than these is refused, so the answer is
 *  cut to fit, never dropped. */
const OWNER_TEXT_MAX = 2000;
const AI_TEXT_MAX = 12000;

type Db = NonNullable<Awaited<ReturnType<typeof createClient>>>;
type HistoryState = "saved" | "not_saved" | "needs_migration";

/** Cuts by code points, not UTF-16 units: `.slice` could split an emoji into a lone surrogate, which Postgres refuses as invalid
 *  text and the whole save would fail. U+0000 is dropped because Postgres text cannot hold it at all. Not exported: a route module
 *  may export only handlers and route config, or `next build` fails. */
function forStorage(s: string, max: number): string {
  return Array.from(s.replace(/\u0000/g, "")).slice(0, max).join("");
}

/**
 * Stores the question and the answer in the owner's history (0209) with one call, after the turn has been recorded as answered:
 * the database accepts it only for an answered 0203 turn of this person not saved before, and writes both rows in one transaction
 * (into this session, or a new one when it is gone or not this person's). Never throws and never fails the turn: the answer is
 * already paid for. A failure is logged with a named code (the database's, never the text).
 */
async function saveHistory(supabase: Db, turn: number, sessionId: string | null, question: string, answer: string, asOf: string | null, model: string): Promise<{ sessionId: string | null; state: HistoryState }> {
  try {
    const { data, error } = await supabase.rpc("owner_ai_turn_save", {
      p_turn: turn,
      p_session: sessionId,
      p_question: forStorage(question, OWNER_TEXT_MAX),
      p_answer: forStorage(answer, AI_TEXT_MAX),
      p_as_of: asOf,
      p_model: model,
    });
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "42883" || code === "PGRST202") {
        console.error("owner ai: history_needs_0209");
        return { sessionId, state: "needs_migration" };
      }
      // The session the page holds is untouched by a refused save, so the next question may still continue it.
      console.error("owner ai: history_save_failed", code ?? "unknown");
      return { sessionId, state: "not_saved" };
    }
    if (typeof data !== "string" || !UUID.test(data)) {
      console.error("owner ai: history_save_failed", "no_id");
      return { sessionId, state: "not_saved" };
    }
    return { sessionId: data, state: "saved" };
  } catch (e) {
    console.error("owner ai: history_save_failed", e instanceof Error ? e.name : "unknown");
    return { sessionId, state: "not_saved" };
  }
}

/** The vendor gets an opaque id for abuse tracing (as S5's chat does), never the person's database key. */
async function vendorUser(userId: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nightshift-owner:${userId}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * POST /api/brain/owner/turn — one question to the owner's Nightshift AI. Answers and drafts only: there is no action endpoint and
 * the model has no tools, so nothing it says is executed (no payment, price, plan, user edit or publish).
 *
 * Order, and why:
 *  1. Same-origin POST, a signed-in user, and the platform owner (0182) — anyone else gets the plain 404 before anything is read,
 *     so the route's existence says nothing.
 *  2. The owner's chosen model (0199 ai_chat_owner_settings), on sale and keyed on this server — or the reason it is not. Never
 *     another model (rule 4).
 *  3. The owner's facts, built server side (second factor enforced there). The browser never sends a figure.
 *  4. A turn reserved in the database under the daily cap (0203) BEFORE the vendor is called; finished with how it ended.
 *  5. Only after a turn recorded as answered: the question and the (link-guarded) answer stored together in the owner's history
 *     (0209, owner-only, deletable, the same on every device; an answer can hold figures and customer names). The facts document is
 *     never stored, and nothing about the question or answer is logged.
 */
export async function POST(request: Request) {
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const user = await getUser();
  if (!user) return notFound();
  if ((await ownerAccess()) !== "owner") return notFound();
  const supabase = await createClient();
  if (!supabase) return notFound();

  const body = await readJsonBodyCapped(request, BODY_BYTES);
  if (!body.ok) return brainJson({ error: body.reason === "too_large" ? "payload_too_large" : "bad_request" }, body.reason === "too_large" ? 413 : 400);
  const b = (body.value ?? {}) as Record<string, unknown>;
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!question) return brainJson({ error: "bad_request" }, 400);
  if (question.length > QUESTION_MAX) return brainJson({ error: "message_too_long", limit: QUESTION_MAX }, 400);
  const history = readHistory(b.history);
  // Checked before anything is spent: a malformed id would otherwise cost a paid turn and then fail to save.
  const sessionId = b.session_id === undefined || b.session_id === null ? null : typeof b.session_id === "string" && UUID.test(b.session_id) ? b.session_id : undefined;
  if (sessionId === undefined) return brainJson({ error: "bad_request" }, 400);

  const settings = await supabase.rpc("ai_chat_owner_settings");
  if (settings.error) {
    const code = (settings.error as { code?: string }).code;
    if (code === "42883" || code === "PGRST202") return brainJson({ error: "not_enabled", needs: "0199" }, 503);
    return brainJson({ error: "unavailable" }, 503);
  }
  const model = await chosenModelState(supabase, (settings.data as { model?: unknown } | null)?.model);
  if (!model.ok) return brainJson({ error: "unavailable" }, 503);
  if (model.state !== "available" || !model.id) return brainJson({ error: "model_unavailable", reason: model.state }, 409);

  let facts;
  try {
    facts = await buildOwnerFacts();
  } catch (e) {
    if (e instanceof OwnerOnlyError) return notFound();
    if (e instanceof SecondFactorRequiredError) return brainJson({ error: "second_factor" }, 401);
    return brainJson({ error: "unavailable" }, 503);
  }

  const reserve = await supabase.rpc("owner_ai_reserve_turn", { p_chars: question.length, p_model: model.id });
  if (reserve.error) {
    const e = reserve.error as { code?: string; message?: string; details?: string };
    if (e.code === "42883" || e.code === "PGRST202") return brainJson({ error: "not_enabled", needs: "0203" }, 503);
    if (e.code === "NS401") return brainJson({ error: "second_factor" }, 401);
    if (e.message === "owner_ai_daily_cap") {
      const m = /used=(\d+) limit=(\d+)/.exec(e.details ?? "");
      return brainJson({ error: "daily_cap", used: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : null }, 429);
    }
    if (e.code === "42501") return notFound();
    return brainJson({ error: "unavailable" }, 503);
  }
  const turn = Number(reserve.data);
  // No id, no call: a turn that cannot be finished would be spend the log never records.
  if (!Number.isSafeInteger(turn) || turn <= 0) return brainJson({ error: "unavailable" }, 503);
  const finish = async (ok: boolean, error: string | null, tokensIn: number | null, tokensOut: number | null) => {
    try {
      const { error: e } = await supabase.rpc("owner_ai_finish_turn", { p_turn: turn, p_ok: ok, p_error: error, p_tokens_in: tokensIn, p_tokens_out: tokensOut });
      return !e;
    } catch {
      return false;
    }
  };

  // Everything after the reserve is guarded (as S5's chat is, after Lens on 0199): a throw must still finish the turn, never
  // leave it "reserved" with a bare 500.
  try {
    const locale = await getLocale().catch(() => "en");
    const llm = await callChatModel(model.id, OWNER_AI_SYSTEM, ownerUserBlock({ facts, question, history, locale }), { endUser: await vendorUser(user.id), maxOutputTokens: OWNER_OUTPUT_TOKENS });
    if (!llm.ok) {
      await finish(false, llm.error, llm.tokensIn, llm.tokensOut);
      // The failure names its remedy (rule 6): the page says "top up the chat model's provider" for vendor_quota, and so on.
      return brainJson({ error: "model_failed", reason: llm.error }, llm.error === "timeout" ? 504 : 502);
    }
    const answer = readOwnerAnswer(extractJson(llm.text));
    if (!answer) {
      await finish(false, "bad_answer", llm.tokensIn, llm.tokensOut);
      return brainJson({ error: "model_failed", reason: "bad_answer" }, 502);
    }
    // The answer is paid for whether or not the log write lands: it is returned either way, and a failed write is the
    // only thing a log line names (no question, no answer).
    const finished = await finish(true, null, llm.tokensIn, llm.tokensOut);
    if (!finished) console.error("owner ai: finish_turn failed", turn);
    const known = knownLinks(facts, BILLED_PROVIDERS.flatMap((p) => (p.billingUrl ? [p.billingUrl] : [])));
    const a = guardLinks(answer.answer, known);
    const d = answer.draft ? guardLinks(answer.draft.body, known) : null;
    const dt = answer.draft?.title ? guardLinks(answer.draft.title, known) : null;
    // Only the guarded text is kept: what the owner saw, never a link the guard cut.
    // A turn the log did not record as answered is one 0209 refuses to store: said as not saved, without a call bound to fail.
    const saved = finished
      ? await saveHistory(supabase, turn, sessionId, question, [a.text, dt?.text, d?.text].filter(Boolean).join("\n\n"), facts.as_of, model.id)
      : { sessionId, state: "not_saved" as const };
    return brainJson({
      answer: a.text,
      draft: answer.draft && d ? { title: dt ? dt.text : null, body: d.text } : null,
      // Links or account numbers the platform does not know were cut: the panel warns, and never shows what was cut.
      removed_links: a.removed + (d?.removed ?? 0) + (dt?.removed ?? 0),
      as_of: facts.as_of,
      model: model.id,
      // Whether this turn is in the stored history (0209), said rather than assumed (rule 5).
      session_id: saved.sessionId,
      history: saved.state,
    });
  } catch (e) {
    await finish(false, "unknown", null, null);
    console.error("owner ai: turn failed", e instanceof Error ? e.name : "unknown");
    return brainJson({ error: "unavailable" }, 503);
  }
}
