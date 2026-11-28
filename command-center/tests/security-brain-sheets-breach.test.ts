import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION, USER, makeFake, storyBrief } from "./helpers/fakeSheetsDb";
import type { RefSheet } from "@/lib/brain/ref-sheets";

/**
 * Breach on S1's character sheets (/api/brain/sheets), fakes only: no database, no model, no spend.
 * What would break without these: a person's one confirm of N credits spent twice on pictures they were never shown (a replayed or
 * retried "make" after the first jobs finished, or a stale confirm after a redo); credits held for a conversation that is already
 * handed off, where the jobs can never be recorded on the sheet (rule 6: refuse before spending); and a BRIEF written straight
 * through ai_chat_save_brief (no shape or size check in 0199) turning one GET into an unbounded fan-out of priced RPCs.
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
vi.mock("@/lib/server/films", () => ({ filmGateFor: async () => ({ ok: true }) }));

import { GET, POST } from "@/app/api/brain/sheets/route";

const get = async () => {
  const res = await GET(new Request(`http://x/api/brain/sheets?session=${SESSION}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: Record<string, unknown>) => {
  const res = await POST(new Request("http://x/api/brain/sheets", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, ...body }) }));
  return { status: res.status, body: await res.json() };
};
const creates = () => fake.state.calls.filter((c) => c.fn === "create_creative_job");
const held = () => [...fake.state.jobs.values()].reduce((a, j) => a + Number(j.quoted_credits ?? 0), 0);
const view = (sheets: RefSheet[], ch: string, stage: string | null, v: string) =>
  sheets.find((s) => s.character_id === ch && s.stage === stage)!.views.find((x) => x.view === v)!;

// One character with no stages: the front is 6 credits (t2i), the side and back 5 each (edit), in the fake's prices.
const oneCharacter = () => {
  const b = storyBrief();
  b.characters = [b.characters![1]];
  b.scenes = b.scenes!.map((s) => ({ ...s, character_ids: ["c2"], in_frame: [{ character_id: "c2", age_stage: null }] }));
  fake.state.session = { ...fake.state.session!, brief: b as unknown as Record<string, unknown> };
};

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "on";
  fake = makeFake();
});

describe("BR-RS-01: one confirm spends only on the views it was shown", () => {
  it("a replay of the same make body after one front finished buys a side and a back nobody was quoted", async () => {
    const shown = await get();
    // The panel shows three fronts (Mira child, Mira adult, Tom) at 6 each and sends exactly that total and the quote's token
    // (RefSheetsPanel make(); the token was added by the fix round, so the replay below is the panel's own body, resent).
    expect(shown.body.quote.views.map((v: { view: string }) => v.view)).toEqual(["front", "front", "front"]);
    const body = { action: "make", max_credits: shown.body.quote.total, quote_token: shown.body.quote.token };
    expect(body.max_credits).toBe(18);
    expect((await post(body)).status).toBe(200);
    expect(creates()).toHaveLength(3);
    // The worker finishes Tom's front (seconds for an image model); then the same request body arrives again: a retry by the
    // browser or a proxy, a press in a second tab still holding the old confirm, or a script resending it.
    fake.finish(view((await get()).body.sheets, "c2", null, "front").job_id!);
    const replay = await post(body);
    // Expected: refused (the confirm named three fronts; the fresh quote names Tom's side and back), nothing held.
    // Before the fix: 200 and two NEW edit jobs, 10 more credits held on an 18-credit confirm that was already spent in full.
    expect(replay.body.error).toBe("price_changed");
    expect(creates()).toHaveLength(3);
  });

  it("a redo mints a new key and a new hold under a confirm made for the previous attempt", async () => {
    oneCharacter();
    const shown = (await get()).body.quote;
    const confirm = { action: "make", max_credits: shown.total, quote_token: shown.token };
    expect((await post(confirm)).status).toBe(200);
    const front = view((await get()).body.sheets, "c2", null, "front");
    fake.finish(front.job_id!);
    expect((await post({ action: "redo", character_id: "c2", stage: null, view: "front" })).status).toBe(200);
    // No GET in between: the browser (or a script) resends the confirm it already had. The redo's own new attempt is bought on it.
    const stale = await post(confirm);
    expect(stale.body.error).toBe("price_changed");
    expect(creates()).toHaveLength(1);
  });
});

describe("BR-RS-02: a handed-off conversation is refused before anything is held", () => {
  it("make on step 'created' holds no credits (today: jobs held, then session_closed with the job ids dropped)", async () => {
    fake.state.session = { ...fake.state.session!, step: "created" };
    const r = await post({ action: "make", max_credits: 18 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("session_closed");
    // Rule 6: the refusal the save would give must come before create_creative_job, not after three holds.
    expect(creates()).toHaveLength(0);
    expect(held()).toBe(0);
  });
});

describe("BR-RS-03: a BRIEF written straight through ai_chat_save_brief cannot fan one GET out without bound", () => {
  it("200 characters (0199 stores any jsonb object; this route never re-reads the BRIEF through readBrief's caps)", async () => {
    const b = storyBrief();
    const base = b.characters![1];
    b.characters = Array.from({ length: 200 }, (_, i) => ({ ...base, id: `x${i}`, name: `N${i}` }));
    fake.state.session = { ...fake.state.session!, brief: b as unknown as Record<string, unknown> };
    await get();
    const quotes = fake.state.calls.filter((c) => c.fn === "quote_creative_job").length;
    // A bound the route owns (the BRIEF's own cap on characters x stages): today every one of the 200 fronts is quoted, one RPC
    // each, on every GET (and the panel polls GET while a job runs). POST make would queue 200 holds the same way.
    expect(quotes).toBeLessThanOrEqual(30);
  });
});
