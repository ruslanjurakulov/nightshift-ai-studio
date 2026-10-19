import { describe, expect, it } from "vitest";
import {
  authenticate,
  createVideo,
  getJob,
  listVideos,
  parseCreateVideo,
  publishVideo,
  requestDownload,
  type ApiCaller,
  type Rpc,
} from "@/lib/api/operations";
import { generateApiKey, hashApiKey } from "@/lib/api/keys";
import { toWire } from "@/lib/api/http";
import { en } from "@/lib/i18n/en";

function caller(answer: unknown = { ok: true, status: 200, data: {} }, over: Partial<ApiCaller> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    return typeof answer === "function" ? (answer as () => { data: unknown; error: null })() : { data: answer, error: null };
  };
  const c: ApiCaller = { keyHash: "a".repeat(64), requestId: "req_test", rpc, backend: "queue", downloads: true, ...over };
  return { c, calls };
}

describe("authentication", () => {
  it("refuses a missing or foreign bearer before any database call", async () => {
    for (const h of [null, "", "Bearer nope", "Token nsk_live_x"]) {
      const r = await authenticate(h);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const w = toWire(r.result, "req_1");
        expect(w.status).toBe(401);
        expect(w.body).toMatchObject({ error: { type: "authentication_error", code: "invalid_api_key", request_id: "req_1" } });
      }
    }
  });

  it("hashes a well-formed key and keeps nothing of the key itself", async () => {
    const { key } = generateApiKey();
    const r = await authenticate(`Bearer ${key}`);
    expect(r).toEqual({ ok: true, keyHash: await hashApiKey(key) });
  });
});

describe("POST /videos", () => {
  it("sends the key hash, never the key, with the request id, to api_create_video", async () => {
    const { c, calls } = caller({ ok: true, status: 201, data: { job_id: 1 } });
    const r = await createVideo(c, { channel_id: "my-channel", topic: " Rome ", duration: 90 });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(calls).toEqual([
      {
        fn: "api_create_video",
        args: {
          p_key_hash: c.keyHash,
          p_channel_id: "my-channel",
          p_params: { topic: "Rome", duration: 90 },
          p_idem_key: null,
          p_fingerprint: null,
          p_request_id: "req_test",
        },
      },
    ]);
  });

  it.each([
    [{ topic: "x" }, "channel_required"],
    [{ channel_id: "c", privacy: "public" }, "unknown_parameter"],
    [{ channel_id: "c", tts_model: "eleven_v3" }, "unknown_parameter"],
    [{ channel_id: "c", duration: 29 }, "invalid_params"],
    [{ channel_id: "c", duration: 90.5 }, "invalid_params"],
    // D8: the platform chooses providers; the flat API price cannot cover a caller's pick.
    [{ channel_id: "c", video_provider: "sora" }, "unknown_parameter"],
    [{ channel_id: "c", video_provider: "kling" }, "unknown_parameter"],
    [{ channel_id: "c", image_provider: "leonardo" }, "unknown_parameter"],
    [{ channel_id: "c", image_provider: " kling" }, "unknown_parameter"],
    [{ channel_id: "c", topic: "x".repeat(301) }, "invalid_params"],
    [[], "invalid_body"],
  ])("refuses %j with %s and never calls the database", async (body, code) => {
    const { c, calls } = caller();
    const r = await createVideo(c, body);
    expect(r).toMatchObject({ ok: false, status: 400, code });
    expect(calls).toEqual([]);
  });

  it("F9: a blank provider ('' or null) is tolerated and ignored, never forwarded", async () => {
    const { c, calls } = caller({ ok: true, status: 201, data: { job_id: 1 } });
    for (const blank of ["", null, "  "]) {
      const r = await createVideo(c, { channel_id: "c", video_provider: blank, image_provider: blank, topic: "Rome" });
      expect(r).toMatchObject({ ok: true });
    }
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.args.p_params).toEqual({ topic: "Rome" });
  });

  it("needs the render queue", async () => {
    const { c, calls } = caller(undefined, { backend: "actions" });
    expect(await createVideo(c, { channel_id: "c" })).toMatchObject({ status: 503, code: "queue_backend_required" });
    expect(calls).toEqual([]);
  });

  it("fingerprints an Idempotency-Key request by its parsed body, not its spelling", async () => {
    const a = caller();
    const b = caller();
    await createVideo(a.c, { channel_id: "c", topic: "x", duration: 60 }, "idem-1");
    await createVideo(b.c, { duration: 60, topic: " x ", channel_id: "c" }, "idem-1");
    expect(a.calls[0].args.p_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.calls[0].args.p_fingerprint).toBe(b.calls[0].args.p_fingerprint);
    expect(a.calls[0].args.p_idem_key).toBe("idem-1");
    const bad = caller();
    expect(await createVideo(bad.c, { channel_id: "c" }, "has space")).toMatchObject({ code: "invalid_idempotency_key" });
  });

  it("keeps the site's bounds", () => {
    expect(parseCreateVideo({ channel_id: "c", duration: 3600 })).toEqual({
      ok: true,
      channelId: "c",
      params: { duration: 3600 },
    });
  });
});

describe("F2: a job's error is a code and a sentence, never the worker log", () => {
  const LOG = "[code:provider_quota] main.py exited with code 1\nmodules.minimax_broll.VideoModelUnavailable: top up the Kling account";
  const job = (error: string | null) => ({ ok: true, status: 200, data: { id: 5, status: "failed", error, charge: null } });

  it("replaces the text with the code's sentence and adds error_code", async () => {
    const { c } = caller(job(LOG));
    const r = await getJob(c, "5");
    expect(r).toMatchObject({ ok: true, data: { id: 5, error_code: "provider_quota", error: en.create.jobError.provider_quota } });
    expect(JSON.stringify(r)).not.toMatch(/Kling|top up|exited with code|Traceback/);
  });

  it("an old failure without a code reads unknown, a job without an error stays null", async () => {
    expect(await getJob(caller(job("main.py exited with code 1")).c, "5")).toMatchObject({
      data: { error_code: "unknown", error: en.create.jobError.unknown },
    });
    expect(await getJob(caller(job(null)).c, "5")).toMatchObject({ data: { error: null, error_code: null } });
  });

  it("N1: only a FAILED job's error is explained; a re-queued or running job's operator text is dropped", async () => {
    for (const status of ["queued", "running", "cancelled", "succeeded"]) {
      const r = await getJob(caller({ ok: true, status: 200, data: { id: 5, status, error: "worker stopping before the run started" } }).c, "5");
      expect(r, status).toMatchObject({ ok: true, data: { status, error: null, error_code: null } });
    }
  });

  it("0111: an answer the database already coded (error_code present) is passed through, not re-read as uncoded", async () => {
    const coded = { id: 5, status: "failed", error: en.create.jobError.voice, error_code: "voice", charge: null };
    expect(await getJob(caller({ ok: true, status: 200, data: coded }).c, "5")).toMatchObject({ ok: true, data: coded });
    const none = { id: 5, status: "running", error: null, error_code: null, charge: null };
    expect(await getJob(caller({ ok: true, status: 200, data: none }).c, "5")).toMatchObject({ ok: true, data: none });
  });

  it("refusals pass through untouched", async () => {
    expect(await getJob(caller({ ok: false, status: 404, error: { code: "job_not_found", message: "x" } }).c, "5")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("database answers", () => {
  it("pass refusals through in the error envelope with rate headers and Retry-After", async () => {
    const { c } = caller({
      ok: false,
      status: 429,
      error: { code: "rate_limit_exceeded", message: "slow down", retry_after: 12 },
      rate: { limit: 30, remaining: 0, reset: 12 },
    });
    const w = toWire(await getJob(c, "5"), "req_9");
    expect(w.status).toBe(429);
    expect(w.headers).toMatchObject({ "retry-after": "12", "x-ratelimit-limit": "30", "x-ratelimit-remaining": "0", "x-request-id": "req_9" });
    expect(w.body).toEqual({
      error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "slow down", request_id: "req_9", retry_after: 12 },
    });
  });

  it("carry billing details on a 402", async () => {
    const { c } = caller({
      ok: false,
      status: 402,
      error: { code: "insufficient_balance", message: "top up", price_cents: 180, available_cents: 20 },
    });
    const w = toWire(await createVideo(c, { channel_id: "c" }), "req_2");
    expect(w.body).toMatchObject({ error: { type: "billing_error", code: "insufficient_balance", price_cents: 180, available_cents: 20 } });
  });

  it("say 'not set up' when 0031 is missing, and 502 on any other database error", async () => {
    const missing: Rpc = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const down: Rpc = async () => ({ data: null, error: { code: "08006", message: "connection failure" } });
    expect(await getJob({ ...caller().c, rpc: missing }, "1")).toMatchObject({ status: 503, code: "api_unavailable" });
    expect(await getJob({ ...caller().c, rpc: down }, "1")).toMatchObject({ status: 502, code: "upstream_error" });
  });

  it("treat a malformed answer as a failure, never a success", async () => {
    const { c } = caller({ ok: true });
    expect(await getJob(c, "1")).toMatchObject({ ok: false, status: 500 });
  });
});

describe("other operations", () => {
  it("validate ids and paging before the database", async () => {
    const { c, calls } = caller();
    expect(await getJob(c, "abc")).toMatchObject({ status: 404 });
    expect(await listVideos(c, { limit: "500" })).toMatchObject({ status: 400 });
    expect(await listVideos(c, { channel_id: "../x" })).toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    await listVideos(c, {});
    expect(calls[0].args).toMatchObject({ p_channel_id: null, p_limit: 20, p_offset: 0 });
  });

  it("publish needs at least one well-formed target, at most ten", async () => {
    const { c, calls } = caller();
    expect(await publishVideo(c, "vid1", {})).toMatchObject({ code: "targets_required" });
    expect(await publishVideo(c, "vid1", { account_ids: ["not-a-uuid"] })).toMatchObject({ code: "invalid_params" });
    expect(await publishVideo(c, "vid1", { channel_ids: Array.from({ length: 11 }, (_, i) => `c${i}`) })).toMatchObject({ code: "too_many_targets" });
    expect(calls).toEqual([]);
    await publishVideo(c, "vid1", { channel_ids: ["other-channel"] });
    expect(calls[0]).toMatchObject({ fn: "api_request_publish", args: { p_video_id: "vid1", p_account_ids: [], p_channel_ids: ["other-channel"] } });
  });

  it("downloads need a quality and a host that can serve the file", async () => {
    const { c } = caller();
    expect(await requestDownload(c, "vid1", { quality: "4k" })).toMatchObject({ code: "invalid_params" });
    const noVolume = caller(undefined, { downloads: false });
    expect(await requestDownload(noVolume.c, "vid1", { quality: "1080p" })).toMatchObject({ status: 503, code: "downloads_unavailable" });
    expect(noVolume.calls).toEqual([]);
  });
});
