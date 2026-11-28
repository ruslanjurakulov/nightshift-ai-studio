import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILM, OTHER_ORG, SESSION, USER, makeFake } from "./helpers/fakeSheetsDb";

/**
 * /api/brain/sheets against another workspace and a member who may not spend (lab-free: fakes only). What would break without these:
 * a person reading or spending on another person's conversation by its id; a film of another workspace priced, read or given
 * references through this route; a member without a spender's seat starting a paid job (the database refuses it, and the route must
 * pass that on by name and record no job).
 */

vi.mock("server-only", () => ({}));
let fake = makeFake();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client, getUser: async () => ({ id: USER }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: "x", source: "org" }) }));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => null }));
vi.mock("@/lib/server/age", () => ({ readAgeState: async () => "adult" }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: null }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/geo", () => ({ geoRefusal: () => null }));
vi.mock("@/lib/server/geo-claim", () => ({ geoClaimHeaders: () => undefined }));
const films = vi.hoisted(() => ({ open: true }));
vi.mock("@/lib/server/films", () => ({ filmGateFor: async () => (films.open ? { ok: true } : { ok: false, response: new Response(JSON.stringify({ error: "not_found" }), { status: 404 }) }) }));

import { GET, POST } from "@/app/api/brain/sheets/route";

const post = async (body: Record<string, unknown>) => {
  const res = await POST(new Request("http://x/api/brain/sheets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const spent = () => fake.state.calls.filter((c) => c.fn === "quote_creative_job" || c.fn === "create_creative_job" || c.fn === "save_film");

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "on";
  fake = makeFake();
});

describe("IDOR", () => {
  it("another person's conversation reads as missing, and nothing is quoted or made", async () => {
    fake.state.session = { ...fake.state.session!, created_by: "ffffffff-0000-4000-8000-000000000009" };
    expect((await GET(new Request(`http://x/api/brain/sheets?session=${SESSION}`))).status).toBe(404);
    expect((await post({ session: SESSION, action: "make", max_credits: 100 })).status).toBe(404);
    expect(spent()).toHaveLength(0);
  });

  it("another workspace's film reads as missing (film_json's own not_found), and nothing is written to it", async () => {
    fake.state.film = { ...fake.filmRow(), org_id: OTHER_ORG };
    expect((await GET(new Request(`http://x/api/brain/sheets?session=${SESSION}&film=${FILM}`))).status).toBe(404);
    expect((await post({ session: SESSION, film: FILM, action: "attach" })).status).toBe(404);
    expect(spent()).toHaveLength(0);
  });

  it("a project Film Studio's switches close (or whose workspace is off) is not read, priced or given references here", async () => {
    fake.state.film = fake.filmRow();
    films.open = false;
    try {
      expect((await post({ session: SESSION, film: FILM, action: "attach" })).status).toBe(404);
      expect(fake.state.calls.some((c) => c.fn === "film_json")).toBe(false);
    } finally {
      films.open = true;
    }
  });

  it("a film readable here but of another workspace than the conversation reads as missing too", async () => {
    const f = fake.filmRow();
    (f.json.film as Record<string, unknown>).org_id = OTHER_ORG;
    fake.state.film = f;
    expect((await post({ session: SESSION, film: FILM, action: "make", max_credits: 100 })).status).toBe(404);
    expect(spent()).toHaveLength(0);
  });

  it("a character or view this conversation does not have reads as missing", async () => {
    expect((await post({ session: SESSION, action: "approve", character_id: "c9", stage: null, view: "front" })).status).toBe(404);
    expect((await post({ session: SESSION, action: "approve", character_id: "c2", stage: null, view: "top" })).status).toBe(404);
  });

  it("a malformed id is a 400 before anything is read", async () => {
    expect((await post({ session: "../x", action: "make", max_credits: 1 })).status).toBe(400);
    expect((await post({ session: SESSION, film: "x' or 1=1", action: "attach" })).status).toBe(400);
  });
});

describe("a member who may not spend", () => {
  it("is refused by the database at the hold, passed on by name, with no job recorded", async () => {
    fake.state.createError = { code: "NS400", message: "not_a_member" };
    const r = await post({ session: SESSION, action: "make", max_credits: 18 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_a_member");
    expect(fake.state.jobs.size).toBe(0);
    expect((r.body.sheets as { views: { job_id?: string | null }[] }[]).flatMap((s) => s.views).every((v) => !v.job_id)).toBe(true);
    fake.state.createError = { code: "42501", message: "forbidden" };
    expect((await post({ session: SESSION, action: "make", max_credits: 18 })).body.error).toBe("forbidden");
  });
});
