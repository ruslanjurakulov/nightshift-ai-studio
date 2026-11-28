import { createClient, getUser } from "@/lib/supabase/server";
import { carrySheets, filmLinkOf } from "@/lib/brain/ref-sheets";
import { saveFilmLink, storedSheets } from "@/lib/server/brain/ref-sheets";
import { BRIEF_MAX_BYTES, briefBytes } from "@/lib/brain/brief-size";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { readAgeState } from "@/lib/server/age";
import { getOrgContext } from "@/lib/orgs-server";
import { getLocale } from "@/lib/i18n/server";
import { filmGate } from "@/lib/server/films";
import { coerceQuote } from "@/lib/studio/timeline";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import {
  FILM,
  HISTORY_TURNS,
  buildBrief,
  draftSettings,
  filmFromBrief,
  nextSlot,
  plain,
  priceLong,
  isSmallTalk,
  unsafeBrief,
  promptOverLimit,
  readModelAnswer,
  readScenario,
  readSlots,
  speechAllowed,
  speechBlocks,
  speechOf,
  speechVoice,
  voiceQuotable,
  changeOptions,
  isInferable,
  mergeSlots,
  type Brief,
  type BrainSlots,
  type InferableSlot,
  type BrainCard,
  type BriefPrice,
  type Scenario,
} from "@/lib/brain/logic";
import { SYSTEM_PROMPT, dataBlock } from "@/lib/brain/prompt";
import { getDictionaryFor } from "@/lib/i18n";
import { isLocale } from "@/lib/i18n/core";
import { callChatModel, type ChatModelId } from "@/lib/server/brain/llm";
import { createHash } from "node:crypto";
import { chatModelGate } from "@/lib/server/brain/google-gate";
import { readChannelFacts } from "@/lib/server/brain/facts";
import { chatPricing } from "@/lib/server/brain/quote";
import { catalogueClaimNames, clipShapeOf, filmCatalogue, promptLimitOf } from "@/lib/server/brain/clip";
import { FILM_MODEL_PREFERENCE, MODEL_ID, pickFilmModel, type OnSaleModel, type PickedModel } from "@/lib/brain/film-models";
import { writeStoryboard } from "@/lib/server/brain/plan";
import { beginFilmLease } from "@/lib/server/brain/film-lease";
import { claimsAuthorship, looksOverLimit, outlineText, planLimits, planTurns, withPlanTurns } from "@/lib/brain/plan";
import { brainJson, channelOrg, chosenModelState, dbRefusal, machineReason, modelFromRef, notFound, vendorUser } from "@/lib/server/brain/session";
import { FILM_PLAN_KEY } from "@/lib/brain/film-plan";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// `choose` on a short outline writes its storyboard in up to 300 s: up to three bounded calls at a time, none started that could not
// finish, with the draft's save and quote, inside lib/server/brain/plan.ts PLAN_BUDGET_MS. maxDuration is honoured on a serverless
// host only; the self-hosted server ignores it, so the proxy in front of it (Caddy) must allow a request longer than 300 s, or a
// plan is cut off while its calls still run (Lens L2). 0211's lease expires after 320 s either way.
export const maxDuration = 300;

/**
 * Nightshift Brain's one POST (docs/studio/NIGHTSHIFT_AI.md): `start`, `turn`, `answer` (a card), `choose` (a proposed scenario) and
 * `handoff` (the record of the person's own Create).
 *
 * The order of a turn is its safety:
 *   1. the flag (off: 404 before anything is read), the person, the conversation (theirs, RLS), the owner's model (on sale AND keyed
 *      on this server) — a dead model is refused before the cap is touched, and no other model is ever tried; for a Google model, the
 *      person's 18+ attestation and the request's country (lib/server/brain/google-gate), refused the same way, never rerouted;
 *   2. ai_chat_reserve_turn: the plan's cap, the person's and the platform's, in the database, under locks — before any vendor call;
 *   3. the channel's research and the history, read as the person;
 *   4. ONE call to the model, its answer checked by lib/brain/logic.ts (links and prices removed, slots validated, the next question
 *      the server's);
 *   5. ai_chat_finish_turn: the assistant's message, the tokens (unknown stays unknown), the BRIEF and card.
 * `choose` prices: a long video by the Run now estimator, a short film by quote_film on a DRAFT film (the storyboard saved into it
 * once, under the plan's lease, and never over scenes the draft already has). Nothing
 * here holds credits, starts anything or publishes (CLAUDE.md rule 3): the person's Create is the film route's or Run now's own.
 */

type Session = { id: string; org_id: string; channel_id: string | null; slots: unknown; step: string; card: unknown; brief: unknown };

const SESSION_COLS = "id,org_id,channel_id,slots,step,card,brief";

async function loadSession(supabase: SupabaseClient, id: unknown): Promise<{ ok: true; s: Session } | { ok: false; res: Response }> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  const { data, error } = await supabase.from("ai_chat_sessions").select(SESSION_COLS).eq("id", id).maybeSingle();
  if (error) return { ok: false, res: dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503) };
  if (!data || !aiChatOpenFor(data.org_id, aiChatEnv())) return { ok: false, res: notFound() };
  // A project's own conversation (the film editor's storyboard writer, lib/server/brain/film-plan) is never a chat's: a turn, an
  // answer, a choice or a hand-off in it would write the chat's BRIEF over the project's marker, or spend the project's turns.
  // Refused here, before any reserve or save, by the same predicate the chat's reads exclude it by (brief->film_plan->>film_id).
  const marker = (data.brief as Record<string, unknown> | null)?.[FILM_PLAN_KEY];
  const markedFilm = marker && typeof marker === "object" ? (marker as { film_id?: unknown }).film_id : undefined;
  if (typeof markedFilm === "string") {
    // With the project's id when it is one (the BRIEF is its author's to write): the chat links to that project's editor.
    const filmId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(markedFilm) ? markedFilm : null;
    return { ok: false, res: brainJson(filmId ? { error: "film_conversation", film_id: filmId } : { error: "film_conversation" }, 409) };
  }
  return { ok: true, s: data as Session };
}

/** A turn the person is not charged for (not_sent, a safety refusal): the reserve counted it, the finished call does not. */
function uncharged(q: { used: number; limit: number | null; trial_left: number | null }) {
  // The plan's cap forgives it; the Free trial counts every outcome (0199 ai_chat_trial_left), so the trial is never handed one
  // back (Lens M4: the panel showed a trial message the database had already counted).
  return { used: Math.max(0, q.used - 1), limit: q.limit, trial_left: q.trial_left };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The story re-ask only when the first answer left room for a second one inside maxDuration (300 s; a proposal call may take 150). */
const STORY_REASK_AFTER_MS = 120_000;
/** The greeting's first card is not stored (nothing is written for a greeting): answered by this id while no kind is decided. */
const FIRST_CARD = "kind-first";

/** What can be made here, in the person's language: a long video needs a channel, a short film needs Film Studio open. */
async function kindChoices(s: Session) {
  const locale = await getLocale().catch(() => "en");
  const words = getDictionaryFor(isLocale(locale) ? locale : "en").aiChat;
  const open = (await filmGate()).ok;
  return { words, open, kindOptions: [...(s.channel_id ? [words.kindLong] : []), ...(open ? [words.kindShort] : [])] };
}

async function runTurn(supabase: SupabaseClient, s: Session, text: string, retry = false, requestId: string | null = null,
                       force?: Partial<Pick<BrainSlots, InferableSlot>>): Promise<Response> {
  // The owner's model as it is now (0199 hands a member only a reference to it, never the id).
  const q0 = await supabase.rpc("ai_chat_quota", { p_org: s.org_id });
  if (q0.error) return dbRefusal(q0.error) ?? brainJson({ error: "unavailable" }, 503);
  const model = await chosenModelState(supabase, modelFromRef((q0.data as { model_ref?: unknown } | null)?.model_ref));
  if (!model.ok) return brainJson({ error: "unavailable" }, 503);
  if (model.state !== "available" || !model.id) return brainJson({ error: "model_unavailable", reason: model.state }, 409);
  // Google's 18+ and country conditions, before the cap is touched (a refused turn is never a turn) and before any vendor call.
  const gate = await chatModelGate(model.id);
  if (gate) return brainJson({ error: gate.error }, gate.status);

  const prev0 = readSlots(s.slots);
  const { words: words0, open, kindOptions } = await kindChoices(s);
  if (!prev0.kind && kindOptions.length === 0) return brainJson({ error: "channel_required" }, 400);
  // A greeting or "who are you" before anything is decided: Nightshift AI's own answer and the first question, from i18n. No vendor
  // call, no turn, nothing written (Lens on 0199: a "salom" cost a turn; Breach: a not_sent that stores is a free write).
  if (!retry && !prev0.kind && isSmallTalk(text)) {
    const first: BrainCard = { id: FIRST_CARD, slot: "kind", thread_title: "", question: "", allow_own: true, options: kindOptions };
    return brainJson({ reply: words0.identityReply, slots: prev0, step: "asking", card: first, scenarios: [], brief: buildBrief(s.id, prev0, null, "drafting") });
  }

  const reserve = await supabase.rpc("ai_chat_reserve_turn", { p_session: s.id, p_text: retry ? "" : text, p_retry: retry, p_request_id: requestId });
  if (reserve.error) return dbRefusal(reserve.error) ?? brainJson({ error: "unavailable" }, 503);
  const r = { ...(reserve.data as { call_id: string; used: number; limit: number | null; trial_left?: number | null }) };
  const quota = { used: r.used, limit: r.limit, trial_left: typeof r.trial_left === "number" ? r.trial_left : null };
  const finish = (outcome: string, tokensIn: number | null, tokensOut: number | null,
                  extra?: { text: string; payload: unknown; slots: unknown; step: string; brief: unknown; card: unknown }) =>
    supabase.rpc("ai_chat_finish_turn", {
      p_call: r.call_id, p_outcome: outcome, p_tokens_in: tokensIn, p_tokens_out: tokensOut,
      p_text: extra?.text ?? null, p_payload: extra?.payload ?? null, p_slots: extra?.slots ?? null, p_step: extra?.step ?? null,
      p_brief: extra?.brief ?? null, p_card: extra?.card ?? null,
    });

  // From here a turn was taken: whatever happens, it ends with a recorded outcome (Lens on 0199: a throw left it pending forever).
  // Until the vendor is called, a failure is not_sent: it costs nothing and the person is not charged a turn for it.
  let called = false;
  // not_sent is refused for a call older than 2 minutes: then the turn is recorded as a failure rather than left pending.
  const finishUnsent = async () => {
    const r = await finish("not_sent", null, null);
    if (r.error) await finish("vendor_error", null, null);
  };
  try {
  const [ch, hist] = await Promise.all([
    s.channel_id ? channelOrg(supabase, s.channel_id) : Promise.resolve({ state: "none" as const }),
    supabase.from("ai_chat_messages").select("role,content").eq("session_id", s.id).order("id", { ascending: false }).limit(HISTORY_TURNS),
  ]);
  if (hist.error || ch.state === "failed") {
    await finishUnsent();
    return brainJson({ error: "unavailable", quota: uncharged(quota) }, 503);
  }
  const prev = readSlots(s.slots);
  const facts = await readChannelFacts(supabase, s.channel_id, ch.state === "ok" ? ch.name : "");
  const history = ((hist.data ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();
  const locale = await getLocale().catch(() => "en");
  // A short film is offered only where it can be made (Pixel M6 on 0199: no dead option); the kind card's options are ours.
  const shortAvailable = open;
  const words = words0;
  called = true;
  // Room for two or three whole scenarios on every turn: the answer that fills the last open slot proposes them in the same turn
  // (DATA open_slots / last_open_slot), so the person never has to write again to see them.
  const said = retry ? [...history].reverse().find((m) => m.role === "user")?.content ?? "" : text;
  const rules = { freezeSlots: isSmallTalk(said), shortAvailable, longAvailable: !!s.channel_id, kindOptions, identityReply: words.identityReply, force };
  const t0 = Date.now();
  let llm = await callChatModel(model.id, SYSTEM_PROMPT, dataBlock({ history, slots: prev, askNext: nextSlot(prev), facts, locale, shortAvailable }),
                                { endUser: await vendorUser(s.org_id), size: "proposal" });
  let answer = llm.ok ? readModelAnswer(llm.text, prev, crypto.randomUUID(), rules) : null;
  // Outlines that broke the story grammar, refused by name with the turns this press used. A chip's change is the person's answer
  // and is kept even then (0199 stores slots only with an "ok" outcome, so that one call is recorded "ok", with no message).
  const arcRefused = async (used: number, tokensIn: number | null, tokensOut: number | null, kept: typeof answer) => {
    if (force && kept && !kept.refused) {
      await finish("ok", tokensIn, tokensOut, { text: "", payload: null, slots: kept.slots, step: s.step, brief: null, card: s.card ?? null });
    } else {
      await finish("invalid_output", tokensIn, tokensOut);
    }
    return brainJson({ error: "story_arc_invalid", used, quota, ...(force && kept && !kept.refused ? { slots: kept.slots } : {}) }, 422);
  };
  // Every slot known, but too few outlines kept the story grammar: asked again ONCE with the server's reason, as a turn of its own
  // (0199's p_retry: the person's message is still the last, unanswered), then refused by name. Never proposed half-made. Not when
  // the first answer took so long that a second could not finish inside the route's 300 s (Lens M2): refused by name at once.
  if (llm.ok && answer && !answer.refused && answer.storyProblem) {
    if (Date.now() - t0 > STORY_REASK_AFTER_MS) return arcRefused(1, llm.tokensIn, llm.tokensOut, answer);
    const problem = answer.storyProblem;
    await finish("invalid_output", llm.tokensIn, llm.tokensOut);
    const again = await supabase.rpc("ai_chat_reserve_turn", { p_session: s.id, p_text: "", p_retry: true,
                                                               p_request_id: requestId ? `${requestId.slice(0, 62)}-r` : null });
    if (again.error) return dbRefusal(again.error) ?? brainJson({ error: "unavailable", quota }, 503);
    const r2 = again.data as { call_id: string; used: number; limit: number | null; trial_left?: number | null };
    r.call_id = r2.call_id;
    Object.assign(quota, { used: r2.used, limit: r2.limit, trial_left: typeof r2.trial_left === "number" ? r2.trial_left : null });
    llm = await callChatModel(model.id, SYSTEM_PROMPT, dataBlock({ history, slots: prev, askNext: nextSlot(prev), facts, locale, shortAvailable, problem }),
                              { endUser: await vendorUser(s.org_id), size: "proposal" });
    answer = llm.ok ? readModelAnswer(llm.text, prev, crypto.randomUUID(), rules) : null;
    if (llm.ok && answer && !answer.refused && answer.storyProblem) return arcRefused(2, llm.tokensIn, llm.tokensOut, answer);
  }
  if (!llm.ok) {
    if (llm.error === "vendor_refused") {
      // The vendor's own safety refusal: said as that, not "unavailable", not retried, and not charged to the person.
      await finish("vendor_refused", llm.tokensIn, llm.tokensOut);
      return brainJson({ error: "content_refused", quota: uncharged(quota) }, 422);
    }
    if (llm.error === "not_configured") {
      await finish("not_configured", null, null);
      return brainJson({ error: "model_failed", reason: llm.error, quota: uncharged(quota) }, 502);
    }
    if (llm.error === "output_too_long") {
      await finish("output_too_long", llm.tokensIn, llm.tokensOut);
      return brainJson({ error: "output_too_long", quota }, 502);
    }
    await finish("vendor_error", llm.tokensIn, llm.tokensOut);
    // The reason names the remedy for the owner; the panel says only "unavailable right now" to a customer (the model is hidden).
    return brainJson({ error: "model_failed", reason: llm.error, quota }, 502);
  }
  if (!answer) {
    await finish("invalid_output", llm.tokensIn, llm.tokensOut);
    return brainJson({ error: "model_answer_invalid", quota }, 502);
  }
  if (answer.refused) {
    // The plan's own safety rule (the prompt's "refused"): our words in the person's language, no scenarios, no turn charged.
    await finish("refused", llm.tokensIn, llm.tokensOut);
    return brainJson({ error: "content_refused", quota: uncharged(quota) }, 422);
  }
  const brief = buildBrief(s.id, answer.slots, null, "drafting");
  const payload = answer.step === "proposing"
    ? { scenarios: answer.scenarios, factsState: facts.state, factsSource: facts.source }
    : { lengthOutOfRange: answer.lengthOutOfRange, factsState: facts.state, factsSource: facts.source };
  // A BRIEF over the database's 262144 bytes (the character sheets counted apart, 0249) cannot be stored. The vendor was paid:
  // the turn ends as brief_too_large with the tokens reported, nothing is written, and the person is told to shorten the story or
  // split it into chapters (Atlas on BR-SW-08). Before 0249 that outcome does not exist: output_too_long, also a paid one.
  if (briefBytes(brief) > BRIEF_MAX_BYTES) {
    const ended = await finish("brief_too_large", llm.tokensIn, llm.tokensOut);
    if (ended.error) await finish("output_too_long", llm.tokensIn, llm.tokensOut);
    return brainJson({ error: "brief_too_large", quota }, 422);
  }
  const done = await finish("ok", llm.tokensIn, llm.tokensOut, {
    // The character sheets and the draft's link survive a chat turn (Lens H1): read again just before this write, so a press made
    // meanwhile is kept too. Before this, a turn wrote a BRIEF without them and the paid pictures were lost from the sheet.
    text: answer.reply, payload, slots: answer.slots, step: answer.step, brief: { ...brief, ...(await carried(supabase, s)) }, card: answer.card,
  });
  if (done.error) return dbRefusal(done.error) ?? brainJson({ error: "unavailable" }, 503);
  return brainJson({
    // With the server's count of the messages planning each outline takes (computed, never stored: the payload above has none).
    reply: answer.reply, slots: answer.slots, step: answer.step, card: answer.card, scenarios: withPlanTurns(answer.scenarios, answer.slots.kind),
    lengthOutOfRange: answer.lengthOutOfRange, factsState: facts.state, factsSource: facts.source, brief, quota,
  });
  } catch {
    // The vendor may or may not have been paid: the outcome is a failure with unknown tokens, never "pending" or "ok".
    await (called ? finish("vendor_error", null, null) : finishUnsent()).then(() => undefined, () => undefined);
    return brainJson({ error: "unavailable", quota: called ? quota : uncharged(quota) }, 503);
  }
}

/**
 * The character sheets and the draft's film link as stored right now (lib/brain/ref-sheets carrySheets), for a write that replaces
 * the BRIEF: read again just before it (Lens M2), falling back to what this request read first when that read fails. With 0249 the
 * database keeps the stored ones whatever this carries (its trigger on ai_chat_sessions), which closes the window between this read
 * and the write; the carry stays for a database without 0249, where it is still the only thing that keeps them.
 */
async function carried(supabase: SupabaseClient, s: Session) {
  return carrySheets((await storedSheets(supabase, s.id)) ?? s.brief);
}

/** sha256 hex of a server-made string: ids derived from a conversation that must not show it (Breach BR-S1-04). */
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** The person's choice of a proposed scenario: a BRIEF with the backend's price. Long: the Run now estimator. Short: the plan step
 *  writes the outline's storyboard (lib/server/brain/plan.ts), and only a complete one becomes a draft film, priced by quote_film. */
async function choose(supabase: SupabaseClient, s: Session, index: unknown): Promise<Response> {
  if (s.step !== "proposing" && s.step !== "ready") return brainJson({ error: "nothing_to_choose" }, 409);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 2) return brainJson({ error: "bad_request" }, 400);
  const [{ data: msgs, error }, lastRead] = await Promise.all([
    supabase.from("ai_chat_messages").select("id,payload").eq("session_id", s.id).eq("role", "assistant").order("id", { ascending: false }).limit(1),
    supabase.from("ai_chat_messages").select("id,role,content").eq("session_id", s.id).order("id", { ascending: false }).limit(1),
  ]);
  if (error || lastRead.error) return brainJson({ error: "unavailable" }, 503);
  const slots = readSlots(s.slots);
  const raw = ((msgs?.[0]?.payload as { scenarios?: unknown[] } | null)?.scenarios ?? [])[index];
  // A stored scenario is data too (its author could have written it directly): read through the same rules again.
  const chosen: Scenario | null = readScenario(raw, slots);
  if (!chosen || nextSlot(slots) !== null) {
    // A proposal from before the plan step whose storyboard does not add up to the length: said as old, with "ask again" (Lens L4),
    // rather than "no longer on screen" while it is on screen.
    const scenes = (raw && typeof raw === "object" ? (raw as { scenes?: unknown }).scenes : null);
    if (slots.kind === "short" && Array.isArray(scenes) && scenes.length > 0 && nextSlot(slots) === null) return brainJson({ error: "proposal_outdated" }, 409);
    return brainJson({ error: "nothing_to_choose" }, 409);
  }
  // 1. The floor under the prompt's and the vendors' safety rules (lib/brain/logic unsafeBrief, the style and audience included,
  // Breach BR-S1-01): nothing of it is planned, priced or drafted.
  if (unsafeBrief(buildBrief(s.id, slots, chosen, "ready"))) return brainJson({ error: "content_refused" }, 422);
  // And no claim that a vendor made it (lib/brain/plan claimsAuthorship, Breach BR-FILM-04): a proposal titled "Made by Claude" is
  // refused before anything is planned, priced or drafted, rather than every plan answer failing on the outline's own words.
  if (claimsAuthorship(outlineText(chosen))) return brainJson({ error: "content_refused" }, 422);
  // One draft per proposal and scenario: a re-proposal is a new key, so choosing "the first one" again is not a conflict with the
  // draft of an earlier, different first one (Lens on 0199). The plan step writes no assistant message, so the key survives it.
  const proposalId = Number((msgs?.[0] as { id?: number } | undefined)?.id ?? 0);

  if (slots.kind === "long") {
    if (!s.channel_id) return brainJson({ error: "channel_required" }, 400);
    const p = await chatPricing(supabase, s.channel_id, s.org_id);
    const price: BriefPrice = p.ok ? await priceLong(chosen.target_seconds, p.spendable, p.quote) : { state: "failed" };
    const brief = buildBrief(s.id, slots, chosen, "ready", price);
    const saved = await supabase.rpc("ai_chat_save_brief", { p_session: s.id, p_brief: { ...brief, ...(await carried(supabase, s)) }, p_step: "ready" });
    if (saved.error) return dbRefusal(saved.error) ?? brainJson({ error: "unavailable" }, 503);
    return brainJson({ brief });
  }

  // Short: a film DRAFT, priced by quote_film. Film Studio must be open here (its own flag and switch); if not, honestly not yet.
  const gate = await filmGate();
  if (!gate.ok) return brainJson({ error: "short_not_available" }, 409);
  // The models on sale for a film's two roles, read before anything is planned: the server picks from them, the plan is told its
  // clip model's real longest scene, and the card names them. A failed read plans nothing (a pick from an unread list is a guess).
  const catalogue = await filmCatalogue(supabase);
  if (!catalogue.ok) return brainJson({ error: "unavailable" }, 503);
  const keyframeAll = [...catalogue.keyframe, ...catalogue.keyframeEdit];
  // The catalogue's own model names and providers, never claimed to have made the film: the outline now, every plan answer below.
  const claimNames = catalogueClaimNames(catalogue);
  if (claimsAuthorship(outlineText(chosen), claimNames)) return brainJson({ error: "content_refused" }, 422);
  const nameOf = (list: { id: string; name: string }[], id: string | null) => (id ? { id, name: list.find((m) => m.id === id)?.name ?? id } : null);

  // The storyboard: one stored before the plan step that already adds up; the one this session's plan already wrote for this same
  // outline (a reload, a price that could not be read, a draft save that failed: choosing again re-reads the draft and the quote,
  // and spends no turn); or the plan step.
  let planned: Scenario | null = chosen.scenes.length ? chosen : null;
  // The stored scenes as written, before any reader cleaned or capped them: their prompts are measured as written (never cut first).
  let rawScenes: unknown[] = planned && raw && typeof raw === "object" && Array.isArray((raw as { scenes?: unknown }).scenes)
    ? ((raw as { scenes: unknown[] }).scenes) : [];
  let quota: unknown = undefined;
  // Stored model ids, only when they are the server's own (Breach BR-S1-07): the BRIEF is its author's to write (0199's
  // ai_chat_save_brief takes any object), so an id in it is a claim, never the server's choice. One in FILM_MODEL_PREFERENCE is
  // what this draft was made with (the draft's key would refuse another); anything else is replaced by the server's pick.
  let storedIds: { clip: string | null; keyframe: string | null } = { clip: null, keyframe: null };
  if (!planned) {
    const stored = s.step === "ready" ? readScenario(s.brief, slots) : null;
    if (stored && stored.scenes.length && stored.title === chosen.title && stored.idea === chosen.idea) {
      planned = { ...chosen, scenes: stored.scenes };
      const scenes = (s.brief as { scenes?: unknown } | null)?.scenes;
      rawScenes = Array.isArray(scenes) ? scenes : [];
      const first = (rawScenes[0] ?? null) as { clip_model?: unknown; keyframe_model?: unknown } | null;
      const ours = (role: "clip" | "keyframe", v: unknown) =>
        typeof v === "string" && (FILM_MODEL_PREFERENCE[role] as readonly string[]).includes(v) ? v : null;
      storedIds = { clip: ours("clip", first?.clip_model), keyframe: ours("keyframe", first?.keyframe_model) };
    }
  }
  const asPicked = (list: OnSaleModel[], id: string): PickedModel => {
    const m = list.find((x) => x.id === id);
    const d = (m?.durations ?? []).filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b);
    return { id, name: m?.name || null, durations: d.length ? d : null };
  };
  // A new draft: the server's pick, in its fixed order (lib/brain/film-models). None on sale for a role: that role stays unset.
  const pick = {
    clip: storedIds.clip ? asPicked(catalogue.clip, storedIds.clip) : pickFilmModel("clip", catalogue.clip),
    keyframe: storedIds.keyframe ? asPicked(keyframeAll, storedIds.keyframe) : pickFilmModel("keyframe", catalogue.keyframe),
  };
  const base = draftSettings(buildBrief(s.id, slots, chosen, "ready"));
  if (!base) return brainJson({ error: "nothing_to_choose" }, 409);
  const settings = { ...base.settings, ...(pick.clip ? { clip_model: pick.clip.id } : {}), ...(pick.keyframe ? { keyframe_model: pick.keyframe.id } : {}) };
  // The draft's key names no conversation (Breach BR-S1-04: films.idempotency_key is read by every viewer of the workspace).
  const draftKey = `brain-${digest(`nightshift-brain-draft:${s.id}:${proposalId}:${index}`).slice(0, 40)}`;

  /** A storyboard over the prompt limit, by its first scene (1-based): each stored prompt as written, then each whole prompt. */
  const overLimit = (scenario: Scenario, limit: number): { scene: number; limit: number } | null => {
    const asWritten = rawScenes.findIndex((r) => {
      const v = r && typeof r === "object" ? (r as { visual_prompt?: unknown }).visual_prompt : null;
      return typeof v === "string" && v.length > limit;
    });
    if (asWritten >= 0) return { scene: asWritten + 1, limit };
    const over = promptOverLimit(buildBrief(s.id, slots, scenario, "ready"), limit);
    return over ? { scene: over.scene, limit } : null;
  };

  // The longest whole scene prompt the picked models take, from their registry rows (S9, 0218), else the film's own 2000.
  const promptLimit = promptLimitOf(catalogue, pick.clip?.id, pick.keyframe?.id);
  // A story outline (one that picked a format) is paced at about 3 s a shot (lib/brain/plan STORY); any other keeps 3-30 s scenes.
  const storyTarget = chosen.format ? chosen.target_seconds : null;
  // A storyboard that already exists (stored, or chosen again) is measured before the draft or any turn: said before any spend.
  if (planned) {
    const over = overLimit(planned, planLimits(null, promptLimit, storyTarget).promptMax);
    if (over) return brainJson({ error: "prompt_too_long", scene: over.scene, limit: over.limit }, 422);
  }

  // The plan's lease (0211): held from before the draft until the end of this request, released in `finally` with how it ended.
  let lease: { attempt: number } | null = null;
  let ending: { state: "done" | "failed"; reason: string } = { state: "failed", reason: "unavailable" };
  /** 0211's lease for this request; a refusal to say when it is not granted. */
  const beginLease = async (turns: { at_most: number; about: number } | null): Promise<Response | null> => {
    const begun = await supabase.rpc("ai_chat_plan_begin", { p_session: s.id, p_proposal: proposalId, p_index: index });
    if (begun.error) {
      const e = begun.error as { code?: string; message?: string; details?: string };
      if (e.code === "PGRST202" || e.code === "42883" || e.code === "PGRST205" || e.code === "42P01") return brainJson({ error: "plan_unavailable" }, 503);
      // Another tab (or this one, refreshed) is writing it: said with when that plan's time runs out, nothing spent here.
      if (e.message === "plan_running") return brainJson({ error: "plan_running", expires_at: typeof e.details === "string" ? e.details : null }, 409);
      return dbRefusal(e) ?? brainJson({ error: "unavailable" }, 503);
    }
    const b = (begun.data ?? {}) as { attempt?: unknown; user_left?: unknown };
    if (typeof b.attempt !== "number" || !Number.isInteger(b.attempt)) return brainJson({ error: "plan_unavailable" }, 503);
    lease = { attempt: b.attempt };
    // The person's own turns across every workspace (0199 per_user_daily), returned by the lease: the same up-front rule.
    if (turns && typeof b.user_left === "number" && b.user_left < turns.at_most) {
      ending = { state: "failed", reason: "plan_over_cap" };
      return brainJson({ error: "plan_over_cap", needed: turns.at_most, about: turns.about, left: b.user_left, scope: "person" }, 429);
    }
    return null;
  };
  /** Whether this request's attempt still holds the lease (Breach BR-S1-08): asked before every write. A plan whose server stalled
   *  past its 320 s may have been taken over by another tab, which wrote its own storyboard; this one then writes nothing. */
  const stillOurs = async (): Promise<boolean> => {
    if (!lease) return false;
    const st = await supabase.rpc("ai_chat_plan_state", { p_session: s.id });
    const d = (st.data ?? null) as { attempt?: unknown; state?: unknown } | null;
    return !st.error && !!d && d.attempt === (lease as { attempt: number }).attempt && d.state === "running";
  };
  const superseded = (filmId: string | null) => {
    ending = { state: "failed", reason: "plan_superseded" };
    return brainJson({ error: "plan_superseded", ...(filmId ? { film_id: filmId } : {}), ...(quota !== undefined ? { quota } : {}) }, 409);
  };
  try {
    let limits = planLimits(null, promptLimit, storyTarget);
    let model: ChatModelId | null = null;
    /** The plan's worst case and its usual count (lib/brain/plan planTurns): what 0232's film lease reserves once the draft exists. */
    let planNeeds: { at_most: number; about: number } | null = null;
    if (!planned) {
      const q0 = await supabase.rpc("ai_chat_quota", { p_org: s.org_id });
      if (q0.error) return dbRefusal(q0.error) ?? brainJson({ error: "unavailable" }, 503);
      const q = (q0.data ?? {}) as { used?: unknown; limit?: unknown; trial_left?: unknown; model_ref?: unknown };
      // The owner's model, as for a turn: a dead one is refused before any turn is reserved, and no other model is ever tried.
      const state = await chosenModelState(supabase, modelFromRef(q.model_ref));
      if (!state.ok) return brainJson({ error: "unavailable" }, 503);
      if (state.state !== "available" || !state.id) return brainJson({ error: "model_unavailable", reason: state.state }, 409);
      // Every plan call is a turn to the same model, so the same gate as a turn (Google's 18+ and country), before any turn.
      const modelGate = await chatModelGate(state.id);
      if (modelGate) return brainJson({ error: modelGate.error }, modelGate.status);
      model = state.id;
      // The longest scene is the picked clip model's longest shot × max_shots (G4), told to every window up front. No clip model:
      // the film's own 3–30 s, and the quote's "model_not_set" says the rest.
      limits = planLimits(pick.clip ? { durations: pick.clip.durations, maxShots: FILM.maxShots } : null, promptLimit, storyTarget);
      const turns = planTurns(chosen, limits);
      // An outline no answer could fit into 60 scenes, or two short chapters no call had room for (Lens M2): said before any turn.
      if (!turns) return brainJson({ error: "plan_failed", reason: "not_plannable", step: null }, 409);
      // Look sheets too long to fit any shot's prompt with its characters (Lens M3): said before the lease and any turn, with the remedy.
      const looks = chosen.format ? looksOverLimit(chosen, slots.style ?? null, limits.promptMax) : null;
      if (looks) return brainJson({ error: "looks_too_long", length: looks.length, limit: looks.limit, in_frame: looks.in_frame }, 422);
      // Every call is a turn under the daily cap. A plan is begun only when today's turns cover its worst case (every window asked
      // again once), so it can never stop halfway for the plan's cap and price nothing. Zero left is the database's own refusal.
      // What other plans hold (0232's `reserved`; absent before 0232, when nothing can be held) is not left: subtracted here too.
      const used = typeof q.used === "number" ? q.used : null;
      const held = typeof (q as { reserved?: unknown }).reserved === "number" ? Math.max(0, (q as { reserved: number }).reserved) : 0;
      const unheld = typeof q.limit === "number" ? (used === null ? null : q.limit - used) : typeof q.trial_left === "number" ? q.trial_left : null;
      const left = unheld === null ? null : Math.max(0, unheld - held);
      // Short only because storyboards being written hold the rest (it fits once they end): a wait, said with when (0232's order).
      if (left !== null && left < turns.at_most && held > 0 && unheld !== null && unheld >= turns.at_most) {
        const until = (q as { reserved_until?: unknown }).reserved_until;
        return brainJson({ error: "chat_reserved", used, reserved: held, limit: typeof q.limit === "number" ? q.limit : null,
                           until: typeof until === "string" ? until : null, scope: typeof q.limit === "number" ? "workspace" : "trial" }, 429);
      }
      if (left !== null && left > 0 && left < turns.at_most) {
        return brainJson({ error: "plan_over_cap", needed: turns.at_most, about: turns.about, left,
                           ...(typeof q.limit === "number" ? {} : { scope: "trial" }) }, 429);
      }
      // 2. One plan at a time per conversation (0211). Without the lease there is no plan: never two of them, never one unguarded.
      const refused = await beginLease(turns);
      if (refused) return refused;
      planNeeds = turns;
    }

    // 3. The draft, before any turn is spent on its storyboard (Breach BR-S1-03): settings only, no scene, so a workspace that cannot
    // make it is told now. Its version is kept: the storyboard is saved at it, or not at all.
    const created = await supabase.rpc("create_film_draft", {
      p_org: s.org_id, p_channel: s.channel_id, p_source_kind: "script", p_source_text: base.sourceText || chosen.title,
      p_settings: settings, p_idempotency_key: draftKey,
    });
    if (created.error) {
      ending = { state: "failed", reason: "film_refused" };
      return brainJson({ error: "film_refused", reason: machineReason(created.error.message) }, 409);
    }
    const cd = (created.data ?? null) as {
      film?: { id?: string; version?: number; clip_model?: unknown; keyframe_model?: unknown; voice?: unknown };
      limits?: { max_shots?: unknown }; totals?: { scenes?: unknown }; scenes?: unknown;
    } | null;
    const f = cd?.film;
    if (!f?.id || typeof f.version !== "number") return brainJson({ error: "unavailable" }, 503);
    const v0 = f.version;
    // The models the film is drafted with, as the database stored them (a replayed draft keeps its own): the card names these, and a
    // scene is measured against THEIR registry limits, a key frame read from the t2i and the edit catalogues alike (BR-S1-07).
    const modelId = (v: unknown, fallback: string | null) => (typeof v === "string" && MODEL_ID.test(v) ? v : v === null ? null : fallback);
    const drafted = { clip: modelId(f.clip_model, pick.clip?.id ?? null), keyframe: modelId(f.keyframe_model, pick.keyframe?.id ?? null) };
    const draftedLimit = planLimits(null, promptLimitOf(catalogue, drafted.clip, drafted.keyframe)).promptMax;
    const models = { clip: nameOf(catalogue.clip, drafted.clip), keyframe: nameOf(keyframeAll, drafted.keyframe) };
    // How the film is heard, and what stops it at Create today (lib/brain/logic speechBlocks): a voice-over needs a film voice a quote
    // can price (only a creative_tts voice is one; the draft has none, and no film voice can be chosen yet), and a scene spoken in its
    // clip needs the cut to keep clip sound (CLIP_SOUND_IN_CUT). Said on the plan by name; Create is not offered while either holds.
    const voiceReady = voiceQuotable(f.voice);
    // What a scene may be heard as in THIS film today (lib/brain/logic speechAllowed): told to the plan, checked on its answers, and
    // on a storyboard chosen again below. Today: wordless only, so the blocked state is a defence that a plan never reaches.
    const allowed = speechAllowed(voiceReady);
    const heard = (b: Brief): Brief => {
      if (b.kind !== "short" || !b.scenes?.length) return b;
      const blocked = speechBlocks(b.scenes, voiceReady);
      return { ...b, voice: { ...speechVoice(b.scenes), ...(blocked.length ? { blocked } : {}) } };
    };
    // A film blocked at Create leaves this route with nothing it could be started with (BR-SG-01): no quote id reaches the browser.
    const startable = (b: Brief, q: { data: unknown; error: unknown }) => {
      const blocked = (b.voice.blocked ?? []).length > 0;
      const raw = q.error ? null : q.data;
      const film_quote = blocked && raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>), quote_id: undefined, startable: false } : raw;
      const read = q.error ? null : coerceQuote(q.data);
      return { film_quote, quote: blocked && read ? { ...legacyQuote(read)!, quote_id: null, startable: false } : legacyQuote(read) };
    };
    // A storyboard stored or chosen again that speaks where only a wordless film can be made: refused by name before it is saved.
    if (planned && !hasScenesOf(cd) && planned.scenes.some((sc) => !allowed.includes(speechOf(sc)))) {
      ending = { state: "failed", reason: "speech_not_available" };
      return brainJson({ error: "speech_not_available" }, 409);
    }
    // The draft already has a storyboard: this outline's, kept from an earlier choice, and perhaps edited by the person since (Lens
    // H1). It is never written over: choosing again only prices the film as it is now.
    const hasScenes = Array.isArray(cd?.scenes) ? cd!.scenes.length > 0 : typeof cd?.totals?.scenes === "number" && cd.totals.scenes > 0;
    if (hasScenes) {
      // A plan (no storyboard in this conversation for this outline) never replaces one the film already has: said, nothing spent.
      if (!planned) return superseded(f.id);
      const q = await supabase.rpc("quote_film", { p_film: f.id, p_version: v0 });
      const quoteRead = q.error ? null : coerceQuote(q.data);
      const brief: Brief = { ...heard(buildBrief(s.id, slots, planned, "ready")), price: priceOf(quoteRead) };
      // Nothing is written: the conversation's BRIEF and the film are left as they are (Lens L3: a re-price takes no lease).
      return brainJson({ brief, film: { id: f.id, version: v0 }, models, ...startable(brief, q) });
    }
    // A storyboard that is not yet in the draft (stored, or chosen from an older proposal): written now, so under the lease too.
    if (planned && !lease) {
      const refused = await beginLease(null);
      if (refused) return refused;
    }

    // 4. The storyboard, each call's request id derived from this attempt: a repeat inside it is 0199's duplicate, a Retry is a
    // new attempt with new ids.
    if (!planned && lease && model) {
      // One plan per film (0232), now that the draft is known: the film editor's button on this same draft is the other way in
      // (BR-FILM-02), and the worst case is reserved under the workspace's cap lock so the plan can finish (BR-FILM-03). Refused:
      // nothing taken, our 0211 lease ends failed below. Before 0232 is applied the function is missing and the plan goes on as before.
      if (planNeeds) {
        const filmLease = await beginFilmLease(supabase, s.id, f.id, planNeeds);
        if (!filmLease.ok) {
          ending = { state: "failed", reason: filmLease.reason };
          return filmLease.res;
        }
      }
      const last = (lastRead.data?.[0] ?? null) as { role?: string; content?: string } | null;
      const run = await writeStoryboard({
        supabase, sessionId: s.id, model, endUser: await vendorUser(s.org_id),
        requestBase: `pl${digest(`${s.id}:${proposalId}:${index}:${(lease as { attempt: number }).attempt}`).slice(0, 40)}`,
        // A Retry of this same choice after a failed plan: the person's choice is already their last, unanswered message.
        choiceStored: last?.role === "user" && last.content === chosen.title,
        choiceText: chosen.title, outline: chosen, slots, limits, claimNames, speechAllowed: allowed,
      });
      if (!run.ok) {
        ending = { state: "failed", reason: run.reason };
        return run.res;
      }
      planned = run.scenario;
      quota = run.quota ?? undefined;
    }
    if (!planned) return brainJson({ error: "unavailable" }, 503);

    // BRIEF v1's own fields: "a model id the server checked is on sale" (docs/studio/NIGHTSHIFT_AI.md). The film keeps them as its
    // defaults, so every scene's own model stays unset and follows the film.
    planned = { ...planned, scenes: planned.scenes.map((sc) => ({ ...sc, clip_model: drafted.clip, keyframe_model: drafted.keyframe })) };
    const draftBrief = heard(buildBrief(s.id, slots, planned, "ready"));
    // The whole storyboard through the same floor: a chapter's own words could carry what the outline did not.
    if (unsafeBrief(draftBrief)) {
      ending = { state: "failed", reason: "content_refused" };
      return brainJson({ error: "content_refused", ...(quota !== undefined ? { quota } : {}) }, 422);
    }
    // Every scene's whole prompt, measured as the drafted models will read it (UTF-16 units): one over the limit is refused by its
    // number, never cut, before the storyboard is kept or the film saved (0218 would refuse it at the quote).
    const tooLong = promptOverLimit(draftBrief, Math.min(limits.promptMax, draftedLimit));
    if (tooLong) {
      ending = { state: "failed", reason: "prompt_too_long" };
      return brainJson({ error: "prompt_too_long", scene: tooLong.scene, limit: tooLong.limit, ...(quota !== undefined ? { quota } : {}) }, 422);
    }
    // 5. The storyboard is kept before anything else can fail (Lens M6): a refresh, or a draft save that fails, finds it and choosing
    // again re-reads it without a turn. Unpriced until the quote below says otherwise. Only while this attempt holds the lease.
    if (!(await stillOurs())) return superseded(f.id);
    const kept = await supabase.rpc("ai_chat_save_brief", { p_session: s.id, p_brief: { ...draftBrief, ...(await carried(supabase, s)), price: { state: "unpriced" } }, p_step: "ready" });
    if (kept.error) return dbRefusal(kept.error) ?? brainJson({ error: "unavailable" }, 503);
    // Shots per scene from the film's own clip model as the database stored it, when its lengths are listed (G4); otherwise one
    // shot, and the quote names what is missing.
    const film = filmFromBrief(draftBrief, clipShapeOf(catalogue.clip, drafted.clip, cd?.limits?.max_shots), Math.min(limits.promptMax, draftedLimit));
    if (!film) return brainJson({ error: "nothing_to_choose" }, 409);
    // 6. Saved at the version the draft had: if someone edited it meanwhile, their edit wins and this plan says so.
    if (!(await stillOurs())) return superseded(f.id);
    const saved = await supabase.rpc("save_film", { p_film: f.id, p_version: v0, p_patch: { scenes: film.scenes } });
    if (saved.error) {
      if (saved.error.message === "film_changed") return superseded(f.id);
      ending = { state: "failed", reason: "film_refused" };
      return brainJson({ error: "film_refused", reason: machineReason(saved.error.message), film_id: f.id, ...(quota !== undefined ? { quota } : {}) }, 409);
    }
    const version = (saved.data as { film?: { version?: number } } | null)?.film?.version ?? v0 + 1;
    // Which film scene each BRIEF scene became, from save_film's own answer: the only link the character sheets' attach trusts
    // (lib/brain/ref-sheets FilmLink), so a scene is never matched by position after the storyboard changed (Lens M3).
    const filmLink = filmLinkOf(f.id, draftBrief.scenes ?? [], saved.data);
    // 7. The price.
    const q = await supabase.rpc("quote_film", { p_film: f.id, p_version: version });
    const quoteRead = q.error ? null : coerceQuote(q.data);
    // 8. The BRIEF with its price, again only while this attempt holds the lease.
    const brief: Brief = { ...draftBrief, price: priceOf(quoteRead) };
    if (!(await stillOurs())) return superseded(f.id);
    // The character sheets this conversation already made (lib/brain/ref-sheets) survive the storyboard being saved again.
    const stored = await supabase.rpc("ai_chat_save_brief", { p_session: s.id, p_brief: { ...brief, ...(await carried(supabase, s)), ...(filmLink ? { film_link: filmLink } : {}) }, p_step: "ready" });
    if (stored.error) return dbRefusal(stored.error) ?? brainJson({ error: "unavailable" }, 503);
    // With 0249 only its writer may set the link (the BRIEF's copy above is kept out by its trigger); without 0249 the BRIEF's copy
    // is the write and this is a no-op. A link that could not be stored is said, never left for attach to call "not this film".
    if (filmLink) {
      const linked = await saveFilmLink(supabase, s.id, filmLink);
      if (!linked.ok) return linked.res;
    }
    ending = { state: "done", reason: "" };
    return brainJson({
      brief,
      film: { id: f.id, version },
      // The models the film is made with, by name, for the card ("Video: …", "Pictures: …"); null = none was on sale for that role.
      models,
      ...(quota !== undefined ? { quota } : {}),
      // The reshaped quote older readers take, and quote_film's own answer, which S2's Create reads through coerceQuote (#905): the
      // panel never reshapes a price. Without a quote id when the film is blocked at Create.
      ...startable(brief, q),
    });
  } finally {
    // 9. Released however this request ends, by its own attempt: a later attempt's lease is never closed by this one.
    const held = lease as { attempt: number } | null;
    if (held) {
      const reason = ending.state === "done" ? null : /^[a-z][a-z0-9_]{0,39}$/.test(ending.reason) ? ending.reason : "unavailable";
      await Promise.resolve(supabase.rpc("ai_chat_plan_end", { p_session: s.id, p_attempt: held.attempt, p_state: ending.state, p_reason: reason }))
        .then(() => undefined, () => undefined);
    }
  }
}

/** Whether create_film_draft answered a draft that already has scenes (a replay). */
function hasScenesOf(cd: { totals?: { scenes?: unknown }; scenes?: unknown } | null): boolean {
  return Array.isArray(cd?.scenes) ? cd!.scenes.length > 0 : typeof cd?.totals?.scenes === "number" && cd.totals.scenes > 0;
}

/** quote_film's answer as the BRIEF's price: priced, exempt, unpriced, or failed when it could not be read. */
function priceOf(quoteRead: ReturnType<typeof coerceQuote>): BriefPrice {
  return !quoteRead ? { state: "failed" }
    : quoteRead.exempt ? { state: "exempt" }
    : quoteRead.priced && quoteRead.total !== null
      ? { state: "priced", total_credits: quoteRead.total, spendable: quoteRead.available ?? "unknown",
          // Short of credits is "does not fit" (Upgrade / Top up); any other block is said by its own reason on the card.
          fits: !quoteRead.blockedBy.includes("insufficient_credits"), shorter: null }
      : { state: "unpriced" };
}

/** The reshaped quote older readers of this route take; S2's Create reads `film_quote` instead. */
function legacyQuote(quoteRead: ReturnType<typeof coerceQuote>) {
  return quoteRead ? { quote_id: quoteRead.quoteId, total: quoteRead.total, startable: quoteRead.startable, blocked_by: quoteRead.blockedBy,
                       refusal: quoteRead.refusal, exempt: quoteRead.exempt } : null;
}

export async function POST(request: Request) {
  // Off is off: nothing is read, not even the session (Breach on 0199: a 401/403 would say the feature exists).
  if (aiChatMode(aiChatEnv()) === "off") return notFound();
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const user = await getUser();
  if (!user) return brainJson({ error: "unauthorized" }, 401);
  const supabase = await createClient();
  if (!supabase) return notFound();
  const body = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (!body.ok) return brainJson({ error: body.reason === "too_large" ? "payload_too_large" : "bad_request" }, body.reason === "too_large" ? 413 : 400);
  const b = (body.value ?? {}) as Record<string, unknown>;
  // The browser's id for this press: a network retry of the same press is a duplicate, never a second message (0199).
  const requestId = typeof b.request_id === "string" && REQUEST_ID.test(b.request_id) ? b.request_id : null;
  // 0192: someone who said they are under 18 is not served, as on Run now.
  if ((await readAgeState()) === "minor") return brainJson({ error: "adult_only_service" }, 403);

  if (b.action === "start") {
    const channelId = typeof b.channel === "string" && b.channel.trim() ? b.channel.trim() : null;
    let orgId: string | null = null;
    if (channelId) {
      const access = await requireOrgRole({ channelId }, "editor");
      if (!access.ok) return access.status === 404 ? notFound() : brainJson({ error: access.error }, access.status);
      const ch = await channelOrg(supabase, channelId);
      if (ch.state === "failed") return brainJson({ error: "unavailable" }, 503);
      if (ch.state === "missing") return notFound();
      orgId = ch.orgId;
    } else {
      const org = await getOrgContext();
      orgId = org.supported && org.current ? org.current.id : null;
      if (!orgId) return brainJson({ error: "org_required" }, 400);
      const access = await requireOrgRole({ orgId }, "editor");
      if (!access.ok) return brainJson({ error: access.error }, access.status);
    }
    if (!aiChatOpenFor(orgId, aiChatEnv())) return notFound();
    const quota = await supabase.rpc("ai_chat_quota", { p_org: orgId });
    if (quota.error) return dbRefusal(quota.error) ?? brainJson({ error: "unavailable" }, 503);
    const model = await chosenModelState(supabase, modelFromRef((quota.data as { model_ref?: unknown })?.model_ref));
    if (!model.ok) return brainJson({ error: "unavailable" }, 503);
    if (model.state !== "available" || !model.id) return brainJson({ error: "model_unavailable", reason: model.state }, 409);
    // Said at Start, before a conversation is opened that could never be answered here (CLAUDE.md rule 6).
    const gate = await chatModelGate(model.id);
    if (gate) return brainJson({ error: gate.error }, gate.status);
    const started = await supabase.rpc("ai_chat_start", { p_org: orgId, p_channel: channelId });
    if (started.error) return dbRefusal(started.error) ?? brainJson({ error: "unavailable" }, 503);
    const sid = String(started.data);
    const prompt = typeof b.prompt === "string" ? b.prompt : "";
    if (!prompt.trim()) return brainJson({ session: { id: sid } });
    const loaded = await loadSession(supabase, sid);
    if (!loaded.ok) return loaded.res;
    const res = await runTurn(supabase, loaded.s, prompt, false, requestId);
    const d = await res.json();
    // A duplicate names the conversation the first copy went to: that one, not the empty one just started.
    return brainJson({ ...d, session: d.error === "duplicate_request" && d.session?.id ? d.session : { id: sid } }, res.status);
  }

  const loaded = await loadSession(supabase, b.session);
  if (!loaded.ok) return loaded.res;
  const s = loaded.s;
  const access = s.channel_id ? await requireOrgRole({ channelId: s.channel_id }, "editor") : await requireOrgRole({ orgId: s.org_id }, "editor");
  if (!access.ok) return notFound();

  if (b.action === "turn") {
    if (typeof b.text !== "string") return brainJson({ error: "bad_request" }, 400);
    return runTurn(supabase, s, b.text, false, requestId);
  }
  if (b.action === "retry") return runTurn(supabase, s, "", true);
  if (b.action === "answer") {
    // The greeting's first card is not stored: it is answered by its fixed id while no kind is decided, with today's options.
    const first = b.card === FIRST_CARD && !readSlots(s.slots).kind
      ? ({ id: FIRST_CARD, slot: "kind", thread_title: "", question: "", allow_own: true, options: (await kindChoices(s)).kindOptions } as BrainCard) : null;
    const c = first ?? ((s.card ?? null) as BrainCard | null);
    if (!c || b.card !== c.id) return brainJson({ error: "card_changed" }, 409);
    // The person's own words are theirs: bounded by the message limit (the database checks it), never trimmed of a "price" or a link.
    const own = typeof b.own === "string" ? plain(b.own, 4000, true) : "";
    const pick = typeof b.choice === "number" && Number.isInteger(b.choice) ? c.options[b.choice - 1] : undefined;
    const text = own || pick;
    if (!text) return brainJson({ error: "bad_request" }, 400);
    return runTurn(supabase, s, text, false, requestId);
  }
  if (b.action === "change") {
    // An inferred slot the person corrects (a chip): their answer is merged as said, whatever the model writes, and the turn goes on
    // from there (it proposes again when every slot is known). Only a slot that IS an inference, before a plan is chosen.
    const slot = b.slot;
    const prev = readSlots(s.slots);
    if (!isInferable(slot) || !(prev.inferred ?? []).includes(slot) || s.step === "ready" || s.step === "created") return brainJson({ error: "card_changed" }, 409);
    const options = changeOptions(slot);
    const own = typeof b.own === "string" ? plain(b.own, 200) : "";
    const value = typeof b.choice === "number" && Number.isInteger(b.choice) ? options[b.choice - 1] : own;
    if (!value) return brainJson({ error: "bad_request" }, 400);
    // Read on its own (from the kind alone): merged into prev, an unusable value would leave the old inference standing.
    const forced = mergeSlots({ kind: prev.kind }, { [slot]: value }).slots[slot];
    if (forced === undefined) return brainJson({ error: "bad_request" }, 400);
    const words = (await kindChoices(s)).words;
    const label = words.slotNames[slot];
    // The person's message reads as the chip showed it, in the app's language (a language by its own name, a shape described); the
    // value merged is the server's own either way.
    const names = slot === "language" ? (words.languageNames as Record<string, string>) : slot === "aspect" ? (words.aspectNames as Record<string, string>) : {};
    const said = names[String(forced)] ?? value;
    return runTurn(supabase, s, `${label}: ${said}`, false, requestId, { [slot]: forced } as Partial<Pick<BrainSlots, InferableSlot>>);
  }
  if (b.action === "choose") return choose(supabase, s, b.index);
  if (b.action === "handoff") {
    const h = b.handoff && typeof b.handoff === "object" ? (b.handoff as Record<string, unknown>) : null;
    if (!h) return brainJson({ error: "bad_request" }, 400);
    const { error } = await supabase.rpc("ai_chat_record_handoff", { p_session: s.id, p_handoff: h });
    if (error) return dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503);
    return brainJson({ ok: true });
  }
  return brainJson({ error: "bad_request" }, 400);
}
