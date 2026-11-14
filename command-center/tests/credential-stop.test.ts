import { describe, expect, it } from "vitest";
import {
  getJob,
  honestAccounts,
  honestChannels,
  honestYoutubeConnected,
  listAccounts,
  listChannels,
  type ApiCaller,
  type Rpc,
} from "@/lib/api/operations";
import { JOB_ERROR_CODES, parseJobError } from "@/lib/runBackend";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { openApiSpec } from "@/lib/api/openapi";

// 2026-11-14, render_jobs id 7: the credential preflight stopped a run because Google had revoked the channel's YouTube
// token, the customer read "Something went wrong" (error_code unknown), and list_channels / list_connected_accounts
// both still said youtube_connected: true.

function caller(answer: unknown) {
  const calls: string[] = [];
  const rpc: Rpc = async (fn) => {
    calls.push(fn);
    return { data: answer, error: null };
  };
  const c: ApiCaller = { keyHash: "a".repeat(64), requestId: "req_test", rpc, backend: "queue", downloads: true };
  return { c, calls };
}

// The worker's stored text for job 7 after this change (tools/queue_worker.py, exit 85), token text never included.
const STORED =
  "[code:channel_reconnect_required] main.py exited with code 85: the channel's YouTube connection must be reconnected; nothing was " +
  "spent and nothing was charged\n…\nERROR Credential preflight stopped the run: youtube_token_live: Google says channel default's " +
  "YouTube refresh token is expired or revoked (invalid_grant) … Press Reconnect on this channel's card";

describe("a credential stop is named, with its remedy", () => {
  it("the stored prefix parses to the code, not unknown", () => {
    expect(parseJobError(STORED).code).toBe("channel_reconnect_required");
    expect(parseJobError("[code:credentials_missing] main.py exited with code 84: x").code).toBe("credentials_missing");
  });

  it("the API's job status sends the remedy sentence and the code, never the log", async () => {
    const r = await getJob(caller({ ok: true, status: 200, data: { id: 7, status: "failed", error: STORED, charge: null } }).c, "7");
    expect(r).toMatchObject({
      ok: true,
      data: { id: 7, error_code: "channel_reconnect_required", error: en.create.jobError.channel_reconnect_required },
    });
    const text = JSON.stringify(r);
    expect(text).toContain("Reconnect YouTube for this channel on the Channels page");
    expect(text).not.toMatch(/invalid_grant|refresh token|exited with code|youtube_token_live/);
  });

  it("every language has a sentence for both codes, and none names a token or a vendor error", () => {
    for (const d of [en, ru, uz]) {
      const errors = d.create.jobError as Record<string, string>;
      for (const code of ["channel_reconnect_required", "credentials_missing"]) {
        expect(errors[code], code).toBeTruthy();
        expect(errors[code]).not.toMatch(/token|invalid_grant|GEMINI|PEXELS|API_KEY/i);
      }
    }
  });

  it("the OpenAPI job schema lists every code the worker can write", () => {
    const spec = openApiSpec("https://nightshift.test/api/v1") as unknown as { components: { schemas: { Job: { properties: { error_code: { enum: unknown[] } } } } } };
    expect(spec.components.schemas.Job.properties.error_code.enum).toEqual([...JOB_ERROR_CODES, null]);
  });
});

describe("youtube_connected says what is known, never presence as acceptance", () => {
  const NOW = "2026-11-14T10:00:00Z";
  const EARLIER = "2026-11-10T10:00:00Z";

  it("a token row with no recorded check is unknown, never true", () => {
    expect(honestYoutubeConnected(true, undefined)).toEqual({ connected: "unknown", checked_at: null });
  });

  it("no token at all is false", () => {
    expect(honestYoutubeConnected(false, undefined)).toEqual({ connected: false, checked_at: null });
  });

  it("an expired or revoked token (a dead check newer than the connection) is false, with when it was checked", () => {
    expect(honestYoutubeConnected(true, { status: "dead", checked_at: NOW, connected_at: EARLIER })).toEqual({
      connected: false,
      checked_at: NOW,
    });
    expect(honestYoutubeConnected(true, { status: "dead", checked_at: NOW, connected_at: null })).toMatchObject({ connected: false });
  });

  it("a reconnect after the dead check is a new token nobody has asked Google about: unknown, not false and not true", () => {
    expect(honestYoutubeConnected(true, { status: "dead", checked_at: EARLIER, connected_at: NOW })).toEqual({
      connected: "unknown",
      checked_at: null,
    });
  });

  it("only a live check newer than the connection is true", () => {
    expect(honestYoutubeConnected(true, { status: "live", checked_at: NOW, connected_at: EARLIER })).toEqual({ connected: true, checked_at: NOW });
    expect(honestYoutubeConnected(true, { status: "live", checked_at: EARLIER, connected_at: NOW }).connected).toBe("unknown");
  });

  it("a check Google did not answer, or a malformed one, stays unknown", () => {
    expect(honestYoutubeConnected(true, { status: "unknown", checked_at: NOW }).connected).toBe("unknown");
    expect(honestYoutubeConnected(true, { status: "live", checked_at: "yesterday" }).connected).toBe("unknown");
    expect(honestYoutubeConnected(true, "live").connected).toBe("unknown");
    expect(honestYoutubeConnected(null, { status: "live", checked_at: NOW }).connected).toBe("unknown");
  });

  it("list_channels: the database's `true` (a token row exists) goes out as unknown, with youtube_checked_at", async () => {
    const answer = {
      ok: true,
      status: 200,
      data: {
        channels: [
          { id: "default", name: "Chronos", active: true, youtube_connected: true },
          { id: "draft", name: "Draft", active: false, youtube_connected: false },
          { id: "dead", name: "Dead", active: true, youtube_connected: true, youtube_token_check: { status: "dead", checked_at: NOW } },
        ],
      },
    };
    const { c, calls } = caller(answer);
    const r = await listChannels(c);
    expect(calls).toEqual(["api_list_channels"]);
    expect(r).toMatchObject({
      ok: true,
      data: {
        channels: [
          { id: "default", youtube_connected: "unknown", youtube_checked_at: null },
          { id: "draft", youtube_connected: false, youtube_checked_at: null },
          { id: "dead", youtube_connected: false, youtube_checked_at: NOW },
        ],
      },
    });
    // The database's input to the verdict is not part of the answer.
    expect(JSON.stringify(r)).not.toContain("youtube_token_check");
    expect(JSON.stringify(r)).not.toMatch(/"youtube_connected":true/);
  });

  it("list_connected_accounts: a YouTube entry is unknown; Instagram / TikTok keep their own status", async () => {
    const answer = {
      ok: true,
      status: 200,
      data: {
        accounts: [
          { platform: "youtube", channel_id: "default", name: "Chronos", connected: true },
          { platform: "instagram", account_id: "u1", name: "ig", connected: true },
        ],
      },
    };
    const r = await listAccounts(caller(answer).c);
    expect(r).toMatchObject({
      data: {
        accounts: [
          { platform: "youtube", channel_id: "default", connected: "unknown", checked_at: null },
          { platform: "instagram", account_id: "u1", connected: true },
        ],
      },
    });
  });

  it("an error from the database passes through untouched", () => {
    const err = { ok: false as const, status: 401, code: "invalid_api_key", message: "no" };
    expect(honestChannels(err)).toBe(err);
    expect(honestAccounts(err)).toBe(err);
  });
});

describe("no code the worker writes falls through to unknown (render_jobs id 8: a held run read `unknown`)", () => {
  const job = (error: string) => ({ ok: true, status: 200, data: { id: 8, status: "failed", error, charge: null } });

  it.each(JOB_ERROR_CODES.filter((c) => c !== "unknown"))("[code:%s] reaches the API as itself, with its own sentence", async (code) => {
    const r = await getJob(caller(job(`[code:${code}] main.py exited with code 79: operator text`)).c, "8");
    expect(r).toMatchObject({ ok: true, data: { status: "failed", error_code: code, error: en.create.jobError[code] } });
    expect(en.create.jobError[code]).not.toBe(en.create.jobError.unknown);
    expect(JSON.stringify(r)).not.toContain("operator text");
  });

  it("a held job keeps status failed (a new status would leave pollers waiting forever) and says where the run is", async () => {
    const r = await getJob(caller(job("[code:held] main.py exited with code 79: the fact-check held the script")).c, "8");
    expect(r).toMatchObject({ data: { status: "failed", error_code: "held" } });
    expect(JSON.stringify(r)).toContain("Videos page");
  });
});
