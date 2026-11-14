/**
 * /api/films (Studio → Projects; NIGHTSHIFT_FILM_STUDIO). What would break without these: a switched-off route that answers (or reads
 * the session) instead of a plain 404; `admins` opening the routes to a customer; a write without the route's rate limit; a database
 * refusal answered as the wrong status (a stale save must be 409 film_changed, never a 500 that invites a blind retry); a body the
 * database would refuse anyway forwarded without a shape check; the project created in another workspace than the one open; and any
 * client other than the member's own session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  user: vi.fn(),
  client: vi.fn(),
  admin: vi.fn(),
  org: vi.fn(),
  rate: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getUser: h.user, createClient: h.client }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: h.admin }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: h.org }));
vi.mock("@/lib/server/web-rate", async (orig) => ({ ...(await orig<typeof import("../lib/server/web-rate")>()), takeWebRate: h.rate }));

const { filmJson, FILM, ORG } = await import("./films-fixtures");
const list = await import("../app/api/films/route");
const one = await import("../app/api/films/[id]/route");
const arch = await import("../app/api/films/[id]/archive/route");
const { filmStudioMode, filmStudioListed } = await import("../lib/server/films");

const ORIGIN = { origin: "https://app.test", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const req = (url: string, method = "GET", body?: unknown) =>
  new Request(`https://app.test${url}`, { method, headers: method === "GET" ? {} : ORIGIN, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const createBody = (over: Record<string, unknown> = {}) => ({
  source_kind: "topic", source_text: "Football in 2050", title: "The stadium", language: "uz", aspect: "16:9",
  target_seconds: 300, channel_id: null, idem: "film-0123456789abcdef", ...over,
});

beforeEach(() => {
  vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "on");
  h.user.mockReset().mockResolvedValue({ id: "u1" });
  h.admin.mockReset().mockResolvedValue(false);
  h.org.mockReset().mockResolvedValue({ supported: true, orgs: [], current: { id: ORG, role: "editor" } });
  h.rate.mockReset().mockResolvedValue("ok");
  h.rpc.mockReset().mockResolvedValue({ data: filmJson(), error: null });
  h.from.mockReset();
  h.client.mockReset().mockResolvedValue({ rpc: h.rpc, from: h.from });
});
afterEach(() => vi.unstubAllEnvs());

describe("the switch", () => {
  it("reads off / admins / on, and anything else is off", () => {
    for (const v of ["", "off", "no", "enabled", "admin"]) expect(filmStudioMode(v)).toBe("off");
    for (const v of ["on", "ON", " 1 ", "true", "yes"]) expect(filmStudioMode(v)).toBe("on");
    expect(filmStudioMode(" Admins ")).toBe("admins");
    expect(filmStudioListed("off", true)).toBe(false);
    expect(filmStudioListed("admins", false)).toBe(false);
    expect(filmStudioListed("admins", true)).toBe(true);
    expect(filmStudioListed("on", false)).toBe(true);
  });

  it("off: every route is a 404 before the session is read", async () => {
    vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "off");
    const answers = [
      await list.GET(req("/api/films")),
      await list.POST(req("/api/films", "POST", createBody())),
      await one.GET(req(`/api/films/${FILM}`), params(FILM)),
      await one.PATCH(req(`/api/films/${FILM}`, "PATCH", { version: 1, patch: { title: "x" } }), params(FILM)),
      await arch.POST(req(`/api/films/${FILM}/archive`, "POST", {}), params(FILM)),
    ];
    for (const r of answers) expect(r.status).toBe(404);
    expect(h.user).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("admins: a member who is not a platform admin gets the same 404; an admin gets through", async () => {
    vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "admins");
    expect((await one.GET(req(`/api/films/${FILM}`), params(FILM))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
    h.admin.mockResolvedValue(true);
    expect((await one.GET(req(`/api/films/${FILM}`), params(FILM))).status).toBe(200);
  });

  it("no session is a 401 (the screen reads it as an ended session)", async () => {
    h.user.mockResolvedValue(null);
    const r = await one.GET(req(`/api/films/${FILM}`), params(FILM));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "session_expired" });
  });
});

describe("create", () => {
  it("creates in the open workspace with the caller's key, after the route's own limit", async () => {
    const r = await list.POST(req("/api/films", "POST", createBody({ channel_id: "night-owl" })));
    expect(r.status).toBe(201);
    expect(h.rate).toHaveBeenCalledWith("u1", expect.objectContaining({ bucket: "films.create" }));
    expect(h.rpc).toHaveBeenCalledWith("create_film_draft", {
      p_org: ORG,
      p_channel: "night-owl",
      p_source_kind: "topic",
      p_source_text: "Football in 2050",
      p_settings: { title: "The stadium", language: "uz", aspect: "16:9", target_seconds: 300 },
      p_idempotency_key: "film-0123456789abcdef",
    });
    expect((await r.json()).film.film.id).toBe(FILM);
  });

  it("refuses a body the database would refuse, without calling it", async () => {
    for (const bad of [
      createBody({ source_kind: "storyboard" }),
      createBody({ source_text: "   " }),
      createBody({ source_text: "x".repeat(2001) }),
      createBody({ title: "" }),
      createBody({ language: "de" }),
      createBody({ aspect: "4:3" }),
      createBody({ target_seconds: 59 }),
      createBody({ target_seconds: 300.5 }),
      createBody({ idem: "short" }),
      createBody({ channel_id: 7 }),
    ]) {
      expect((await list.POST(req("/api/films", "POST", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    // A script may be long.
    expect((await list.POST(req("/api/films", "POST", createBody({ source_kind: "script", source_text: "x".repeat(30000) })))).status).toBe(201);
  });

  it("a rate-limited person gets 429 with retry-after, and nothing is written", async () => {
    h.rate.mockResolvedValue("limited");
    const r = await list.POST(req("/api/films", "POST", createBody()));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("3600");
    expect(await r.json()).toEqual({ error: "rate_limited" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a database refusal keeps its word and status (limit, idempotency conflict, its own rate limit)", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "NS400", message: "limit_reached", details: "an organization keeps at most 50 open drafts; archive one first" } });
    let r = await list.POST(req("/api/films", "POST", createBody()));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "limit_reached", detail: "an organization keeps at most 50 open drafts; archive one first" });
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "NS409", message: "idempotency_conflict" } });
    r = await list.POST(req("/api/films", "POST", createBody()));
    expect(r.status).toBe(409);
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "NS429", message: "rate_limited" } });
    r = await list.POST(req("/api/films", "POST", createBody()));
    expect(r.status).toBe(429);
  });

  it("no open workspace is said, not guessed", async () => {
    h.org.mockResolvedValue({ supported: true, orgs: [], current: null });
    const r = await list.POST(req("/api/films", "POST", createBody()));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "org_required" });
  });
});

describe("save", () => {
  it("sends the version and the patch, and a stale version is 409 film_changed", async () => {
    let r = await one.PATCH(req(`/api/films/${FILM}`, "PATCH", { version: 3, patch: { title: "New", scenes: [] } }), params(FILM));
    expect(r.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("save_film", { p_film: FILM, p_version: 3, p_patch: { title: "New", scenes: [] } });
    expect(h.rate).toHaveBeenCalledWith("u1", expect.objectContaining({ bucket: "films.save" }));
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "NS409", message: "film_changed", details: "the film is at version 4" } });
    r = await one.PATCH(req(`/api/films/${FILM}`, "PATCH", { version: 3, patch: { title: "New" } }), params(FILM));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("film_changed");
  });

  it("a board edit (split, merge, insert, delete, reorder, retime) calls save_film and nothing else: nothing is quoted, held or started", async () => {
    const patch = {
      scenes: [
        { id: "51000000-0000-4000-8000-000000000001", title: "One", narration: "", visual_prompt: "", negative_prompt: "", planned_seconds: 6, shot_count: 1, first_frame: "keyframe", last_frame: "none" },
        { title: "Split off", narration: "", visual_prompt: "", negative_prompt: "", planned_seconds: 6, shot_count: 1, first_frame: "previous", last_frame: "none" },
      ],
    };
    expect((await one.PATCH(req(`/api/films/${FILM}`, "PATCH", { version: 3, patch }), params(FILM))).status).toBe(200);
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["save_film"]);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("refuses an empty patch, an unknown key, a bad version or a bad id before the database", async () => {
    for (const body of [{ version: 3, patch: {} }, { version: 3, patch: { status: "ready" } }, { version: 0, patch: { title: "x" } }, { version: "3", patch: { title: "x" } }, { version: 3, patch: [] }]) {
      expect((await one.PATCH(req(`/api/films/${FILM}`, "PATCH", body), params(FILM))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await one.PATCH(req("/api/films/nope", "PATCH", { version: 3, patch: { title: "x" } }), params("nope"))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an answer that is not a read model is a 502, not a success", async () => {
    h.rpc.mockResolvedValueOnce({ data: { film: { id: FILM } }, error: null });
    expect((await one.PATCH(req(`/api/films/${FILM}`, "PATCH", { version: 3, patch: { title: "x" } }), params(FILM))).status).toBe(502);
  });

  it("a cross-site request is refused before anything", async () => {
    const r = await one.PATCH(
      new Request(`https://app.test/api/films/${FILM}`, { method: "PATCH", headers: { origin: "https://evil.example" }, body: "{}" }),
      params(FILM),
    );
    expect(r.status).toBe(403);
    expect(h.user).not.toHaveBeenCalled();
  });
});

describe("read and archive", () => {
  it("another workspace's project reads exactly like a missing one", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "not_found" } });
    const r = await one.GET(req(`/api/films/${FILM}`), params(FILM));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });

  it("archives through archive_film with its own limit; a running project is 409 film_not_editable", async () => {
    let r = await arch.POST(req(`/api/films/${FILM}/archive`, "POST", {}), params(FILM));
    expect(r.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("archive_film", { p_film: FILM });
    expect(h.rate).toHaveBeenCalledWith("u1", expect.objectContaining({ bucket: "films.archive" }));
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "NS409", message: "film_not_editable" } });
    r = await arch.POST(req(`/api/films/${FILM}/archive`, "POST", {}), params(FILM));
    expect(r.status).toBe(409);
  });

  it("the list reads the open workspace's films, open or archived, and says when the read failed", async () => {
    const q = { eq: vi.fn(), neq: vi.fn(), order: vi.fn(), limit: vi.fn() };
    q.eq.mockReturnValue(q);
    q.neq.mockReturnValue(q);
    q.order.mockReturnValue(q);
    q.limit.mockResolvedValue({ data: [], error: null });
    h.from.mockReturnValue({ select: () => q });
    let r = await list.GET(req("/api/films?archived=1"));
    expect(r.status).toBe(200);
    expect(q.eq).toHaveBeenCalledWith("org_id", ORG);
    expect(q.eq).toHaveBeenCalledWith("status", "archived");
    q.limit.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    r = await list.GET(req("/api/films"));
    expect(r.status).toBe(502);
    q.limit.mockResolvedValue({ data: null, error: { code: "42P01", message: "relation does not exist" } });
    r = await list.GET(req("/api/films"));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "not_available" });
  });
});
