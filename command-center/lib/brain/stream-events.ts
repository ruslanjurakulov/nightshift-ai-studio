import type { SceneParts, Scenario } from "@/lib/brain/logic";

/**
 * The NDJSON events of `POST /api/brain/turn` with `stream:true` (docs/studio/LIVE_CREATION_PLAN.md §3.1), shared by the server's
 * writer (lib/server/brain/stream.ts) and the panel's reader. One JSON object per line.
 *
 * Only units the server has already CHECKED are sent, never raw model tokens: a token stream would show prompts that are later
 * refused, cut or asked for again (§3.5). And nothing here is a timer: a `phase` is sent when the work really enters it (rule 5).
 *
 * `end` is the whole answer: its `body` is exactly the JSON today's route answers for the same request, and its `status` the HTTP
 * status it would have had. The stream itself is a 200 once it has started; a refusal before anything was emitted (auth, a cap, a
 * model that is down) is still today's plain JSON response with its own status.
 */

export const BRAIN_STREAM_CONTENT_TYPE = "application/x-ndjson";

/** Real phases of a turn or a choice, in the order they can happen. */
export const BRAIN_PHASES = ["thinking", "planning", "saving", "pricing"] as const;
export type BrainPhase = (typeof BRAIN_PHASES)[number];

/** One part of a plan window (a chapter, or one part of a chapter too long for one call), with the scenes that passed every check. */
export interface StreamWindowPart {
  chapter_id: string;
  /** 1-based, in the outline's order. */
  chapter_n: number;
  title: string;
  part: number;
  /** How many parts this chapter was split into: the chapter is written once all of them arrived. */
  parts: number;
  scenes: SceneParts[];
}

export type BrainStreamEvent =
  | { type: "phase"; phase: BrainPhase }
  /** A proposed scenario, provisional until `end` (item #14; defined now so the reader already knows it). */
  | { type: "scenario"; index: number; provisional: true; scenario: Scenario }
  /** The storyboard is begun: how many windows the server will write, how many chapters they cover, and the plan's turns. */
  | { type: "plan.begun"; windows: number; chapters: number; at_most: number | null; about: number | null }
  /** One window that passed readWindow, its re-ask, the length, speech, shot-rule and prompt checks, and was recorded. */
  | { type: "plan.window"; index: number; n: number; of: number; parts: StreamWindowPart[] }
  /** Something sent provisionally is withdrawn (item #14: a scenario asked again). */
  | { type: "retract"; what: "scenario" | "plan.window"; index: number | null }
  | { type: "ping" }
  | { type: "end"; status: number; body: unknown };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const intOrNull = (v: unknown): number | null => (int(v) ? v : null);

function readPart(v: unknown): StreamWindowPart | null {
  const o = obj(v);
  if (!o || typeof o.chapter_id !== "string" || !int(o.chapter_n, 1) || !int(o.part, 1) || !int(o.parts, 1) || !Array.isArray(o.scenes)) return null;
  const scenes = o.scenes.filter((s) => obj(s) && typeof (s as { visual_prompt?: unknown }).visual_prompt === "string") as SceneParts[];
  return { chapter_id: o.chapter_id, chapter_n: o.chapter_n, title: typeof o.title === "string" ? o.title : "", part: o.part, parts: o.parts, scenes };
}

/**
 * One line, tolerantly: a blank line, a line that is not JSON, or an event this reader does not know is `null` (skipped), never a
 * throw. A newer server may add event types; an older panel must keep working through them.
 */
export function readStreamLine(line: string): BrainStreamEvent | null {
  const t = line.trim();
  if (!t) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  const o = obj(v);
  if (!o) return null;
  switch (o.type) {
    case "phase":
      return (BRAIN_PHASES as readonly unknown[]).includes(o.phase) ? { type: "phase", phase: o.phase as BrainPhase } : null;
    case "ping":
      return { type: "ping" };
    case "end":
      return int(o.status, 100) ? { type: "end", status: o.status, body: o.body ?? null } : null;
    case "plan.begun":
      return int(o.windows, 1) && int(o.chapters, 1)
        ? { type: "plan.begun", windows: o.windows, chapters: o.chapters, at_most: intOrNull(o.at_most), about: intOrNull(o.about) } : null;
    case "plan.window": {
      if (!int(o.index) || !int(o.n, 1) || !int(o.of, 1) || !Array.isArray(o.parts)) return null;
      const parts = o.parts.map(readPart);
      if (parts.some((p) => p === null)) return null;
      return { type: "plan.window", index: o.index, n: o.n, of: o.of, parts: parts as StreamWindowPart[] };
    }
    case "scenario":
      return int(o.index) && obj(o.scenario) ? { type: "scenario", index: o.index, provisional: true, scenario: o.scenario as unknown as Scenario } : null;
    case "retract":
      return o.what === "scenario" || o.what === "plan.window" ? { type: "retract", what: o.what, index: intOrNull(o.index) } : null;
    default:
      return null;
  }
}

/** Lines of an NDJSON body as they arrive: a line split across chunks is joined, and a last line without its newline is read too. */
export async function* readStreamLines(body: ReadableStream<Uint8Array>): AsyncGenerator<BrainStreamEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
      let at = rest.indexOf("\n");
      while (at >= 0) {
        const ev = readStreamLine(rest.slice(0, at));
        rest = rest.slice(at + 1);
        if (ev) yield ev;
        at = rest.indexOf("\n");
      }
    }
    rest += dec.decode();
    const last = readStreamLine(rest);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** Whether a response is the stream (by its content type). A response without headers (a test's fetch stub) is not. */
export function isBrainStream(res: unknown): boolean {
  const headers = (res as { headers?: { get?: unknown } | null } | null)?.headers;
  const type = headers && typeof headers.get === "function" ? String((headers as Headers).get("content-type") ?? "") : "";
  return type.split(";")[0].trim().toLowerCase() === BRAIN_STREAM_CONTENT_TYPE;
}

/** A stream that ended without its `end`: the work may still be running on the server (the socket does not own it, §3.2). */
export class BrainStreamCut extends Error {
  constructor() {
    super("brain_stream_cut");
    this.name = "BrainStreamCut";
  }
}

/**
 * The answer of one press, whichever way the server sent it: the stream's `end` (each event before it given to `onEvent`), or
 * today's JSON. `status` and `ok` are what today's response would have said, so a caller reads both the same way.
 */
export async function readBrainAnswer(
  res: Response | { ok: boolean; status: number; json: () => Promise<unknown>; headers?: Response["headers"]; body?: Response["body"] },
  onEvent: (e: BrainStreamEvent) => void = () => undefined,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; streamed: boolean }> {
  const asBody = (v: unknown) => (obj(v) ?? {}) as Record<string, unknown>;
  if (!isBrainStream(res) || !res.body) {
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: asBody(body), streamed: false };
  }
  for await (const ev of readStreamLines(res.body)) {
    if (ev.type === "end") return { ok: ev.status >= 200 && ev.status < 300, status: ev.status, body: asBody(ev.body), streamed: true };
    try {
      onEvent(ev);
    } catch {
      // A listener's own failure (a canvas that is gone) is not the answer's: the press still ends with `end`.
    }
  }
  throw new BrainStreamCut();
}
