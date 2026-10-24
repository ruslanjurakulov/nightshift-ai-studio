import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agent/run with a `voice_id`: the Custom Voice hard gate on the Actions backend (docs/CUSTOM_VOICE.md).
 *
 * What would break without these: the Run-now voice reaches GitHub Actions as a workflow input and inserts no database row, so
 * migration 0117's guards (render_jobs, creative_jobs, channels.agent_config) never see it. Anyone who could run a channel could
 * narrate it with another person's cloned voice by pasting its id. The route now asks the database function those guards use,
 * channel_voice_config_problem, as the signed-in user, before anything is held or dispatched.
 *
 * The database is faked by a model of that function's channel path (lowercased and stripped id, approved profile, attached to the
 * channel in the narrator slot). The SQL itself is tested in tests/security/test_sec_voice_profiles.py.
 */

vi.mock("server-only", () => ({}));

const CLONE = "AbCdEfGhIjKlMnOpQrSt";
const STOCK = "pNInz6obpgDQGcFmaJgB";
const swapCase = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

const h = {
  /** lowercase ids of voices that are in a profile and NOT usable on the channel (the model's whole rule). */
  blocked: new Set<string>([CLONE.toLowerCase()]),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcOverride: null as null | (() => Promise<RpcAnswer>),
  client: "present" as "present" | "missing",
  insert: vi.fn(),
  reserve: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
};

const fakeClient = {
  from: () => ({ insert: (row: unknown) => ({ select: () => ({ single: async () => h.insert(row) }) }) }),
  rpc: async (fn: string, args: Record<string, unknown>): Promise<RpcAnswer> => {
    h.rpcCalls.push({ fn, args });
    if (h.rpcOverride) return h.rpcOverride();
    const id = String((args.p_new as Record<string, unknown>).elevenlabs_voice_id ?? "")
      .replace(/^[\s 　]+|[\s 　]+$/g, "")
      .toLowerCase();
    return { data: h.blocked.has(id) ? "elevenlabs_voice_id" : null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u-me" }),
  createClient: async () => (h.client === "present" ? fakeClient : null),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async () => ({ ok: true, role: "admin", orgId: "org-a", source: "org" }),
  isOperator: async () => false,
  isPlatformAdmin: async () => false,
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ current: null }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/connectedAccounts", () => ({ readConnectedAccounts: async () => [] }));
vi.mock("@/lib/server/github-secrets", () => ({ dispatchDailyVideo: (...a: unknown[]) => h.dispatch(...a), isGithubConfigured: true }));
vi.mock("@/lib/server/credits", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/credits")>("../lib/server/credits");
  return { ...actual, creditsEnforced: true, reserveRunCredits: (...a: unknown[]) => h.reserve(...a) };
});

const route = await import("../app/api/agent/run/route");
const { runVoiceProblem } = await import("../lib/server/run-voice");
const { dictionaries } = await import("../lib/i18n");
const { readRunAnswer } = await import("../lib/run-answer");

const post = (body: Record<string, unknown>) =>
  route.POST(
    new Request("http://test.local/api/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: JSON.stringify({ channel_id: "ch-a", ...body }),
    }),
  );

const useBackend = (b: "actions" | "queue") => {
  process.env.NIGHTSHIFT_RUN_BACKEND = b;
};
const nothingStarted = () => {
  expect(h.reserve).not.toHaveBeenCalled();
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.insert).not.toHaveBeenCalled();
};

beforeEach(() => {
  useBackend("actions");
  h.blocked = new Set([CLONE.toLowerCase()]);
  h.rpcCalls = [];
  h.rpcOverride = null;
  h.client = "present";
  h.dispatch.mockReset().mockResolvedValue(undefined);
  h.insert.mockReset().mockResolvedValue({ data: { id: 7 }, error: null, status: 201 });
  h.audit.mockReset();
  h.reserve.mockReset().mockResolvedValue({ ok: true, creditRef: "gh-ref", estimate: { credits: 36 }, exempt: false, durationS: 180 });
});

describe.each(["actions", "queue"] as const)("%s backend: a custom voice the channel may not use", (backend) => {
  beforeEach(() => useBackend(backend));

  it("is refused 403 voice_not_allowed before any hold, dispatch or job exists", async () => {
    const res = await post({ voice_id: CLONE });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "voice_not_allowed" });
    nothingStarted();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("asks channel_voice_config_problem for this channel, this organization and the narrator key, as the signed-in user's client", async () => {
    await post({ voice_id: CLONE });
    expect(h.rpcCalls).toEqual([
      {
        fn: "channel_voice_config_problem",
        args: { p_channel: "ch-a", p_org: "org-a", p_old: {}, p_new: { elevenlabs_voice_id: CLONE } },
      },
    ]);
  });

  it.each([CLONE.toLowerCase(), CLONE.toUpperCase(), `  ${CLONE}  `, `\t${swapCase(CLONE)} `])(
    "refuses the variant %j of the same id",
    async (variant) => {
      const res = await post({ voice_id: variant });
      expect(res.status).toBe(403);
      nothingStarted();
    },
  );

  it("does not say whose voice it is, or why: the answer carries one closed code", async () => {
    const res = await post({ voice_id: CLONE });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(CLONE);
    expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
  });
});

describe.each(["actions", "queue"] as const)("%s backend: a custom voice the channel may use, or no custom voice at all", (backend) => {
  beforeEach(() => useBackend(backend));

  it("an allowed voice (the function answers null) goes on exactly as before", async () => {
    h.blocked = new Set();
    const res = await post({ voice_id: CLONE });
    expect(res.status).toBe(200);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    if (backend === "actions") expect(h.dispatch).toHaveBeenCalledWith("ch-a", expect.objectContaining({ voiceId: CLONE }));
    else expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it("a stock voice (in no profile) is asked about and goes on exactly as before", async () => {
    const res = await post({ voice_id: STOCK });
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.reserve).toHaveBeenCalledTimes(1);
  });

  it("NO voice_id: the database is not asked anything and the answer is the one it always was", async () => {
    const res = await post({ topic: "t" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      backend === "actions"
        ? { ok: true, backend: "actions", credits_reserved: 36 }
        : { ok: true, backend: "queue", job_id: 7, credits_reserved: 36 },
    );
    expect(h.rpcCalls).toEqual([]);
  });

  it.each([{ voice_id: "" }, { voice_id: "   " }, { voice_id: 12345678901234567890 }, { voice_id: null }, { voice_id: ["x"] }])(
    "a voice_id of %j is no voice: not asked about, nothing refused",
    async (extra) => {
      const res = await post(extra);
      expect(res.status).toBe(200);
      expect(h.rpcCalls).toEqual([]);
    },
  );

  it.each(["16516516145", "short", "has space 12345678901", "x".repeat(21)])(
    "%j is not shaped like a voice id: the dispatch never forwards it, so nothing is asked and nothing changes",
    async (voice_id) => {
      const res = await post({ voice_id });
      expect(res.status).toBe(200);
      expect(h.rpcCalls).toEqual([]);
    },
  );
});

describe("a check that cannot be answered fails CLOSED for an id that could be a profile's", () => {
  const cases: Array<[string, () => Promise<RpcAnswer>]> = [
    ["a database error", async () => ({ data: null, error: { code: "57014", message: "timeout" } })],
    ["a permission error", async () => ({ data: null, error: { code: "42501", message: "denied" } })],
    ["a thrown network error", async () => Promise.reject(new Error("fetch failed"))],
    ["an answer of the wrong shape", async () => ({ data: { not: "text" }, error: null })],
    ["an answer of the wrong type", async () => ({ data: 7, error: null })],
  ];
  it.each(cases)("%s: 503 voice_check_unavailable, nothing held, dispatched or inserted", async (_name, override) => {
    h.rpcOverride = override;
    for (const backend of ["actions", "queue"] as const) {
      useBackend(backend);
      const res = await post({ voice_id: STOCK });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "voice_check_unavailable" });
    }
    nothingStarted();
  });

  it("no database client at all: refused, not run in a voice nobody checked", async () => {
    h.client = "missing";
    const res = await post({ voice_id: STOCK });
    expect(res.status).toBe(503);
    nothingStarted();
  });

  it("but the function not existing (0117 not applied, so no profile can exist) lets the id through", async () => {
    for (const code of ["PGRST202", "42883"]) {
      h.rpcOverride = async () => ({ data: null, error: { code, message: "no such function" } });
      h.dispatch.mockClear();
      const res = await post({ voice_id: CLONE });
      expect(res.status, code).toBe(200);
    }
  });
});

describe("runVoiceProblem", () => {
  const rpcWith = (answer: RpcAnswer) => ({ rpc: async () => answer });

  it("needs no client and asks nothing for something that is not a voice id", async () => {
    expect(await runVoiceProblem(null, "ch", null, "")).toBeNull();
    expect(await runVoiceProblem(null, "ch", null, "not-a-voice-id")).toBeNull();
  });

  it("an id shaped like a voice with no client is unavailable", async () => {
    expect(await runVoiceProblem(null, "ch", null, STOCK)).toBe("voice_check_unavailable");
  });

  it("sends a null organization when the role check read none", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await runVoiceProblem({ rpc: async (_f, a) => (seen.push(a), { data: null, error: null }) }, "ch", null, STOCK);
    expect(seen[0].p_org).toBeNull();
  });

  it("asks about the id without its padding, whoever trimmed it first", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = { rpc: async (_f: string, a: Record<string, unknown>) => (seen.push(a), { data: null, error: null }) };
    expect(await runVoiceProblem(client, "ch", "o", `  ${STOCK}\t`)).toBeNull();
    expect(seen[0].p_new).toEqual({ elevenlabs_voice_id: STOCK });
  });

  it("maps the three answers", async () => {
    expect(await runVoiceProblem(rpcWith({ data: null, error: null }), "ch", "o", STOCK)).toBeNull();
    expect(await runVoiceProblem(rpcWith({ data: "elevenlabs_voice_id", error: null }), "ch", "o", STOCK)).toBe("voice_not_allowed");
    expect(await runVoiceProblem(rpcWith({ data: null, error: { code: "XX000" } }), "ch", "o", STOCK)).toBe("voice_check_unavailable");
  });
});

describe("the refusal is logged on the server with its code only", () => {
  it("a 403 and a 503 each leave one line with the closed code and no voice id, channel or user", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await post({ voice_id: CLONE });
      h.rpcOverride = async () => ({ data: null, error: { code: "57014" } });
      await post({ voice_id: STOCK });
      expect(warn.mock.calls).toEqual([["[agent-run] voice refused: voice_not_allowed"], ["[agent-run] voice refused: voice_check_unavailable"]]);
      const text = JSON.stringify(warn.mock.calls);
      for (const secret of [CLONE, STOCK, "ch-a", "u-me", "org-a"]) expect(text).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  it("an allowed voice and a run with no voice log nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await post({ voice_id: STOCK });
      await post({});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the screen's sentence", () => {
  const read = (status: number, error: string, locale: "en" | "ru" | "uz") =>
    readRunAnswer({ ok: false, status }, { error }, dictionaries[locale], locale);

  it.each(["en", "ru", "uz"] as const)("%s: both refusals are translated, say nothing was taken, and are neither 'unsure' nor 'settled'", (locale) => {
    const t = dictionaries[locale];
    for (const [status, error, text] of [
      [403, "voice_not_allowed", t.agents.runVoiceNotAllowed],
      [503, "voice_check_unavailable", t.agents.runVoiceCheckUnavailable],
    ] as const) {
      const a = read(status, error, locale);
      if (a.outcome !== "failed") throw new Error("expected a failure");
      expect(a.message).toBe(`${text} ${t.create.flow.notTaken}`);
      expect(a.unsure).toBe(false);
      expect(a.settled).toBe(false);
      expect(a.message).not.toBe(`${t.agents.runFailed} ${t.create.flow.notTaken}`);
    }
  });

  it("ru and uz are really translated", () => {
    for (const locale of ["ru", "uz"] as const) {
      expect(dictionaries[locale].agents.runVoiceNotAllowed).not.toBe(dictionaries.en.agents.runVoiceNotAllowed);
      expect(dictionaries[locale].agents.runVoiceCheckUnavailable).not.toBe(dictionaries.en.agents.runVoiceCheckUnavailable);
    }
  });

  it("the refusal text tells a stranger nothing about voices: no 'clone', 'custom', 'owner' or 'profile'", () => {
    for (const k of ["runVoiceNotAllowed", "runVoiceCheckUnavailable"] as const)
      expect(dictionaries.en.agents[k]).not.toMatch(/clone|custom|owner|profile|approved|attached/i);
  });
});

describe("the route source", () => {
  const src = readFileSync(path.join(__dirname, "..", "app", "api", "agent", "run", "route.ts"), "utf8");

  it("asks before the hold is reserved, and holds the check to the route's own organization", () => {
    expect(src.indexOf("runVoiceProblem(")).toBeGreaterThan(-1);
    expect(src.indexOf("runVoiceProblem(")).toBeLessThan(src.indexOf("reserveRunCredits(supabase"));
    expect(src).toContain("access.orgId");
  });
});
