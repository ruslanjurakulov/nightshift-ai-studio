import { CliError, EXIT, exitCodeForStatus, hintFor } from "./errors.js";

export const DEFAULT_BASE_URL = "https://nightshift-ai.studio";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A base URL we are willing to send a key to: https anywhere, http only to
 * this machine. Returns it without a trailing slash.
 */
export function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new CliError("usage", `--base-url is not a URL: ${String(raw).slice(0, 80)}`, { exit: EXIT.USAGE });
  }
  if (u.username || u.password)
    throw new CliError("usage", "The base URL must not contain a user name or password.", { exit: EXIT.USAGE });
  if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname))
    throw new CliError(
      "insecure_base_url",
      `Refusing to send an API key over plain http to ${u.hostname}. Use https (http is allowed only for localhost).`,
      { exit: EXIT.USAGE },
    );
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new CliError("usage", "The base URL must start with https://", { exit: EXIT.USAGE });
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

function parseRetryAfter(header, bodyValue) {
  const n = header == null ? NaN : Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  return typeof bodyValue === "number" && Number.isFinite(bodyValue) ? Math.ceil(bodyValue) : null;
}

/** Turn a non-2xx answer into the CliError that carries the API's envelope. */
async function toApiError(res, requestId, idempotencyKey) {
  let parsed = null;
  let text = "";
  try {
    text = await res.text();
    parsed = JSON.parse(text);
  } catch {
    /* not JSON: a proxy or an outage page */
  }
  const e = parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object" ? parsed.error : null;
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"), e && e.retry_after);
  if (e && typeof e.code === "string") {
    const { type, code, message, request_id, retry_after, ...details } = e;
    return new CliError(code, typeof message === "string" ? message : "The API refused this request.", {
      exit: exitCodeForStatus(res.status),
      type: typeof type === "string" ? type : "api_error",
      details,
      hint: hintFor(code),
      requestId: typeof request_id === "string" ? request_id : requestId,
      status: res.status,
      retryAfter,
      idempotencyKey,
    });
  }
  return new CliError("bad_response", `The server answered HTTP ${res.status} without an API error body.`, {
    exit: exitCodeForStatus(res.status),
    requestId,
    status: res.status,
    retryAfter,
    idempotencyKey,
  });
}

/**
 * A thin client over /api/v1. It never retries a request on its own: a retry
 * of a money-moving POST is the caller's decision, made with the same
 * Idempotency-Key.
 */
export class Client {
  /**
   * @param {{baseUrl: string, key: string, io: import("./io.js").Io, debug?: boolean, log?: (s: string) => void}} o
   */
  constructor({ baseUrl, key, io, debug = false, log = () => {} }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.key = key;
    this.io = io;
    this.debug = debug;
    this.log = log;
  }

  _headers(extra = {}) {
    return {
      authorization: `Bearer ${this.key}`,
      accept: "application/json",
      "user-agent": `nightshift-cli (node ${process.versions.node})`,
      ...extra,
    };
  }

  async _send(method, path, { query, body, idempotencyKey, timeoutMs = 30000 } = {}) {
    const url = new URL(this.baseUrl + "/api/v1" + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null && v !== "") url.searchParams.set(k, String(v));
    const headers = this._headers(body !== undefined ? { "content-type": "application/json" } : {});
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (this.debug) this.log(`> ${method} ${url.pathname}${url.search}${idempotencyKey ? `  (Idempotency-Key ${idempotencyKey})` : ""}\n`);
    let res;
    try {
      res = await this.io.fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      const why = timedOut ? "timed out" : `${(e && e.cause && e.cause.code) || (e && e.code) || "network error"}`;
      throw new CliError(
        timedOut ? "timeout" : "network_error",
        `Could not reach ${this.baseUrl} (${why}).` +
          (method === "POST" && idempotencyKey
            ? ` The request may or may not have reached the server. Retry with --idempotency-key ${idempotencyKey}: the same key never charges twice.`
            : ""),
        { idempotencyKey: method === "POST" ? idempotencyKey ?? null : null },
      );
    }
    const requestId = res.headers.get("x-request-id");
    if (this.debug) this.log(`< ${res.status}${requestId ? `  ${requestId}` : ""}\n`);
    if (res.status >= 300 && res.status < 400)
      throw new CliError("unexpected_redirect", `The server redirected (HTTP ${res.status}); the key was not sent on. Check --base-url.`, {
        requestId,
      });
    return { res, requestId };
  }

  /**
   * @returns {Promise<{status: number, body: any, requestId: string|null, replayed: boolean}>}
   */
  async request(method, path, opts = {}) {
    const { res, requestId } = await this._send(method, path, opts);
    if (!res.ok) throw await toApiError(res, requestId, method === "POST" ? opts.idempotencyKey ?? null : null);
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new CliError("bad_response", `The server answered HTTP ${res.status} with a body that is not JSON.`, { requestId });
      }
    }
    return { status: res.status, body, requestId, replayed: res.headers.get("idempotent-replayed") === "true" };
  }

  /** The raw response of a successful GET (for the MP4). The caller reads the body. */
  async stream(path, { timeoutMs = 0 } = {}) {
    const { res, requestId } = await this._send("GET", path, { timeoutMs });
    if (!res.ok) throw await toApiError(res, requestId, null);
    return { res, requestId };
  }
}
