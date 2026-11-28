#!/usr/bin/env node
// Lab-only NDJSON responder for docs/studio/STREAM_PROXY_MEASUREMENT.md (live-creation plan §3.4, rule 8).
//
// It answers any request with one NDJSON line every --every ms until --for ms have passed, then
// ends. Nothing imports it and no compose service runs it: it exists so the arrival time of each
// line can be measured directly, through `next start` and through Caddy, with the proxy config
// as the only thing that changes between legs. It binds 127.0.0.1 only.
//
//   node tools/stream_lab/responder.mjs --port 4101 [--every 2000] [--for 10000] [--bytes 120]
//        [--type application/x-ndjson] [--stream-headers]
//
// --bytes pads each line to about that size: Caddy's `encode` decides on the first write
// (minimum_length 512), so a stream of short lines and a stream of long ones take different
// paths through it, and both are measured. --stream-headers adds the two headers the plan names
// (Cache-Control: no-transform, X-Accel-Buffering: no), so their effect is measured on its own.
import http from "node:http";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const port = Number(opt("port", "4101"));
const every = Number(opt("every", "2000"));
const total = Number(opt("for", "10000"));
const bytes = Number(opt("bytes", "120"));
const type = opt("type", "application/x-ndjson");
const streamHeaders = args.includes("--stream-headers");

function line(seq, t0) {
  const base = { type: seq === 0 ? "phase" : "ping", seq, server_ms: Date.now() - t0 };
  const room = Math.max(0, bytes - JSON.stringify({ ...base, pad: "" }).length - 1);
  return JSON.stringify({ ...base, pad: "x".repeat(room) }) + "\n";
}

// The body is read to its end before the answer starts, as the real route does (readJsonBodyCapped). Answering while the
// request was still being read made Caddy cut about one stream in thirty after its first line ("aborting with incomplete
// response ... use of closed network connection"), before and after the change alike.
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => answer(res));
});

function answer(res) {
  const headers = { "Content-Type": type };
  if (streamHeaders) {
    headers["Cache-Control"] = "no-transform";
    headers["X-Accel-Buffering"] = "no";
  }
  res.writeHead(200, headers);
  const t0 = Date.now();
  let seq = 0;
  res.write(line(seq++, t0));
  const timer = setInterval(() => {
    res.write(line(seq++, t0));
    if (Date.now() - t0 >= total - 5) {
      clearInterval(timer);
      res.end();
    }
  }, every);
  res.on("close", () => clearInterval(timer));
}

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`responder listening on 127.0.0.1:${port}\n`);
});
