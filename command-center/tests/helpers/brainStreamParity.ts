import { isBrainStream, readStreamLines, type BrainStreamEvent } from "@/lib/brain/stream-events";

/**
 * The parity suite (docs/studio/LIVE_CREATION_PLAN.md §3.11): every route test of POST /api/brain/turn runs twice, once as written
 * (JSON) and once with `stream:true` and NIGHTSHIFT_AI_STREAM=on (vitest.config.ts's "brain-stream" project sets
 * BRAIN_PARITY_MODE=stream). In stream mode the route's answer is read the way the panel reads it: the stream's `end` becomes a
 * Response with end.body and end.status, so every assertion the test makes on today's JSON is made on end.body too. A refusal before
 * the stream started is passed through as it is, and must then be today's plain JSON.
 *
 * What would break without it: a streamed answer that differs from the JSON one (a field dropped, a status flattened to 200), or a
 * lease, reservation or finish_turn that runs differently because a stream was asked for.
 */

export type ParityMode = "json" | "stream";

export const PARITY_MODE: ParityMode = process.env.BRAIN_PARITY_MODE === "stream" ? "stream" : "json";

/** The events of the last streamed answer (stream mode only), for a test that wants to look at them. */
export const lastStream: { events: BrainStreamEvent[] } = { events: [] };

/** The stream's own invariants, checked on every streamed answer of the suite. */
export function checkStream(events: BrainStreamEvent[]): void {
  const ends = events.filter((e) => e.type === "end");
  if (ends.length !== 1 || events[events.length - 1].type !== "end") throw new Error(`stream must end with exactly one end: ${JSON.stringify(events.map((e) => e.type))}`);
  const begun = events.findIndex((e) => e.type === "plan.begun");
  events.forEach((e, i) => {
    if (e.type === "plan.window") {
      if (begun < 0 || i < begun) throw new Error("plan.window before plan.begun");
      if (e.n < 1 || e.n > e.of || e.index !== e.n - 1) throw new Error(`plan.window out of range: ${e.n} of ${e.of}`);
    }
  });
  const ns = events.flatMap((e) => (e.type === "plan.window" ? [e.n] : []));
  if (new Set(ns).size !== ns.length) throw new Error(`a window was sent twice: ${ns.join(",")}`);
}

/** Today's answer from a streamed Response: end.body and end.status, as the panel reads them. */
export async function endAsResponse(res: Response): Promise<Response> {
  const events: BrainStreamEvent[] = [];
  for await (const e of readStreamLines(res.body!)) events.push(e);
  lastStream.events = events;
  checkStream(events);
  const end = events[events.length - 1] as Extract<BrainStreamEvent, { type: "end" }>;
  return new Response(end.body === null ? null : JSON.stringify(end.body), {
    status: end.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** `request` with `stream:true` added to its JSON body (a body that is not a JSON object is sent as it is). */
export async function withStream(request: Request): Promise<Request> {
  const text = await request.text();
  let body = text;
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) body = JSON.stringify({ ...(v as Record<string, unknown>), stream: true });
  } catch {
    // Not JSON: the route's own refusal of it is what is tested.
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** Calls the route in this run's mode and answers with today's JSON Response either way. */
export async function viaMode(post: (r: Request) => Promise<Response>, request: Request, mode: ParityMode = PARITY_MODE): Promise<Response> {
  if (mode === "json") return post(request);
  const before = process.env.NIGHTSHIFT_AI_STREAM;
  process.env.NIGHTSHIFT_AI_STREAM = "on";
  try {
    const res = await post(await withStream(request));
    if (!isBrainStream(res)) {
      lastStream.events = [];
      return res;
    }
    if (res.status !== 200) throw new Error(`a started stream answers 200, got ${res.status}`);
    return await endAsResponse(res);
  } finally {
    if (before === undefined) delete process.env.NIGHTSHIFT_AI_STREAM;
    else process.env.NIGHTSHIFT_AI_STREAM = before;
  }
}
