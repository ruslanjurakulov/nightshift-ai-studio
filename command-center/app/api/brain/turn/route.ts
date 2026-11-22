import { createClient, getUser } from "@/lib/supabase/server";
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
  filmFromBrief,
  nextSlot,
  plain,
  priceLong,
  isSmallTalk,
  unsafeBrief,
  readModelAnswer,
  readScenario,
  readSlots,
  type Brief,
  type BrainCard,
  type BriefPrice,
  type Scenario,
} from "@/lib/brain/logic";
import { SYSTEM_PROMPT, dataBlock } from "@/lib/brain/prompt";
import { getDictionaryFor } from "@/lib/i18n";
import { isLocale } from "@/lib/i18n/core";
import { callChatModel } from "@/lib/server/brain/llm";
import { chatModelGate } from "@/lib/server/brain/google-gate";
import { readChannelFacts } from "@/lib/server/brain/facts";
import { chatPricing } from "@/lib/server/brain/quote";
import { clipShape } from "@/lib/server/brain/clip";
import { writeStoryboard } from "@/lib/server/brain/plan";
import { planLimits, planWindows } from "@/lib/brain/plan";
import { brainJson, channelOrg, chosenModelState, dbRefusal, modelFromRef, notFound } from "@/lib/server/brain/session";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// `choose` on a short outline writes its storyboard: up to three bounded calls at a time inside this (lib/server/brain/plan.ts
// PLAN_BUDGET_MS starts no call that could not finish before it).
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
 * `choose` prices: a long video by the Run now estimator, a short film by quote_film on a DRAFT film it saves from the BRIEF. Nothing
 * here holds credits, starts anything or publishes (CLAUDE.md rule 3): the person's Create is the film route's or Run now's own.
 */

type Session = { id: string; org_id: string; channel_id: string | null; slots: unknown; step: string; card: unknown; brief: unknown };

const SESSION_COLS = "id,org_id,channel_id,slots,step,card,brief";

async function loadSession(supabase: SupabaseClient, id: unknown): Promise<{ ok: true; s: Session } | { ok: false; res: Response }> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  const { data, error } = await supabase.from("ai_chat_sessions").select(SESSION_COLS).eq("id", id).maybeSingle();
  if (error) return { ok: false, res: dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503) };
  if (!data || !aiChatOpenFor(data.org_id, aiChatEnv())) return { ok: false, res: notFound() };
  return { ok: true, s: data as Session };
}

/** An opaque id for the vendor's abuse tooling: the workspace, hashed as the worker does (never the person's own user id). */
async function vendorUser(orgId: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nightshift-org:${orgId}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** A turn the person is not charged for (not_sent, a safety refusal): the reserve counted it, the finished call does not. */
function uncharged(q: { used: number; limit: number | null; trial_left: number | null }) {
  return { used: Math.max(0, q.used - 1), limit: q.limit, trial_left: q.trial_left === null ? null : q.trial_left + 1 };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The greeting's first card is not stored (nothing is written for a greeting): answered by this id while no kind is decided. */
const FIRST_CARD = "kind-first";

/** What can be made here, in the person's language: a long video needs a channel, a short film needs Film Studio open. */
async function kindChoices(s: Session) {
  const locale = await getLocale().catch(() => "en");
  const words = getDictionaryFor(isLocale(locale) ? locale : "en").aiChat;
  const open = (await filmGate()).ok;
  return { words, open, kindOptions: [...(s.channel_id ? [words.kindLong] : []), ...(open ? [words.kindShort] : [])] };
}

async function runTurn(supabase: SupabaseClient, s: Session, text: string, retry = false, requestId: string | null = null): Promise<Response> {
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
  const r = reserve.data as { call_id: string; used: number; limit: number | null; trial_left?: number | null };
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
  // Room for two or three whole scenarios on every turn: the answer to the last question is the one that proposes them.
  const llm = await callChatModel(model.id, SYSTEM_PROMPT, dataBlock({ history, slots: prev, askNext: nextSlot(prev), facts, locale, shortAvailable }),
                                  { endUser: await vendorUser(s.org_id), size: "proposal" });
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
  const said = retry ? [...history].reverse().find((m) => m.role === "user")?.content ?? "" : text;
  const answer = readModelAnswer(llm.text, prev, crypto.randomUUID(), {
    freezeSlots: isSmallTalk(said),
    shortAvailable,
    longAvailable: !!s.channel_id,
    kindOptions,
    identityReply: words.identityReply,
  });
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
  const done = await finish("ok", llm.tokensIn, llm.tokensOut, {
    text: answer.reply, payload, slots: answer.slots, step: answer.step, brief, card: answer.card,
  });
  if (done.error) return dbRefusal(done.error) ?? brainJson({ error: "unavailable" }, 503);
  return brainJson({
    reply: answer.reply, slots: answer.slots, step: answer.step, card: answer.card, scenarios: answer.scenarios,
    lengthOutOfRange: answer.lengthOutOfRange, factsState: facts.state, factsSource: facts.source, brief, quota,
  });
  } catch {
    // The vendor may or may not have been paid: the outcome is a failure with unknown tokens, never "pending" or "ok".
    await (called ? finish("vendor_error", null, null) : finishUnsent()).then(() => undefined, () => undefined);
    return brainJson({ error: "unavailable", quota: called ? quota : uncharged(quota) }, 503);
  }
}

/** The person's choice of a proposed scenario: a BRIEF with the backend's price. Long: the Run now estimator. Short: the plan step
 *  writes the outline's storyboard (lib/server/brain/plan.ts), and only a complete one becomes a draft film, priced by quote_film. */
async function choose(supabase: SupabaseClient, s: Session, index: unknown, requestId: string | null): Promise<Response> {
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
  if (!chosen || nextSlot(slots) !== null) return brainJson({ error: "nothing_to_choose" }, 409);
  // The floor under the prompt's and the vendors' safety rules (lib/brain/logic unsafeBrief): nothing of it is planned, priced or drafted.
  if (unsafeBrief(buildBrief(s.id, slots, chosen, "ready"))) return brainJson({ error: "content_refused" }, 422);
  // One draft per proposal and scenario: a re-proposal is a new key, so choosing "the first one" again is not a conflict with the
  // draft of an earlier, different first one (Lens on 0199). The plan step writes no assistant message, so the key survives it.
  const proposal = String((msgs?.[0] as { id?: number } | undefined)?.id ?? "0");

  if (slots.kind === "long") {
    if (!s.channel_id) return brainJson({ error: "channel_required" }, 400);
    const p = await chatPricing(supabase, s.channel_id, s.org_id);
    const price: BriefPrice = p.ok ? await priceLong(chosen.target_seconds, p.spendable, p.quote) : { state: "failed" };
    const brief = buildBrief(s.id, slots, chosen, "ready", price);
    const saved = await supabase.rpc("ai_chat_save_brief", { p_session: s.id, p_brief: brief, p_step: "ready" });
    if (saved.error) return dbRefusal(saved.error) ?? brainJson({ error: "unavailable" }, 503);
    return brainJson({ brief });
  }

  // Short: a film DRAFT, priced by quote_film. Film Studio must be open here (its own flag and switch); if not, honestly not yet.
  const gate = await filmGate();
  if (!gate.ok) return brainJson({ error: "short_not_available" }, 409);

  // The storyboard: one stored before the plan step that already adds up; the one this session's plan already wrote for this same
  // outline (a reload, or a price that could not be read: choosing again re-reads the draft and the quote, and spends no turn);
  // or the plan step.
  let planned: Scenario | null = chosen.scenes.length ? chosen : null;
  let quota: unknown = undefined;
  if (!planned) {
    const stored = s.step === "ready" ? readScenario(s.brief, slots) : null;
    if (stored && stored.scenes.length && stored.title === chosen.title && stored.idea === chosen.idea) planned = { ...chosen, scenes: stored.scenes };
  }
  if (!planned) {
    const q0 = await supabase.rpc("ai_chat_quota", { p_org: s.org_id });
    if (q0.error) return dbRefusal(q0.error) ?? brainJson({ error: "unavailable" }, 503);
    const q = (q0.data ?? {}) as { used?: unknown; limit?: unknown; trial_left?: unknown; model_ref?: unknown };
    // The owner's model, as for a turn: a dead one is refused before any turn is reserved, and no other model is ever tried.
    const model = await chosenModelState(supabase, modelFromRef(q.model_ref));
    if (!model.ok) return brainJson({ error: "unavailable" }, 503);
    if (model.state !== "available" || !model.id) return brainJson({ error: "model_unavailable", reason: model.state }, 409);
    // Every plan call is a turn to the same model, so the same gate as a turn (Google's 18+ and country), before any turn is reserved.
    const modelGate = await chatModelGate(model.id);
    if (modelGate) return brainJson({ error: modelGate.error }, modelGate.status);
    // The clip model a new draft gets decides the longest scene (G4). create_film_draft sets none and no migration chooses a
    // default, so today this is "unknown": the plan keeps to the film's own 3–30 s, and nothing is split on a guess.
    const limits = planLimits(await clipShape(supabase, null, FILM.maxShots));
    const windows = planWindows(chosen, limits);
    // Proposed outlines always add up; what is left is a clip model too short for this length within 60 scenes (G4).
    if (!windows) return brainJson({ error: "plan_failed", reason: "not_plannable", step: null }, 409);
    // Every call is a turn under the daily cap: a plan that cannot finish inside what is left is not begun (it would spend the
    // turns and price nothing). Zero left is the database's own refusal, said as it is today.
    const used = typeof q.used === "number" ? q.used : null;
    const left = typeof q.limit === "number" ? (used === null ? null : Math.max(0, q.limit - used)) : typeof q.trial_left === "number" ? q.trial_left : null;
    if (left !== null && left > 0 && left < windows.length) return brainJson({ error: "plan_over_cap", needed: windows.length, left }, 429);
    const last = (lastRead.data?.[0] ?? null) as { role?: string; content?: string } | null;
    const run = await writeStoryboard({
      supabase, sessionId: s.id, model: model.id, endUser: await vendorUser(s.org_id),
      requestBase: requestId ?? `pl${crypto.randomUUID().replace(/-/g, "")}`,
      // A Retry of this same choice after a failed plan: the person's choice is already their last, unanswered message.
      choiceStored: last?.role === "user" && last.content === chosen.title,
      choiceText: chosen.title, outline: chosen, slots, limits,
    });
    if (!run.ok) return run.res;
    planned = run.scenario;
    quota = run.quota ?? undefined;
  }

  const draftBrief = buildBrief(s.id, slots, planned, "ready");
  // The whole storyboard through the same floor: a chapter's own words could carry what the outline did not.
  if (unsafeBrief(draftBrief)) return brainJson({ error: "content_refused", quota }, 422);
  const first = filmFromBrief(draftBrief);
  if (!first) return brainJson({ error: "nothing_to_choose" }, 409);
  const created = await supabase.rpc("create_film_draft", {
    p_org: s.org_id, p_channel: s.channel_id, p_source_kind: "script", p_source_text: first.sourceText || draftBrief.title,
    p_settings: first.settings, p_idempotency_key: `brain-${s.id}-${proposal}-${index}`.slice(0, 80),
  });
  if (created.error) return brainJson({ error: "film_refused", reason: plain(created.error.message, 64), quota }, 409);
  const cd = (created.data ?? null) as { film?: { id?: string; version?: number; clip_model?: unknown }; limits?: { max_shots?: unknown } } | null;
  const f = cd?.film;
  if (!f?.id || typeof f.version !== "number") return brainJson({ error: "unavailable", quota }, 503);
  // Shots per scene from the film's own clip model, when it has one whose lengths are listed (G4); otherwise one shot, and the quote
  // names what is missing.
  const film = filmFromBrief(draftBrief, await clipShape(supabase, f.clip_model, cd?.limits?.max_shots)) ?? first;
  const saved = await supabase.rpc("save_film", { p_film: f.id, p_version: f.version, p_patch: { scenes: film.scenes } });
  if (saved.error) return brainJson({ error: "film_refused", reason: plain(saved.error.message, 64), film_id: f.id, quota }, 409);
  const version = (saved.data as { film?: { version?: number } } | null)?.film?.version ?? f.version + 1;
  const q = await supabase.rpc("quote_film", { p_film: f.id, p_version: version });
  const quoteRead = q.error ? null : coerceQuote(q.data);
  const price: BriefPrice = !quoteRead ? { state: "failed" }
    : quoteRead.exempt ? { state: "exempt" }
    : quoteRead.priced && quoteRead.total !== null
      ? { state: "priced", total_credits: quoteRead.total, spendable: quoteRead.available ?? "unknown",
          // Short of credits is "does not fit" (Shorten / Upgrade / Top up); any other block is said by its own reason on the card.
          fits: !quoteRead.blockedBy.includes("insufficient_credits"), shorter: null }
      : { state: "unpriced" };
  const brief: Brief = { ...draftBrief, price };
  const stored = await supabase.rpc("ai_chat_save_brief", { p_session: s.id, p_brief: brief, p_step: "ready" });
  if (stored.error) return dbRefusal(stored.error) ?? brainJson({ error: "unavailable" }, 503);
  return brainJson({
    brief,
    film: { id: f.id, version },
    ...(quota !== undefined ? { quota } : {}),
    // The film route starts it, at this quote, on the person's press ("Create — N credits"): /api/films/<id>/start.
    quote: quoteRead ? { quote_id: quoteRead.quoteId, total: quoteRead.total, startable: quoteRead.startable, blocked_by: quoteRead.blockedBy, refusal: quoteRead.refusal, exempt: quoteRead.exempt } : null,
  });
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
  if (b.action === "choose") return choose(supabase, s, b.index, requestId);
  if (b.action === "handoff") {
    const h = b.handoff && typeof b.handoff === "object" ? (b.handoff as Record<string, unknown>) : null;
    if (!h) return brainJson({ error: "bad_request" }, 400);
    const { error } = await supabase.rpc("ai_chat_record_handoff", { p_session: s.id, p_handoff: h });
    if (error) return dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503);
    return brainJson({ ok: true });
  }
  return brainJson({ error: "bad_request" }, 400);
}
