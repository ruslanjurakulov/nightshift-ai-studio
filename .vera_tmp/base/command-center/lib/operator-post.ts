/**
 * One way for the owner's buttons to talk to /api/*, and one reading of what came back.
 *
 * Why it exists: `fetch` follows redirects and a signed-out request used to be answered with a 307 to /login, so
 * `res.ok` was TRUE for a sign-in page and a button reported "started" for something that never ran. The middleware
 * now answers 401 JSON, but a client must not depend on that alone: a redirected response, a non-JSON body, a body
 * that says `ok:false` or `recorded:false`, a proxy error page and a dropped connection are all FAILURES here, and each
 * has its own kind so the owner is told the true reason (sign in again / second step / not allowed / server / offline).
 *
 * Nothing in here reads or returns a secret: it passes the caller's body through and hands back the parsed reply.
 */

export type OperatorFailureKind =
  /** Signed out or the session ended: the owner must sign in again. */
  | "session"
  /** The second step (authenticator code) is required before this action. */
  | "mfa"
  /** Strict mode: this account must add an authenticator before anything else opens. */
  | "mfa_enrol"
  /** Signed in, but this account may not do it. */
  | "forbidden"
  | "rate_limited"
  /** The server answered but could not do it (5xx, a refusal, `ok:false`). */
  | "server"
  /** The server said it did not record the thing (`recorded:false`). */
  | "not_recorded"
  /** No answer at all: offline, DNS, a dropped connection. */
  | "network";

export type OperatorReply = { error?: unknown; ok?: unknown; recorded?: unknown; name?: unknown; reason?: unknown; [k: string]: unknown };

export type OperatorResult =
  | { ok: true; status: number; data: OperatorReply }
  | { ok: false; kind: OperatorFailureKind; status: number; data: OperatorReply };

/** Fired on `window` when any owner action learns the session is gone; the shell shows a "sign in again" bar. */
export const SESSION_ENDED_EVENT = "ns:session-ended";

function announceSessionEnded(): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  } catch {
    /* no window (a test, a worker): the inline message still says it */
  }
}

/** Reads a fetch Response into a result. Pure apart from the session-ended notice; exported for the tests. */
export async function readOperatorResponse(res: Response): Promise<OperatorResult> {
  const status = res.status;
  const fail = (kind: OperatorFailureKind, data: OperatorReply = {}): OperatorResult => {
    if (kind === "session") announceSessionEnded();
    return { ok: false, kind, status, data };
  };
  // A followed redirect (the old middleware answer) or a redirect we were told not to follow.
  if (res.redirected || res.type === "opaqueredirect" || (status >= 300 && status < 400)) return fail("session");

  let data: OperatorReply = {};
  let json = false;
  const type = res.headers.get("content-type") ?? "";
  if (/\bjson\b/i.test(type)) {
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as OperatorReply;
        json = true;
      }
    } catch {
      /* a body that claims JSON and is not: treated as no JSON below */
    }
  }

  const code = typeof data.error === "string" ? data.error : "";
  if (status === 401) return fail(code === "mfa_required" ? "mfa" : "session", data);
  if (status === 403) {
    if (code === "mfa_enrol_required") return fail("mfa_enrol", data);
    if (code === "mfa_recent_required") return fail("mfa", data);
    return fail("forbidden", data);
  }
  if (status === 429) return fail("rate_limited", data);
  if (!res.ok) return fail("server", data);

  // 200 with something that is not our JSON: a sign-in page served in place of the answer, or a proxy error page.
  if (!json) return fail(/html/i.test(type) ? "session" : "server", data);
  if (data.ok === false) return fail("server", data);
  if (data.recorded === false) return fail("not_recorded", data);
  return { ok: true, status, data };
}

/** The failure for a call that never got an answer. */
export function networkFailure(): OperatorResult {
  return { ok: false, kind: "network", status: 0, data: {} };
}

/** POSTs JSON (or nothing) to an owner route and reads the answer. Never throws. */
export async function postOperator(url: string, body?: unknown): Promise<OperatorResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return await readOperatorResponse(res);
  } catch {
    return networkFailure();
  }
}

/**
 * The failure kind for an error from the browser's Supabase client (a direct PostgREST or RPC call). `status` is the
 * HTTP status the client returns beside `error`; a missing/zero status with a fetch-style message is the network.
 */
export function supabaseFailureKind(error: { code?: string | null; message?: string | null } | null | undefined, status?: number | null): OperatorFailureKind {
  const message = (error?.message ?? "").toLowerCase();
  const code = error?.code ?? "";
  if (status === 401 || code === "PGRST301" || code === "PGRST303" || /jwt|not authenticated|session/.test(message)) {
    announceSessionEnded();
    return "session";
  }
  if (status === 403 || code === "42501" || /permission denied|only a platform|not allowed/.test(message)) return "forbidden";
  if (!status && /failed to fetch|network|load failed|fetch/.test(message)) return "network";
  return "server";
}
