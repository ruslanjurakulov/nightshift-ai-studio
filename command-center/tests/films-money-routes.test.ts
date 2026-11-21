/**
 * /api/films/[id]/quote and /start (0171's quote_film / start_film for the Studio Timeline). What would break without these: a price,
 * a quote id or any field from the browser forwarded to the database beside the film and the key; a start without an idempotency key;
 * a cross-site POST that reaches the database; a switched-off route that answers; and the remedy lost: "insufficient credits", "switched
 * off" and "the migration is not applied" must reach the screen as three different answers, never one "failed".
 * Membership of the film's organization is the database's check (quote_film / start_film: not_found for another org's film, forbidden
 * below editor/admin), run as the member's own session; these tests pin that the route passes that answer on, not around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ user: vi.fn(), client: vi.fn(), admin: vi.fn(), rate: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getUser: h.user, createClient: h.client }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: h.admin }));
vi.mock("@/lib/orgs-server", async () => ({ getOrgContext: async () => (await import("./films-fixtures")).ORG_CONTEXT }));
vi.mock("@/lib/server/web-rate", async (orig) => ({ ...(await orig<typeof import("../lib/server/web-rate")>()), takeWebRate: h.rate }));

const { FILM, withOrgSwitch } = await import("./films-fixtures");
const quote = await import("../app/api/films/[id]/quote/route");
const start = await import("../app/api/films/[id]/start/route");

const QID = `fq-3-${"c".repeat(32)}`;
const IDEM = "film-0123456789abcdef0123456789abcdef";
const SAME = { origin: "https://app.test", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const post = (url: string, body: unknown, headers: Record<string, string> = SAME) =>
  new Request(`https://app.test${url}`, { method: "POST", headers, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const PRICED = { priced: true, total: 16, quote_id: QID, startable: true, may_start: true, blocked_by: [], refusals: [] };

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

describe("quote", () => {
  it("calls quote_film with the film and the version only, whatever else the body carries", async () => {
    h.rpc.mockResolvedValue({ data: PRICED, error: null });
    const r = await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3, total: 1, price: 0, quote_id: QID }), params(FILM));
    expect(r.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("quote_film", { p_film: FILM, p_version: 3 });
    expect((await r.json()).quote.total).toBe(16);
  });

  it("migration missing: 503 not_available; another org's film: 404; not an editor: 403", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await (await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3 }), params(FILM))).json()).toEqual({ error: "not_available" });
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found" } });
    expect((await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3 }), params(FILM))).status).toBe(404);
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    expect((await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3 }), params(FILM))).status).toBe(403);
  });

  it("a bad body, a bad id, a cross-site post, the switch off: refused before the database", async () => {
    expect((await quote.POST(post(`/api/films/${FILM}/quote`, { version: "3" }), params(FILM))).status).toBe(400);
    expect((await quote.POST(post(`/api/films/nope/quote`, { version: 3 }), params("nope"))).status).toBe(404);
    const cross = await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3 }, { origin: "https://evil.test", "sec-fetch-site": "cross-site", "content-type": "application/json" }), params(FILM));
    expect(cross.status).toBe(403);
    vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "off");
    expect((await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3 }), params(FILM))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an answer that is not a quote is a 502, never passed on", async () => {
    h.rpc.mockResolvedValue({ data: { total: 0 }, error: null });
    expect((await quote.POST(post(`/api/films/${FILM}/quote`, { version: 3 }), params(FILM))).status).toBe(502);
  });
});

describe("start", () => {
  it("calls start_film with the film, the quote id and the caller's key only", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, replayed: false }, error: null });
    const r = await start.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM, total: 0, credits: 1 }), params(FILM));
    expect(r.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("start_film", { p_film: FILM, p_quote_id: QID, p_idempotency_key: IDEM });
  });

  it("no idempotency key, or a malformed quote id: 400 before the database", async () => {
    expect((await start.POST(post(`/api/films/${FILM}/start`, { quote_id: QID }), params(FILM))).status).toBe(400);
    expect((await start.POST(post(`/api/films/${FILM}/start`, { quote_id: "fq-1", idem: IDEM }), params(FILM))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("three remedies stay three answers: credits, switched off, migration missing", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, reason: "insufficient_credits", code: "NS402" }, error: null });
    expect((await (await start.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM }), params(FILM))).json()).start.reason).toBe("insufficient_credits");
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS409", message: "film_studio_disabled" } });
    expect(await (await start.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM }), params(FILM))).json()).toEqual({ start: { ok: false, reason: "film_studio_disabled" } });
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const missing = await start.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM }), params(FILM));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "not_available" });
  });

  it("not an admin of the film's workspace: 403 from the database, passed on", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    expect((await start.POST(post(`/api/films/${FILM}/start`, { quote_id: QID, idem: IDEM }), params(FILM))).status).toBe(403);
  });
});
