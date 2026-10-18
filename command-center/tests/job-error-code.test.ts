import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOB_ERROR_CODES,
  forCustomer,
  parseJobError,
  toQueueJob,
  withCreditsReturned,
} from "@/lib/runBackend";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

/**
 * D12: a failed render job carries a code (modules/render_error.py writes the prefix); the customer page shows a plain
 * sentence for it, and says the credits came back only when the reservation was seen released.
 */

const LOG = "[code:voice] main.py exited with code 1\nTraceback ...\nmodules.audio_mixer.VoiceUnavailable: top up the ElevenLabs account";

describe("parseJobError", () => {
  it("splits the code from the operator text", () => {
    expect(parseJobError(LOG)).toEqual({ code: "voice", text: LOG.replace("[code:voice] ", "") });
  });

  it("a failure written before codes has no code and keeps its text", () => {
    expect(parseJobError("main.py exited with code 1")).toEqual({ code: null, text: "main.py exited with code 1" });
  });

  it("an unknown prefix reads unknown, never a made-up code", () => {
    expect(parseJobError("[code:telepathy] x").code).toBe("unknown");
  });

  it("nothing in, nothing out", () => {
    expect(parseJobError(null)).toEqual({ code: null, text: null });
    expect(parseJobError("")).toEqual({ code: null, text: null });
  });

  it("only a leading prefix counts", () => {
    expect(parseJobError("main.py failed [code:voice]").code).toBeNull();
  });
});

describe("toQueueJob", () => {
  it("exposes the code and the text without the prefix", () => {
    const j = toQueueJob({ id: 4, status: "failed", error: LOG });
    expect(j.errorCode).toBe("voice");
    expect(j.error?.startsWith("main.py exited")).toBe(true);
    expect(j.creditsReturned).toBeNull();
  });
});

describe("withCreditsReturned", () => {
  const failed = (id: number) => toQueueJob({ id, status: "failed", error: LOG });
  it("says yes only for a released reservation of a failed job", () => {
    const jobs = [failed(1), failed(2), failed(3), toQueueJob({ id: 4, status: "running" })];
    const out = withCreditsReturned(
      jobs,
      [
        { id: 1, credit_ref: "rj-a" },
        { id: 2, credit_ref: "rj-b" },
        { id: 3, credit_ref: null },
        { id: 4, credit_ref: "rj-d" },
      ],
      [
        { job_id: "rj-a", status: "released" },
        { job_id: "rj-b", status: "open" },
        { job_id: "rj-d", status: "released" },
      ],
    );
    expect(out.map((j) => j.creditsReturned)).toEqual([true, false, null, null]);
  });

  it("a reservation that could not be read claims nothing", () => {
    expect(withCreditsReturned([failed(1)], [{ id: 1, credit_ref: "rj-a" }], [])[0].creditsReturned).toBeNull();
  });
});

describe("what a customer is sent", () => {
  it("keeps the code and the refund fact, drops the log text", () => {
    const j = { ...toQueueJob({ id: 1, status: "failed", error: LOG }), creditsReturned: true };
    expect(forCustomer(j)).toMatchObject({ error: null, errorCode: "voice", creditsReturned: true });
    expect(JSON.stringify(forCustomer(j))).not.toMatch(/ElevenLabs|top up|Traceback/i);
  });
});

describe("the sentences", () => {
  const VENDORS = /eleven|gemini|google|pexels|kling|veo\b|minimax|leonardo|openai|seedance|higgsfield|runway|luma|supabase|youtube|\.env|api key|secret/i;
  for (const [name, d] of [["en", en], ["ru", ru], ["uz", uz]] as const) {
    it(`${name}: one non-empty sentence per code, no vendor, no operator remedy`, () => {
      for (const code of JOB_ERROR_CODES) {
        const s = d.create.jobError[code];
        expect(s, code).toBeTruthy();
        expect(s, code).not.toMatch(VENDORS);
      }
      expect(Object.keys(d.create.jobError).sort()).toEqual([...JOB_ERROR_CODES].sort());
      expect(d.create.creditsReturned).toBeTruthy();
    });
  }

  it("the three languages differ (a missing translation is not a copy of English)", () => {
    for (const code of JOB_ERROR_CODES) {
      expect(ru.create.jobError[code]).not.toBe(en.create.jobError[code]);
      expect(uz.create.jobError[code]).not.toBe(en.create.jobError[code]);
    }
  });
});

// ── the route ────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  operator: false,
  jobs: [] as Record<string, unknown>[],
  refs: [] as Record<string, unknown>[],
  reservations: { data: [] as Record<string, unknown>[], error: null as unknown },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => {
  const table = (name: string) => {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ["select", "eq", "order", "limit", "in"]) q[m] = (...a: unknown[]) => {
      if (m === "select") (q as { cols?: unknown }).cols = a[0];
      return chain();
    };
    q.then = (resolve: (v: unknown) => void) => {
      if (name === "system_events") return resolve({ data: [], error: null });
      if (name === "credit_reservations") return resolve(h.reservations);
      const cols = String((q as { cols?: unknown }).cols);
      return resolve({ data: cols.includes("credit_ref") && !cols.includes("kind") ? h.refs : h.jobs, error: null });
    };
    return q;
  };
  const client = { from: (n: string) => table(n) };
  return { getUser: async () => ({ id: "u" }), createClient: async () => client };
});
vi.mock("@/lib/channels-server", () => ({ getChannelScope: async () => ({ selection: "news" }) }));
vi.mock("@/lib/channels", () => ({ isScoped: () => true, scopeQuery: (q: unknown) => q }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => h.operator }));

const { GET } = await import("../app/api/agent/events/route");

beforeEach(() => {
  process.env.NIGHTSHIFT_RUN_BACKEND = "queue";
  h.operator = false;
  h.jobs = [{ id: 9, kind: "daily", status: "failed", attempts: 1, error: LOG }];
  h.refs = [{ id: 9, credit_ref: "rj-9" }];
  h.reservations = { data: [{ job_id: "rj-9", status: "released" }], error: null };
});

describe("GET /api/agent/events", () => {
  it("a customer gets the code and the refund fact, never the log", async () => {
    const body = (await (await GET()).json()) as { jobs: Record<string, unknown>[] };
    expect(body.jobs[0]).toMatchObject({ id: 9, status: "failed", error: null, errorCode: "voice", creditsReturned: true });
    expect(JSON.stringify(body)).not.toMatch(/ElevenLabs|VoiceUnavailable|Traceback/);
  });

  it("the operator keeps the log tail", async () => {
    h.operator = true;
    const body = (await (await GET()).json()) as { jobs: { error: string }[] };
    expect(body.jobs[0].error).toContain("VoiceUnavailable");
  });

  it("an unreadable reservation claims no refund", async () => {
    h.reservations = { data: [], error: { message: "denied" } };
    const body = (await (await GET()).json()) as { jobs: { creditsReturned: boolean | null }[] };
    expect(body.jobs[0].creditsReturned).toBeNull();
  });
});
