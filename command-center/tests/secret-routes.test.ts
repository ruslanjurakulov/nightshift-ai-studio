import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../lib/orgs-server";

/**
 * The GitHub secret and variable routes (ledger BR-S-020): a value is checked against its NAME before anything is
 * sent to GitHub, writes are rate limited, `enforce` asks for a recent code, and every written name leaves a log line
 * with the name and the outcome and nothing derived from the value. What would break without these: a typed value that swaps the
 * alert address or Slack URL, a Google token JSON that sends the refresh token elsewhere, a `$` that makes every deploy
 * fail, a stolen session looping over the allow-list, an old stolen aal2 cookie rewriting credentials.
 */

vi.mock("server-only", () => ({}));

type Factor = { status: string; factor_type: string };
const state: {
  user: { id: string; factors?: Factor[] } | null;
  org: OrgContext;
  aal: string;
  amr: Array<{ method: string; timestamp: number }> | undefined;
} = { user: null, org: { supported: true, orgs: [], current: null }, aal: "aal1", amr: undefined };

const put = vi.fn();
const fakeClient = {
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel: async () => ({
        data: { currentLevel: state.aal, currentAuthenticationMethods: state.amr },
        error: null,
      }),
    },
  },
  rpc: async (fn: string) => {
    if (fn === "is_platform_admin") return { data: true, error: null };
    if (fn === "bind_current_member") return { data: "owner", error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => state.user, createClient: async () => fakeClient }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => state.org, ORG_COOKIE_OPTIONS: {} }));
vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => true }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/server/audit", () => ({ logAudit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/server/github-secrets", () => ({
  GITHUB_REPO: "owner/bot",
  isGithubConfigured: true,
  isWritableSecretName: (n: string) => /^[A-Z0-9_]+$/.test(n),
  fetchPublicKey: async () => ({ key_id: "k", key: "x" }),
  putSecret: async (name: string, value: string) => {
    put("secret", name, value);
    return "updated";
  },
  listConfiguredSecretNames: async () => [],
}));
vi.mock("@/lib/server/github-variables", () => ({
  readVariables: async () => ({}),
  putVariable: async (name: string, value: string) => {
    put("variable", name, value);
  },
  isWritableVariable: (n: string) => /^(CHRONOS_|ALERT_EMAIL_)/.test(n),
}));

const secrets = (await import("../app/api/setup/secrets/route")).POST;
const variables = (await import("../app/api/setup/variables/route")).POST;
const youtube = (await import("../app/api/setup/youtube/route")).POST;
const { SECRET_WRITE_RATE } = await import("../lib/server/secret-write");

const ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const VERIFIED: Factor[] = [{ status: "verified", factor_type: "totp" }];
// Assembled from parts so a push scanner does not mistake the fixture for a live webhook.
const SLACK_PATH = ["services", "T01ABCDEF", "B01ABCDEF", "abcdefghijklmnopqrstuvwx"].join("/");
const SLACK = `https://hooks.slack.com/${SLACK_PATH}`;
const NOW_S = Math.floor(Date.now() / 1000);

let n = 0;
function admin(factors: Factor[] = [], aal = "aal1", amr?: typeof state.amr) {
  // a fresh id per test: the rate limit is per person, per process
  state.user = { id: `u-admin-${String(++n).padStart(8, "0")}`, factors };
  state.org = { supported: true, orgs: [ORG], current: ORG };
  state.aal = aal;
  state.amr = amr;
}
function req(path: string, body: unknown, headers: Record<string, string> = { origin: "https://app.test" }) {
  return new Request(`https://app.test/api/setup/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.user = null;
  state.aal = "aal1";
  state.amr = undefined;
  put.mockClear();
  audit.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "");
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  info.mockClear();
});

describe("POST /api/setup/secrets: values are checked against their name", () => {
  it("a good Slack webhook is written, trimmed, with an audit row that has names only", async () => {
    admin();
    const res = await secrets(req("secrets", { secrets: { SLACK_WEBHOOK_URL: `  ${SLACK} ` } }));
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith("secret", "SLACK_WEBHOOK_URL", SLACK);
    expect(audit).toHaveBeenCalledWith({ action: "secret.write", detail: { names: ["SLACK_WEBHOOK_URL"] } });
  });

  it.each([
    ["Slack on another host", { SLACK_WEBHOOK_URL: `https://evil.example/${SLACK_PATH}` }, "SLACK_WEBHOOK_URL", "bad_host"],
    ["a dollar in a key", { GEMINI_API_KEY: "abcdefgh$HOME" }, "GEMINI_API_KEY", "forbidden_chars"],
    ["a line break in a key", { PEXELS_API_KEY: "abcdefgh\nXYZ=1" }, "PEXELS_API_KEY", "control_chars"],
    ["a Resend key of the wrong shape", { RESEND_API_KEY: "not-a-resend-key" }, "RESEND_API_KEY", "bad_shape"],
    ["a token JSON naming another token endpoint", { YOUTUBE_TOKEN_JSON: JSON.stringify({ refresh_token: "r", token_uri: "https://evil.example/t" }) }, "YOUTUBE_TOKEN_JSON", "bad_host"],
    ["a channel id that is a handle", { YOUTUBE_CHANNEL_ID: "@me" }, "YOUTUBE_CHANNEL_ID", "bad_shape"],
  ])("%s is 400 bad_value (name and reason, never the value) and nothing is written", async (_label, secretsBody, name, reason) => {
    admin();
    const res = await secrets(req("secrets", { secrets: secretsBody }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "bad_value", name, reason });
    expect(JSON.stringify(body)).not.toContain(Object.values(secretsBody)[0] as string);
    expect(put).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("all values are checked before the first one is written (one bad value writes nothing)", async () => {
    admin();
    const res = await secrets(req("secrets", { secrets: { GEMINI_API_KEY: "good-key-12345678", PEXELS_API_KEY: "bad key" } }));
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("a non-string value is a 400, not a crash", async () => {
    admin();
    const res = await secrets(req("secrets", { secrets: { GEMINI_API_KEY: 12345 } }));
    expect(res.status).toBe(400);
  });

  it("logs only the name and the outcome per secret: nothing derived from the value (no hash, length or prefix)", async () => {
    admin();
    const value = "sk-live-VERY-SECRET-value-0123456789";
    const res = await secrets(req("secrets", { secrets: { OPENAI_API_KEY: value } }));
    expect(res.status).toBe(200);
    const lines = info.mock.calls.map((c: unknown[]) => String(c[0]));
    const line = lines.find((l: string) => l.includes("[admin-write]"));
    expect(line).toMatch(/^\[admin-write\] secret user=u-admin- name=OPENAI_API_KEY outcome=accepted$/);
    const everything = JSON.stringify([info.mock.calls, audit.mock.calls]);
    expect(everything).not.toContain(value);
    expect(everything).not.toContain(value.slice(0, 6));
    expect(everything).not.toMatch(/sha256|hash/i);
    expect(everything).not.toContain(String(value.length));
    expect(everything).not.toMatch(/\b[0-9a-f]{8}\b/);
  });

  it("a refused value logs the name and the reason code only, and the 400 body has no value, length or prefix", async () => {
    admin();
    const value = "abcdefgh$HOME-secret-tail";
    const res = await secrets(req("secrets", { secrets: { GEMINI_API_KEY: value } }));
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toBe('{"error":"bad_value","name":"GEMINI_API_KEY","reason":"forbidden_chars"}');
    const lines = info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual(["[admin-write] secret user=u-admin- name=GEMINI_API_KEY outcome=rejected reason=forbidden_chars"]);
    expect(lines.join()).not.toContain("abcdefgh");
  });

  it("the same person is rate limited (429) after the window's allowance; another person is not", async () => {
    admin();
    for (let i = 0; i < SECRET_WRITE_RATE.max; i++) {
      expect((await secrets(req("secrets", { secrets: { GEMINI_API_KEY: "good-key-12345678" } }))).status).toBe(200);
    }
    const limited = await secrets(req("secrets", { secrets: { GEMINI_API_KEY: "good-key-12345678" } }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("retry-after")).toBe(String(SECRET_WRITE_RATE.windowSeconds));
    admin();
    expect((await secrets(req("secrets", { secrets: { GEMINI_API_KEY: "good-key-12345678" } }))).status).toBe(200);
  });

  it("an oversized body is a 400 and never parsed", async () => {
    admin();
    const res = await secrets(req("secrets", JSON.stringify({ secrets: { GEMINI_API_KEY: "a".repeat(200_000) } })));
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("POST /api/setup/variables: values are checked against their name", () => {
  it("good values are written normalised, one log line each", async () => {
    admin();
    const res = await variables(
      req("variables", { variables: { CHRONOS_VIDEO_PROVIDER: "Higgsfield", ALERT_EMAIL_TO: "owner@example.com", CHRONOS_ENABLE_VIDEO_GEN: "1" } }),
    );
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith("variable", "CHRONOS_VIDEO_PROVIDER", "higgsfield");
    expect(put).toHaveBeenCalledWith("variable", "ALERT_EMAIL_TO", "owner@example.com");
    const varLines = info.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("[admin-write] variable"));
    expect(varLines.length).toBe(3);
    for (const l of varLines) expect(l).toMatch(/ name=[A-Z_]+ outcome=accepted$/);
    expect(varLines.join()).not.toContain("owner@example.com");
    expect(audit).toHaveBeenCalledWith({
      action: "variable.write",
      detail: { names: ["CHRONOS_VIDEO_PROVIDER", "ALERT_EMAIL_TO", "CHRONOS_ENABLE_VIDEO_GEN"] },
    });
  });

  it.each([
    ["two addresses", { ALERT_EMAIL_TO: "a@example.com,b@example.com" }, "ALERT_EMAIL_TO", "bad_email"],
    ["a display-name list", { ALERT_EMAIL_TO: "Boss <a@example.com>" }, "ALERT_EMAIL_TO", "bad_email"],
    ["a newline", { ALERT_EMAIL_TO: "a@example.com\nbcc: x@y.co" }, "ALERT_EMAIL_TO", "control_chars"],
    ["a dollar", { ALERT_EMAIL_FROM: "a$HOME@example.com" }, "ALERT_EMAIL_FROM", "forbidden_chars"],
    ["an unknown provider", { CHRONOS_VIDEO_PROVIDER: "attacker-gpu" }, "CHRONOS_VIDEO_PROVIDER", "bad_choice"],
    ["a switch that is not a switch", { CHRONOS_AGENT_AUTOPILOT: "maybe" }, "CHRONOS_AGENT_AUTOPILOT", "bad_choice"],
  ])("%s is 400 bad_value and nothing is written", async (_label, variablesBody, name, reason) => {
    admin();
    const res = await variables(req("variables", { variables: variablesBody }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_value", name, reason });
    expect(put).not.toHaveBeenCalled();
  });

  it("a non-string or oversized value keeps the old plain bad_value answer", async () => {
    admin();
    const res = await variables(req("variables", { variables: { CHRONOS_VIDEO_PROVIDER: 7 } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_value", name: "CHRONOS_VIDEO_PROVIDER" });
  });
});

describe("recent second factor (NIGHTSHIFT_ADMIN_MFA=enforce only)", () => {
  const body = () => ({ secrets: { GEMINI_API_KEY: "good-key-12345678" } });

  it("enforce: an aal2 session whose code is 9 hours old gets 401 mfa_recent_required, nothing written", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    admin(VERIFIED, "aal2", [{ method: "totp", timestamp: NOW_S - 9 * 3600 }]);
    for (const call of [
      () => secrets(req("secrets", body())),
      () => variables(req("variables", { variables: { CHRONOS_AGENT_AUTOPILOT: "1" } })),
    ]) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "mfa_recent_required" });
    }
    expect(put).not.toHaveBeenCalled();
  });

  it("enforce: a code typed an hour ago is recent enough (default window 8 h)", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    admin(VERIFIED, "aal2", [{ method: "totp", timestamp: NOW_S - 3600 }]);
    expect((await secrets(req("secrets", body()))).status).toBe(200);
  });

  it("enforce: the window is configurable", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA_RECENT_MINUTES", "30");
    admin(VERIFIED, "aal2", [{ method: "totp", timestamp: NOW_S - 3600 }]);
    expect((await secrets(req("secrets", body()))).status).toBe(401);
  });

  it("enforce: LOCKOUT SAFETY, an unreadable time is not 'stale'", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    admin(VERIFIED, "aal2", undefined);
    expect((await secrets(req("secrets", body()))).status).toBe(200);
  });

  it.each(["warn", "off", ""])("NIGHTSHIFT_ADMIN_MFA=%j: an old code changes nothing", async (mode) => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", mode);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    admin(VERIFIED, "aal2", [{ method: "totp", timestamp: NOW_S - 999 * 3600 }]);
    expect((await secrets(req("secrets", body()))).status).toBe(200);
    expect(
      (await variables(req("variables", { variables: { CHRONOS_AGENT_AUTOPILOT: "0" } }))).status,
    ).toBe(200);
  });
});

describe("POST /api/setup/youtube (the wizard's key check)", () => {
  it("is not operator-only: any signed-in person who adds a channel may use it, with their own key", async () => {
    admin();
    state.user = { id: "u-customer-0001", factors: [] };
    const fetchMock = vi.fn(async () => Response.json({ items: [{ id: "UCx", snippet: { title: "T" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await youtube(req("youtube", { apiKey: "AIza-test-key", handle: "@me" }));
    expect(res.status).toBe(200);
    // fixed host, the caller's key goes only to Google
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?/);
    vi.unstubAllGlobals();
  });

  it("refuses a cross-origin call, an oversized body and an overlong field, and is rate limited", async () => {
    admin();
    expect((await youtube(req("youtube", { apiKey: "k", handle: "x" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await youtube(req("youtube", { apiKey: "k".repeat(600), handle: "x" }))).status).toBe(400);
    expect((await youtube(req("youtube", JSON.stringify({ apiKey: "k", handle: "x".repeat(100_000) })))).status).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [] })));
    let last = 200;
    for (let i = 0; i < 40; i++) last = (await youtube(req("youtube", { apiKey: "k", handle: "x" }))).status;
    expect(last).toBe(429);
    vi.unstubAllGlobals();
  });
});
