import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_STREAM_CONTENT_TYPE, BrainStreamCut, isBrainStream, readBrainAnswer, readStreamLine, readStreamLines, type BrainStreamEvent,
} from "@/lib/brain/stream-events";
import { PING_MS, acceptStream, emit, refreshBeforeStream, streamAllowed, streamMode, streamable } from "@/lib/server/brain/stream";

/**
 * The NDJSON writer and reader (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.2). What would break without these: a refusal that used
 * to be a plain 409 arriving as a 200 stream; a closed tab throwing into the plan that is still running; a quiet 300 s plan dropped by
 * a proxy for want of a ping; a newer server's event crashing an older panel; a stream cut short read as a finished answer.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function events(res: Response): Promise<BrainStreamEvent[]> {
  const out: BrainStreamEvent[] = [];
  for await (const e of readStreamLines(res.body!)) out.push(e);
  return out;
}

function chunked(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
}

describe("the switch", () => {
  it("is off unless it says lab or on, and lab streams only on the lab server", () => {
    for (const v of [undefined, "", "off", "yes", "1", "true", "stream"]) expect(streamMode({ NIGHTSHIFT_AI_STREAM: v })).toBe("off");
    expect(streamMode({ NIGHTSHIFT_AI_STREAM: " ON " })).toBe("on");
    expect(streamAllowed({ NIGHTSHIFT_AI_STREAM: "lab" })).toBe(false);
    expect(streamAllowed({ NIGHTSHIFT_AI_STREAM: "lab", NIGHTSHIFT_AI_LAB: "true" })).toBe(false);
    expect(streamAllowed({ NIGHTSHIFT_AI_STREAM: "lab", NIGHTSHIFT_AI_LAB: "1" })).toBe(true);
    expect(streamAllowed({ NIGHTSHIFT_AI_STREAM: "on" })).toBe(true);
    expect(streamAllowed({ NIGHTSHIFT_AI_STREAM: "off", NIGHTSHIFT_AI_LAB: "1" })).toBe(false);
  });
});

describe("streamable", () => {
  it("answers the work's own Response when nothing was emitted: a refusal stays today's plain JSON", async () => {
    const refusal = json({ error: "chat_daily_cap", used: 30, limit: 30 }, 429);
    const res = await streamable(async () => { acceptStream(); return refusal; });
    expect(res).toBe(refusal);
  });

  it("ignores events of a request that did not accept the stream", async () => {
    const plain = json({ ok: true });
    const res = await streamable(async () => { emit({ type: "phase", phase: "thinking" }); await sleep(1); return plain; });
    expect(res).toBe(plain);
    // And outside any request, emit is a no-op, never a throw.
    expect(() => emit({ type: "phase", phase: "thinking" })).not.toThrow();
  });

  it("streams from the first event: a 200 NDJSON with no-transform, the events in order, and end = the answer's body and status", async () => {
    const res = await streamable(async () => {
      acceptStream();
      emit({ type: "phase", phase: "thinking" });
      await sleep(2);
      emit({ type: "phase", phase: "pricing" });
      return json({ error: "model_failed", reason: "vendor_error" }, 502);
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(BRAIN_STREAM_CONTENT_TYPE);
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await events(res)).toEqual([
      { type: "phase", phase: "thinking" }, { type: "phase", phase: "pricing" },
      { type: "end", status: 502, body: { error: "model_failed", reason: "vendor_error" } },
    ]);
  });

  it("end carries the answer's own cache-control and retry-after, and nothing else (Lens L4)", async () => {
    const res = await streamable(async () => {
      acceptStream();
      emit({ type: "phase", phase: "thinking" });
      return new Response(JSON.stringify({ error: "x" }), { status: 429,
        headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "30", "x-other": "y" } });
    });
    const end = (await events(res)).pop();
    expect(end).toEqual({ type: "end", status: 429, body: { error: "x" }, headers: { "cache-control": "no-store", "retry-after": "30" } });
    expect(readStreamLine(JSON.stringify({ type: "end", status: 200, body: {}, headers: { "set-cookie": "a=b", "retry-after": 5 } })))
      .toEqual({ type: "end", status: 200, body: {} });
  });

  it("pings while the work is quiet, every PING_MS (10 s in production)", async () => {
    expect(PING_MS).toBe(10_000);
    const res = await streamable(async () => {
      acceptStream();
      emit({ type: "phase", phase: "planning" });
      await sleep(95);
      return json({ ok: true });
    }, { pingMs: 20 });
    const ev = await events(res);
    expect(ev.filter((e) => e.type === "ping").length).toBeGreaterThanOrEqual(3);
    expect(ev[ev.length - 1]).toEqual({ type: "end", status: 200, body: { ok: true } });
  });

  it("a reader that leaves does not stop the work, and later writes are swallowed", async () => {
    let finished = false;
    const res = await streamable(async () => {
      acceptStream();
      emit({ type: "phase", phase: "planning" });
      await sleep(10);
      emit({ type: "phase", phase: "saving" });
      await sleep(10);
      emit({ type: "phase", phase: "pricing" });
      finished = true;
      return json({ ok: true });
    }, { pingMs: 5 });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(finished).toBe(true));
    await sleep(20);
  });

  it("a work that throws after the stream started ends with status 500 and no body, never a hang", async () => {
    const res = await streamable(async () => {
      acceptStream();
      emit({ type: "phase", phase: "thinking" });
      await sleep(1);
      throw new Error("boom");
    });
    expect((await events(res)).pop()).toEqual({ type: "end", status: 500, body: null });
  });

  it("a work that throws before any event throws as it does today", async () => {
    await expect(streamable(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

describe("the access token before the first byte", () => {
  const client = (expiresInS: number) => {
    const refreshSession = vi.fn(async () => ({ data: {}, error: null }));
    return { refreshSession, c: { auth: { getSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + expiresInS } } }), refreshSession } } };
  };
  it("is refreshed when it would expire inside the work's time, and left alone otherwise", async () => {
    const soon = client(120);
    await refreshBeforeStream(soon.c as never);
    expect(soon.refreshSession).toHaveBeenCalledTimes(1);
    const later = client(3600);
    await refreshBeforeStream(later.c as never);
    expect(later.refreshSession).not.toHaveBeenCalled();
    // A client without auth (or one that fails) never stops the request.
    await expect(refreshBeforeStream({} as never)).resolves.toBeUndefined();
    await expect(refreshBeforeStream({ auth: { getSession: async () => { throw new Error("x"); } } } as never)).resolves.toBeUndefined();
  });
});

describe("the reader", () => {
  it("skips blank, broken and unknown lines, and an event with bad fields, instead of throwing", () => {
    expect(readStreamLine("")).toBeNull();
    expect(readStreamLine("{not json")).toBeNull();
    expect(readStreamLine(JSON.stringify({ type: "plan.scene", n: 1 }))).toBeNull();
    expect(readStreamLine(JSON.stringify({ type: "phase", phase: "almost-done" }))).toBeNull();
    expect(readStreamLine(JSON.stringify({ type: "plan.window", index: 0, n: 0, of: 2, parts: [] }))).toBeNull();
    expect(readStreamLine(JSON.stringify({ type: "end", body: {} }))).toBeNull();
    expect(readStreamLine(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
    expect(readStreamLine(JSON.stringify({ type: "retract", what: "scenario", index: 1 }))).toEqual({ type: "retract", what: "scenario", index: 1 });
    expect(readStreamLine(JSON.stringify({ type: "plan.begun", windows: 2, chapters: 4, at_most: 4, about: 2 })))
      .toEqual({ type: "plan.begun", windows: 2, chapters: 4, at_most: 4, about: 2 });
  });

  it("joins a line split across chunks and reads a last line without its newline", async () => {
    const out: BrainStreamEvent[] = [];
    for await (const e of readStreamLines(chunked(['{"type":"ph', 'ase","phase":"thinking"}\n\n{"ty', 'pe":"end","status":200,"body":{"a":1}}']))) out.push(e);
    expect(out).toEqual([{ type: "phase", phase: "thinking" }, { type: "end", status: 200, body: { a: 1 } }]);
  });

  it("reads today's JSON as it is, including a test's fetch stub that has no headers", async () => {
    expect(await readBrainAnswer(json({ error: "x" }, 409))).toEqual({ ok: false, status: 409, body: { error: "x" }, streamed: false });
    const stub = { ok: true, status: 200, json: async () => ({ reply: "hi" }) };
    expect(isBrainStream(stub)).toBe(false);
    expect(await readBrainAnswer(stub)).toEqual({ ok: true, status: 200, body: { reply: "hi" }, streamed: false });
  });

  it("answers a stream with its end (each event before it handed over), and a stream with no end is a cut, never an answer", async () => {
    const seen: string[] = [];
    const lines = (l: unknown[]) => new Response(chunked(l.map((x) => `${JSON.stringify(x)}\n`)), { headers: { "content-type": "application/x-ndjson" } });
    const a = await readBrainAnswer(lines([{ type: "phase", phase: "planning" }, { type: "ping" }, { type: "end", status: 422, body: { error: "content_refused" } }]),
      (e) => { seen.push(e.type); throw new Error("a listener's own failure"); });
    expect(a).toEqual({ ok: false, status: 422, body: { error: "content_refused" }, streamed: true });
    expect(seen).toEqual(["phase", "ping"]);
    await expect(readBrainAnswer(lines([{ type: "phase", phase: "planning" }]))).rejects.toBeInstanceOf(BrainStreamCut);
  });
});
