import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ user: vi.fn(), client: vi.fn(), admin: vi.fn(), rate: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getUser: h.user, createClient: h.client }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: h.admin }));
vi.mock("@/lib/orgs-server", async () => ({ getOrgContext: async () => (await import("./films-fixtures")).ORG_CONTEXT }));
vi.mock("@/lib/server/web-rate", async (orig) => ({ ...(await orig<typeof import("../lib/server/web-rate")>()), takeWebRate: h.rate }));

const { FILM, withOrgSwitch } = await import("./films-fixtures");
const startRoute = await import("../app/api/films/[id]/start/route");

const QID = `fq-3-${"c".repeat(32)}`;
const IDEM = "film-0123456789abcdef0123456789abcdef";
const SAME = { origin: "https://app.test", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const post = (url: string, body: unknown, headers: Record<string, string> = SAME) =>
  new Request(`https://app.test${url}`, { method: "POST", headers, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

// What start_film answered in the security lab on a replay after a worker claimed the film.
const REPLAY = {
  ok: true, replayed: true, id: "9bd8a435-c433-43a7-8aac-3844c6138d3b", status: "running",
  worker_id: "breach-host-10.0.3.7:pid-4242", heartbeat_at: "2026-11-14T21:26:18.879415+00:00",
  credit_ref: "fm-9bd8a435c43343a78aac3844c6138d3b", confirmed_credits: 49,
};

beforeEach(() => {
  vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "on");
  h.user.mockReset().mockResolvedValue({ id: "u1" });
  h.admin.mockReset().mockResolvedValue(false);
  h.rate.mockReset().mockResolvedValue("ok");
  h.rpc.mockReset();
  // The open workspace is switched on (0198): these tests are about what comes after the gate.
  h.client.mockReset().mockResolvedValue({ rpc: h.rpc, from: withOrgSwitch(() => { throw new Error("no table read here"); }) });
});
afterEach(() => vi.unstubAllEnvs());

describe("BR-790-01: the start answer", () => {
  it("never hands the browser the worker id the column grant withholds", async () => {
    h.rpc.mockResolvedValue({ data: REPLAY, error: null });
    const r = await startRoute.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM }), params(FILM));
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("worker_id");
    expect(text).not.toContain(REPLAY.worker_id);
    expect(text).not.toContain("heartbeat_at");
    expect(JSON.parse(text).start).toMatchObject({ ok: true, replayed: true });
  });
});

describe("BR-790-02: a deleted reference is named, not \"failed\"", () => {
  it("start_film's reference_missing reaches the screen as its own word, never a 502", async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: "NS400", message: "reference_missing", details: "a reference picture or character no longer exists; remove it or choose another" },
    });
    const r = await startRoute.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM }), params(FILM));
    const body = (await r.json()) as { error?: string; start?: { reason?: string } };
    expect(r.status).not.toBe(502);
    expect(body.error ?? body.start?.reason).toBe("reference_missing");
  });
});
