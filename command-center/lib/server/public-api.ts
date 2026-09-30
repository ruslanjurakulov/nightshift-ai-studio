import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { runBackend } from "@/lib/server/run-backend";
import { downloadsDir } from "@/lib/server/downloads";
import { apiError, newRequestId, toResponse, type ApiResult } from "@/lib/api/http";
import { authenticate, type ApiCaller, type Rpc } from "@/lib/api/operations";

/**
 * The server half of the public API: a Supabase client with the ANON key and
 * no session (an API call has no signed-in user; the key is checked by the
 * 0031 functions), and the wrapper every /api/v1 route runs in. The service
 * key is never used here (CLAUDE.md #3).
 */

let anon: SupabaseClient | null = null;

function anonClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  anon ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return anon;
}

export const apiRpc: Rpc = async (fn, args) => {
  const client = anonClient();
  if (!client) return { data: null, error: { code: "not_configured", message: "not configured" } };
  const { data, error } = await client.rpc(fn, args);
  return { data, error: error ? { code: error.code, message: error.message } : null };
};

/** Authenticate the request and build the caller, or the 401 / 503 to send. */
export async function apiCaller(request: Request, requestId: string): Promise<ApiCaller | ApiResult> {
  if (!isSupabaseConfigured) return apiError(503, "api_unavailable", "The API is not configured on this deployment.");
  const auth = await authenticate(request.headers.get("authorization"));
  if (!auth.ok) return auth.result;
  return { keyHash: auth.keyHash, requestId, rpc: apiRpc, backend: runBackend, downloads: downloadsDir() !== null };
}

export function isCaller(v: ApiCaller | ApiResult): v is ApiCaller {
  return "keyHash" in v;
}

/**
 * Run one API route: a request id on every answer, the key checked before
 * anything else, and an unexpected failure turned into a 500 envelope. A log
 * line carries the request id, status and error code — never the key or any
 * part of it; the request id finds the key's id in api_requests.
 */
export async function runApi(request: Request, op: (caller: ApiCaller) => Promise<ApiResult>): Promise<Response> {
  const requestId = newRequestId();
  try {
    const caller = await apiCaller(request, requestId);
    if (!isCaller(caller)) return toResponse(caller, requestId);
    const result = await op(caller);
    if (!result.ok && result.status >= 500) console.error(`[api] ${requestId} ${result.status} ${result.code}`);
    return toResponse(result, requestId);
  } catch (e) {
    console.error(`[api] ${requestId} 500 ${e instanceof Error ? e.name : "error"}`);
    return toResponse(apiError(500, "internal_error", "The API could not complete this request."), requestId);
  }
}

/** A JSON body, or undefined when there is none / it is not JSON. */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await request.text();
  if (text.length > 64_000) return { ok: false };
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
