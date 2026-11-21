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
  HISTORY_TURNS,
  buildBrief,
  filmFromBrief,
  modelText,
  nextSlot,
  plain,
  priceLong,
  readModelAnswer,
  readScenario,
  readSlots,
  type Brief,
  type BrainCard,
  type BriefPrice,
  type Scenario,
} from "@/lib/brain/logic";
import { SYSTEM_PROMPT, dataBlock } from "@/lib/brain/prompt";
import { callChatModel } from "@/lib/server/brain/llm";
import { readChannelFacts } from "@/lib/server/brain/facts";
import { chatPricing } from "@/lib/server/brain/quote";
import { brainJson, channelOrg, chosenModelState, dbRefusal, notFound } from "@/lib/server/brain/session";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Nightshift Brain's one POST (docs/studio/NIGHTSHIFT_AI.md): `start`, `turn`, `answer` (a card), `choose` (a proposed scenario) and
 * `handoff` (the record of the person's own Create).
 *
 * The order of a turn is its safety:
 *   1. the flag (off: 404 before anything is read), the person, the conversation (theirs, RLS), the owner's model (on sale AND keyed
 *      on this server) — a dead model is refused before the cap is touched, and no other model is ever tried;
 *   2. ai_chat_reserve_turn: the plan's cap, the person's and the platform's, in the database, under locks — before any vendor call;
 *   3. the channel's research and the history, read as the person;
 *   4. ONE call to the model, its answer checked by lib/brain/logic.ts (links and prices removed, slots validated, the next question
 *      the server's);
 *   5. ai_chat_finish_turn: the assistant's message, the tokens (unknown stays unknown), the BRIEF and card.
 * `choose` prices: a long video by the Run now estimator, a short film by quote_film on a DRAFT film it saves from the BRIEF. Nothing
 * here holds credits, starts anything or publishes (CLAUDE.md rule 3): the person's Create is the film route's or Run now's own.
 */

type Session = { id: string; org_id: string; channel_id: string | null; model: string; slots: unknown; step: string; card: unknown; brief: unknown };

const SESSION_COLS = "id,org_id,channel_id,model,slots,step,card,brief";

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

async function runTurn(supabase: SupabaseClient, s: Session, text: string, retry = false): Promise<Response> {
  const model = await chosenModelState(supabase, s.model);
  if (!model.ok) return brainJson({ error: "unavailable" }, 503);
  if (model.state !== "available" || !model.id) return brainJson({ error: "model_unavailable", reason: model.state }, 409);

  const reserve = await supabase.rpc("ai_chat_reserve_turn", { p_session: s.id, p_text: retry ? "" : text, p_retry: retry });
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

  // From here a turn was taken: whatever happens, it ends with a recorded outcome (Lens on 0197: a throw left it pending forever).
  try {
  const [ch, hist] = await Promise.all([
    s.channel_id ? channelOrg(supabase, s.channel_id) : Promise.resolve({ state: "none" as const }),
    supabase.from("ai_chat_messages").select("role,content").eq("session_id", s.id).order("id", { ascending: false }).limit(HISTORY_TURNS),
  ]);
  if (hist.error || ch.state === "failed") {
    await finish("vendor_error", null, null);
    return brainJson({ error: "unavailable", quota }, 503);
  }
  const prev = readSlots(s.slots);
  const facts = await readChannelFacts(supabase, s.channel_id, ch.state === "ok" ? ch.name : "");
  const history = ((hist.data ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();
  const locale = await getLocale().catch(() => "en");
  const llm = await callChatModel(model.id, SYSTEM_PROMPT, dataBlock({ history, slots: prev, askNext: nextSlot(prev), facts, locale }),
                                  { endUser: await vendorUser(s.org_id) });
  if (!llm.ok) {
    await finish(llm.error === "not_configured" ? "not_configured" : "vendor_error", llm.tokensIn, llm.tokensOut);
    // The reason names the remedy for the owner; the panel says only "unavailable right now" to a customer (the model is hidden).
    return brainJson({ error: "model_failed", reason: llm.error, quota }, 502);
  }
  const answer = readModelAnswer(llm.text, prev, crypto.randomUUID());
  if (!answer) {
    await finish("invalid_output", llm.tokensIn, llm.tokensOut);
    return brainJson({ error: "model_answer_invalid", quota }, 502);
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
    await finish("vendor_error", null, null).then(() => undefined, () => undefined);
    return brainJson({ error: "unavailable", quota }, 503);
  }
}

/** The person's choice of a proposed scenario: a BRIEF with the backend's price. Long: the Run now estimator. Short: a draft film. */
async function choose(supabase: SupabaseClient, s: Session, index: unknown): Promise<Response> {
  if (s.step !== "proposing" && s.step !== "ready") return brainJson({ error: "nothing_to_choose" }, 409);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 2) return brainJson({ error: "bad_request" }, 400);
  const { data: msgs, error } = await supabase.from("ai_chat_messages").select("payload").eq("session_id", s.id).eq("role", "assistant")
    .order("id", { ascending: false }).limit(1);
  if (error) return brainJson({ error: "unavailable" }, 503);
  const slots = readSlots(s.slots);
  const raw = ((msgs?.[0]?.payload as { scenarios?: unknown[] } | null)?.scenarios ?? [])[index];
  // A stored scenario is data too (its author could have written it directly): read through the same rules again.
  const chosen: Scenario | null = readScenario(raw, slots);
  if (!chosen || nextSlot(slots) !== null) return brainJson({ error: "nothing_to_choose" }, 409);

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
  const draftBrief = buildBrief(s.id, slots, chosen, "ready");
  const film = filmFromBrief(draftBrief);
  if (!film) return brainJson({ error: "nothing_to_choose" }, 409);
  const created = await supabase.rpc("create_film_draft", {
    p_org: s.org_id, p_channel: s.channel_id, p_source_kind: "storyboard", p_source_text: film.sourceText || draftBrief.title,
    p_settings: film.settings, p_idempotency_key: `brain-${s.id}-${index}`.slice(0, 80),
  });
  if (created.error) return brainJson({ error: "film_refused", reason: plain(created.error.message, 64) }, 409);
  const f = (created.data as { film?: { id?: string; version?: number } } | null)?.film;
  if (!f?.id || typeof f.version !== "number") return brainJson({ error: "unavailable" }, 503);
  const saved = await supabase.rpc("save_film", { p_film: f.id, p_version: f.version, p_patch: { scenes: film.scenes } });
  if (saved.error) return brainJson({ error: "film_refused", reason: plain(saved.error.message, 64), film_id: f.id }, 409);
  const version = (saved.data as { film?: { version?: number } } | null)?.film?.version ?? f.version + 1;
  const q = await supabase.rpc("quote_film", { p_film: f.id, p_version: version });
  const quote = q.error ? null : coerceQuote(q.data);
  const price: BriefPrice = !quote ? { state: "failed" }
    : quote.exempt ? { state: "exempt" }
    : quote.priced && quote.total !== null
      ? { state: "priced", total_credits: quote.total, spendable: quote.available ?? "unknown",
          fits: quote.startable, shorter: null }
      : { state: "unpriced" };
  const brief: Brief = { ...draftBrief, price };
  const stored = await supabase.rpc("ai_chat_save_brief", { p_session: s.id, p_brief: brief, p_step: "ready" });
  if (stored.error) return dbRefusal(stored.error) ?? brainJson({ error: "unavailable" }, 503);
  return brainJson({
    brief,
    film: { id: f.id, version },
    // The film route starts it, at this quote, on the person's press ("Create — N credits"): /api/films/<id>/start.
    quote: quote ? { quote_id: quote.quoteId, total: quote.total, startable: quote.startable, blocked_by: quote.blockedBy, refusal: quote.refusal, exempt: quote.exempt } : null,
  });
}

export async function POST(request: Request) {
  // Off is off: nothing is read, not even the session (Breach on 0197: a 401/403 would say the feature exists).
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
    const model = await chosenModelState(supabase, (quota.data as { model?: unknown })?.model);
    if (!model.ok) return brainJson({ error: "unavailable" }, 503);
    if (model.state !== "available") return brainJson({ error: "model_unavailable", reason: model.state }, 409);
    const started = await supabase.rpc("ai_chat_start", { p_org: orgId, p_channel: channelId });
    if (started.error) return dbRefusal(started.error) ?? brainJson({ error: "unavailable" }, 503);
    const sid = String(started.data);
    const prompt = typeof b.prompt === "string" ? b.prompt : "";
    if (!prompt.trim()) return brainJson({ session: { id: sid } });
    const loaded = await loadSession(supabase, sid);
    if (!loaded.ok) return loaded.res;
    const res = await runTurn(supabase, loaded.s, prompt);
    const d = await res.json();
    return brainJson({ ...d, session: { id: sid } }, res.status);
  }

  const loaded = await loadSession(supabase, b.session);
  if (!loaded.ok) return loaded.res;
  const s = loaded.s;
  const access = s.channel_id ? await requireOrgRole({ channelId: s.channel_id }, "editor") : await requireOrgRole({ orgId: s.org_id }, "editor");
  if (!access.ok) return notFound();

  if (b.action === "turn") {
    if (typeof b.text !== "string") return brainJson({ error: "bad_request" }, 400);
    return runTurn(supabase, s, b.text);
  }
  if (b.action === "retry") return runTurn(supabase, s, "", true);
  if (b.action === "answer") {
    const c = (s.card ?? null) as BrainCard | null;
    if (!c || b.card !== c.id) return brainJson({ error: "card_changed" }, 409);
    const own = typeof b.own === "string" ? modelText(b.own, 600) : "";
    const pick = typeof b.choice === "number" && Number.isInteger(b.choice) ? c.options[b.choice - 1] : undefined;
    const text = own || pick;
    if (!text) return brainJson({ error: "bad_request" }, 400);
    return runTurn(supabase, s, text);
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
