/**
 * The public API's wire format — pure, so the REST routes and the MCP
 * endpoint answer the same way and the shapes are unit-tested.
 *
 * Every response carries `x-request-id`. Every error is
 *   { "error": { "type", "code", "message", "request_id", ...details } }
 * with a type that says which family the problem is in (the code says which
 * problem). 429s carry Retry-After; every answer that got as far as the key
 * carries x-ratelimit-limit / -remaining / -reset.
 */

export type ApiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "conflict_error"
  | "idempotency_error"
  | "rate_limit_error"
  | "api_error";

export function errorType(status: number, code?: string): ApiErrorType {
  if (code && code.startsWith("idempotency_")) return "idempotency_error";
  switch (status) {
    case 400:
    case 405:
    case 413:
    case 415:
    case 422:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 409:
      return "conflict_error";
    case 429:
      return "rate_limit_error";
    default:
      return "api_error";
  }
}

export interface RateInfo {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
}

/** What one API operation produced, before it is put on the wire. */
export type ApiResult =
  | { ok: true; status: number; data: unknown; rate?: RateInfo | null; replayed?: boolean }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      retryAfter?: number | null;
      rate?: RateInfo | null;
    };

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: { details?: Record<string, unknown>; retryAfter?: number | null } = {},
): ApiResult {
  return { ok: false, status, code, message, ...extra };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An api_* function's jsonb answer -> an ApiResult. Anything malformed is a
 *  500, never a success. */
export function fromRpcResult(value: unknown): ApiResult {
  const r = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const status = num(r.status) ?? 500;
  const rr = (r.rate && typeof r.rate === "object" ? r.rate : null) as Record<string, unknown> | null;
  const rate: RateInfo | null = rr ? { limit: num(rr.limit), remaining: num(rr.remaining), reset: num(rr.reset) } : null;
  if (r.ok === true && status < 400) return { ok: true, status, data: r.data ?? null, rate, replayed: r.replayed === true };
  const e = (r.error && typeof r.error === "object" ? r.error : {}) as Record<string, unknown>;
  const { code, message, retry_after, ...details } = e;
  if (typeof code !== "string" || typeof message !== "string")
    return apiError(500, "internal_error", "The API could not complete this request.");
  return {
    ok: false,
    status: status >= 400 ? status : 500,
    code,
    message,
    details: Object.keys(details).length ? details : undefined,
    retryAfter: num(retry_after),
    rate,
  };
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `req_` + 24 random base62 characters. */
export function newRequestId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return "req_" + Array.from(random(24), (b) => B62[b % 62]).join("");
}

/** The JSON body and headers of a result, for any transport. */
export function toWire(result: ApiResult, requestId: string): { status: number; body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    "x-request-id": requestId,
    "cache-control": "no-store",
  };
  if (result.rate) {
    if (result.rate.limit !== null) headers["x-ratelimit-limit"] = String(result.rate.limit);
    if (result.rate.remaining !== null) headers["x-ratelimit-remaining"] = String(result.rate.remaining);
    if (result.rate.reset !== null) headers["x-ratelimit-reset"] = String(result.rate.reset);
  }
  if (result.ok) {
    if (result.replayed) headers["idempotent-replayed"] = "true";
    return { status: result.status, body: result.data, headers };
  }
  if (result.status === 429 || (result.retryAfter ?? null) !== null)
    headers["retry-after"] = String(Math.max(1, Math.ceil(result.retryAfter ?? 60)));
  return {
    status: result.status,
    headers,
    body: {
      error: {
        type: errorType(result.status, result.code),
        code: result.code,
        message: result.message,
        request_id: requestId,
        ...(result.details ?? {}),
        ...(result.retryAfter ? { retry_after: result.retryAfter } : {}),
      },
    },
  };
}

export function toResponse(result: ApiResult, requestId: string): Response {
  const w = toWire(result, requestId);
  return Response.json(w.body, { status: w.status, headers: w.headers });
}
