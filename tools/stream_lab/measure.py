#!/usr/bin/env python3
"""Lab-only: when does each NDJSON line of a streamed answer reach the client? (rule 8)

Live-creation plan §3.4: before the stream flag is turned on, line arrival is measured directly,
through `next start` and through Caddy with deploy/Caddyfile's /api/brain/turn block. The method
and the numbers are in docs/studio/STREAM_PROXY_MEASUREMENT.md. Nothing here is loaded
in production: no compose service, workflow or app module imports it, and every server it starts
listens on 127.0.0.1 only. It calls no provider and spends nothing.

    python3 tools/stream_lab/measure.py curl URL
        One POST with `curl -N -s --compressed` (a browser-like Accept-Encoding); prints the
        response headers that matter and each line's arrival time in ms after the request began.

    python3 tools/stream_lab/measure.py caddyfile --src deploy/Caddyfile --port P --upstream H:P --out F
        Writes deploy/Caddyfile as a lab config: the site on http://127.0.0.1:P, admin and
        automatic HTTPS off, every `web:3000` pointed at the lab upstream. Nothing else changes,
        so the /api/brain/turn block under test is the file's own.

    python3 tools/stream_lab/measure.py matrix --caddy BIN [--caddy BIN2 ...] --next-dir DIR
            --before OLD_CADDYFILE --after NEW_CADDYFILE [--legs a,b,c-h1,c-h2] [--out results.json]
        Starts tools/stream_lab/responder.mjs and the built lab Next app (tools/stream_lab/next_app,
        `next start` and the standalone `server.js`), runs every leg and prints one line per leg:
        status, Content-Encoding, and each line's arrival in ms. c-h2 is HTTPS + HTTP/2 from
        Caddy's local CA, the transport a browser uses.

    python3 tools/stream_lab/measure.py table results.json [more.json ...]
        The rows of one or more runs as the Markdown table in the measurement doc.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESPONDER = HERE / "responder.mjs"
# What a current Chromium offers (Caddy then picks zstd); curl decodes all four with --compressed.
# STREAM_LAB_ACCEPT=gzip measures a browser that offers no zstd (Caddy then picks gzip).
ACCEPT = os.environ.get("STREAM_LAB_ACCEPT", "gzip, deflate, br, zstd")
SHOWN = ("content-type", "content-encoding", "cache-control", "x-accel-buffering", "transfer-encoding", "vary")


def curl_lines(url: str, timeout: float = 40.0, cacert: str | None = None) -> dict:
    """Arrival time of each line, read from curl's stdout as it is written (curl -N: no buffer).

    With ``cacert``, HTTPS over HTTP/2 as a browser reaches Caddy, verified against the lab Caddy's own
    local root (never -k)."""
    hdr = tempfile.NamedTemporaryFile(prefix="stream-lab-h-", delete=False)
    hdr.close()
    cmd = ["curl", "-N", "-s", "--compressed", "-H", f"Accept-Encoding: {ACCEPT}", "-X", "POST",
           "-H", "Content-Type: application/json", "--data", "{}", "-D", hdr.name, "--max-time", str(timeout)]
    if cacert:
        cmd += ["--http2", "--cacert", cacert]
    cmd.append(url)
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=0)
    arrivals: list[int] = []
    sizes: list[int] = []
    buf = b""
    assert p.stdout is not None
    while True:
        chunk = p.stdout.read(65536)
        if not chunk:
            break
        now = int((time.monotonic() - t0) * 1000)
        buf += chunk
        while b"\n" in buf:
            ln, buf = buf.split(b"\n", 1)
            arrivals.append(now)
            sizes.append(len(ln) + 1)
    p.wait()
    ended_ms = int((time.monotonic() - t0) * 1000)
    raw = Path(hdr.name).read_text(encoding="latin-1")
    os.unlink(hdr.name)
    headers: dict[str, str] = {}
    for line in raw.splitlines()[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            k = k.strip().lower()
            if k in SHOWN:
                headers[k] = (headers[k] + ", " if k in headers else "") + v.strip()
    status = raw.splitlines()[0].strip() if raw else "no response"
    # curl_exit 18 is "transfer closed with outstanding read data": the body was cut, so the row is not a timing.
    return {"url": url, "status": status, "headers": headers, "arrivals_ms": arrivals, "line_bytes": sizes,
            "ended_ms": ended_ms, "curl_exit": p.returncode}


def lab_caddyfile(src: Path, port: int, upstream: str, tls: bool = False) -> str:
    """deploy/Caddyfile runnable on this machine: plain HTTP, or (tls) HTTPS and HTTP/2 from Caddy's local CA."""
    text = src.read_text(encoding="utf-8")
    if "\temail {$ACME_EMAIL}\n" not in text or "web:3000" not in text:
        raise SystemExit(f"{src}: not the deploy Caddyfile shape this lab expects")
    extra = "\tadmin off\n\tlocal_certs\n\tskip_install_trust\n" if tls else "\tadmin off\n\tauto_https off\n"
    text = text.replace("\temail {$ACME_EMAIL}\n", "\temail {$ACME_EMAIL}\n" + extra, 1)
    site = f"https://localhost:{port}" if tls else f"http://127.0.0.1:{port}"
    text = text.replace("{$DOMAIN} {", f"{site} {{", 1)
    return text.replace("web:3000", upstream)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_port(port: int, seconds: float = 30.0) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise SystemExit(f"nothing listened on 127.0.0.1:{port} within {seconds}s")


class Procs:
    def __init__(self) -> None:
        self.ps: list[subprocess.Popen] = []

    def start(self, cmd: list[str], port: int, cwd: Path | None = None, env: dict | None = None) -> None:
        log = open(Path(tempfile.gettempdir()) / f"stream-lab-{int(time.time() * 1000)}-{port}.log", "w")
        self.ps.append(subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **(env or {})}, stdout=log,
                                        stderr=subprocess.STDOUT, start_new_session=True))
        wait_port(port)

    def stop_last(self) -> None:
        p = self.ps.pop()
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(10)

    def stop_all(self) -> None:
        while self.ps:
            self.stop_last()


def caddy_version(bin_: str) -> str:
    out = subprocess.run([bin_, "build-info"], capture_output=True, text=True).stdout
    m = re.search(r"^(?:dep|mod)\s+github\.com/caddyserver/caddy/v2\s+(\S+)", out, re.M)
    return m.group(1) if m else "unknown"


def matrix(a: argparse.Namespace) -> list[dict]:
    procs = Procs()
    rows: list[dict] = []
    q = "?every=2000&for=10000"
    try:
        # Upstreams: the bare responder in four shapes, and the lab Next app two ways.
        ups: dict[str, int] = {}
        for name, extra in (("ndjson-120B", ["--type", "application/x-ndjson", "--bytes", "120"]),
                            ("ndjson-2KB", ["--type", "application/x-ndjson", "--bytes", "2048"]),
                            ("json-120B", ["--type", "application/json", "--bytes", "120"]),
                            ("json-2KB", ["--type", "application/json", "--bytes", "2048"]),
                            ("ndjson-120B+hdrs", ["--type", "application/x-ndjson", "--bytes", "120", "--stream-headers"]),
                            ("json-2KB+hdrs", ["--type", "application/json", "--bytes", "2048", "--stream-headers"])):
            port = free_port()
            procs.start(["node", str(RESPONDER), "--port", str(port), *extra], port)
            ups[name] = port
        nd = Path(a.next_dir)
        nport = free_port()
        procs.start([str(nd / "node_modules/.bin/next"), "start", "-p", str(nport), "-H", "127.0.0.1"], nport, cwd=nd,
                    env={"NEXT_TELEMETRY_DISABLED": "1"})
        sport = free_port()
        sa = nd / ".next/standalone"
        procs.start(["node", "server.js"], sport, cwd=sa, env={"PORT": str(sport), "HOSTNAME": "127.0.0.1",
                                                              "NEXT_TELEMETRY_DISABLED": "1"})

        def leg(label: str, url: str, cacert: str | None = None, **kw) -> None:
            r = curl_lines(url, cacert=cacert)
            r.update(label=label, **kw)
            rows.append(r)
            hd = r["headers"]
            print(f"{label:80s} {r['status'][:8]:8s} enc={hd.get('content-encoding', '-'):5s} "
                  f"cc={hd.get('cache-control', '-'):24s} xab={hd.get('x-accel-buffering', '-'):3s} {r['arrivals_ms']}"
                  f" end={r['ended_ms']} exit={r['curl_exit']}", flush=True)

        legs = set(a.legs.split(","))
        if "a" in legs:
            for name, port in ups.items():
                leg(f"a. direct responder {name}", f"http://127.0.0.1:{port}/api/brain/turn", leg="a", shape=name)
        if "b" in legs:
            for srv, port in (("next start", nport), ("standalone server.js", sport)):
                for path, desc in (("/api/brain/turn", "route sets no headers"),
                                   ("/api/brain/turn", "route sets both headers"),
                                   ("/api/cfg/turn", "next.config sets both headers"),
                                   ("/api/cfg/turn", "next.config sets both, route sends no-store")):
                    h = {"route sets both headers": "&h=1", "next.config sets both, route sends no-store": "&cc=1"}.get(desc, "")
                    for shape, extra in (("ndjson-120B", "&bytes=120"), ("json-2KB", "&type=application/json&bytes=2048")):
                        leg(f"b. {srv}, {desc}, {shape}", f"http://127.0.0.1:{port}{path}{q}{extra}{h}", leg="b",
                            server=srv, variant=desc, shape=shape)
        for cb in a.caddy:
            ver = caddy_version(cb)
            for proto in ("h1", "h2"):
                if f"c-{proto}" not in legs:
                    continue
                for which, src in (("before", Path(a.before)), ("after", Path(a.after))):
                    shapes = [*ups.items(), ("next standalone ndjson-120B", sport), ("next standalone json-2KB", sport)]
                    if proto == "h2":  # the browser's transport, on the shapes that differ through encode
                        shapes = [x for x in shapes if x[0] in ("ndjson-120B", "json-2KB", "next standalone json-2KB")]
                    for name, port in shapes:
                        cport = free_port()
                        data = Path(tempfile.mkdtemp(prefix="stream-lab-caddy-"))
                        cfg = data / "Caddyfile"
                        cfg.write_text(lab_caddyfile(src, cport, f"127.0.0.1:{port}", tls=proto == "h2"), encoding="utf-8")
                        procs.start([cb, "run", "--config", str(cfg), "--adapter", "caddyfile"], cport,
                                    env={"ACME_EMAIL": "lab@example.invalid", "XDG_DATA_HOME": str(data),
                                         "XDG_CONFIG_HOME": str(data)})
                        cacert, scheme, host = None, "http", "127.0.0.1"
                        if proto == "h2":
                            root = data / "caddy/pki/authorities/local/root.crt"
                            end = time.monotonic() + 30
                            while not root.exists() and time.monotonic() < end:
                                time.sleep(0.1)
                            time.sleep(1.0)  # the leaf certificate is issued just after the root appears
                            cacert, scheme, host = str(root), "https", "localhost"
                        tail = {"next standalone ndjson-120B": f"{q}&bytes=120",
                                "next standalone json-2KB": f"{q}&type=application/json&bytes=2048"}.get(name, "")
                        for path in ("/api/brain/turn", "/api/other"):
                            if path == "/api/other" and not name.startswith("json-2KB"):
                                continue  # the control: a path outside the block must still be compressed
                            leg(f"c. caddy {ver} {proto} {which}, {name}, {path}", f"{scheme}://{host}:{cport}{path}{tail}",
                                cacert=cacert, leg="c", caddy=ver, proto=proto, config=which, shape=name, path=path)
                        procs.stop_last()
                        shutil.rmtree(data, ignore_errors=True)
    finally:
        procs.stop_all()
    return rows


def table(paths: list[str]) -> str:
    """The rows of one or more matrix runs as Markdown. "Worst late" is the largest arrival_i - 2000*i: how far behind its
    send time (one line every 2000 ms from t=0) the latest line reached curl. A held-back line would show here in seconds."""
    out = ["| Leg | Path through | Body | Content-Encoding | Cache-Control | Arrival of lines 0..5 (ms) | Worst late (ms) | curl |",
           "|---|---|---|---|---|---|---|---|"]
    for p in paths:
        for r in json.loads(Path(p).read_text(encoding="utf-8")):
            arr = r["arrivals_ms"]
            late = max((t - 2000 * i for i, t in enumerate(arr)), default=None)
            if r["leg"] == "a":
                through = "direct (responder)"
            elif r["leg"] == "b":
                through = f"{r['server']}: {r['variant']}"
            else:
                through = f"Caddy {r['caddy']} {'HTTP/2+TLS' if r.get('proto') == 'h2' else 'HTTP/1.1'} **{r['config']}** {r['path']}"
            hd = r["headers"]
            out.append(f"| {r['leg']} | {through} | {r['shape']} | {hd.get('content-encoding', '-')} | {hd.get('cache-control', '-')} "
                       f"| {', '.join(map(str, arr))} | {late} | {'ok' if r['curl_exit'] == 0 else 'exit ' + str(r['curl_exit'])} |")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("curl")
    c.add_argument("url")
    f = sub.add_parser("caddyfile")
    f.add_argument("--src", required=True)
    f.add_argument("--port", type=int, required=True)
    f.add_argument("--upstream", required=True)
    f.add_argument("--out", required=True)
    m = sub.add_parser("matrix")
    m.add_argument("--caddy", action="append", required=True)
    m.add_argument("--next-dir", required=True)
    m.add_argument("--before", required=True)
    m.add_argument("--after", required=True)
    m.add_argument("--legs", default="a,b,c-h1,c-h2", help="any of a, b, c-h1 (Caddy, HTTP/1.1), c-h2 (Caddy, HTTPS + HTTP/2)")
    m.add_argument("--out")
    t = sub.add_parser("table")
    t.add_argument("results", nargs="+")
    a = ap.parse_args()
    if a.cmd == "table":
        print(table(a.results))
        return 0
    if not shutil.which("curl"):
        raise SystemExit("curl is needed")
    if a.cmd == "curl":
        print(json.dumps(curl_lines(a.url), indent=2))
    elif a.cmd == "caddyfile":
        Path(a.out).write_text(lab_caddyfile(Path(a.src), a.port, a.upstream), encoding="utf-8")
    else:
        rows = matrix(a)
        if a.out:
            Path(a.out).write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
