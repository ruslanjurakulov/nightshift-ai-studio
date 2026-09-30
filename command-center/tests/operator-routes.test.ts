import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../lib/orgs-server";

/**
 * C7 / C8: routes that read the platform operator's configuration or spend
 * the operator's ElevenLabs characters and Actions minutes.
 *
 * What would break without these: any account that signed up reading which
 * GitHub repository, pipeline providers and alert channels the operator uses;
 * a customer organization's admin burning the operator's ElevenLabs quota and
 * Actions minutes on voice previews for free; and the voice list serving as a
 * free "is this ElevenLabs key valid / out of characters?" oracle.
 *
 * The database is faked at the edges the routes consult: the session, the
 * org context (my_organizations), is_platform_admin, take_web_rate and the
 * previews bucket.
 */

vi.mock("server-only", () => ({}));

const state: {
  user: { id: string; email?: string } | null;
  org: OrgContext;
  platformAdmin: boolean;
  rate: { data: unknown; error: { code?: string; message?: string } | null };
  clipExists: boolean;
} = {
  user: null,
  org: { supported: true, orgs: [], current: null },
  platformAdmin: false,
  rate: { data: true, error: null },
  clipExists: false,
};

const rpcCalls: { fn: string; args: unknown }[] = [];
const dispatchWorkflow = vi.fn(async () => undefined);
const readVariables = vi.fn(async () => ({ NIGHTSHIFT_VIDEO_PROVIDER: "higgsfield" }));
const listConfiguredSecretNames = vi.fn(async () => ["SLACK_WEBHOOK_URL"]);
const fetchMock = vi.fn(async () => Response.json({ voices: [{ voice_id: "abcdefghijklmnopqrst", name: "Adam" }] }));

const fakeClient = {
  rpc: async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
    if (fn === "take_web_rate") return state.rate;
    return { data: null, error: null };
  },
  storage: {
    from: () => ({
      createSignedUrl: async () =>
        state.clipExists ? { data: { signedUrl: "https://x.supabase.co/signed" }, error: null } : { data: null, error: { message: "not found" } },
    }),
  },
};

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => fakeClient,
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => state.org,
  ORG_COOKIE_OPTIONS: {},
}));
vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => true }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/github-secrets", () => ({
  GITHUB_REPO: "owner/bot",
  isGithubConfigured: true,
  isWritableSecretName: () => true,
  fetchPublicKey: async () => ({}),
  putSecret: async () => "created",
  listConfiguredSecretNames,
  dispatchDailyVideo: async () => undefined,
  dispatchWorkflow,
}));
vi.mock("@/lib/server/github-variables", () => ({
  readVariables,
  putVariable: async () => undefined,
  isWritableVariable: () => true,
}));

vi.stubGlobal("fetch", fetchMock);

const secrets = await import("../app/api/setup/secrets/route");
const variables = await import("../app/api/setup/variables/route");
const alerts = await import("../app/api/alerts/test/route");
const run = await import("../app/api/agent/run/route");
const voices = await import("../app/api/setup/voices/route");
const preview = await import("../app/api/voices/preview/route");
const { takeLocal } = await import("../lib/server/web-rate");

const CUSTOMER_ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const VOICE = "abcdefghijklmnopqrst";

/** A customer who signed up and owns their own organization. */
function customerAdmin() {
  state.user = { id: "u-bob" };
  state.org = { supported: true, orgs: [CUSTOMER_ORG], current: CUSTOMER_ORG };
  state.platformAdmin = false;
}

/** Signed up, no organization at all. */
function stranger() {
  state.user = { id: "u-sam" };
  state.org = { supported: true, orgs: [], current: null };
  state.platformAdmin = false;
}

function operator() {
  state.user = { id: "u-op" };
  state.org = { supported: true, orgs: [CUSTOMER_ORG], current: CUSTOMER_ORG };
  state.platformAdmin = true;
}

function post(body: unknown) {
  return new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.user = null;
  state.rate = { data: true, error: null };
  state.clipExists = false;
  rpcCalls.length = 0;
  dispatchWorkflow.mockClear();
  readVariables.mockClear();
  listConfiguredSecretNames.mockClear();
  fetchMock.mockClear();
});

describe("C7: the operator's configuration is the operator's", () => {
  const reads = [
    ["GET /api/setup/secrets", () => secrets.GET()],
    ["GET /api/setup/variables", () => variables.GET()],
    ["GET /api/alerts/test", () => alerts.GET()],
  ] as const;

  it.each(reads)("%s refuses a customer organization's admin", async (_name, call) => {
    customerAdmin();
    const res = await call();
    expect(res.status).toBe(403);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("owner/bot");
    expect(body).not.toContain("higgsfield");
    expect(readVariables).not.toHaveBeenCalled();
    expect(listConfiguredSecretNames).not.toHaveBeenCalled();
  });

  it.each(reads)("%s refuses a signed-in stranger and a signed-out visitor", async (_name, call) => {
    stranger();
    expect((await call()).status).toBe(403);
    state.user = null;
    expect((await call()).status).toBe(401);
  });

  it.each(reads)("%s still answers the operator", async (_name, call) => {
    operator();
    expect((await call()).status).toBe(200);
  });

  it("GET /api/agent/run answers a member of the org being viewed, not an account with no org", async () => {
    stranger();
    expect((await run.GET()).status).toBe(403);
    customerAdmin();
    expect((await run.GET()).status).toBe(200);
    operator();
    state.org = { supported: true, orgs: [], current: null };
    expect((await run.GET()).status).toBe(200);
  });
});

describe("C8: nobody but the operator spends the operator's ElevenLabs quota", () => {
  it("the voice list refuses a customer admin before any ElevenLabs call", async () => {
    customerAdmin();
    const res = await voices.POST(post({ apiKey: "sk_someone_elses_key" }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the voice list serves the operator, and counts each call against the rate limit", async () => {
    operator();
    const res = await voices.POST(post({ apiKey: "sk_operator" }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rpcCalls.find((c) => c.fn === "take_web_rate")?.args).toMatchObject({ p_bucket: "elevenlabs.voices" });
  });

  it("the voice list stops at the rate limit without calling ElevenLabs", async () => {
    operator();
    state.rate = { data: false, error: null };
    const res = await voices.POST(post({ apiKey: "sk_operator" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unknown rate count is not permission to spend", async () => {
    operator();
    state.rate = { data: null, error: { code: "08006", message: "connection failure" } };
    expect((await voices.POST(post({ apiKey: "sk_operator" }))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a voice preview refuses a customer admin of the channel's own org", async () => {
    customerAdmin();
    const res = await preview.POST(post({ voice_id: VOICE, channel_id: "chan-b" }));
    expect(res.status).toBe(403);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("a voice preview is dispatched for the operator, once per rate window allowance", async () => {
    operator();
    expect((await preview.POST(post({ voice_id: VOICE }))).status).toBe(200);
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    state.rate = { data: false, error: null };
    expect((await preview.POST(post({ voice_id: VOICE }))).status).toBe(429);
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it("a clip that already exists is never prepared (paid for) again", async () => {
    operator();
    state.clipExists = true;
    const res = await preview.POST(post({ voice_id: VOICE }));
    expect(await res.json()).toEqual({ queued: false, ready: true });
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.fn === "take_web_rate")).toBe(false);
  });

  it("anyone signed in still hears a clip that exists", async () => {
    customerAdmin();
    state.clipExists = true;
    const res = await preview.GET(new Request(`http://test.local/api/voices/preview?voice_id=${VOICE}`));
    expect(await res.json()).toMatchObject({ ready: true });
  });

  it("before migration 0042 the limit still holds, per process", async () => {
    operator();
    state.rate = { data: null, error: { code: "PGRST202", message: "Could not find the function public.take_web_rate" } };
    for (let i = 0; i < 10; i++) expect((await preview.POST(post({ voice_id: VOICE }))).status).toBe(200);
    expect((await preview.POST(post({ voice_id: VOICE }))).status).toBe(429);
  });

  it("the in-process fallback resets with the window and keeps users apart", () => {
    const rule = { bucket: "t.local", max: 2, windowSeconds: 60 };
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    expect([takeLocal("a", rule, t0), takeLocal("a", rule, t0), takeLocal("a", rule, t0)]).toEqual([true, true, false]);
    expect(takeLocal("b", rule, t0)).toBe(true);
    expect(takeLocal("a", rule, t0 + 60_000)).toBe(true);
  });
});
