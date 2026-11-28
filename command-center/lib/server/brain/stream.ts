import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAIN_STREAM_CONTENT_TYPE, type BrainStreamEvent } from "@/lib/brain/stream-events";

/**
 * The NDJSON writer of `POST /api/brain/turn` (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.2).
 *
 *   NIGHTSHIFT_AI_STREAM=off (or unset, or anything else): today's route, byte for byte, even when a request asks for `stream:true`;
 *   NIGHTSHIFT_AI_STREAM=lab: streamed only on a server that is also NIGHTSHIFT_AI_LAB=1 (the lab, never production by accident);
 *   NIGHTSHIFT_AI_STREAM=on: streamed for every request that asks.
 *
 * The socket does not own the work (§3.2). The route's work runs as one promise that nothing here can abort: a person who closes
 * the tab mid-plan leaves the lease, the reservations, the re-asks, ai_chat_finish_turn, ai_chat_plan_end, save_film and quote_film
 * to run to completion exactly as a JSON request would; only the writes to a stream nobody reads any more are dropped. The person
 * comes back through the paths that already exist for a lost answer (duplicate_request, plan_running, the panel's waitForPlan).
 *
 * The stream starts lazily, at the work's first event: everything the route refuses before it emits anything (sign-in, a cap, a
 * model that is down, a plan already running) is still today's plain JSON with today's status.
 */

/** The switch, named once for the deploy scan (tests/test_deploy_self_host.py): set in deploy/.env.web.example and deploy_web.yml. */
export const AI_STREAM_FLAG = "NIGHTSHIFT_AI_STREAM";

export type StreamMode = "off" | "lab" | "on";

/** Read by literal names, as every server env read is. */
export function streamEnv(): Record<string, string | undefined> {
  return { NIGHTSHIFT_AI_STREAM: process.env.NIGHTSHIFT_AI_STREAM, NIGHTSHIFT_AI_LAB: process.env.NIGHTSHIFT_AI_LAB };
}

export function streamMode(env: Record<string, string | undefined>): StreamMode {
  const v = (env.NIGHTSHIFT_AI_STREAM ?? "").trim().toLowerCase();
  return v === "on" || v === "lab" ? v : "off";
}

/** Whether this server is the lab (the same flag the fake-vendor seam in lib/server/brain/llm.ts requires). Only "1" is the lab. */
export function isLabServer(env: Record<string, string | undefined>): boolean {
  return (env.NIGHTSHIFT_AI_LAB ?? "").trim() === "1";
}

/** Whether a request that asks for the stream may have it on this server. */
export function streamAllowed(env: Record<string, string | undefined>): boolean {
  const mode = streamMode(env);
  return mode === "on" || (mode === "lab" && isLabServer(env));
}

/** A ping on a quiet stream: a proxy or a phone drops an idle connection long before a 300 s plan ends. */
export const PING_MS = 10_000;

/**
 * Proactively refreshed before the first byte when the access token would expire inside the work's time (maxDuration 300 s, plus
 * supabase-js's own refresh margin). A refresh AFTER the headers went out would rotate the refresh token in a Set-Cookie nobody
 * receives, and the browser's next request would present a spent one.
 */
export const STREAM_TOKEN_MARGIN_MS = 420_000;

type Emitted = Exclude<BrainStreamEvent, { type: "end" } | { type: "ping" }>;

interface Ctx {
  accepted: boolean;
  started: boolean;
  queue: Emitted[];
  write: ((e: BrainStreamEvent) => void) | null;
  start: () => void;
}

// The sink rides the request's async context, so the route's runTurn and choose keep their signatures (another PR edits them).
const store = new AsyncLocalStorage<Ctx>();

/** Called by the route once the request asked for `stream:true` and the switch allows it: the first event may start the stream. */
export function acceptStream(): void {
  const c = store.getStore();
  if (c) c.accepted = true;
}

/**
 * One checked unit for the stream. A no-op outside a streaming request (JSON mode, the switch off, a caller with no stream), so the
 * route calls it unconditionally. Never throws into the work.
 */
export function emit(event: Emitted): void {
  const c = store.getStore();
  if (!c || !c.accepted) return;
  if (c.write) {
    c.write(event);
    return;
  }
  c.queue.push(event);
  if (!c.started) {
    c.started = true;
    c.start();
  }
}

/** The refresh before the first byte (see STREAM_TOKEN_MARGIN_MS). A client without a session (a test's) has nothing to refresh. */
export async function refreshBeforeStream(supabase: SupabaseClient, now: () => number = Date.now): Promise<void> {
  const auth = (supabase as { auth?: SupabaseClient["auth"] }).auth;
  if (!auth || typeof auth.getSession !== "function") return;
  try {
    const { data } = await auth.getSession();
    const exp = data.session?.expires_at;
    if (typeof exp === "number" && exp * 1000 - now() < STREAM_TOKEN_MARGIN_MS) await auth.refreshSession();
  } catch {
    // The token getUser() already accepted is still valid for this request; the work's own calls say so if it is not.
  }
}

const HEADERS = {
  "content-type": BRAIN_STREAM_CONTENT_TYPE,
  // no-store as every brain answer; no-transform so no proxy compresses (and so buffers) it (§3.4).
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
} as const;

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Runs the route's work, and answers with today's Response when it ends without emitting anything; otherwise with the stream,
 * from its first event to `end` (today's body and status).
 */
export async function streamable(work: () => Promise<Response>, opts: { pingMs?: number } = {}): Promise<Response> {
  let begin: () => void = () => undefined;
  const begun = new Promise<void>((r) => { begin = r; });
  const ctx: Ctx = { accepted: false, started: false, queue: [], write: null, start: () => begin() };
  const done = store.run(ctx, work);
  const first = await Promise.race([
    done.then((res) => ({ res }), (error: unknown) => ({ error })),
    begun.then(() => null),
  ]);
  if (first && "res" in first) return first.res;
  if (first) throw first.error;

  const enc = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    closed = true;
    ctx.write = () => undefined;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (e: BrainStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
        } catch {
          // The stream was closed under us (the person left): the work goes on, its writes are dropped.
          stop();
        }
      };
      for (const e of ctx.queue.splice(0)) write(e);
      ctx.write = write;
      timer = setInterval(() => write({ type: "ping" }), opts.pingMs ?? PING_MS);
      (timer as { unref?: () => void }).unref?.();
      void done
        .then(async (res) => ({ status: res.status, body: await bodyOf(res) }), () => ({ status: 500, body: null }))
        .then((end) => {
          write({ type: "end", status: end.status, body: end.body });
          if (!closed) {
            stop();
            try {
              controller.close();
            } catch {
              // Already closed by the reader.
            }
          }
        });
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { status: 200, headers: HEADERS });
}
