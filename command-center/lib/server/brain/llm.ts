import "server-only";
import type { ChatModelId } from "@/lib/brain/chat-models";

/**
 * Nightshift AI's three vendors, called from this server only (the browser never talks to a vendor, and never sees a key). The request
 * shapes are the worker's verified ones (modules/capabilities/describe_llm.py: Anthropic Messages with anthropic-version 2026-10-21,
 * OpenAI Responses with store:false; modules/capabilities/image.py GeminiDescribeAdapter: Gemini generateContent with
 * systemInstruction, the key in x-goog-api-key), text only.
 *
 * No fallback (CLAUDE.md rule 4): a model that is not configured, refuses, or answers badly is that model's failure, said as such.
 * The error names the remedy, and never the key or any part of it (rule 1).
 */

export type { ChatModelId } from "@/lib/brain/chat-models";

export type ChatProvider = "anthropic" | "openai" | "google";

interface ModelWire {
  provider: ChatProvider;
  vendorModel: string;
}

/** The registry rows this chat may run, by their registry id. Whether one is on sale is the database's answer, not this table's. */
export const CHAT_MODELS: Record<ChatModelId, ModelWire> = {
  "anthropic-claude-sonnet-5-5": { provider: "anthropic", vendorModel: "claude-sonnet-5-5" },
  "openai-gpt-6-luna": { provider: "openai", vendorModel: "gpt-6-luna" },
  // The registry's own id (schemas/model_registry.json), so sellable_models, ai_chat_set_model and the country table name the same row.
  "gemini-3.6-flash": { provider: "google", vendorModel: "gemini-3.6-flash" },
};

/** Legacy owner turn default for callers that omit the model. Customer turns use ai_chat_settings.model. */
export const OWNER_CHAT_MODEL: ChatModelId = "anthropic-claude-sonnet-5-5";

/** The chat's own keys (never the worker's ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY): see deploy/.env.web.example. */
export interface ChatKeys {
  anthropic?: string;
  openai?: string;
  gemini?: string;
}

/** Read by literal names, as every server env read is (tests/test_deploy_self_host.py). */
export function chatKeysFromEnv(): ChatKeys {
  return {
    anthropic: process.env.AI_CHAT_ANTHROPIC_API_KEY,
    openai: process.env.AI_CHAT_OPENAI_API_KEY,
    gemini: process.env.AI_CHAT_GEMINI_API_KEY,
  };
}

function keyFor(id: ChatModelId, keys: ChatKeys): string {
  const provider = CHAT_MODELS[id].provider;
  return ((provider === "anthropic" ? keys.anthropic : provider === "openai" ? keys.openai : keys.gemini) ?? "").trim();
}

export function isChatModelId(v: unknown): v is ChatModelId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CHAT_MODELS, v);
}

/**
 * vendor_region and model_not_found are Google's alone so far: a server whose ADDRESS Google does not serve (moving the server, not
 * replacing the key, is the fix) and a model id Google does not know (the model table or the registry is wrong, not the vendor down).
 */
export type LlmFailure =
  | "not_configured" | "vendor_auth" | "vendor_quota" | "vendor_rate_limited" | "vendor_refused" | "vendor_error" | "timeout" | "output_too_long"
  | "vendor_region" | "model_not_found";

export type LlmResult =
  | { ok: true; text: string; tokensIn: number | null; tokensOut: number | null }
  | { ok: false; error: LlmFailure; tokensIn: number | null; tokensOut: number | null };

export function chatModelConfigured(id: ChatModelId, keys: ChatKeys = chatKeysFromEnv()): boolean {
  return Boolean(keyFor(id, keys));
}

/** A question card is short; two or three whole scenarios (ru and uz run longer than en) are not (Lens on 0199: 1600 cut them off). */
// A plan call writes at most 15 scenes (lib/brain/plan.ts PLAN.windowScenes), each up to ~2,000 characters of prompt and a few lines.
// Its timeout is shorter than a proposal's: up to three run at once inside one route's time (app/api/brain/turn maxDuration).
export const OUTPUT_TOKENS = { card: 1_600, proposal: 8_000, plan: 8_000 } as const;
/** One plan call's ceiling, exported: lib/server/brain/plan.ts budgets its windows against this same number, never a copy of it. */
export const PLAN_CALL_TIMEOUT_MS = 110_000;
const TIMEOUT_MS = { card: 45_000, proposal: 150_000, plan: PLAN_CALL_TIMEOUT_MS } as const;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

function failure(status: number, body: string): LlmFailure {
  if (status === 401 || status === 403) return "vendor_auth";
  if (status === 402 || /billing_error|insufficient_quota|credit balance/i.test(body)) return "vendor_quota";
  if (status === 429) return "vendor_rate_limited";
  return "vendor_error";
}

// Google's vocabulary, as the worker reads it (modules/capabilities/google_interactions.py vendor_error_code, modules/gemini_client.py).
const GOOGLE_KEY_WORDS = /api key not valid|api_key_invalid|api key expired|api key not found/i;
const GOOGLE_QUOTA_WORDS = /billing|paid tier|free tier|quota|credit|payment|spending/i;
const GOOGLE_REGION_WORDS = /location|region|country|territory/i;
const GOOGLE_POLICY_WORDS = /safety|blocked|prohibited|policy|violat|harm/i;
/**
 * A 429 that no wait clears: "limit: 0" is an allowance of nothing (a free tier this model or region does not have, or billing never
 * enabled), and a billing state that is off or used up. Deliberately NOT the bare word "billing": Google's ordinary per-minute 429
 * says "please check your plan and billing details" too, and reading that as an empty account would tell the owner to top up for a
 * limit that clears in a minute.
 */
const GOOGLE_EMPTY_ALLOWANCE = /\blimit:\s*0\b|billing (?:is )?(?:not enabled|disabled)|enable billing|billing_disabled|credits? (?:are |is )?(?:depleted|exhausted)/i;

/**
 * A non-2xx from Gemini, by the remedy. Google answers a wrong key with 400 INVALID_ARGUMENT, not 401, and every 429 says "quota":
 * only a per-day quota (a QuotaFailure whose quotaId has PerDay) or an allowance of nothing (GOOGLE_EMPTY_ALLOWANCE) is an empty
 * allowance; a per-minute one clears by itself.
 */
function googleFailure(status: number, body: string): LlmFailure {
  let name = "";
  let message = body;
  try {
    const err = (JSON.parse(body) as { error?: { status?: unknown; message?: unknown } }).error;
    if (err && typeof err === "object") {
      name = String(err.status ?? "").toUpperCase();
      if (typeof err.message === "string") message = err.message;
    }
  } catch {
    // Not JSON: the status alone decides.
  }
  if (GOOGLE_KEY_WORDS.test(message)) return "vendor_auth";
  if (status === 429) return /PerDay/.test(body) || GOOGLE_EMPTY_ALLOWANCE.test(body) ? "vendor_quota" : "vendor_rate_limited";
  if (name === "FAILED_PRECONDITION") {
    if (GOOGLE_QUOTA_WORDS.test(message)) return "vendor_quota";
    // "User location is not supported": the SERVER's address, not the person's (the person's country is checked before any call). A new
    // key from the same server gets the same answer, so this is not vendor_auth: the remedy is where the server runs.
    if (GOOGLE_REGION_WORDS.test(message)) return "vendor_region";
  }
  // A model id Google does not serve (renamed, retired, or never on this key's API version): waiting does not fix it.
  if (status === 404 || name === "NOT_FOUND") return "model_not_found";
  if (status === 401 || status === 403) return name === "PERMISSION_DENIED" && GOOGLE_QUOTA_WORDS.test(message) ? "vendor_quota" : "vendor_auth";
  if (status === 402) return "vendor_quota";
  if ((name === "INVALID_ARGUMENT" || name === "FAILED_PRECONDITION") && GOOGLE_POLICY_WORDS.test(message)) return "vendor_refused";
  return "vendor_error";
}

/** The Gemini chat's thinking depth, sent on every call (see the request below for why, and the doc it was read from). */
export const GEMINI_THINKING_LEVEL = "LOW";

/** A candidate Gemini stopped for its content (modules/capabilities/image.py GeminiDescribeAdapter.submit). */
const GOOGLE_REFUSED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

export async function callChatModel(
  id: ChatModelId,
  system: string,
  user: string,
  opts: {
    fetchImpl?: typeof fetch; keys?: ChatKeys; endUser?: string; size?: keyof typeof OUTPUT_TOKENS;
    /** A caller's own ceiling (S8's owner Brain), bounded to 256–16000; otherwise the size's. */
    maxOutputTokens?: number;
  } = {},
): Promise<LlmResult> {
  const wire = CHAT_MODELS[id];
  const key = keyFor(id, opts.keys ?? chatKeysFromEnv());
  if (!key) return { ok: false, error: "not_configured", tokensIn: null, tokensOut: null };
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const size = opts.size ?? "card";
  const asked = opts.maxOutputTokens;
  const MAX_OUTPUT_TOKENS = typeof asked === "number" && Number.isFinite(asked) ? Math.min(16_000, Math.max(256, Math.round(asked))) : OUTPUT_TOKENS[size];
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS[size]);
  try {
    const req: { url: string; headers: Record<string, string>; body: Record<string, unknown> } =
      wire.provider === "anthropic"
        ? {
            url: "https://api.anthropic.com/v1/messages",
            headers: { "x-api-key": key, "anthropic-version": "2026-10-21", "content-type": "application/json" },
            body: {
              model: wire.vendorModel,
              max_tokens: MAX_OUTPUT_TOKENS,
              system,
              messages: [{ role: "user", content: user }],
              ...(opts.endUser ? { metadata: { user_id: opts.endUser } } : {}),
            },
          }
        : wire.provider === "google"
        ? {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${wire.vendorModel}:generateContent`,
            // Google takes the key in its own header, never in the query string (a URL is what logs and proxies keep).
            headers: { "x-goog-api-key": key, "content-type": "application/json" },
            // No end-user field: the worker's verified Gemini shape has none, and none is invented here.
            body: {
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: user }] }],
              // Thinking pinned, never Google's default. aistudio.google.com/docs/thinking (read 2026-11-22; ai.google.dev/gemini-api/docs/
              // thinking redirects there): "Gemini models engage in dynamic thinking by default", gemini-3.6-flash's default is
              // medium (it takes minimal | low | medium | high), and the output-token ceiling covers the response "including thought
              // tokens". So an unpinned turn could spend its 8k on thinking and come back cut off (MAX_TOKENS), billed. LOW, the
              // lowest level the docs give that still reasons (minimal is "near-off"), over a budget: thinkingLevel is the field the
              // generateContent reference recommends for Gemini 3 and later, and the enum is spelled MINIMAL | LOW | MEDIUM | HIGH there.
              // Not settled by those pages: whether generateContent's maxOutputTokens (described only as "the maximum number of tokens
              // to include in a response candidate") counts thoughts the same way the thinking page says; pinning LOW holds either way.
              generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL } },
            },
          }
        : {
            url: "https://api.openai.com/v1/responses",
            headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: {
              model: wire.vendorModel,
              instructions: system,
              max_output_tokens: MAX_OUTPUT_TOKENS,
              // A person's plans have no reason to stay at the vendor.
              store: false,
              input: [{ role: "user", content: [{ type: "input_text", text: user }] }],
              ...(opts.endUser ? { safety_identifier: opts.endUser } : {}),
            },
          };
    // redirect "error": a 3xx would carry the key to wherever it points.
    const res = await doFetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal, redirect: "error", cache: "no-store" });
    const raw = await res.text();
    if (!res.ok) {
      const body = raw.slice(0, 2000);
      return { ok: false, error: wire.provider === "google" ? googleFailure(res.status, body) : failure(res.status, body), tokensIn: null, tokensOut: null };
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "vendor_error", tokensIn: null, tokensOut: null };
    }
    if (wire.provider === "google") return readGemini(data);
    const usage = (data.usage ?? {}) as Record<string, unknown>;
    const tokensIn = num(usage.input_tokens);
    const tokensOut = num(usage.output_tokens);
    if (wire.provider === "anthropic") {
      if (data.stop_reason === "refusal") return { ok: false, error: "vendor_refused", tokensIn, tokensOut };
      // Cut off: its own failure, said as such (a half JSON is not "the vendor is down").
      if (data.stop_reason === "max_tokens") return { ok: false, error: "output_too_long", tokensIn, tokensOut };
      const text = (Array.isArray(data.content) ? data.content : [])
        .flatMap((b) => (b && typeof b === "object" && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string" ? [(b as { text: string }).text] : []))
        .join("\n");
      return text ? { ok: true, text, tokensIn, tokensOut } : { ok: false, error: "vendor_error", tokensIn, tokensOut };
    }
    if (data.status === "incomplete") {
      const reason = (data.incomplete_details as Record<string, unknown> | undefined)?.reason;
      return { ok: false, error: reason === "content_filter" ? "vendor_refused" : reason === "max_output_tokens" ? "output_too_long" : "vendor_error", tokensIn, tokensOut };
    }
    let refused = false;
    const texts: string[] = [];
    for (const item of Array.isArray(data.output) ? data.output : []) {
      if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "message") continue;
      for (const part of ((item as Record<string, unknown>).content as unknown[]) ?? []) {
        const p = part as Record<string, unknown>;
        if (p?.type === "refusal") refused = true;
        if (p?.type === "output_text" && typeof p.text === "string") texts.push(p.text);
      }
    }
    if (refused) return { ok: false, error: "vendor_refused", tokensIn, tokensOut };
    return texts.length ? { ok: true, text: texts.join("\n"), tokensIn, tokensOut } : { ok: false, error: "vendor_error", tokensIn, tokensOut };
  } catch (e) {
    return { ok: false, error: (e as { name?: string })?.name === "AbortError" ? "timeout" : "vendor_error", tokensIn: null, tokensOut: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gemini's answer (generateContent; field names and meanings read on aistudio.google.com/api-reference/generate-content, 2026-11-22):
 * the text of candidates[0].content.parts without the parts marked `thought`; a blocked prompt (promptFeedback.blockReason) or a
 * candidate stopped for its content is the vendor's refusal; MAX_TOKENS is a cut-off answer; no text at all is a failure, never "".
 * Tokens: usageMetadata.promptTokenCount in, candidatesTokenCount plus thoughtsTokenCount out (a thinking model's thoughts are output
 * it bills, as the other two vendors' output_tokens include their reasoning). A count Google did not report stays unknown.
 */
function readGemini(data: Record<string, unknown>): LlmResult {
  const usage = (data.usageMetadata ?? {}) as Record<string, unknown>;
  const tokensIn = num(usage.promptTokenCount);
  const answered = num(usage.candidatesTokenCount);
  const thoughts = num(usage.thoughtsTokenCount);
  const tokensOut = answered === null ? null : answered + (thoughts ?? 0);
  const feedback = data.promptFeedback as Record<string, unknown> | undefined;
  if (feedback && typeof feedback === "object" && feedback.blockReason) return { ok: false, error: "vendor_refused", tokensIn, tokensOut };
  const first = (Array.isArray(data.candidates) ? data.candidates[0] : undefined) as Record<string, unknown> | undefined;
  const reason = String(first?.finishReason ?? "").toUpperCase();
  if (GOOGLE_REFUSED_FINISH.has(reason)) return { ok: false, error: "vendor_refused", tokensIn, tokensOut };
  // Cut off: its own failure, said as such (a half JSON is not "the vendor is down"), as for the other two vendors.
  if (reason === "MAX_TOKENS") return { ok: false, error: "output_too_long", tokensIn, tokensOut };
  const parts = (first?.content as Record<string, unknown> | undefined)?.parts;
  // Joined with nothing between: the answer is one JSON document, and a newline put inside a string it splits would break it.
  const text = (Array.isArray(parts) ? parts : [])
    .flatMap((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" && !(p as Record<string, unknown>).thought ? [(p as { text: string }).text] : []))
    .join("");
  return text.trim() ? { ok: true, text, tokensIn, tokensOut } : { ok: false, error: "vendor_error", tokensIn, tokensOut };
}
