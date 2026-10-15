import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
const OPERATOR_ORG = "00000000-0000-4000-8000-000000000001";
const NONCE = "n-0123456789abcdef";
const YT = "UC1234567890abcdefghijkl";
const YT2 = "UCzzzzzzzzzzzzzzzzzzzzzz";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

type Rpc = { name: string; args: Record<string, unknown> };
const s = {
  user: { id: "u1", email: "a@b.test" } as { id: string; email: string } | null,
  org: { supported: true, orgs: [], current: { id: ORG, name: "A", slug: "a", role: "admin", is_default: false } } as unknown,
  orgRole: { ok: true, role: "admin", orgId: ORG, source: "org" } as unknown,
  platformAdmin: true,
  rpcs: [] as Rpc[],
  takenIds: new Set<string>(),
  createError: null as { code: string } | null,
  storeError: null as { code: string; message: string } | null,
  existing: [] as unknown[],
  tokenStatusAvailable: true,
  audits: [] as { action: string; channelId?: string; detail?: Record<string, unknown> }[],
  secrets: [] as { name: string; value: string }[],
  githubConfigured: true,
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => s.user,
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      s.rpcs.push({ name, args });
      if (name === "create_channel") {
        if (s.createError) return { error: s.createError };
        if (s.takenIds.has(String(args.p_channel_id))) return { error: { code: "23505" } };
        return { error: null };
      }
      if (name === "store_channel_token") return { error: s.storeError };
      if (name === "channel_token_status") return s.tokenStatusAvailable ? { data: [], error: null } : { data: null, error: { code: "42883", message: "function does not exist" } };
      return { error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: s.existing, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => s.org }));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => (s.platformAdmin ? "admin" : null) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => s.orgRole }));
vi.mock("@/lib/server/audit", () => ({
  logAudit: async (e: { action: string; channelId?: string; detail?: Record<string, unknown> }) => void s.audits.push(e),
}));
vi.mock("@/lib/server/github-secrets", () => ({
  get isGithubConfigured() {
    return s.githubConfigured;
  },
  fetchPublicKey: async () => ({ key_id: "k", key: "pk" }),
  putSecret: async (name: string, value: string) => void s.secrets.push({ name, value }),
}));

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
delete process.env.APP_ORIGIN;

const yt = await import("../lib/server/connect-youtube");
const pending = await import("../lib/server/connect-pending");
const { encodeState, decodeState } = await import("../lib/server/google-oauth");

const ORIGIN = "https://nightshift-ai.studio";
const state = (over: Record<string, unknown> = {}) => encodeState({ ref: "", nonce: NONCE, pick: true, ...over } as never);
const cb = (q: Record<string, string>, cookie = `__Host-yt_oauth_nonce=${NONCE}`) => {
  const u = new URL(`${ORIGIN}/api/oauth/youtube/callback`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return new Request(u, { headers: cookie ? { cookie } : {} });
};
const loc = (r: Response) => new URL(r.headers.get("location") ?? "");
const cookies = (r: Response) => r.headers.getSetCookie().join("\n");

const channelsBody = (...items: object[]) => ({
  items: items.map((i) => ({ snippet: { title: "Extinct World", customUrl: "@extinctworld" }, statistics: { subscriberCount: "10", videoCount: "2" }, ...i })),
});
function fakeGoogle(opts: { token?: object; channels?: object; tokenStatus?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return opts.tokenStatus && opts.tokenStatus !== 200
        ? new Response("{}", { status: opts.tokenStatus })
        : Response.json({ access_token: "ya29.ACCESS", refresh_token: "1//REFRESH-token-value", scope: SCOPES, ...opts.token });
    if (url.startsWith("https://www.googleapis.com/youtube/v3/channels"))
      return Response.json(opts.channels ?? channelsBody({ id: YT }));
    throw new Error(`unexpected fetch ${url}`);
  });
}
/** Run start + callback and return the pending cookie value. */
async function connected(channels: object = channelsBody({ id: YT }), grantState = state()) {
  fakeGoogle({ channels });
  const res = await yt.finishYoutubePick(cb({ code: "c", state: grantState }), new URL(cb({ code: "c", state: grantState }).url), ORIGIN, decodeState(grantState)!, "u1");
  const handle = /ns_connect_pending=([^;]+)/.exec(cookies(res))?.[1];
  return { res, handle };
}

beforeEach(() => {
  vi.restoreAllMocks();
  s.user = { id: "u1", email: "a@b.test" };
  s.org = { supported: true, orgs: [], current: { id: ORG, name: "A", slug: "a", role: "admin", is_default: false } };
  s.orgRole = { ok: true, role: "admin", orgId: ORG, source: "org" };
  s.platformAdmin = true;
  s.rpcs = [];
  s.takenIds = new Set();
  s.createError = null;
  s.storeError = null;
  s.existing = [];
  s.tokenStatusAvailable = true;
  s.audits = [];
  s.secrets = [];
  s.githubConfigured = true;
  pending.dropUserPending("u1");
  pending.dropUserPending("u2");
});

describe("start", () => {
  it("sends the browser to Google's chooser with a nonce cookie and the pick flag in the state", async () => {
    const res = await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1&niche=Ancient+history`), "u1");
    const to = loc(res);
    expect(to.host).toBe("accounts.google.com");
    expect(to.searchParams.get("prompt")).toBe("select_account consent");
    expect(to.searchParams.get("scope")).toBe(SCOPES);
    const st = decodeState(to.searchParams.get("state") ?? "");
    expect(st).toMatchObject({ ref: "", pick: true, niche: "Ancient history" });
    expect(cookies(res)).toMatch(/__Host-yt_oauth_nonce=[^;]+;.*HttpOnly/is);
    expect(cookies(res)).toMatch(/__Host-yt_oauth_nonce=[^;]+;(?=.*Path=\/)(?=.*Secure)(?!.*Domain=)/is);
    expect(st?.nonce).toBe(/yt_oauth_nonce=([^;]+)/.exec(cookies(res))?.[1]);
  });
  it("changes no held state: a GET start leaves a waiting sign-in alone (a link cannot cancel it)", async () => {
    const { handle } = await connected();
    await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1`), "u1");
    expect(pending.readPending(handle, { userId: "u1", orgId: ORG })).not.toBeNull();
  });
  it("refuses before the consent screen: a non-admin of a customer organization", async () => {
    s.orgRole = { ok: false, status: 403, error: "forbidden" };
    const res = await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1`), "u1");
    expect(loc(res).host).toBe("nightshift-ai.studio");
    expect(loc(res).searchParams.get("connect")).toBe("forbidden");
    expect(cookies(res)).not.toMatch(/yt_oauth_nonce=[^;]/);
  });
  it("refuses before the consent screen: the operator's organization needs a platform admin", async () => {
    s.org = { supported: true, orgs: [], current: { id: OPERATOR_ORG, name: "Op", slug: "op", role: "admin", is_default: true } };
    s.platformAdmin = false;
    const res = await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1`), "u1");
    expect(loc(res).searchParams.get("connect")).toBe("forbidden");
  });
  it("says so instead of starting when nowhere to save the connection exists", async () => {
    s.tokenStatusAvailable = false;
    expect(loc(await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1`), "u1")).searchParams.get("connect")).toBe("token_store");
    s.org = { supported: true, orgs: [], current: { id: OPERATOR_ORG, name: "Op", slug: "op", role: "admin", is_default: true } };
    s.githubConfigured = false;
    expect(loc(await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1`), "u1")).searchParams.get("connect")).toBe("token_store");
  });
  it("refuses a workspace it cannot read, rather than guessing the weaker gate", async () => {
    s.org = { supported: false, unavailable: true, orgs: [], current: null };
    expect(loc(await yt.startYoutubePick(new Request(`${ORIGIN}/api/oauth/youtube/start?pick=1`), "u1")).searchParams.get("connect")).toBe("unavailable");
  });
});

describe("callback", () => {
  it("holds the authorisation on the server and sends the browser to the pick screen with only a handle", async () => {
    const { res, handle } = await connected(channelsBody({ id: YT }, { id: YT2, snippet: { title: "Second" } }));
    expect(loc(res).pathname).toBe("/all-channels/channels/connect");
    expect(loc(res).search).toBe("");
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing secret reaches the browser: not the URL, not any cookie value.
    expect(cookies(res)).toMatch(/__Host-ns_connect_pending=[^;]+;(?=.*Path=\/)(?=.*Secure)(?!.*Domain=)/is);
    const everything = `${res.headers.get("location")}\n${cookies(res)}`;
    expect(everything).not.toMatch(/ACCESS|REFRESH|client-secret/);
    expect(cookies(res)).toMatch(/ns_connect_pending=[^;]+;.*HttpOnly/is);
    const read = pending.readPending(handle, { userId: "u1", orgId: ORG });
    expect(read?.grant.platform === "youtube" && read.grant.candidates.map((c) => c.id)).toEqual([YT, YT2]);
  });
  it("refuses a missing or wrong nonce cookie (CSRF) and holds nothing", async () => {
    for (const cookie of ["", "__Host-yt_oauth_nonce=other-nonce-value-1234"]) {
      fakeGoogle();
      const req = cb({ code: "c", state: state() }, cookie);
      const res = await yt.finishYoutubePick(req, new URL(req.url), ORIGIN, decodeState(state())!, "u1");
      expect(loc(res).searchParams.get("connect")).toBe("bad_state");
    }
    expect(pending.pendingCount()).toBe(0);
  });
  it("reports a declined consent as denied", async () => {
    const req = cb({ error: "access_denied", state: state() });
    const res = await yt.finishYoutubePick(req, new URL(req.url), ORIGIN, decodeState(state())!, "u1");
    expect(loc(res).searchParams.get("connect")).toBe("denied");
    expect(loc(res).searchParams.get("platform")).toBe("youtube");
  });
  it("refuses a grant with no refresh token, a missing scope, or no channel, naming the remedy's word", async () => {
    for (const [opts, word] of [
      [{ token: { refresh_token: undefined } }, "no_refresh"],
      [{ token: { scope: SCOPES.split(" ").slice(0, 2).join(" ") } }, "missing_scopes"],
      [{ channels: { items: [] } }, "no_channel"],
      [{ tokenStatus: 400 }, "exchange_rejected"],
    ] as const) {
      fakeGoogle(opts);
      const req = cb({ code: "c", state: state() });
      const res = await yt.finishYoutubePick(req, new URL(req.url), ORIGIN, decodeState(state())!, "u1");
      expect(loc(res).searchParams.get("connect"), word).toBe(word);
      vi.restoreAllMocks();
    }
    expect(pending.pendingCount()).toBe(0);
    expect(s.audits.every((a) => a.action === "channel.youtube.connect_failed")).toBe(true);
  });
  it("re-checks the caller at the callback, not only at the start", async () => {
    s.orgRole = { ok: false, status: 403, error: "forbidden" };
    const req = cb({ code: "c", state: state() });
    const res = await yt.finishYoutubePick(req, new URL(req.url), ORIGIN, decodeState(state())!, "u1");
    expect(loc(res).searchParams.get("connect")).toBe("forbidden");
  });
});

describe("confirm (a customer organization: the token goes to the vault)", () => {
  it("creates the channel linked to the chosen YouTube channel, then stores the token", async () => {
    const { handle } = await connected();
    const out = await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT });
    expect(out).toEqual({ result: "connected", channelId: "extinctworld" });
    const [create, store] = s.rpcs.filter((r) => r.name !== "channel_token_status");
    expect(create.name).toBe("create_channel");
    expect(create.args).toMatchObject({
      p_channel_id: "extinctworld",
      p_org: ORG,
      p_name: "Extinct World",
      p_verified: false, // a customer channel is confirmed by the stored token, never by this call
      p_credential: { provider: "youtube", ref: "extinctworld", youtube_channel_id: YT },
    });
    expect(store.name).toBe("store_channel_token");
    expect(store.args).toMatchObject({ p_channel_id: "extinctworld", p_refresh_token: "1//REFRESH-token-value" });
    expect(store.args.p_meta).toMatchObject({ youtube_channel_id: YT });
    expect(s.audits.map((a) => a.action)).toEqual(["channel.youtube.connect"]);
    expect(s.audits[0].channelId).toBe("extinctworld");
    expect(JSON.stringify(s.audits)).not.toMatch(/REFRESH|ACCESS/);
  });
  it("is single use: a second press finds nothing and creates nothing", async () => {
    const { handle } = await connected();
    await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT });
    s.rpcs = [];
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("expired");
    expect(s.rpcs).toEqual([]);
  });
  it("never creates a channel that was not in the list Google returned", async () => {
    const { handle } = await connected();
    s.rpcs = [];
    for (const id of [YT2, "UC-not-listed", "x"]) {
      expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: id })).result).toBe("not_in_list");
    }
    expect(s.rpcs.filter((r) => r.name === "create_channel" || r.name === "store_channel_token")).toEqual([]);
    // The record survives a wrong id: the right one still works.
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("connected");
  });
  it("multi-channel guard: only the identity's first channel can take the token; another listed one is refused and nothing is created", async () => {
    const { handle } = await connected(channelsBody({ id: YT }, { id: YT2, snippet: { title: "Second" } }));
    s.rpcs = [];
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT2 })).result).toBe("other_channel");
    expect(s.rpcs.filter((r) => r.name === "create_channel" || r.name === "store_channel_token")).toEqual([]);
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("connected");
  });
  it("refuses another user holding the handle, a missing handle, and an organization switch", async () => {
    const { handle } = await connected();
    expect((await yt.confirmYoutubePick({ userId: "u2", handle, youtubeChannelId: YT })).result).toBe("expired");
    expect((await yt.confirmYoutubePick({ userId: "u1", handle: undefined, youtubeChannelId: YT })).result).toBe("expired");
    s.org = { supported: true, orgs: [], current: { id: "99999999-9999-4999-8999-999999999999", name: "B", slug: "b", role: "admin", is_default: false } };
    s.orgRole = { ok: true, role: "admin", orgId: "99999999-9999-4999-8999-999999999999", source: "org" };
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("expired");
    expect(s.rpcs.some((r) => r.name === "create_channel")).toBe(false);
  });
  it("re-checks the role at the confirm", async () => {
    const { handle } = await connected();
    s.orgRole = { ok: false, status: 403, error: "forbidden" };
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("forbidden");
    expect(s.rpcs.some((r) => r.name === "create_channel")).toBe(false);
  });
  it("shows a channel already linked here as connected and does not create a duplicate", async () => {
    s.existing = [{ channel_id: "mine", name: "Mine", credential_ref: { youtube_channel_id: YT } }];
    const { handle } = await connected();
    expect(await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).toEqual({ result: "already_connected", channelId: "mine" });
    expect(s.rpcs.some((r) => r.name === "create_channel")).toBe(false);
    const linked = await yt.linkedYoutubeChannels(ORG);
    expect(linked?.get(YT)).toEqual({ channelId: "mine", name: "Mine" });
  });
  it("tries the next id when one is taken, and says so when none is free", async () => {
    s.takenIds = new Set(["extinctworld", "extinctworld-2"]);
    let { handle } = await connected();
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).channelId).toBe("extinctworld-3");
    pending.dropUserPending("u1");
    s.takenIds = new Set(["extinctworld", ...[2, 3, 4, 5, 6].map((n) => `extinctworld-${n}`)]);
    ({ handle } = await connected());
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("id_taken");
  });
  it("keeps the channel (paused) and says the connection was not saved when the store refuses", async () => {
    s.storeError = { code: "XX000", message: "boom" };
    const { handle } = await connected();
    const out = await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT });
    expect(out).toEqual({ result: "created_not_connected", channelId: "extinctworld" });
    expect(s.audits.map((a) => a.action)).toEqual(["channel.youtube.connect_failed"]);
    // A second press must not create a second channel.
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("expired");
  });
  it("lets a failed creation be retried", async () => {
    s.createError = { code: "XX000" };
    const { handle } = await connected();
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("failed");
    s.createError = null;
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("connected");
  });
});

describe("confirm (the operator's organization: the token goes to a repository secret)", () => {
  beforeEach(() => {
    s.org = { supported: true, orgs: [], current: { id: OPERATOR_ORG, name: "Op", slug: "op", role: "admin", is_default: true } };
  });
  it("stamps the channel from the sign-in and seals the token under the channel's own secret name", async () => {
    const { handle } = await connected();
    const out = await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT });
    expect(out.result).toBe("connected");
    const create = s.rpcs.find((r) => r.name === "create_channel");
    expect(create?.args).toMatchObject({ p_org: OPERATOR_ORG, p_verified: true });
    expect(s.rpcs.some((r) => r.name === "store_channel_token")).toBe(false);
    expect(s.secrets.map((x) => x.name)).toEqual(["CHRONOS_YT_TOKEN_EXTINCTWORLD"]);
    expect(JSON.parse(s.secrets[0].value)).toMatchObject({ refresh_token: "1//REFRESH-token-value", client_id: "client-id.apps.googleusercontent.com" });
  });
  it("refuses a caller who is not a platform admin at the confirm", async () => {
    const { handle } = await connected();
    s.platformAdmin = false;
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("forbidden");
    expect(s.secrets).toEqual([]);
  });
  it("creates nothing when the repository cannot take the secret", async () => {
    const { handle } = await connected();
    s.githubConfigured = false;
    expect((await yt.confirmYoutubePick({ userId: "u1", handle, youtubeChannelId: YT })).result).toBe("not_configured");
    expect(s.rpcs.some((r) => r.name === "create_channel")).toBe(false);
  });
});
