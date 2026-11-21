import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { readAgeState } from "@/lib/server/age";
import { aiChatEnv, aiChatOpenFor } from "@/lib/ai-chat/flag";
import {
  HISTORY_TURNS,
  longestThatFits,
  priceScenarios,
  readModelAnswer,
  readSlots,
  type FitAdvice,
  type PricedScenario,
} from "@/lib/ai-chat/logic";
import { SYSTEM_PROMPT, dataBlock } from "@/lib/ai-chat/prompt";
import { CHAT_MODELS, callChatModel, chatModelConfigured, isChatModelId, type ChatModelId } from "@/lib/server/ai-chat/llm";
import { readChannelFacts } from "@/lib/server/ai-chat/facts";
import { chatPricing } from "@/lib/server/ai-chat/quote";
import { getLocale } from "@/lib/i18n/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Nightshift AI (Studio Create): GET the panel's state for a channel, POST `start` (a conversation) or `turn` (one message).
 *
 * The order of a turn is the safety of it:
 *   1. the flag, the person, the conversation (theirs, RLS) and the model (on sale on the web AND configured on this server) — a dead
 *      model is refused before the cap is touched;
 *   2. ai_chat_reserve_turn: the workspace's daily cap, in the database, under its lock — before any vendor is called;
 *   3. the channel's facts and the history, read as the person;
 *   4. ONE call to the chosen model (no fallback), its answer checked by lib/ai-chat/logic.ts;
 *   5. prices from the Run now estimator only, and the longest length that fits when one does not;
 *   6. ai_chat_finish_turn: the assistant's message, the tokens, the outcome.
 * Nothing here holds credits, starts a run or publishes (CLAUDE.md rule 3): a chosen scenario only opens the Run now form.
 */

const DEFAULT_MODEL: ChatModelId = "anthropic-claude-sonnet-5-5";
const MODEL_ORDER: ChatModelId[] = ["anthropic-claude-sonnet-5-5", "openai-gpt-6-luna"];

type ModelState = "available" | "not_on_sale" | "not_configured";

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** A refusal raised by 0197's functions (creative_refuse: the code is the message, the SQLSTATE NSxxx). */
function dbRefusal(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return null;
  if (error.code === "PGRST202" || error.code === "42P01" || error.code === "42883") {
    return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  }
  const code = error.message ?? "";
  const status = /^NS(\d{3})$/.test(error.code ?? "") ? Number((error.code as string).slice(2)) : null;
  if (code === "chat_daily_cap") {
    const m = /used=(\d+) limit=(\d+)/.exec(error.details ?? "");
    return NextResponse.json({ error: "chat_daily_cap", used: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : null }, { status: 429 });
  }
  if (code === "message_too_long" || code === "invalid_params") return NextResponse.json({ error: code }, { status: 400 });
  if (code === "session_not_found" || code === "channel_not_found" || code === "call_not_found") return notFound();
  if (code === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ error: "unavailable" }, { status: status && status >= 500 ? status : 503 });
}

async function modelStates(supabase: SupabaseClient): Promise<{ ok: true; states: Record<ChatModelId, ModelState> } | { ok: false }> {
  const { data, error } = await supabase.rpc("sellable_models", { p_capability: "describe", p_surface: "web" });
  if (error) return { ok: false };
  const onSale = new Set(((data ?? []) as { id?: unknown }[]).map((r) => String(r.id)));
  const states = {} as Record<ChatModelId, ModelState>;
  for (const id of MODEL_ORDER) states[id] = !onSale.has(id) ? "not_on_sale" : chatModelConfigured(id) ? "available" : "not_configured";
  return { ok: true, states };
}

async function channelOrg(supabase: SupabaseClient, channelId: string) {
  const { data, error } = await supabase.from("channels").select("org_id,name").eq("channel_id", channelId).maybeSingle();
  if (error) return { state: "failed" as const };
  if (!data || typeof data.org_id !== "string") return { state: "missing" as const };
  return { state: "ok" as const, orgId: data.org_id as string, name: typeof data.name === "string" ? data.name : channelId };
}

export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  if (!supabase) return notFound();
  const channelId = (new URL(request.url).searchParams.get("channel") ?? "").trim();
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });
  const access = await requireOrgRole({ channelId }, "viewer");
  if (!access.ok) return access.status === 404 ? notFound() : NextResponse.json({ error: access.error }, { status: access.status });
  const ch = await channelOrg(supabase, channelId);
  if (ch.state === "failed") return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (ch.state === "missing" || !aiChatOpenFor(ch.orgId, aiChatEnv())) return notFound();

  const [models, quota, session] = await Promise.all([
    modelStates(supabase),
    supabase.rpc("ai_chat_quota", { p_org: ch.orgId }),
    supabase.from("ai_chat_sessions").select("id,model,slots,step,updated_at").eq("channel_id", channelId)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (quota.error) return dbRefusal(quota.error) ?? NextResponse.json({ error: "unavailable" }, { status: 503 });
  let messages: unknown[] = [];
  if (session.data?.id) {
    const m = await supabase.from("ai_chat_messages").select("id,role,content,payload,created_at").eq("session_id", session.data.id)
      .order("id", { ascending: true }).limit(200);
    if (!m.error) messages = m.data ?? [];
  }
  return NextResponse.json({
    models: models.ok ? MODEL_ORDER.map((id) => ({ id, state: models.states[id] })) : null,
    defaultModel: DEFAULT_MODEL,
    quota: quota.data,
    session: session.data ? { id: session.data.id, model: session.data.model, slots: readSlots(session.data.slots), step: session.data.step, messages } : null,
  });
}

export async function POST(request: Request) {
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  if (!supabase) return notFound();
  const body = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (!body.ok) return NextResponse.json({ error: body.reason === "too_large" ? "payload_too_large" : "bad_request" }, { status: body.reason === "too_large" ? 413 : 400 });
  const b = (body.value ?? {}) as Record<string, unknown>;
  // 0192: someone who said they are under 18 is not served, as on Run now.
  if ((await readAgeState()) === "minor") return NextResponse.json({ error: "adult_only_service" }, { status: 403 });

  if (b.action === "start") {
    const channelId = typeof b.channel === "string" ? b.channel.trim() : "";
    if (!channelId || !isChatModelId(b.model)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const access = await requireOrgRole({ channelId }, "viewer");
    if (!access.ok) return access.status === 404 ? notFound() : NextResponse.json({ error: access.error }, { status: access.status });
    const ch = await channelOrg(supabase, channelId);
    if (ch.state === "failed") return NextResponse.json({ error: "unavailable" }, { status: 503 });
    if (ch.state === "missing" || !aiChatOpenFor(ch.orgId, aiChatEnv())) return notFound();
    const models = await modelStates(supabase);
    if (!models.ok) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    if (models.states[b.model] !== "available") return NextResponse.json({ error: "model_unavailable", reason: models.states[b.model] }, { status: 409 });
    const { data, error } = await supabase.rpc("ai_chat_start", { p_org: ch.orgId, p_channel: channelId, p_model: b.model });
    if (error) return dbRefusal(error) ?? NextResponse.json({ error: "unavailable" }, { status: 503 });
    return NextResponse.json({ session: { id: data, model: b.model, slots: {}, step: "asking", messages: [] } });
  }

  if (b.action !== "turn" || typeof b.session !== "string" || typeof b.text !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const { data: s, error: sErr } = await supabase.from("ai_chat_sessions").select("id,org_id,channel_id,model,slots,step")
    .eq("id", b.session).maybeSingle();
  if (sErr) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (!s || !aiChatOpenFor(s.org_id, aiChatEnv())) return notFound();
  const access = await requireOrgRole({ channelId: s.channel_id }, "viewer");
  if (!access.ok) return notFound();
  if (!isChatModelId(s.model)) return NextResponse.json({ error: "model_unavailable", reason: "not_on_sale" }, { status: 409 });
  const model: ChatModelId = s.model;
  const models = await modelStates(supabase);
  if (!models.ok) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (models.states[model] !== "available") return NextResponse.json({ error: "model_unavailable", reason: models.states[model] }, { status: 409 });

  const reserve = await supabase.rpc("ai_chat_reserve_turn", { p_session: s.id, p_text: b.text });
  if (reserve.error) return dbRefusal(reserve.error) ?? NextResponse.json({ error: "unavailable" }, { status: 503 });
  const r = reserve.data as { call_id: string; used: number; limit: number };
  const finish = (outcome: string, tokensIn: number | null, tokensOut: number | null, extra?: { text: string; payload: unknown; slots: unknown; step: string }) =>
    supabase.rpc("ai_chat_finish_turn", {
      p_call: r.call_id, p_outcome: outcome, p_tokens_in: tokensIn, p_tokens_out: tokensOut,
      p_text: extra?.text ?? null, p_payload: extra?.payload ?? null, p_slots: extra?.slots ?? null, p_step: extra?.step ?? null,
    });
  const quota = { used: r.used, limit: r.limit };

  const [ch, hist] = await Promise.all([
    channelOrg(supabase, s.channel_id),
    supabase.from("ai_chat_messages").select("role,content").eq("session_id", s.id).order("id", { ascending: false }).limit(HISTORY_TURNS),
  ]);
  if (hist.error || ch.state !== "ok") {
    await finish("vendor_error", null, null);
    return NextResponse.json({ error: "unavailable", quota }, { status: 503 });
  }
  const prev = readSlots(s.slots);
  const facts = await readChannelFacts(supabase, s.channel_id, ch.name);
  const history = ((hist.data ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();
  const locale = await getLocale().catch(() => "en");
  const llm = await callChatModel(model, SYSTEM_PROMPT, dataBlock({ history, slots: prev, facts, locale }), { endUser: user.id });
  if (!llm.ok) {
    await finish(llm.error === "not_configured" ? "not_configured" : "vendor_error", llm.tokensIn, llm.tokensOut);
    return NextResponse.json({ error: "model_failed", reason: llm.error, model, quota }, { status: 502 });
  }
  const answer = readModelAnswer(llm.text, prev);
  if (!answer) {
    await finish("invalid_output", llm.tokensIn, llm.tokensOut);
    return NextResponse.json({ error: "model_answer_invalid", model, quota }, { status: 502 });
  }

  let scenarios: PricedScenario[] = [];
  const advice: Record<number, FitAdvice> = {};
  let pricing: "ok" | "failed" | "none" = "none";
  let spendable: number | "exempt" | "unknown" | null = null;
  if (answer.step === "proposing") {
    const p = await chatPricing(supabase, s.channel_id, s.org_id);
    if (!p.ok) {
      pricing = "failed";
      scenarios = answer.scenarios.map((x) => ({ ...x, price: { state: "failed" } as const }));
    } else {
      pricing = "ok";
      spendable = p.spendable;
      scenarios = await priceScenarios(answer.scenarios, p.spendable, p.quote);
      if (typeof p.spendable === "number") {
        for (const sc of scenarios) {
          if (sc.price.state === "priced" && !sc.price.fits && advice[sc.length_s] === undefined) {
            advice[sc.length_s] = await longestThatFits(sc.length_s, p.spendable, p.quote);
          }
        }
      }
    }
  }
  const payload = answer.step === "proposing"
    ? { scenarios, advice, pricing, spendable, factsState: facts.state }
    : { missing: answer.missing, unsupportedPlatform: answer.unsupportedPlatform, factsState: facts.state };
  const done = await finish("ok", llm.tokensIn, llm.tokensOut, { text: answer.reply, payload, slots: answer.slots, step: answer.step });
  if (done.error) return dbRefusal(done.error) ?? NextResponse.json({ error: "unavailable" }, { status: 503 });
  return NextResponse.json({
    reply: answer.reply,
    slots: answer.slots,
    step: answer.step,
    missing: answer.missing,
    unsupportedPlatform: answer.unsupportedPlatform,
    scenarios,
    advice,
    pricing,
    spendable,
    factsState: facts.state,
    model: { id: model, vendor: CHAT_MODELS[model].provider },
    quota,
  });
}
