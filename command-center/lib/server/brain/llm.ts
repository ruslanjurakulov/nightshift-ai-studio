import "server-only";

/**
 * Nightshift AI's two vendors, called from this server only (the browser never talks to a vendor, and never sees a key). The request
 * shapes are the worker's verified ones (modules/capabilities/describe_llm.py: Anthropic Messages with anthropic-version 2026-10-21,
 * OpenAI Responses with store:false), text only.
 *
 * No fallback (CLAUDE.md rule 4): a model that is not configured, refuses, or answers badly is that model's failure, said as such.
 * The error names the remedy, and never the key or any part of it (rule 1).
 */

export type ChatModelId = "anthropic-claude-sonnet-5-5" | "openai-gpt-6-luna";

interface ModelWire {
  provider: "anthropic" | "openai";
  vendorModel: string;
}

/** The registry rows this chat may run, by their registry id. Whether one is on sale is the database's answer, not this table's. */
export const CHAT_MODELS: Record<ChatModelId, ModelWire> = {
  "anthropic-claude-sonnet-5-5": { provider: "anthropic", vendorModel: "claude-sonnet-5-5" },
  "openai-gpt-6-luna": { provider: "openai", vendorModel: "gpt-6-luna" },
};

/** The chat's own keys (never the worker's ANTHROPIC_API_KEY / OPENAI_API_KEY): see deploy/.env.web.example. */
export interface ChatKeys {
  anthropic?: string;
  openai?: string;
}

/** Read by literal names, as every server env read is (tests/test_deploy_self_host.py). */
export function chatKeysFromEnv(): ChatKeys {
  return { anthropic: process.env.AI_CHAT_ANTHROPIC_API_KEY, openai: process.env.AI_CHAT_OPENAI_API_KEY };
}

function keyFor(id: ChatModelId, keys: ChatKeys): string {
  return ((CHAT_MODELS[id].provider === "anthropic" ? keys.anthropic : keys.openai) ?? "").trim();
}

export function isChatModelId(v: unknown): v is ChatModelId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CHAT_MODELS, v);
}

export type LlmFailure = "not_configured" | "vendor_auth" | "vendor_quota" | "vendor_rate_limited" | "vendor_refused" | "vendor_error" | "timeout" | "output_too_long";

export type LlmResult =
  | { ok: true; text: string; tokensIn: number | null; tokensOut: number | null }
  | { ok: false; error: LlmFailure; tokensIn: number | null; tokensOut: number | null };

export function chatModelConfigured(id: ChatModelId, keys: ChatKeys = chatKeysFromEnv()): boolean {
  return Boolean(keyFor(id, keys));
}

/** A question card is short; two or three whole scenarios (ru and uz run longer than en) are not (Lens on 0198: 1600 cut them off). */
export const OUTPUT_TOKENS = { card: 1_600, proposal: 8_000 } as const;
const TIMEOUT_MS = { card: 45_000, proposal: 150_000 } as const;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

function failure(status: number, body: string): LlmFailure {
  if (status === 401 || status === 403) return "vendor_auth";
  if (status === 402 || /billing_error|insufficient_quota|credit balance/i.test(body)) return "vendor_quota";
  if (status === 429) return "vendor_rate_limited";
  return "vendor_error";
}

export async function callChatModel(
  id: ChatModelId,
  system: string,
  user: string,
  opts: { fetchImpl?: typeof fetch; keys?: ChatKeys; endUser?: string; size?: keyof typeof OUTPUT_TOKENS } = {},
): Promise<LlmResult> {
  const wire = CHAT_MODELS[id];
  const key = keyFor(id, opts.keys ?? chatKeysFromEnv());
  if (!key) return { ok: false, error: "not_configured", tokensIn: null, tokensOut: null };
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const size = opts.size ?? "card";
  const MAX_OUTPUT_TOKENS = OUTPUT_TOKENS[size];
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
    if (!res.ok) return { ok: false, error: failure(res.status, raw.slice(0, 2000)), tokensIn: null, tokensOut: null };
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "vendor_error", tokensIn: null, tokensOut: null };
    }
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
