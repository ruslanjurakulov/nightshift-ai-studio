import test from "node:test";
import assert from "node:assert/strict";
import { apiError, fakeApi, run, TEST_KEY } from "./helpers.js";

const ME = { organization: { id: "org-1", name: "Acme" }, key: { id: "key-1" }, tier: 1, limits: { requests_per_minute: 30, concurrent_videos: 2, monthly_limit_cents: 10000, key_monthly_limit_cents: null } };
const BALANCE = { currency: "usd", exempt: false, balance_cents: 2500, reserved_cents: 120, available_cents: 2380, month_spend_cents: 700, monthly_limit_cents: 10000, tier: 1 };

test("whoami, balance, channels: success in human and JSON form", async () => {
  const api = await fakeApi({
    "GET /me": ME,
    "GET /balance": BALANCE,
    "GET /channels": { channels: [{ id: "tides", name: "Tides", active: true, youtube_connected: true, target_duration_seconds: 90 }] },
  });
  try {
    let r = await run(["whoami"], { api });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Acme/);
    assert.match(r.stdout, /Tier:\s+1/);
    r = await run(["balance"], { api });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Available:\s+\$23\.80/);
    assert.match(r.stdout, /On hold:\s+\$1\.20/);
    r = await run(["balance", "--json"], { api });
    assert.deepEqual(JSON.parse(r.stdout), BALANCE);
    assert.equal(r.stderr, "");
    r = await run(["channels"], { api });
    assert.match(r.stdout, /tides\s+Tides\s+active/);
    // the key went out as a Bearer header, once per request
    assert.ok(api.seen.every((s) => s.headers.authorization === `Bearer ${TEST_KEY}`));
  } finally {
    await api.close();
  }
});

test("unknown values are never rendered as numbers", async () => {
  const api = await fakeApi({ "GET /balance": { currency: "usd" } });
  try {
    const r = await run(["balance"], { api });
    assert.match(r.stdout, /Available:\s+unknown/);
    assert.doesNotMatch(r.stdout, /\$0\.00/);
  } finally {
    await api.close();
  }
});

test("401 maps to exit 3 and prints code, message and request_id", async () => {
  const api = await fakeApi({ "GET /me": apiError(401, "invalid_api_key", "That key is not valid.") });
  try {
    const r = await run(["whoami"], { api });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /That key is not valid\./);
    assert.match(r.stderr, /code: invalid_api_key/);
    assert.match(r.stderr, /request_id: req_test123/);
    assert.match(r.stderr, /HTTP 401/);
  } finally {
    await api.close();
  }
});

test("402 maps to exit 4 and names the remedy; --json keeps the envelope", async () => {
  const api = await fakeApi({
    "POST /videos": apiError(402, "insufficient_balance", "Not enough balance.", { price_cents: 120, available_cents: 50 }),
  });
  try {
    let r = await run(["create", "--channel", "tides", "--duration", "90s"], { api });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /insufficient_balance/);
    assert.match(r.stderr, /Nothing was charged/);
    r = await run(["create", "--channel", "tides", "--duration", "90s", "--json"], { api });
    assert.equal(r.code, 4);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error.code, "insufficient_balance");
    assert.equal(j.error.request_id, "req_test123");
    assert.equal(j.error.available_cents, 50);
    assert.equal(j.http_status, 402);
    assert.equal(r.stderr, "");
  } finally {
    await api.close();
  }
});

test("429 maps to exit 5 and shows Retry-After", async () => {
  const api = await fakeApi({
    "GET /balance": apiError(429, "rate_limit_exceeded", "Slow down.", { retry_after: 12 }, { "retry-after": "12" }),
  });
  try {
    const r = await run(["balance"], { api });
    assert.equal(r.code, 5);
    assert.match(r.stderr, /Retry-After: 12s/);
    assert.match(r.stderr, /rate_limit_exceeded/);
    const j = JSON.parse((await run(["balance", "--json"], { api })).stdout);
    assert.equal(j.error.retry_after, 12);
  } finally {
    await api.close();
  }
});

test("403 is an auth failure (exit 3); other 4xx is exit 1", async () => {
  const api = await fakeApi({
    "GET /balance": apiError(403, "insufficient_scope", "Needs account:read.", { required_scope: "account:read" }),
    "GET /channels": apiError(404, "unknown_endpoint", "No."),
  });
  try {
    assert.equal((await run(["balance"], { api })).code, 3);
    assert.equal((await run(["channels"], { api })).code, 1);
  } finally {
    await api.close();
  }
});

test("a non-JSON error page is reported honestly", async () => {
  const api = await fakeApi({ "GET /balance": { status: 502, body: "<html>bad gateway</html>" } });
  try {
    const r = await run(["balance"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 502 without an API error body/);
  } finally {
    await api.close();
  }
});

test("create: auto Idempotency-Key, prints the hold, and the same key on retry", async () => {
  const api = await fakeApi({ "POST /videos": { status: 201, body: { job_id: 41, channel_id: "tides", status: "queued", price_cents: 180 } } });
  try {
    let r = await run(["create", "--channel", "tides", "--topic", "How tides work", "--duration", "1m30s"], { api });
    assert.equal(r.code, 0);
    const first = api.seen[0];
    assert.match(first.headers["idempotency-key"], /^cli-[0-9a-f-]{36}$/);
    assert.deepEqual(first.body, { channel_id: "tides", topic: "How tides work", duration: 90 });
    assert.match(r.stdout, /Queued job 41/);
    assert.match(r.stdout, /Held from your API balance: \$1\.80/);
    assert.match(r.stderr, new RegExp(first.headers["idempotency-key"]));
    // retry with that same key: the header is identical
    r = await run(["create", "--channel", "tides", "--topic", "How tides work", "--duration", "90", "--idempotency-key", first.headers["idempotency-key"]], { api });
    assert.equal(api.seen[1].headers["idempotency-key"], first.headers["idempotency-key"]);
    assert.doesNotMatch(r.stderr, /Idempotency-Key:/, "an explicit key is not announced again");
    // a different run without a key gets a different one
    await run(["create", "--channel", "tides", "--duration", "90"], { api });
    assert.notEqual(api.seen[2].headers["idempotency-key"], first.headers["idempotency-key"]);
  } finally {
    await api.close();
  }
});

test("create: a replayed answer says so; an unreported price is not shown as $0", async () => {
  const api = await fakeApi({
    "POST /videos": { status: 201, headers: { "idempotent-replayed": "true" }, body: { job_id: 41, channel_id: "tides", status: "queued", price_cents: null } },
  });
  try {
    const r = await run(["create", "--channel", "tides", "--duration", "90", "--idempotency-key", "k1"], { api });
    assert.match(r.stdout, /Replayed the earlier request/);
    assert.match(r.stdout, /did not report a price/);
    assert.doesNotMatch(r.stdout, /\$0\.00/);
  } finally {
    await api.close();
  }
});

test("create: a network failure tells the user to retry with the same key", async () => {
  const api = await fakeApi({});
  await api.close(); // nothing is listening any more
  const r = await run(["create", "--channel", "tides", "--duration", "90"], { api });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /may or may not have reached the server/);
  const key = /--idempotency-key (cli-[0-9a-f-]{36})/.exec(r.stderr)?.[1];
  assert.ok(key, "the key to retry with is printed");
  const j = JSON.parse((await run(["create", "--channel", "tides", "--duration", "90", "--json", "--idempotency-key", "same-key"], { api })).stdout);
  assert.equal(j.idempotency_key, "same-key");
  assert.equal(j.error.code, "network_error");
});

test("create validates input before sending anything", async () => {
  const api = await fakeApi({ "POST /videos": { status: 201, body: {} } });
  try {
    assert.equal((await run(["create"], { api })).code, 2);
    assert.equal((await run(["create", "--channel", "t", "--duration", "10s"], { api })).code, 2);
    assert.equal((await run(["create", "--channel", "t", "--duration", "banana"], { api })).code, 2);
    assert.equal((await run(["create", "--channel", "t", "--idempotency-key", "bad key!"], { api })).code, 2);
    assert.equal((await run(["create", "--channel", "t", "--nope"], { api })).code, 2);
    assert.equal(api.seen.length, 0);
  } finally {
    await api.close();
  }
});

test("create --wait polls with backoff and prints held and charged", async () => {
  const states = ["queued", "running", "running", "succeeded"];
  const api = await fakeApi({
    "POST /videos": { status: 201, body: { job_id: 7, channel_id: "tides", status: "queued", price_cents: 120 } },
    "GET /jobs/7": (req, body, n) => {
      const status = states[Math.min(n - 1, states.length - 1)];
      return { id: 7, channel_id: "tides", status, charge: status === "succeeded" ? { status: "captured", held_cents: 120, captured_cents: 120 } : { status: "open", held_cents: 120, captured_cents: null } };
    },
  });
  try {
    const r = await run(["create", "--channel", "tides", "--duration", "60", "--wait"], { api });
    assert.equal(r.code, 0);
    assert.deepEqual(r.sleeps, [2000, 3000, 4500]);
    assert.match(r.stdout, /Job 7 succeeded/);
    assert.match(r.stdout, /charged \$1\.20 \(held \$1\.20\)/);
    assert.match(r.stderr, /Held from your API balance: \$1\.20/);
    assert.match(r.stdout, /videos list --channel tides/);
  } finally {
    await api.close();
  }
});

test("create --wait: a failed job exits 1 and says the hold was released", async () => {
  const api = await fakeApi({
    "POST /videos": { status: 201, body: { job_id: 8, channel_id: "tides", status: "queued", price_cents: 120 } },
    "GET /jobs/8": { id: 8, channel_id: "tides", status: "failed", error: "render stopped", charge: { status: "released", held_cents: 120, captured_cents: null } },
  });
  try {
    const r = await run(["create", "--channel", "tides", "--duration", "60", "--wait"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /nothing charged \(the \$1\.20 hold was released\)/);
    assert.match(r.stdout, /render stopped/);
  } finally {
    await api.close();
  }
});

test("polling: --timeout stops waiting, 429 waits Retry-After, a flaky GET is retried", async () => {
  let polls = 0;
  const api = await fakeApi({
    "GET /jobs/9": () => {
      polls++;
      if (polls === 1) return apiError(429, "rate_limit_exceeded", "Slow.", { retry_after: 7 }, { "retry-after": "7" });
      if (polls === 2) return { status: 503, body: "down" };
      return { id: 9, channel_id: "t", status: "running", charge: null };
    },
  });
  try {
    const r = await run(["jobs", "get", "9", "--wait", "--timeout", "60"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Stopped waiting for job 9 after 60s/);
    assert.match(r.stderr, /nothing was cancelled/);
    assert.equal(r.sleeps[0], 7000, "waited out Retry-After first");
    assert.ok(polls >= 3);
  } finally {
    await api.close();
  }
});

test("jobs get without --wait is one request", async () => {
  const api = await fakeApi({ "GET /jobs/12": { id: 12, channel_id: "t", status: "running", charge: { status: "open", held_cents: 60, captured_cents: null } } });
  try {
    const r = await run(["jobs", "get", "12"], { api });
    assert.equal(r.code, 0);
    assert.equal(api.seen.length, 1);
    assert.match(r.stdout, /held \$0\.60, not charged yet/);
    assert.equal((await run(["jobs", "get", "abc"], { api })).code, 2);
  } finally {
    await api.close();
  }
});

test("videos list/get send the right query and path", async () => {
  const api = await fakeApi({
    "GET /videos": { videos: [{ id: "v1", channel_id: "tides", title: "T", review_state: "approved", publish_state: null, privacy: "private" }] },
    "GET /videos/v1": { id: "v1", channel_id: "tides", title: "T", publish_requests: [{ platform: "youtube", target_channel_id: "tides", status: "sent", reason: null }] },
  });
  try {
    let r = await run(["videos", "list", "--channel", "tides", "--limit", "5", "--offset", "10"], { api });
    assert.deepEqual(api.seen[0].query, { channel_id: "tides", limit: "5", offset: "10" });
    assert.match(r.stdout, /v1\s+tides\s+T\s+review:approved\s+publish:unknown\s+privacy:private/);
    r = await run(["videos", "get", "v1"], { api });
    assert.match(r.stdout, /youtube -> tides\s+sent/);
    assert.equal((await run(["videos", "list", "--limit", "500"], { api })).code, 2);
  } finally {
    await api.close();
  }
});

test("download request / get / save", async () => {
  const mp4 = Buffer.from("not really a video");
  const api = await fakeApi({
    "POST /videos/v1/downloads": { status: 201, body: { id: 45, status: "queued", quality: "1080p", price_cents: 26, free_reason: null, reused: false } },
    "GET /downloads/45": { id: 45, video_id: "v1", quality: "1080p", status: "ready", file_url: "/api/v1/downloads/45/file", expires_at: "2030-01-01T00:00:00Z" },
    "GET /downloads/45/file": { status: 200, raw: mp4 },
  });
  try {
    let r = await run(["download", "request", "v1", "--quality", "1080p", "--wait"], { api });
    assert.equal(r.code, 0);
    assert.deepEqual(api.seen[0].body, { quality: "1080p" });
    assert.ok(api.seen[0].headers["idempotency-key"]);
    assert.match(r.stderr, /Price: \$0\.26/);
    assert.equal((await run(["download", "request", "v1", "--quality", "4k"], { api })).code, 2);
    const { dir } = r;
    r = await run(["download", "save", "45"], { api, configDir: dir });
    assert.equal(r.code, 0);
    const { readFile } = await import("node:fs/promises");
    assert.deepEqual(await readFile(`${dir}/nightshift-download-45.mp4`), mp4);
    r = await run(["download", "save", "45"], { api, configDir: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /already exists/);
    r = await run(["download", "save", "45", "--force", "--out", "x.mp4"], { api, configDir: dir });
    assert.equal(r.code, 0);
    assert.deepEqual(await readFile(`${dir}/x.mp4`), mp4);
  } finally {
    await api.close();
  }
});

test("download save: not ready is an honest 409, and no partial file is left", async () => {
  const api = await fakeApi({ "GET /downloads/46/file": apiError(409, "download_not_ready", "The download is processing.") });
  try {
    const r = await run(["download", "save", "46"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /download_not_ready/);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual((await readdir(r.dir)).filter((f) => f.includes("46")), []);
  } finally {
    await api.close();
  }
});

test("publish: sends targets, shows reasons, never claims a public post", async () => {
  const api = await fakeApi({
    "POST /videos/v1/publish": { requests: [{ id: 1, platform: "youtube", account_id: null, target_channel_id: "tides", status: "pending", reason: "waiting for approval" }], errors: [{ account_id: "0b1c2d3e-0000-4000-8000-000000000000", error: "forbidden" }] },
    "GET /accounts": { accounts: [{ platform: "youtube", channel_id: "tides", name: "Tides", connected: true }, { platform: "tiktok", account_id: "0b1c2d3e-0000-4000-8000-000000000000", name: "t", connected: true }] },
  });
  try {
    let r = await run(["publish", "v1", "--youtube", "tides", "--account", "0b1c2d3e-0000-4000-8000-000000000000"], { api });
    assert.deepEqual(api.seen[0].body, { channel_ids: ["tides"], account_ids: ["0b1c2d3e-0000-4000-8000-000000000000"] });
    assert.match(r.stdout, /youtube -> tides: pending \(waiting for approval\)/);
    assert.match(r.stdout, /refused .*forbidden/);
    assert.match(r.stdout, /private/);
    assert.equal(r.code, 1, "a partly refused publish is not a clean success");
    assert.equal((await run(["publish", "v1"], { api })).code, 2);
    r = await run(["accounts"], { api });
    assert.match(r.stdout, /youtube\s+--youtube tides/);
    assert.match(r.stdout, /tiktok\s+--account 0b1c2d3e/);
  } finally {
    await api.close();
  }
});

test("publish refused by the gate surfaces the API's refusal (409)", async () => {
  const api = await fakeApi({ "POST /videos/v1/publish": apiError(409, "publish_refused", "No publish request could be recorded.", { errors: [{ channel_id: "tides", error: "forbidden" }] }) });
  try {
    const r = await run(["publish", "v1", "--youtube", "tides"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /publish_refused/);
    assert.match(r.stderr, /publish gate/);
  } finally {
    await api.close();
  }
});

test("quote and generate: --max-credits is required; price_changed (409) holds nothing and says so", async () => {
  const api = await fakeApi({
    "POST /creative/quote": { quote: { credits: 4.5, exempt: false, model: "m1", capability: "t2i", unit: "image", quantity: 1, credits_per_unit: 4.5, minimum: 1 } },
    "POST /creative/jobs": apiError(409, "price_changed", "The price is now higher than max_credits.", { price_credits: 6, max_credits: 5 }),
  });
  try {
    let r = await run(["quote", "--capability", "t2i", "--model", "m1", "--prompt", "a lighthouse"], { api });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Price:\s+4\.5 credits/);
    assert.deepEqual(api.seen[0].body, { capability: "t2i", params: { prompt: "a lighthouse" }, model: "m1" });
    r = await run(["generate", "--capability", "t2i", "--model", "m1", "--prompt", "x"], { api });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--max-credits is required/);
    r = await run(["generate", "--capability", "t2i", "--model", "m1", "--prompt", "x", "--max-credits", "5", "--param", "seed=3", "--param", "audio=true"], { api });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /price_changed/);
    assert.match(r.stderr, /Nothing was held/);
    const sent = api.seen.at(-1);
    assert.equal(sent.body.max_credits, 5);
    assert.deepEqual(sent.body.params, { seed: 3, audio: true, prompt: "x" });
    assert.ok(sent.headers["idempotency-key"]);
  } finally {
    await api.close();
  }
});

test("generate --wait follows the generation to completion", async () => {
  const id = "0b1c2d3e-0000-4000-8000-000000000000";
  let n = 0;
  const api = await fakeApi({
    "POST /creative/jobs": { status: 201, body: { id, capability: "t2i", model: "m1", status: "queued", quoted_credits: 4.5, charged_credits: null } },
    [`GET /creative/jobs/${id}`]: () => ({ id, capability: "t2i", model: "m1", status: ++n < 2 ? "running" : "completed", quoted_credits: 4.5, charged_credits: n < 2 ? null : 4.5, result_asset_ids: ["a-1"] }),
  });
  try {
    const r = await run(["generate", "--capability", "t2i", "--model", "m1", "--prompt", "x", "--max-credits", "5", "--wait"], { api });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /Held from your credits: 4\.5 credits \(you allowed up to 5\)/);
    assert.match(r.stdout, /Charged:\s+4\.5 credits/);
    assert.match(r.stdout, /a-1/);
  } finally {
    await api.close();
  }
});

test("a debug trace never contains the key, and an echoed key is redacted", async () => {
  const api = await fakeApi({
    "GET /me": apiError(401, "invalid_api_key", `Key ${TEST_KEY} was not accepted.`),
    "GET /balance": BALANCE,
  });
  try {
    let r = await run(["whoami", "--debug"], { api });
    assert.ok(!r.all.includes(TEST_KEY), "the key is not in any output");
    assert.ok(!r.all.includes(TEST_KEY.slice(0, 20)), "no part of it either");
    assert.match(r.all, /\[redacted\]/);
    r = await run(["balance", "--debug", "--json"], { api });
    assert.ok(!r.all.includes(TEST_KEY));
    assert.match(r.stderr, /> GET \/api\/v1\/balance/);
    assert.match(r.stderr, /< 200\s+req_test123/);
  } finally {
    await api.close();
  }
});
