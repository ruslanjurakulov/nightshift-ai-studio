import { createClient, getUser } from "@/lib/supabase/server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped } from "@/lib/server/json-body";
import { getLocale } from "@/lib/i18n/server";
import { ownerAccess } from "@/lib/server/owner-analytics";
import { buildOwnerFacts, OwnerOnlyError, SecondFactorRequiredError } from "@/lib/server/owner-brain-facts";
import { callChatModel } from "@/lib/server/brain/llm";
import { brainJson, chosenModelState, notFound } from "@/lib/server/brain/session";
import { extractJson } from "@/lib/brain/logic";
import { OWNER_AI_SYSTEM, ownerUserBlock, QUESTION_MAX, readHistory, readOwnerAnswer } from "@/lib/owner-console/ai-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A question plus six prior turns at their caps, in 2-byte Cyrillic, with room for the JSON: (2000 + 1200) × 7 × 2 ≈ 45 KB. */
const BODY_BYTES = 64_000;

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
 *  2. The owner's chosen model (0198 ai_chat_owner_settings), on sale and keyed on this server — or the reason it is not. Never
 *     another model (rule 4).
 *  3. The owner's facts, built server side (second factor enforced there). The browser never sends a figure.
 *  4. A turn reserved in the database under the daily cap (0202) BEFORE the vendor is called; finished with how it ended.
 * Nothing about the question, the facts or the answer is logged or stored.
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

  const settings = await supabase.rpc("ai_chat_owner_settings");
  if (settings.error) {
    const code = (settings.error as { code?: string }).code;
    if (code === "42883" || code === "PGRST202") return brainJson({ error: "not_enabled", needs: "0198" }, 503);
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
    if (e.code === "42883" || e.code === "PGRST202") return brainJson({ error: "not_enabled", needs: "0202" }, 503);
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

  // Everything after the reserve is guarded (as S5's chat is, after Lens on 0198): a throw must still finish the turn, never
  // leave it "reserved" with a bare 500.
  try {
    const locale = await getLocale().catch(() => "en");
    const llm = await callChatModel(model.id, OWNER_AI_SYSTEM, ownerUserBlock({ facts, question, history, locale }), { endUser: await vendorUser(user.id) });
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
    if (!(await finish(true, null, llm.tokensIn, llm.tokensOut))) console.error("owner ai: finish_turn failed", turn);
    return brainJson({ answer: answer.answer, draft: answer.draft, as_of: facts.as_of, model: model.id });
  } catch (e) {
    await finish(false, "unknown", null, null);
    console.error("owner ai: turn failed", e instanceof Error ? e.name : "unknown");
    return brainJson({ error: "unavailable" }, 503);
  }
}
