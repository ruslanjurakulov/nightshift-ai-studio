import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isModelKeyProviderId,
  parseModelKeysFlag,
  type ExpectShape,
  type ModelKeyProvider,
  type StoredKey,
  type UnreachableReason,
  type VerifyOutcome,
} from "@/lib/model-keys";
import { ownerReplyToHttp, ownerRpcErrorToHttp, type OwnerHttp } from "@/lib/owner-rpc";
import { fetchWithTimeout } from "@/lib/server/fetch-timeout";
import type { RateRule } from "@/lib/server/web-rate";

/**
 * NIGHTSHIFT_MODEL_KEYS — a server env var, exactly `on` to turn the owner's "Model API keys" page and its route on (default off).
 *
 * Off (empty, `off`, anything unrecognised): the page shows only an "off" note and reads nothing, and a same-origin POST to the route answers
 * 404. Read on every call, never at import: a restart is enough. The read names the variable literally because tests/test_deploy_self_host.py
 * scans for exactly that, so the name is also in deploy/.env.web.example and .github/workflows/deploy_web.yml.
 */
export function modelKeysOn(): boolean {
  return parseModelKeysFlag(process.env.NIGHTSHIFT_MODEL_KEYS);
}

/** The verify route is the one place a typed key leaves this server, so it is limited per person on top of the database's own limit. */
export const MODEL_KEY_RATE: RateRule = { bucket: "owner.model_keys", max: 20, windowSeconds: 600 };

/** Short on purpose: the owner is waiting at a button. A vendor that does not answer in this time is "could not reach", not "rejected". */
export const VERIFY_TIMEOUT_MS = 8_000;
/** A model list can be long; past this the answer is not read and the check reads "unexpected response". */
export const VERIFY_MAX_BODY_BYTES = 2_097_152;

export interface VerifyDeps {
  /** For tests: the transport. The URL it is given is always the vendor's own fixed one. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Take `key` out of `text`, whole and in the pieces that matter (a paired Kling key is two secrets). Used on anything that is about to be
 * logged or thrown, so that a library error that happened to quote a header cannot carry the key out. It is the last line of defence: nothing
 * here puts the key in a message in the first place.
 */
export function redactKey(text: string, key: string): string {
  let out = text;
  const parts = new Set([key, ...key.split(":")].filter((p) => p.length >= 6));
  for (const p of parts) out = out.split(p).join("[redacted]");
  return out;
}

/** The text of a failure, safe to log: our own words plus the error's name; the key taken out if something quoted it. */
export function safeErrorText(err: unknown, key: string): string {
  const name = err instanceof Error ? err.name : "error";
  const message = err instanceof Error ? err.message : "";
  return redactKey(`${name}: ${message}`.slice(0, 300), key);
}

function shapeHolds(expect: ExpectShape, body: unknown): boolean {
  switch (expect.kind) {
    case "array":
      return Array.isArray(body);
    case "object":
      return typeof body === "object" && body !== null && !Array.isArray(body);
    case "field": {
      if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
      const v = (body as Record<string, unknown>)[expect.name];
      if (expect.type === "array") return Array.isArray(v);
      if (expect.type === "number") return typeof v === "number" && Number.isFinite(v);
      return typeof v === "object" && v !== null && !Array.isArray(v);
    }
  }
}

/** Read at most `max` bytes of the answer; null when it is longer (the rest is cancelled, never buffered). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const unreachable = (reason: UnreachableReason): VerifyOutcome => ({ outcome: "unreachable", reason });

/**
 * Ask the vendor, once, whether it accepts `key`: ONE GET to the vendor's fixed host (lib/model-keys.ts), a free read that creates nothing.
 *
 *   200 with the documented shape          -> verified
 *   a status the vendor uses for a bad key -> rejected   (401/403 and, where the vendor documents it, 400)
 *   timeout, no connection, a redirect, 429, 5xx, a 200 that is not the documented shape, any other status
 *                                          -> unreachable (the key is not judged)
 *
 * A `format_only` vendor is NOT called: it answers {outcome: "format_only"} without a request.
 *
 * What the vendor said is never read out loud: the body is parsed for its shape and dropped, and no part of it, of the URL's query or of
 * the key is returned or logged. A redirect is never followed (the key would go to wherever the vendor's answer points).
 */
export async function verifyKeyWithVendor(
  provider: ModelKeyProvider,
  key: string,
  deps: VerifyDeps = {},
): Promise<VerifyOutcome | { outcome: "format_only" }> {
  const strategy = provider.strategy;
  if (strategy.kind !== "http") return { outcome: "format_only" };

  const url = new URL(strategy.path + (strategy.query ? `?${strategy.query}` : ""), strategy.origin);
  // The host is the registry's, whatever the path or query contained. A registry edit that broke this would fail here, not call a stranger.
  if (url.protocol !== "https:" || url.origin !== strategy.origin) return unreachable("unexpected_response");

  const headers: Record<string, string> = { Accept: "application/json", ...strategy.headers };
  headers[strategy.auth.header] = strategy.auth.scheme === "bearer" ? `Bearer ${key}` : key;

  const doFetch = deps.fetchImpl;
  let res: Response;
  try {
    const init: RequestInit = { method: "GET", headers, redirect: "manual", cache: "no-store" };
    res = doFetch
      ? await doFetch(url.toString(), { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? VERIFY_TIMEOUT_MS) })
      : await fetchWithTimeout(url, init, deps.timeoutMs ?? VERIFY_TIMEOUT_MS);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return unreachable(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }

  try {
    if (res.status >= 300 && res.status < 400) return unreachable("redirect");
    if (strategy.rejectStatuses.includes(res.status)) return { outcome: "rejected" };
    if (res.status === 429) return unreachable("rate_limited");
    if (res.status >= 500) return unreachable("vendor_error");
    if (res.status !== 200) return unreachable("unexpected_response");
    const text = await readCapped(res, VERIFY_MAX_BODY_BYTES);
    if (text === null) return unreachable("unexpected_response");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return unreachable("unexpected_response");
    }
    return shapeHolds(strategy.expect, body) ? { outcome: "verified" } : unreachable("unexpected_response");
  } catch {
    // A body that broke half way: the vendor did not finish answering.
    return unreachable("network");
  } finally {
    // Nothing of the answer is kept; make sure the connection is not left reading it.
    res.body?.cancel().catch(() => {});
  }
}

// ── the database half ────────────────────────────────────────────────────────────────────────────────────────────────────

type Db = SupabaseClient;
const missing = (code: string | null | undefined) => ["42883", "PGRST202", "42P01", "PGRST205"].includes(code ?? "");

async function callOwnerFn(db: Db, fn: string, args: Record<string, unknown>): Promise<OwnerHttp> {
  let result: { data: unknown; error: { code?: string | null; message?: string | null } | null };
  try {
    result = await db.rpc(fn, args);
  } catch {
    return { status: 502, body: { ok: false, error: "rpc_failed" } };
  }
  if (result.error) return ownerRpcErrorToHttp(result.error);
  const out = ownerReplyToHttp(result.data);
  // The platform admin who is not the owner: a refusal, not a "could not process".
  if (!out.body.ok && out.body.error === "owner_required") return { status: 403, body: { ok: false, error: "forbidden" } };
  return out;
}

/** Store (or replace) the vendor's key in Vault. The key is an argument of one call and is held nowhere else. */
export function storeModelKey(db: Db, provider: ModelKeyProvider, key: string, status: "verified" | "format_only"): Promise<OwnerHttp> {
  return callOwnerFn(db, "owner_model_key_store", { p_provider: provider.id, p_secret: key, p_status: status });
}

export function removeModelKey(db: Db, provider: ModelKeyProvider): Promise<OwnerHttp> {
  return callOwnerFn(db, "owner_model_key_remove", { p_provider: provider.id });
}

export type ModelKeyRead =
  | { state: "ok"; keys: StoredKey[] }
  | { state: "unsupported" }
  | { state: "forbidden" }
  | { state: "failed" };

/** What is stored, as the signed-in owner (the anon key and their session; never a service key). Unreadable is "failed", never "nothing stored". */
export async function readModelKeys(db: Db): Promise<ModelKeyRead> {
  try {
    const { data, error } = await db.rpc("owner_model_key_status");
    if (error) {
      if (missing(error.code)) return { state: "unsupported" };
      return error.code === "42501" ? { state: "forbidden" } : { state: "failed" };
    }
    const doc = data as { ok?: unknown; error?: unknown; keys?: unknown } | null;
    if (!doc || typeof doc !== "object") return { state: "failed" };
    if (doc.ok === false) return { state: doc.error === "owner_required" ? "forbidden" : "failed" };
    if (doc.ok !== true || !Array.isArray(doc.keys)) return { state: "failed" };
    const keys: StoredKey[] = [];
    for (const raw of doc.keys) {
      const k = raw as Record<string, unknown>;
      if (!k || !isModelKeyProviderId(k.provider)) return { state: "failed" };
      if (k.status !== "verified" && k.status !== "format_only") return { state: "failed" };
      if (typeof k.last4 !== "string" || k.last4.length !== 4) return { state: "failed" };
      keys.push({
        provider: k.provider,
        status: k.status,
        last4: k.last4,
        verifiedAt: typeof k.verified_at === "string" ? k.verified_at : null,
        checkedByEmail: typeof k.checked_by_email === "string" ? k.checked_by_email : null,
      });
    }
    return { state: "ok", keys };
  } catch {
    return { state: "failed" };
  }
}

/** One line per attempt: who (a user-id prefix), which vendor, what came of it. Nothing about the key. */
export function logModelKey(userId: string, provider: string, outcome: string): void {
  console.info(`[model-key] user=${userId.slice(0, 8)} provider=${provider} outcome=${outcome}`);
}
