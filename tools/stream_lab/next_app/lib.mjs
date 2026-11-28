// Lab-only (tools/stream_lab): the NDJSON stream both lab routes answer with, one line every
// `every` ms for `for` ms, the same shape as tools/stream_lab/responder.mjs.
export function labStream(url) {
  const q = new URL(url).searchParams;
  const every = Number(q.get("every") ?? 2000);
  const total = Number(q.get("for") ?? 10000);
  const bytes = Number(q.get("bytes") ?? 120);
  const enc = new TextEncoder();
  const t0 = Date.now();
  let seq = 0;
  let timer;
  const line = () => {
    const base = { type: seq === 0 ? "phase" : "ping", seq, server_ms: Date.now() - t0 };
    const room = Math.max(0, bytes - JSON.stringify({ ...base, pad: "" }).length - 1);
    seq += 1;
    return enc.encode(JSON.stringify({ ...base, pad: "x".repeat(room) }) + "\n");
  };
  return {
    type: q.get("type") ?? "application/x-ndjson",
    routeHeaders: q.get("h") === "1",
    body: new ReadableStream({
      start(c) {
        c.enqueue(line());
        timer = setInterval(() => {
          c.enqueue(line());
          if (Date.now() - t0 >= total - 5) {
            clearInterval(timer);
            c.close();
          }
        }, every);
      },
      cancel() {
        clearInterval(timer);
      },
    }),
  };
}
