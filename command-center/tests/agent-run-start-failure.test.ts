import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agent/run: the hold was taken and then the START failed.
 *
 * What would break without these: a keyed request whose insert/dispatch failed
 * answered like any other failure while its hold reference is burnt (the same
 * key then answers `run_already_started`, which the page reads as "it started"
 * although nothing did); a timeout read as "nothing happened" and retried into
 * a second dispatch; a refusal read as "may have happened".
 *
 * The database and GitHub are faked at the edges the route consults. Nothing
 * here dispatches or touches a real database.
 *
 * KNOWN GAP, pinned below: the definite case should release the hold at once.
 * It cannot: release_credits() is service-only (0020) and this app never holds
 * the service key, so the hold stays (credits_held keeps its amount) until it
 * expires. The tests say so instead of pretending.
 */

vi.mock("server-only", () => ({}));

const HELD = 36;
const REF = "rj-ref";

const h = {
  insert: vi.fn(),
  rpc: vi.fn(async () => ({ data: null, error: null })),
  dispatch: vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined),
  reserve: vi.fn(),
};

const fakeClient = {
  from: (table: string) => ({
    insert: (row: unknown) => ({
      select: () => ({ single: async () => h.insert(table, row) }),
    }),
  }),
  rpc: (...a: unknown[]) => (h.rpc as unknown as (...x: unknown[]) => unknown)(...a),
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u-me" }),
  createClient: async () => fakeClient,
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async () => ({ ok: true, role: "admin", orgId: "org-a", source: "org" }),
  isOperator: async () => false,
  isPlatformAdmin: async () => false,
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ current: null }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/connectedAccounts", () => ({ readConnectedAccounts: async () => [] }));
vi.mock("@/lib/server/github-secrets", () => ({
  dispatchDailyVideo: (...a: unknown[]) => h.dispatch(...a),
  isGithubConfigured: true,
}));
vi.mock("@/lib/server/credits", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/credits")>("../lib/server/credits");
  return { ...actual, creditsEnforced: true, reserveRunCredits: (...a: unknown[]) => h.reserve(...a) };
});

const route = await import("../app/api/agent/run/route");
const { dispatchOutcome, insertOutcome, refusedStatus, startFailureBody } = await import("../lib/server/run-start");

const held = () => ({ ok: true, creditRef: REF, estimate: { credits: HELD }, exempt: false, durationS: 180 });
const post = (body: Record<string, unknown>) =>
  route.POST(
    new Request("http://test.local/api/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: JSON.stringify({ channel_id: "ch-a", ...body }),
    }),
  );
const keyed = { idempotency_key: "create:attempt-1" };

/** A GitHub dispatch error as dispatchWorkflow throws it: a named reason, and the status when GitHub answered. */
const githubError = (message: string, status?: number) => Object.assign(new Error(message), status === undefined ? {} : { status });

beforeEach(() => {
  process.env.NIGHTSHIFT_RUN_BACKEND = "queue";
  h.insert.mockReset().mockResolvedValue({ data: { id: 42 }, error: null, status: 201 });
  h.rpc.mockClear();
  h.dispatch.mockReset().mockResolvedValue(undefined);
  h.reserve.mockReset().mockResolvedValue(held());
});

const useActions = () => {
  process.env.NIGHTSHIFT_RUN_BACKEND = "actions";
};

/** The hold is never released from here, and nothing else touches the database through the user client. */
const nothingReleased = () => expect(h.rpc).not.toHaveBeenCalled();

describe("success is unchanged", () => {
  it("queue: a keyed run that inserts answers ok with the job id", async () => {
    const res = await post(keyed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, backend: "queue", job_id: 42, credits_reserved: HELD });
  });

  it("actions: a keyed run that dispatches answers ok, dispatched once", async () => {
    useActions();
    const res = await post(keyed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, backend: "actions", credits_reserved: HELD });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("DEFINITE failure: the other side refused, nothing started", () => {
  it("queue: a 4xx from the insert is start_failed, retry with a new key; the hold is not released (no service path) and says so", async () => {
    h.insert.mockResolvedValue({ data: null, error: { code: "42501", message: "new row violates row-level security policy" }, status: 403 });
    const res = await post(keyed);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "start_failed",
      reason: "queue_insert_failed",
      // Still held: nothing here can release it. `false` is reserved for a hold that was released.
      credits_held: HELD,
      retry_with_new_key: true,
    });
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    nothingReleased();
  });

  it("queue: a missing render_jobs table (0017 not applied) is start_failed too, as a 503", async () => {
    h.insert.mockResolvedValue({ data: null, error: { code: "42P01", message: 'relation "render_jobs" does not exist' }, status: 404 });
    const res = await post(keyed);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "start_failed", reason: "queue_unavailable", retry_with_new_key: true });
  });

  it("actions: GitHub refusing (401/403, 404, 422) is start_failed, dispatched exactly once", async () => {
    useActions();
    for (const [err, status, reason] of [
      [githubError("github_unauthorized", 403), 403, "github_unauthorized"],
      [githubError("github_workflow_not_found", 404), 404, "github_workflow_not_found"],
      [githubError("github_dispatch_failed", 422), 502, "github_dispatch_failed"],
    ] as const) {
      h.dispatch.mockReset().mockRejectedValue(err);
      const res = await post(keyed);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: "start_failed", reason, credits_held: HELD, retry_with_new_key: true });
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    }
    nothingReleased();
  });
});

describe("AMBIGUOUS failure: it may have happened, so nothing is released and nothing is sent again", () => {
  it("queue: an insert with no answer (supabase-js reports a failed fetch as status 0) is start_unsure", async () => {
    h.insert.mockResolvedValue({ data: null, error: { code: "", message: "TypeError: fetch failed" }, status: 0 });
    const res = await post(keyed);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "start_unsure", reason: "queue_insert_failed", credits_held: HELD });
    expect(h.insert).toHaveBeenCalledTimes(1);
    nothingReleased();
  });

  it("queue: a thrown insert, a gateway 5xx and a 408 are start_unsure, inserted once each", async () => {
    for (const make of [
      () => h.insert.mockRejectedValue(new Error("socket hang up")),
      () => h.insert.mockResolvedValue({ data: null, error: { code: "", message: "Bad Gateway" }, status: 502 }),
      () => h.insert.mockResolvedValue({ data: null, error: { code: "", message: "Gateway Timeout" }, status: 504 }),
      () => h.insert.mockResolvedValue({ data: null, error: { code: "", message: "Request Timeout" }, status: 408 }),
    ]) {
      h.insert.mockReset();
      make();
      const res = await post(keyed);
      expect(await res.json()).toMatchObject({ error: "start_unsure", credits_held: HELD });
      expect(h.insert).toHaveBeenCalledTimes(1);
    }
    nothingReleased();
  });

  it("queue: an answer that is neither an error nor a row is start_unsure (we cannot tell)", async () => {
    h.insert.mockResolvedValue({ data: null, error: null, status: 200 });
    expect(await (await post(keyed)).json()).toMatchObject({ error: "start_unsure" });
  });

  it("actions: a timeout/reset after the request was sent is start_unsure, dispatched at most once, never re-dispatched", async () => {
    useActions();
    h.dispatch.mockRejectedValue(new TypeError("fetch failed"));
    const res = await post(keyed);
    expect(res.status).toBe(502);
    // The raw error text is not echoed; the reason is a named one.
    expect(await res.json()).toEqual({ error: "start_unsure", reason: "github_dispatch_failed", credits_held: HELD });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    nothingReleased();
  });

  it("actions: a GitHub 5xx may have been accepted: start_unsure", async () => {
    useActions();
    h.dispatch.mockRejectedValue(githubError("github_dispatch_failed", 503));
    expect(await (await post(keyed)).json()).toMatchObject({ error: "start_unsure" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("a repeat with the same key after a definite failure", () => {
  it("is answered run_already_started: the reference is burnt, so the caller must rotate its key", async () => {
    useActions();
    h.dispatch.mockRejectedValue(githubError("github_unauthorized", 403));
    const first = await post(keyed);
    expect(await first.json()).toMatchObject({ error: "start_failed", retry_with_new_key: true });

    // reserve_credits() refuses every existing job_id (23505), released ones too; reserveRunCredits answers it.
    h.reserve.mockResolvedValue({ ok: false, status: 409, body: { error: "run_already_started" } });
    const again = await post(keyed);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "run_already_started" });
    // The same reference both times, and nothing was dispatched the second time.
    const refs = h.reserve.mock.calls.map((c) => (c[4] as { creditRef: string }).creditRef);
    expect(refs[0]).toBe(refs[1]);
    expect(h.dispatch).toHaveBeenCalledTimes(1);

    // A new key is a new reference.
    h.reserve.mockResolvedValue(held());
    h.dispatch.mockReset().mockResolvedValue(undefined);
    const rotated = await post({ idempotency_key: "create:attempt-2" });
    expect(rotated.status).toBe(200);
    const next = (h.reserve.mock.calls.at(-1)![4] as { creditRef: string }).creditRef;
    expect(next).not.toBe(refs[0]);
  });
});

describe("requests that do not hold under a key behave exactly as before", () => {
  it("unkeyed: the old error codes and credits_held, whatever the cause", async () => {
    h.insert.mockResolvedValue({ data: null, error: { code: "42501", message: "rls" }, status: 403 });
    let res = await post({});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "queue_insert_failed", credits_held: HELD });

    useActions();
    h.dispatch.mockRejectedValue(githubError("github_unauthorized", 403));
    res = await post({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "github_unauthorized", credits_held: HELD });
  });

  it("keyed but nothing held (the operator's own, credit-exempt run): the old codes, no hold to talk about", async () => {
    h.reserve.mockResolvedValue({ ok: true, creditRef: null, estimate: null, exempt: true, durationS: null });
    h.insert.mockResolvedValue({ data: null, error: { code: "42501", message: "rls" }, status: 403 });
    expect(await (await post(keyed)).json()).toEqual({ error: "queue_insert_failed" });
  });
});

describe("run-start helpers", () => {
  it("only a received 4xx (not 408) is a refusal", () => {
    for (const s of [400, 401, 403, 404, 409, 422, 429]) expect(refusedStatus(s), String(s)).toBe(true);
    for (const s of [0, 200, 204, 408, 500, 502, 503, 504, undefined, null, "403"]) expect(refusedStatus(s), String(s)).toBe(false);
    expect(insertOutcome({ status: 403 })).toBe("failed");
    expect(insertOutcome({})).toBe("unsure");
  });

  it("a dispatch error with no status and no named refusal is unsure; an unnamed message is not echoed", () => {
    expect(dispatchOutcome(new TypeError("fetch failed"))).toEqual({ outcome: "unsure", reason: "github_dispatch_failed" });
    expect(dispatchOutcome("boom")).toEqual({ outcome: "unsure", reason: "github_dispatch_failed" });
    expect(dispatchOutcome(githubError("github_unauthorized"))).toEqual({ outcome: "failed", reason: "github_unauthorized" });
    expect(dispatchOutcome(githubError("github_dispatch_failed", 422)).outcome).toBe("failed");
    expect(dispatchOutcome(githubError("github_dispatch_failed", 500)).outcome).toBe("unsure");
  });

  it("the bodies: only a definite failure asks for a new key; credits_held false is a released hold", () => {
    expect(startFailureBody("failed", "r", 5)).toEqual({ error: "start_failed", reason: "r", credits_held: 5, retry_with_new_key: true });
    expect(startFailureBody("failed", "r", false)).toMatchObject({ credits_held: false });
    expect(startFailureBody("unsure", "r", 5)).toEqual({ error: "start_unsure", reason: "r", credits_held: 5 });
  });
});

describe("no new privileged path", () => {
  it("the route and the helper hold no service key and call no release", () => {
    for (const f of ["app/api/agent/run/route.ts", "lib/server/run-start.ts"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8")
        // The comments explain the gap in words; the code must not reach for it.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/service[_-]?role|SERVICE_KEY|SERVICE_ROLE|createServiceClient|createAdminClient|release_credits|credit_release/i);
    }
  });
});
