# Streaming through the proxy: line arrival measured (live-creation plan §3.4, item 2)

Nightshift AI's turn (`POST /api/brain/turn`) is to stream NDJSON lines on the same path (plan §3.1). Before that flag is
turned on, rule 8: measure where a line could be held back between the app and the browser, then change the proxy. This is
that measurement, and the change that came out of it. Measured 2026-11-28, in a container, by Forge.

## Evidence

**Method.** One NDJSON line every 2000 ms from t = 0 for 10 s (6 lines), so a line that is on time arrives at
about 0, 2000, 4000, 6000, 8000 and 10000 ms. Each leg is one `POST` with `curl -N -s --compressed`, a Chromium-like
`Accept-Encoding: gzip, deflate, br, zstd` (and one set with `gzip` alone, as a browser that offers no zstd), and the arrival of
each line is the time curl's stdout delivered it. "Worst late" is the largest `arrival_i - 2000*i`: a line held back by a
buffer shows there in seconds, jitter in milliseconds.

- **a. Direct**: `tools/stream_lab/responder.mjs`, a bare Node server, 127.0.0.1 only.
- **b. Through Next**: the lab app `tools/stream_lab/next_app` (a route that returns a `ReadableStream`, never part of
  command-center), built with the same Next as command-center (15.5.29) and run two ways: `next start`, and the standalone
  `node server.js` the production image runs (`NEXT_OUTPUT=standalone`, command-center/Dockerfile). `compress` is at Next's
  default (on), as in command-center.
- **c. Through Caddy**: `deploy/Caddyfile` itself, with only what makes it runnable here changed (`measure.py caddyfile`: the
  site on 127.0.0.1, `admin off`, every `web:3000` pointed at the lab upstream). **before** is PR #934's head (`f5eb5fe3e`),
  **after** is this change. Over HTTP/1.1 and over HTTPS with HTTP/2 (Caddy's local CA, verified with `--cacert`, never `-k`),
  which is how a browser reaches it. `/api/other` is the control: a path outside the turn's block, still compressed.
- **Caddy versions**: built from source with `go install github.com/caddyserver/caddy/v2/cmd/caddy@<v>` (no package or
  release download could be reached from here): **2.11.4**, which is what production runs (docker-compose pins
  `caddy:2@sha256:0c994536…`, which Docker Hub lists under the tag `2.11.4`; the running container itself was not read),
  2.10.2 (before 2.11.8 changed the `no-transform` rule) and 2.11.9 (latest).
- **Bodies**: `ndjson` is `Content-Type: application/x-ndjson`, `json` is `application/json`; `120B` and `2KB` are the size
  of each line (Caddy's `encode` decides on the first write against `minimum_length`, 512 bytes). `+hdrs` adds
  `Cache-Control: no-transform` and `X-Accel-Buffering: no`.

Reproduce (paths are examples):

```bash
node --version && curl -V | head -1     # Node 22, curl 8.5 with zstd and brotli
go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
cp -r tools/stream_lab/next_app /tmp/lab-next && ln -s "$PWD/command-center/node_modules" /tmp/lab-next/node_modules
(cd /tmp/lab-next && NEXT_OUTPUT=standalone ./node_modules/.bin/next build)
git show f5eb5fe3e:deploy/Caddyfile > /tmp/Caddyfile.before
python3 tools/stream_lab/measure.py matrix --caddy "$(go env GOPATH)/bin/caddy" --next-dir /tmp/lab-next \
  --before /tmp/Caddyfile.before --after deploy/Caddyfile --out /tmp/results.json
python3 tools/stream_lab/measure.py table /tmp/results.json
```

**One lab artefact, found and removed.** The first runs had the responder answer while the request body was still being read.
Through Caddy, 6 of 176 legs were then cut after their first line (curl exit 18; Caddy logged "aborting with incomplete
response ... use of closed network connection"), before and after the change alike and on both proxy blocks. Once the
responder reads the body to its end first, as the real route does (`readJsonBodyCapped`), 0 of 98 legs were cut. The cause
inside Caddy or Go was not chased further; the cut legs are not timings and are not in the table. Every row below is a
complete run of the final lab (legs a and c from the fixed responder, legs b from the lab Next app).

### Raw timings

| Leg | Path through | Body | Content-Encoding | Cache-Control | Arrival of lines 0..5 (ms) | Worst late (ms) | curl |
|---|---|---|---|---|---|---|---|
| a | direct (responder) | ndjson-120B | - | - | 8, 2010, 4011, 6014, 8014, 10016 | 16 | ok |
| a | direct (responder) | ndjson-2KB | - | - | 10, 2013, 4014, 6017, 8017, 10020 | 20 | ok |
| a | direct (responder) | json-120B | - | - | 8, 2010, 4013, 6015, 8015, 10016 | 16 | ok |
| a | direct (responder) | json-2KB | - | - | 9, 2011, 4013, 6013, 8015, 10017 | 17 | ok |
| a | direct (responder) | ndjson-120B+hdrs | - | no-transform | 8, 2010, 4011, 6013, 8015, 10017 | 17 | ok |
| a | direct (responder) | json-2KB+hdrs | - | no-transform | 8, 2010, 4011, 6014, 8016, 10017 | 17 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | ndjson-120B | - | - | 8, 2010, 4010, 6013, 8014, 10017 | 17 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | ndjson-2KB | - | - | 11, 2012, 4015, 6017, 8019, 10022 | 22 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | json-120B | - | - | 8, 2008, 4010, 6013, 8014, 10016 | 16 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | json-2KB | zstd | - | 13, 2009, 4009, 6012, 8014, 10016 | 16 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/other | json-2KB | zstd | - | 7, 2008, 4010, 6010, 8012, 10014 | 14 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | ndjson-120B+hdrs | - | no-transform | 7, 2009, 4009, 6012, 8014, 10016 | 16 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | json-2KB+hdrs | - | no-transform | 6, 2008, 4009, 6012, 8014, 10015 | 15 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/other | json-2KB+hdrs | - | no-transform | 7, 2010, 4012, 6013, 8015, 10018 | 18 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | next standalone ndjson-120B | - | - | 31, 2030, 4030, 6029, 8031, 10033 | 33 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **before** /api/brain/turn | next standalone json-2KB | zstd | - | 16, 2014, 4016, 6017, 8018, 10020 | 20 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | ndjson-120B | - | - | 7, 2009, 4011, 6012, 8015, 10015 | 15 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | ndjson-2KB | - | - | 6, 2008, 4010, 6013, 8013, 10015 | 15 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | json-120B | - | - | 6, 2006, 4009, 6010, 8013, 10014 | 14 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | json-2KB | - | - | 6, 2007, 4009, 6010, 8012, 10014 | 14 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/other | json-2KB | zstd | - | 9, 2008, 4009, 6010, 8010, 10010 | 10 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | ndjson-120B+hdrs | - | no-transform | 6, 2007, 4008, 6009, 8012, 10013 | 13 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | json-2KB+hdrs | - | no-transform | 5, 2007, 4009, 6012, 8014, 10017 | 17 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/other | json-2KB+hdrs | - | no-transform | 6, 2007, 4010, 6010, 8010, 10011 | 11 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | next standalone ndjson-120B | - | - | 11, 2012, 4014, 6016, 8018, 10020 | 20 | ok |
| c | Caddy v2.10.2 HTTP/1.1 **after** /api/brain/turn | next standalone json-2KB | - | - | 8, 2010, 4012, 6012, 8013, 10016 | 16 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | ndjson-120B | - | - | 6, 2007, 4010, 6012, 8014, 10015 | 15 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | ndjson-2KB | - | - | 7, 2008, 4009, 6011, 8014, 10015 | 15 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | json-120B | - | - | 8, 2009, 4012, 6014, 8016, 10018 | 18 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | json-2KB | zstd | - | 12, 2011, 4012, 6014, 8014, 10017 | 17 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/other | json-2KB | zstd | - | 6, 2007, 4009, 6009, 8011, 10013 | 13 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | ndjson-120B+hdrs | - | no-transform | 7, 2009, 4011, 6013, 8016, 10017 | 17 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | json-2KB+hdrs | - | no-transform | 7, 2009, 4009, 6011, 8012, 10014 | 14 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/other | json-2KB+hdrs | - | no-transform | 8, 2009, 4011, 6011, 8014, 10015 | 15 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | next standalone ndjson-120B | - | - | 10, 2011, 4012, 6015, 8016, 10020 | 20 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **before** /api/brain/turn | next standalone json-2KB | zstd | - | 14, 2012, 4014, 6014, 8016, 10019 | 19 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | ndjson-120B | - | - | 8, 2009, 4010, 6013, 8014, 10017 | 17 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | ndjson-2KB | - | - | 7, 2009, 4011, 6012, 8014, 10017 | 17 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | json-120B | - | - | 10, 2010, 4014, 6016, 8017, 10021 | 21 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | json-2KB | - | - | 7, 2009, 4011, 6013, 8015, 10018 | 18 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/other | json-2KB | zstd | - | 10, 2009, 4015, 6011, 8012, 10016 | 16 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | ndjson-120B+hdrs | - | no-transform | 10, 2011, 4014, 6014, 8016, 10019 | 19 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | json-2KB+hdrs | - | no-transform | 8, 2008, 4011, 6013, 8015, 10017 | 17 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/other | json-2KB+hdrs | - | no-transform | 12, 2014, 4015, 6016, 8017, 10020 | 20 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | next standalone ndjson-120B | - | - | 12, 2013, 4013, 6014, 8016, 10018 | 18 | ok |
| c | Caddy v2.11.4 HTTP/1.1 **after** /api/brain/turn | next standalone json-2KB | - | - | 10, 2011, 4014, 6013, 8016, 10017 | 17 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | ndjson-120B | - | - | 6, 2006, 4009, 6010, 8012, 10015 | 15 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | ndjson-2KB | - | - | 8, 2009, 4011, 6012, 8015, 10018 | 18 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | json-120B | - | - | 7, 2009, 4012, 6013, 8015, 10018 | 18 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | json-2KB | zstd | - | 10, 2010, 4012, 6015, 8017, 10020 | 20 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/other | json-2KB | zstd | - | 7, 2007, 4009, 6009, 8011, 10013 | 13 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | ndjson-120B+hdrs | - | no-transform | 6, 2007, 4010, 6010, 8012, 10014 | 14 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | json-2KB+hdrs | - | no-transform | 7, 2008, 4011, 6013, 8012, 10013 | 13 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/other | json-2KB+hdrs | - | no-transform | 6, 2006, 4008, 6008, 8011, 10012 | 12 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | next standalone ndjson-120B | - | - | 10, 2011, 4012, 6014, 8014, 10017 | 17 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **before** /api/brain/turn | next standalone json-2KB | zstd | - | 12, 2010, 4012, 6013, 8014, 10017 | 17 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | ndjson-120B | - | - | 8, 2009, 4010, 6011, 8014, 10015 | 15 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | ndjson-2KB | - | - | 9, 2011, 4012, 6014, 8016, 10019 | 19 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | json-120B | - | - | 6, 2007, 4009, 6011, 8014, 10016 | 16 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | json-2KB | - | - | 6, 2008, 4009, 6011, 8014, 10017 | 17 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/other | json-2KB | zstd | - | 13, 2009, 4011, 6011, 8013, 10016 | 16 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | ndjson-120B+hdrs | - | no-transform | 6, 2008, 4009, 6011, 8014, 10016 | 16 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | json-2KB+hdrs | - | no-transform | 8, 2009, 4010, 6011, 8013, 10016 | 16 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/other | json-2KB+hdrs | - | no-transform | 6, 2009, 4010, 6010, 8012, 10015 | 15 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | next standalone ndjson-120B | - | - | 10, 2008, 4011, 6012, 8014, 10020 | 20 | ok |
| c | Caddy v2.11.9 HTTP/1.1 **after** /api/brain/turn | next standalone json-2KB | - | - | 14, 2014, 4015, 6015, 8016, 10019 | 19 | ok |
| b | next start: route sets no headers | ndjson-120B | - | - | 29, 2028, 4029, 6037, 8034, 10036 | 37 | ok |
| b | next start: route sets no headers | json-2KB | - | - | 9, 2011, 4014, 6019, 8015, 10018 | 19 | ok |
| b | next start: route sets both headers | ndjson-120B | - | no-transform | 9, 2010, 4013, 6014, 8015, 10016 | 16 | ok |
| b | next start: route sets both headers | json-2KB | - | no-transform | 10, 2012, 4013, 6013, 8016, 10018 | 18 | ok |
| b | next start: next.config sets both headers | ndjson-120B | - | no-transform | 8, 2009, 4010, 6011, 8014, 10015 | 15 | ok |
| b | next start: next.config sets both headers | json-2KB | - | no-transform | 11, 2014, 4012, 6012, 8014, 10015 | 15 | ok |
| b | next start: next.config sets both, route sends no-store | ndjson-120B | - | no-transform | 9, 2010, 4013, 6013, 8014, 10017 | 17 | ok |
| b | next start: next.config sets both, route sends no-store | json-2KB | - | no-transform | 9, 2010, 4012, 6013, 8014, 10016 | 16 | ok |
| b | standalone server.js: route sets no headers | ndjson-120B | - | - | 28, 2026, 4030, 6032, 8034, 10038 | 38 | ok |
| b | standalone server.js: route sets no headers | json-2KB | - | - | 10, 2009, 4012, 6012, 8017, 10016 | 17 | ok |
| b | standalone server.js: route sets both headers | ndjson-120B | - | no-transform | 11, 2015, 4019, 6018, 8020, 10022 | 22 | ok |
| b | standalone server.js: route sets both headers | json-2KB | - | no-transform | 9, 2011, 4012, 6013, 8015, 10015 | 15 | ok |
| b | standalone server.js: next.config sets both headers | ndjson-120B | - | no-transform | 11, 2012, 4017, 6016, 8018, 10018 | 18 | ok |
| b | standalone server.js: next.config sets both headers | json-2KB | - | no-transform | 8, 2010, 4012, 6011, 8014, 10014 | 14 | ok |
| b | standalone server.js: next.config sets both, route sends no-store | ndjson-120B | - | no-transform | 8, 2009, 4012, 6011, 8014, 10014 | 14 | ok |
| b | standalone server.js: next.config sets both, route sends no-store | json-2KB | - | no-transform | 17, 2019, 4022, 6021, 8023, 10026 | 26 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **before** /api/brain/turn | ndjson-120B | - | - | 17, 2018, 4023, 6020, 8021, 10024 | 24 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **before** /api/brain/turn | json-2KB | zstd | - | 20, 2017, 4018, 6019, 8021, 10023 | 23 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **before** /api/other | json-2KB | zstd | - | 14, 2013, 4016, 6015, 8018, 10020 | 20 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **before** /api/brain/turn | next standalone json-2KB | zstd | - | 48, 2045, 4047, 6049, 8058, 10060 | 60 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **after** /api/brain/turn | ndjson-120B | - | - | 13, 2013, 4017, 6017, 8020, 10026 | 26 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **after** /api/brain/turn | json-2KB | - | - | 12, 2013, 4014, 6017, 8019, 10020 | 20 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **after** /api/other | json-2KB | zstd | - | 17, 2015, 4015, 6015, 8017, 10021 | 21 | ok |
| c | Caddy v2.10.2 HTTP/2+TLS **after** /api/brain/turn | next standalone json-2KB | - | - | 15, 2019, 4020, 6018, 8020, 10022 | 22 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/brain/turn | ndjson-120B | - | - | 15, 2016, 4017, 6020, 8021, 10023 | 23 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/brain/turn | json-2KB | zstd | - | 17, 2020, 4034, 6026, 8029, 10042 | 42 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/other | json-2KB | zstd | - | 119, 2045, 4048, 6047, 8049, 10052 | 119 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/brain/turn | next standalone json-2KB | zstd | - | 18, 2020, 4024, 6026, 8029, 10031 | 31 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/brain/turn | ndjson-120B | - | - | 17, 2019, 4021, 6055, 8064, 10063 | 64 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/brain/turn | json-2KB | - | - | 17, 2020, 4020, 6036, 8045, 10050 | 50 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/other | json-2KB | zstd | - | 17, 2017, 4020, 6019, 8021, 10048 | 48 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/brain/turn | next standalone json-2KB | - | - | 27, 2027, 4028, 6032, 8079, 10092 | 92 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **before** /api/brain/turn | ndjson-120B | - | - | 75, 2073, 4073, 6076, 8077, 10080 | 80 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **before** /api/brain/turn | json-2KB | zstd | - | 18, 2044, 4058, 6064, 8069, 10073 | 73 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **before** /api/other | json-2KB | zstd | - | 13, 2013, 4013, 6030, 8019, 10052 | 52 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **before** /api/brain/turn | next standalone json-2KB | zstd | - | 20, 2020, 4020, 6023, 8032, 10028 | 32 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **after** /api/brain/turn | ndjson-120B | - | - | 34, 2081, 4082, 6084, 8109, 10108 | 109 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **after** /api/brain/turn | json-2KB | - | - | 15, 2017, 4017, 6020, 8025, 10034 | 34 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **after** /api/other | json-2KB | zstd | - | 15, 2011, 4012, 6014, 8017, 10022 | 22 | ok |
| c | Caddy v2.11.9 HTTP/2+TLS **after** /api/brain/turn | next standalone json-2KB | - | - | 43, 2044, 4064, 6047, 8056, 10054 | 64 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/brain/turn | ndjson-120B (Accept-Encoding: gzip) | - | - | 15, 2016, 4018, 6019, 8021, 10024 | 24 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/brain/turn | json-2KB (Accept-Encoding: gzip) | gzip | - | 22, 2021, 4023, 6025, 8025, 10027 | 27 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/other | json-2KB (Accept-Encoding: gzip) | gzip | - | 14, 2015, 4055, 6056, 8057, 10060 | 60 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **before** /api/brain/turn | next standalone json-2KB (Accept-Encoding: gzip) | gzip | - | 40, 2049, 4039, 6041, 8048, 10051 | 51 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/brain/turn | ndjson-120B (Accept-Encoding: gzip) | - | - | 21, 2024, 4027, 6027, 8030, 10036 | 36 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/brain/turn | json-2KB (Accept-Encoding: gzip) | - | - | 46, 2047, 4049, 6064, 8062, 10067 | 67 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/other | json-2KB (Accept-Encoding: gzip) | gzip | - | 10, 2008, 4012, 6010, 8012, 10014 | 14 | ok |
| c | Caddy v2.11.4 HTTP/2+TLS **after** /api/brain/turn | next standalone json-2KB (Accept-Encoding: gzip) | - | - | 15, 2016, 4017, 6018, 8020, 10034 | 34 | ok |

## Diagnosis

1. **No hop held a line back, before or after.** Across all 114 rows the worst line was 119 ms behind its send time; a held
   line would be seconds behind. This includes Caddy compressing the stream (zstd or gzip, the `before` rows marked so): it
   flushed the compressor after every write. So the change below is **not** a measured latency fix, and nothing here says
   `encode` buffers a stream on these versions. What it removes is the dependency: whether `encode` touches the stream at all
   rests on its Content-Type (`application/x-ndjson` is not in `encode`'s default list, `application/json` is), on the
   first write's size (lines under 512 bytes were not compressed), and on a `no-transform` rule that changed in 2.11.8.
2. **Why it flushes.** Caddy's `reverse_proxy` flushes immediately, whatever `flush_interval` says, when the response's
   `Content-Length` is unknown, which a stream's always is (docs below; `modules/caddyhttp/reverseproxy/streaming.go`,
   `flushInterval`, returns -1 for `res.ContentLength == -1`); `encode`'s `FlushError` flushes its encoder before the
   connection. So **`flush_interval -1` is not needed**, and it is not added: its only other effect is that a visitor's
   disconnect no longer cancels the request to the app, which is a decision of its own (plan §3.2), not a proxy side effect.
3. **Next.js did not compress or buffer the stream** in either server, with or without the headers.
4. **Both headers reach the browser unchanged through Caddy**, and with `no-transform` on the response every version left the
   body alone even on a compressed path (`/api/other`, `json-2KB+hdrs`).
5. **Where the headers are set matters: a `next.config.ts` header replaces the route's own.** With `Cache-Control:
   no-transform` in next.config and `Cache-Control: no-store` from the route, the browser got `no-transform` only (rows "next.config
   sets both, route sends no-store", both servers). Every `/api/brain` answer sends `no-store` (`lib/server/brain/session.ts`), so
   setting them there would have made a signed-in person's answers storable. In Caddy, a `header` can only replace the app's
   Cache-Control or add a second line beside it (reasoned from the directive, not measured).

## The change

- **`deploy/Caddyfile`**: `encode` gets a matcher, `@compressible not path /api/brain/turn`, so that exact path (the one
  the 330 s proxy block serves) is never compressed and every other path is compressed exactly as before (control rows).
  The 330 s `response_header_timeout`, `read_timeout` and `write_timeout` from #934 are unchanged. Note for item 3:
  `read_timeout` bounds each read from the app, not the whole answer, so a stream that writes a `ping` every 10 s is never cut
  by it. No `flush_interval` (point 2).
- **The route**: `POST /api/brain/turn` passes every answer, refusals and the switched-off 404 included, through
  `withStreamHeaders` (`lib/server/brain/session.ts`): `Cache-Control` keeps its own directives and gains `no-transform`
  (`no-store, no-transform`), and `X-Accel-Buffering: no` is added. Chosen over next.config.ts and the Caddyfile because of
  point 5. The stream of item 3 is a response of the same `POST`, so it gets them without doing anything.
- Tests: `tests/test_deploy_self_host.py` `CaddyTurnStreamTests` (the one `encode` line and its matcher, the same path as the
  proxy block, no `flush_interval`); `command-center/tests/brain-turn-route.test.ts` (the headers on an answer, a refusal and
  the switched-off 404).

## Not measured here

- The production server itself (Hetzner, real TLS, real browser). The Caddy legs ran the same Caddyfile and the same Caddy
  version locally; a `curl -N` against the deployed turn once item 3 exists is still the check.
- The real `/api/brain/turn` stream: it does not exist yet (item 3). The lab routes stand in for it.
- HTTP/3: Caddy offers it, a browser may use it, and curl here has no HTTP/3.
- The real route's headers were checked by its tests, not over the wire: against the command-center build under `next start`,
  a request with no session is answered 401 by the middleware (`cache-control: no-store`, no `no-transform`), before the
  route runs. That refusal is never a stream, and Caddy no longer compresses the path anyway.

## Sources

- Caddy, `reverse_proxy`: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (`flush_interval`: "This option is
  ignored and responses are flushed immediately to the client if ... `Content-Length` is unknown"; "does not cancel the request
  to the backend even if the client disconnects early"; the `http` transport's `read_timeout`, "the next read from the backend").
- Caddy, `encode`: https://caddyserver.com/docs/caddyfile/directives/encode (the `[<matcher>]` argument; `minimum_length`
  default 512; the default `match` Content-Type list; "Responses ... whose Cache-Control header contains no-transform, are not
  encoded"; the v2.11.8 change).
- Caddy, request matchers: https://caddyserver.com/docs/caddyfile/matchers ("Path matching is an exact match by default, not a
  prefix match").
- Caddy source, v2.10.2 and v2.11.9 from the Go module proxy: `modules/caddyhttp/reverseproxy/streaming.go` (`flushInterval`)
  and `modules/caddyhttp/encode/encode.go` (`Write`, `FlushError`, `init`).
- Docker Hub, the `caddy` image's tags: https://hub.docker.com/_/caddy/tags (the digest pinned in deploy/docker-compose.yml is
  listed under `2.11.4`).
