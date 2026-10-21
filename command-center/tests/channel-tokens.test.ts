import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../lib/auth/roles-shared";
import type { OrgContext } from "../lib/orgs-server";

/**
 * Customer channels' YouTube connection (migration 0022): the connect routes'
 * guards, the disconnect route, and the pure helpers behind the channel page.
 *
 * What would break without these: a customer organization's viewer (or another
 * organization's admin) sealing a token onto somebody's channel; the
 * operator's GitHub-secret path changing shape or losing its platform-admin
 * gate; a refresh token reaching a redirect, a response or the audit log; a
 * half-granted consent being stored as if it could upload.
 */

vi.mock("server-only", () => ({}));

const ORG_A = "0a000000-0000-0000-0000-00000000000a";
const ORG_B = "0b000000-0000-0000-0000-00000000000b";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const REFRESH = "1//0gREFRESHTOKENfromgoogleABCDEFGHIJKLMNOP";
const ACCESS = "ya29.accesstokenfromgoogle0123456789abcdef";
const ALL_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

const state: {
  user: { id: string } | null;
  org: OrgContext;
  inScope: Set<string>;
  platformRole: Role;
  channelOrg: Record<string, string>;
  channelOrgError: { code?: string; message?: string } | null;
  storeAnswer: RpcAnswer;
  operatorStoreAnswer: RpcAnswer;
  githubConfigured: boolean;
  revokeAnswer: RpcAnswer;
  grantedScopes: string;
  refresh: string | undefined;
  youtube: { id: string; title: string } | null;
} = {
  user: null,
  org: { supported: false, orgs: [], current: null },
  inScope: new Set(),
  platformRole: "viewer",
  channelOrg: {},
  channelOrgError: null,
  storeAnswer: { data: { connected: true }, error: null },
  operatorStoreAnswer: { data: { connected: true }, error: null },
  githubConfigured: true,
  revokeAnswer: { data: true, error: null },
  grantedScopes: ALL_SCOPES.join(" "),
  refresh: REFRESH,
  youtube: { id: "UCcustomer", title: "Customer Channel" },
};

const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<RpcAnswer> => {
  if (fn === "channel_org") {
    if (state.channelOrgError) return { data: null, error: state.channelOrgError };
    return { data: state.channelOrg[args.ch as string] ?? null, error: null };
  }
  if (fn === "store_channel_token") return state.storeAnswer;
  if (fn === "store_operator_channel_token") return state.operatorStoreAnswer;
  if (fn === "revoke_channel_token") return state.revokeAnswer;
  return { data: null, error: null };
});
const putSecret = vi.fn(async () => undefined);
const exchangeCode = vi.fn(async () => ({
  access_token: ACCESS,
  refresh_token: state.refresh,
  scope: state.grantedScopes,
}));
const logAudit = vi.fn(async () => undefined);

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => ({ rpc }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => state.org, ORG_COOKIE_OPTIONS: {} }));
vi.mock("@/lib/channels-server", () => ({
  isChannelInCurrentOrg: async (id: string | null | undefined) => Boolean(id) && state.inScope.has(id as string),
}));
vi.mock("@/lib/auth/roles", async () => {
  const shared = await vi.importActual<typeof import("../lib/auth/roles-shared")>("../lib/auth/roles-shared");
  return {
    ...shared,
    resolveRole: async () => state.platformRole,
    requireRole: async (min: Role) => (shared.atLeast(state.platformRole, min) ? state.platformRole : null),
  };
});
vi.mock("@/lib/server/audit", () => ({ logAudit }));
vi.mock("@/lib/server/github-secrets", () => ({
  fetchPublicKey: async () => ({ key: "k", key_id: "1" }),
  putSecret,
  get isGithubConfigured() {
    return state.githubConfigured;
  },
}));
vi.mock("@/lib/server/google-oauth", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/google-oauth")>("../lib/server/google-oauth");
  return { ...actual, isGoogleOAuthConfigured: true, GOOGLE_CLIENT_ID: "cc-client.apps.googleusercontent.com", exchangeCode };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    state.youtube
      ? new Response(JSON.stringify({ items: [{ id: state.youtube.id, snippet: { title: state.youtube.title } }] }), {
          status: 200,
        })
      : new Response(JSON.stringify({ items: [] }), { status: 200 }),
  ),
);

const start = await import("../app/api/oauth/youtube/start/route");
const callback = await import("../app/api/oauth/youtube/callback/route");
const revoke = await import("../app/api/channels/youtube-token/revoke/route");
const helpers = await import("../lib/channel-tokens");
const { encodeState } = await import("../lib/server/google-oauth");

function org(id: string, role: Role, isDefault = false) {
  return { id, name: id, slug: id.slice(0, 4), role, is_default: isDefault };
}

/** Signed in, viewing `current` whose channels are `channels`. */
function viewing(current: ReturnType<typeof org>, channels: string[], platformRole: Role = "viewer") {
  state.user = { id: "u-me" };
  state.org = { supported: true, orgs: [current], current };
  state.inScope = new Set(channels);
  state.platformRole = platformRole;
}

function startReq(ref: string) {
  return new Request(`https://app.test/api/oauth/youtube/start?ref=${encodeURIComponent(ref)}`);
}

function callbackReq(ref: string, opts: { nonce?: string; cookie?: string; error?: string } = {}) {
  const nonce = opts.nonce ?? "n-1";
  const params = new URLSearchParams({ code: "one-time-code", state: encodeState({ ref, nonce }) });
  if (opts.error) params.set("error", opts.error);
  return new Request(`https://app.test/api/oauth/youtube/callback?${params}`, {
    headers: { cookie: `__Host-yt_oauth_nonce=${opts.cookie ?? nonce}` },
  });
}

function revokeReq(channelId: string) {
  return new Request("https://app.test/api/channels/youtube-token/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: JSON.stringify({ channel_id: channelId }),
  });
}

function storeCalls() {
  return rpc.mock.calls.filter(([fn]) => fn === "store_channel_token");
}

function operatorStoreCalls() {
  return rpc.mock.calls.filter(([fn]) => fn === "store_operator_channel_token");
}

beforeEach(() => {
  state.channelOrg = { "ch-a": ORG_A, "ch-b": ORG_B, news: DEFAULT_ORG };
  state.channelOrgError = null;
  state.storeAnswer = { data: { connected: true }, error: null };
  state.operatorStoreAnswer = { data: { connected: true }, error: null };
  state.githubConfigured = true;
  state.revokeAnswer = { data: true, error: null };
  state.grantedScopes = ALL_SCOPES.join(" ");
  state.refresh = REFRESH;
  state.youtube = { id: "UCcustomer", title: "Customer Channel" };
  rpc.mockClear();
  putSecret.mockClear();
  exchangeCode.mockClear();
  logAudit.mockClear();
});

describe("start — who may begin the consent", () => {
  it("lets a customer organization's admin connect their own channel", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const res = await start.GET(startReq("ch-a"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(res.headers.get("set-cookie")).toContain("__Host-yt_oauth_nonce=");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("refuses the organization's viewer before Google is ever asked", async () => {
    viewing(org(ORG_A, "viewer"), ["ch-a"]);
    const res = await start.GET(startReq("ch-a"));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("answers not found to another organization's admin", async () => {
    viewing(org(ORG_B, "owner"), ["ch-b"]);
    expect((await start.GET(startReq("ch-a"))).status).toBe(404);
  });

  it("keeps the operator's channels a platform-admin action, as before", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "viewer");
    expect((await start.GET(startReq("news"))).status).toBe(403);
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    expect((await start.GET(startReq("news"))).status).toBe(307);
  });

  it("treats a pre-0018 deployment (no channel_org) as the operator's path", async () => {
    state.channelOrgError = { code: "PGRST202", message: "Could not find the function" };
    viewing(org(ORG_A, "admin"), ["ch-a"], "viewer");
    expect((await start.GET(startReq("ch-a"))).status).toBe(403);
  });

  it("fails closed when the organization lookup errors", async () => {
    state.channelOrgError = { code: "57014", message: "timeout" };
    viewing(org(ORG_A, "admin"), ["ch-a"], "admin");
    expect((await start.GET(startReq("ch-a"))).status).toBe(503);
  });

  it("still needs a signed-in user", async () => {
    state.user = null;
    expect((await start.GET(startReq("ch-a"))).status).toBe(401);
  });
});

describe("callback — customer channel into Vault", () => {
  it("stores the refresh token through store_channel_token, as the signed-in admin", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const res = await callback.GET(callbackReq("ch-a"));
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://app.test/all-channels/channels?yt=connected");
    const [[, args]] = storeCalls();
    expect(args).toMatchObject({
      p_channel_id: "ch-a",
      p_refresh_token: REFRESH,
      p_meta: {
        youtube_channel_id: "UCcustomer",
        youtube_channel_title: "Customer Channel",
        oauth_client_id: "cc-client.apps.googleusercontent.com",
      },
    });
    expect((args as { p_meta: { scopes: string[] } }).p_meta.scopes).toEqual([...ALL_SCOPES].sort());
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("never lets a token reach the redirect, the cookie or the audit log", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const res = await callback.GET(callbackReq("ch-a"));
    const visible = [res.headers.get("location"), res.headers.get("set-cookie"), JSON.stringify(logAudit.mock.calls)].join(
      " ",
    );
    expect(visible).not.toContain(REFRESH);
    expect(visible).not.toContain(ACCESS);
    expect(res.headers.get("set-cookie")).toContain("__Host-yt_oauth_nonce=;");
  });

  it("drops scopes Google adds from earlier grants, which 0022 would refuse", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.grantedScopes = [...ALL_SCOPES, "openid", "https://www.googleapis.com/auth/userinfo.email"].join(" ");
    await callback.GET(callbackReq("ch-a"));
    const [[, args]] = storeCalls();
    expect((args as { p_meta: { scopes: string[] } }).p_meta.scopes).toEqual([...ALL_SCOPES].sort());
  });

  it("refuses a CSRF nonce mismatch before exchanging the code", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const res = await callback.GET(callbackReq("ch-a", { nonce: "n-1", cookie: "n-2" }));
    expect(res.headers.get("location")).toContain("yt=bad_state");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(storeCalls()).toHaveLength(0);
  });

  it("refuses a missing nonce cookie", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const params = new URLSearchParams({ code: "c", state: encodeState({ ref: "ch-a", nonce: "n-1" }) });
    const res = await callback.GET(new Request(`https://app.test/api/oauth/youtube/callback?${params}`));
    expect(res.headers.get("location")).toContain("yt=bad_state");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("re-checks the role: the state is only a claim", async () => {
    viewing(org(ORG_A, "viewer"), ["ch-a"]);
    const res = await callback.GET(callbackReq("ch-a"));
    expect(res.headers.get("location")).toContain("yt=forbidden");
    expect(exchangeCode).not.toHaveBeenCalled();
    viewing(org(ORG_B, "owner"), ["ch-b"]);
    expect((await callback.GET(callbackReq("ch-a"))).headers.get("location")).toContain("yt=not_found");
    expect(storeCalls()).toHaveLength(0);
  });

  it("stores nothing when a required permission was unticked", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.grantedScopes = ALL_SCOPES.filter((s) => !s.endsWith("youtube.upload")).join(" ");
    const res = await callback.GET(callbackReq("ch-a"));
    expect(res.headers.get("location")).toContain("yt=missing_scopes");
    expect(storeCalls()).toHaveLength(0);
  });

  it("stores nothing without a refresh token or without a YouTube channel", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.refresh = undefined;
    expect((await callback.GET(callbackReq("ch-a"))).headers.get("location")).toContain("yt=no_refresh");
    state.refresh = REFRESH;
    state.youtube = null;
    expect((await callback.GET(callbackReq("ch-a"))).headers.get("location")).toContain("yt=no_channel");
    expect(storeCalls()).toHaveLength(0);
  });

  it("reports the database's wrong-channel refusal by name", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.storeAnswer = { data: null, error: { code: "22023", message: "wrong_youtube_channel: …" } };
    expect((await callback.GET(callbackReq("ch-a"))).headers.get("location")).toContain("yt=wrong_channel");
  });

  it("says 0022 is missing instead of claiming success", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.storeAnswer = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect((await callback.GET(callbackReq("ch-a"))).headers.get("location")).toContain("yt=not_available");
  });
});

describe("callback — the operator's own channels (migration 0115)", () => {
  it("seals the token into Vault through the operator function for a platform admin, never into a GitHub secret", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    const res = await callback.GET(callbackReq("news"));
    expect(res.headers.get("location")).toBe("https://app.test/all-channels/channels?yt=connected");
    const [[, args]] = operatorStoreCalls();
    expect(args).toMatchObject({
      p_channel_id: "news",
      p_refresh_token: REFRESH,
      p_meta: { youtube_channel_id: "UCcustomer", oauth_client_id: "cc-client.apps.googleusercontent.com" },
    });
    expect((args as { p_meta: { scopes: string[] } }).p_meta.scopes).toEqual([...ALL_SCOPES].sort());
    expect(putSecret).not.toHaveBeenCalled();
    expect(storeCalls()).toHaveLength(0);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.youtube.connect", channelId: "news", detail: expect.objectContaining({ store: "vault", operator: true }) }),
    );
  });

  it("never lets a token reach the redirect, the cookie or the audit log", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    const res = await callback.GET(callbackReq("news"));
    const visible = [res.headers.get("location"), res.headers.get("set-cookie"), JSON.stringify(logAudit.mock.calls)].join(" ");
    expect(visible).not.toContain(REFRESH);
    expect(visible).not.toContain(ACCESS);
  });

  it("refuses an organization admin with no platform role before Google is asked, and stores nothing anywhere", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "viewer");
    const res = await callback.GET(callbackReq("news"));
    expect(res.headers.get("location")).toBe("https://app.test/all-channels/channels?yt=forbidden");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putSecret).not.toHaveBeenCalled();
    expect(operatorStoreCalls()).toHaveLength(0);
  });

  it("refuses a customer organization's admin who names an operator channel, at the start and at the callback", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"], "viewer");
    expect((await start.GET(startReq("news"))).status).toBe(403);
    const res = await callback.GET(callbackReq("news"));
    expect(res.headers.get("location")).toContain("yt=forbidden");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(operatorStoreCalls()).toHaveLength(0);
    expect(storeCalls()).toHaveLength(0);
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("does not take the operator path for a customer's channel, whoever asks (a platform admin included)", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"], "admin");
    await callback.GET(callbackReq("ch-a"));
    expect(operatorStoreCalls()).toHaveLength(0);
    expect(storeCalls()).toHaveLength(1);
  });

  it("reads the store from the database, never from the state: a state claiming another ref changes nothing", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    const params = new URLSearchParams({
      code: "c",
      state: Buffer.from(JSON.stringify({ ref: "news", nonce: "n-1", store: "github", operator: false, pick: false }), "utf8").toString("base64url"),
    });
    const res = await callback.GET(new Request(`https://app.test/api/oauth/youtube/callback?${params}`, { headers: { cookie: "__Host-yt_oauth_nonce=n-1" } }));
    expect(res.headers.get("location")).toContain("yt=connected");
    expect(operatorStoreCalls()).toHaveLength(1);
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("falls back to the GitHub secret, as before 0115, only when the function is missing and GitHub is configured", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    state.operatorStoreAnswer = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await callback.GET(callbackReq("news"));
    expect(res.headers.get("location")).toBe("https://app.test/all-channels/channels?yt=connected");
    expect(putSecret).toHaveBeenCalledTimes(1);
    expect((putSecret.mock.calls[0] as unknown[])[0]).toBe("CHRONOS_YT_TOKEN_NEWS");
    expect(exchangeCode).toHaveBeenCalledTimes(1);            // the one-time code is exchanged once
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ store: "github" }) }));
    putSecret.mockClear();
    state.githubConfigured = false;
    const res2 = await callback.GET(callbackReq("news"));
    expect(res2.headers.get("location")).toContain("yt=not_available");
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("falls back for no other refusal: wrong YouTube channel, not a platform admin in the database, a failure", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    for (const [error, word] of [
      [{ code: "22023", message: "wrong_youtube_channel: …" }, "wrong_channel"],
      [{ code: "42501", message: "only the platform owner or an admin may connect an operator channel" }, "forbidden"],
      [{ code: "XX000", message: "boom" }, "failed"],
    ] as const) {
      state.operatorStoreAnswer = { data: null, error };
      const res = await callback.GET(callbackReq("news"));
      expect(res.headers.get("location")).toContain(`yt=${word}`);
    }
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("stores nothing when a permission was unticked, without a refresh token, or without a YouTube channel", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    state.grantedScopes = ALL_SCOPES.filter((s) => !s.endsWith("youtube.upload")).join(" ");
    expect((await callback.GET(callbackReq("news"))).headers.get("location")).toContain("yt=missing_scopes");
    state.grantedScopes = ALL_SCOPES.join(" ");
    state.refresh = undefined;
    expect((await callback.GET(callbackReq("news"))).headers.get("location")).toContain("yt=no_refresh");
    state.refresh = REFRESH;
    state.youtube = null;
    expect((await callback.GET(callbackReq("news"))).headers.get("location")).toContain("yt=no_channel");
    expect(operatorStoreCalls()).toHaveLength(0);
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("checks the CSRF nonce before exchanging the code", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), ["news"], "admin");
    const res = await callback.GET(callbackReq("news", { nonce: "n-1", cookie: "n-2" }));
    expect(res.headers.get("location")).toContain("yt=bad_state");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("keeps the GitHub path for a ref that is no channel of the operator's, as before", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), [], "admin");
    const res = await callback.GET(callbackReq("ghost"));
    expect(res.headers.get("location")).toBe("https://app.test/ghost/providers?yt=connected");
    expect((putSecret.mock.calls[0] as unknown[])[0]).toBe("CHRONOS_YT_TOKEN_GHOST");
    expect(operatorStoreCalls()).toHaveLength(0);
  });

  it("refuses an organization admin with no platform role on the legacy ref too, as before", async () => {
    viewing(org(DEFAULT_ORG, "admin", true), [], "viewer");
    const res = await callback.GET(callbackReq("ghost"));
    expect(res.headers.get("location")).toBe("https://app.test/default/providers?yt=forbidden");
    expect(putSecret).not.toHaveBeenCalled();
  });
});

describe("disconnect", () => {
  it("revokes through revoke_channel_token and points at Google's permissions page", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const res = await revoke.POST(revokeReq("ch-a"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      revoked: true,
      google_permissions_url: "https://myaccount.google.com/permissions",
    });
    expect(rpc).toHaveBeenCalledWith("revoke_channel_token", { p_channel_id: "ch-a" });
  });

  it("is refused to a viewer, to another organization, and for the operator's channels", async () => {
    viewing(org(ORG_A, "viewer"), ["ch-a"]);
    expect((await revoke.POST(revokeReq("ch-a"))).status).toBe(403);
    viewing(org(ORG_B, "admin"), ["ch-b"]);
    expect((await revoke.POST(revokeReq("ch-a"))).status).toBe(404);
    viewing(org(DEFAULT_ORG, "owner", true), ["news"], "owner");
    expect((await revoke.POST(revokeReq("news"))).status).toBe(400);
    expect(rpc.mock.calls.some(([fn]) => fn === "revoke_channel_token")).toBe(false);
  });
});

describe("operator panel state — what the bot reported", () => {
  const token = (over: Partial<import("../lib/channel-tokens").ChannelTokenStatus> = {}) =>
    ({
      channel_id: "default",
      connected: true,
      youtube_channel_id: "UC1",
      youtube_channel_title: "Chronos",
      google_account_email: null,
      scopes: [],
      connected_at: "2026-10-21T10:00:00Z",
      connected_by_email: null,
      revoked_at: null,
      ...over,
    }) as import("../lib/channel-tokens").ChannelTokenStatus;
  const health = (ts: string, status: string, as: "object" | "text" = "object") => {
    const meta = { channel_id: "default", checks: [{ name: "gemini", status: "ok" }, { name: "youtube_token_live", status }] };
    return { channel_id: "default", event: "credential.health", ts, metadata: as === "text" ? JSON.stringify(meta) : meta };
  };

  it("reads the newest live verdict from object or text metadata, skipping events without the check", () => {
    const m = helpers.latestLiveVerdicts([
      health("2026-10-20T22:00:00Z", "missing"),
      health("2026-10-18T22:00:00Z", "ok", "text"),
      { channel_id: "default", event: "credential.health", ts: "2026-10-21T01:00:00Z", metadata: { checks: [{ name: "gemini", status: "ok" }] } },
      { channel_id: "other", event: "run.started", ts: "2026-10-21T01:00:00Z", metadata: null },
      { channel_id: null, event: "credential.health", ts: "2026-10-21T01:00:00Z", metadata: "not json" },
    ]);
    expect(m.get("default")).toEqual({ ts: "2026-10-20T22:00:00Z", dead: true });
    expect(m.size).toBe(1);
    expect(helpers.latestLiveVerdicts([health("2026-10-19T00:00:00Z", "ok", "text")]).get("default")?.dead).toBe(false);
  });

  it("is expired when the bot's live check found the token dead after it was connected", () => {
    const dead = { ts: "2026-10-22T01:00:00Z", dead: true };
    expect(helpers.operatorYoutubeState({ token: token(), credentialStatus: undefined, live: dead })).toBe("expired");
    expect(helpers.operatorYoutubeState({ token: null, credentialStatus: "connected", live: dead })).toBe("expired");
  });

  it("reads connected after a reconnect that is newer than the failure, until the bot says otherwise", () => {
    const old = { ts: "2026-10-20T22:50:00Z", dead: true };
    expect(helpers.operatorYoutubeState({ token: token(), credentialStatus: undefined, live: old })).toBe("connected");
  });

  it("is connected from a live token, an active Vault row, or the bot's sight of the old secret; else not connected", () => {
    expect(helpers.operatorYoutubeState({ token: token(), credentialStatus: undefined, live: { ts: "2026-10-22T00:00:00Z", dead: false } })).toBe("connected");
    expect(helpers.operatorYoutubeState({ token: null, credentialStatus: "connected", live: undefined })).toBe("connected");
    expect(helpers.operatorYoutubeState({ token: null, credentialStatus: undefined, live: undefined })).toBe("not_connected");
    expect(helpers.operatorYoutubeState({ token: token({ connected: false, revoked_at: "2026-10-01T00:00:00Z" }), credentialStatus: "not_connected", live: undefined })).toBe("not_connected");
    expect(helpers.operatorYoutubeState({ token: null, credentialStatus: "expired", live: undefined })).toBe("expired");
  });

  it("offers an operator Connect / Reconnect but never Disconnect, and only to an admin", () => {
    const base = { oauthConfigured: true, available: true, connected: true, operator: true };
    expect(helpers.tokenPanelActions({ ...base, role: "admin" })).toEqual({ connect: true, disconnect: false });
    expect(helpers.tokenPanelActions({ ...base, role: "viewer" })).toEqual({ connect: false, disconnect: false });
    expect(helpers.tokenPanelActions({ ...base, role: "admin", operator: false })).toEqual({ connect: true, disconnect: true });
  });

  it("knows the operator's organization and nothing else", () => {
    expect(helpers.isOperatorOrg(DEFAULT_ORG)).toBe(true);
    for (const v of [ORG_A, null, undefined, ""]) expect(helpers.isOperatorOrg(v)).toBe(false);
  });
});

describe("helpers", () => {
  it("decides the store from the channel's organization", () => {
    expect(helpers.decideTokenStore({ orgId: ORG_A })).toEqual({ mode: "vault", orgId: ORG_A });
    expect(helpers.decideTokenStore({ orgId: DEFAULT_ORG })).toEqual({ mode: "github" });
    expect(helpers.decideTokenStore({ orgId: null })).toEqual({ mode: "github" });
    expect(helpers.decideTokenStore({ orgId: null, missingFunction: true, failed: true })).toEqual({ mode: "github" });
    expect(helpers.decideTokenStore({ orgId: null, failed: true })).toEqual({ mode: "unavailable" });
  });

  it("coerces status rows and drops ones without a channel", () => {
    const rows = helpers.coerceTokenStatuses([
      { channel_id: "ch-a", connected: true, scopes: ["a", 3], youtube_channel_title: "T" },
      { connected: true },
      "junk",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: "ch-a", connected: true, scopes: ["a"], youtube_channel_title: "T" });
    expect(helpers.coerceTokenStatuses(null)).toEqual([]);
  });

  it("names the missing scopes", () => {
    expect(helpers.missingScopes(ALL_SCOPES.slice(1), ALL_SCOPES)).toEqual([ALL_SCOPES[0]]);
    expect(helpers.shortScope(ALL_SCOPES[0])).toBe("youtube.upload");
  });

  it("offers Connect/Disconnect to admins only, and only when it can work", () => {
    const base = { oauthConfigured: true, available: true, connected: true };
    expect(helpers.tokenPanelActions({ ...base, role: "admin" })).toEqual({ connect: true, disconnect: true });
    expect(helpers.tokenPanelActions({ ...base, role: "editor" })).toEqual({ connect: false, disconnect: false });
    expect(helpers.tokenPanelActions({ ...base, role: "owner", oauthConfigured: false })).toEqual({
      connect: false,
      disconnect: true,
    });
    expect(helpers.tokenPanelActions({ ...base, role: "owner", available: false })).toEqual({
      connect: false,
      disconnect: false,
    });
    expect(helpers.tokenPanelActions({ ...base, role: "admin", connected: false }).disconnect).toBe(false);
  });

  it("only renders result words it knows", () => {
    expect(helpers.parseVaultResult("connected")).toBe("connected");
    expect(helpers.parseVaultResult("<script>")).toBeNull();
    expect(helpers.parseVaultResult(undefined)).toBeNull();
  });

  it("maps store errors without reading anything else from them", () => {
    expect(helpers.storeErrorResult({ code: "42501", message: "x" })).toBe("forbidden");
    expect(helpers.storeErrorResult({ code: "22023", message: "wrong_youtube_channel: y" })).toBe("wrong_channel");
    expect(helpers.storeErrorResult({ code: "42883", message: "" })).toBe("not_available");
    expect(helpers.storeErrorResult({ code: "22023", message: "invalid refresh token" })).toBe("failed");
  });

  it("has a message for every result word in every language", async () => {
    const { en } = await import("../lib/i18n/en");
    const { ru } = await import("../lib/i18n/ru");
    const { uz } = await import("../lib/i18n/uz");
    for (const dict of [en, ru, uz])
      for (const r of helpers.VAULT_RESULTS) expect(dict.channelTokens.results[r]).toBeTruthy();
  });
});
