import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION, USER, makeFake } from "./helpers/fakeSheetsDb";

/**
 * The sheets route's writes with and without migration 0249 (ai_chat_save_sheets), through fakes (no database, no spend; the merge
 * and the trigger themselves are pinned in the lab, tests/security/test_sec_sheets_writer_0249.py). What would break without these:
 * a sheets write still going through a whole BRIEF once 0249 is on (the race it closes reopens); an approval another tab saved
 * between this request's read and its write put back to "ready"; 0249's refusal of a list turned into "unavailable" or into a
 * hold; a database without 0249 left with no way to save a sheet at all.
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
import type { RefSheet } from "@/lib/brain/ref-sheets";

const get = async () => {
  const res = await GET(new Request(`http://x/api/brain/sheets?session=${SESSION}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: Record<string, unknown>) => {
  const res = await POST(new Request("http://x/api/brain/sheets", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, ...body }) }));
  return { status: res.status, body: await res.json() };
};
const make = async () => {
  const g = await get();
  return post({ action: "make", max_credits: g.body.quote.total, quote_token: g.body.quote.token });
};
const calls = (fn: string) => fake.state.calls.filter((c) => c.fn === fn);
const storedSheets = () => (fake.state.session!.brief as { ref_sheets: RefSheet[] }).ref_sheets;
const at = (sheets: RefSheet[], ch: string, stage: string | null, v: string) =>
  sheets.find((s) => s.character_id === ch && s.stage === stage)!.views.find((x) => x.view === v)!;
/** Every front made and finished by the worker: each is "ready", for the person to approve. */
const madeFronts = async () => {
  await make();
  for (const id of [...fake.state.jobs.keys()]) fake.finish(id);
  await get();
};

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "on";
  fake = makeFake();
});

describe("with 0249 applied", () => {
  beforeEach(() => { fake.state.with0249 = true; });

  it("every sheets write is ai_chat_save_sheets with the base it started from, never a whole BRIEF", async () => {
    const r = await make();
    expect(r.status).toBe(200);
    expect(calls("ai_chat_save_brief")).toHaveLength(0);
    const writes = calls("ai_chat_save_sheets");
    // The intent before the creates, the job ids after them.
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.args.p_session).toBe(SESSION);
      expect(Array.isArray(w.args.p_sheets)).toBe(true);
      expect(Array.isArray(w.args.p_base)).toBe(true);
      expect(w.args.p_film_link).toBeNull();
    }
    expect(storedSheets().flatMap((s) => s.views).filter((v) => v.status === "making" && v.job_id)).toHaveLength(3);
  });

  it("an approval another tab saved between this request's read and its write is kept", async () => {
    await madeFronts();
    // Another tab approves Mira's child front right before this request's write takes the row.
    fake.state.beforeSheetsWrite = () => {
      const s = fake.state.session!;
      const sheets = (s.brief as { ref_sheets: RefSheet[] }).ref_sheets.map((x) => x.character_id !== "c1" || x.stage !== "a1" ? x
        : { ...x, views: x.views.map((v) => v.view === "front" ? { ...v, status: "approved" as const } : v) });
      fake.state.session = { ...s, brief: { ...(s.brief as object), ref_sheets: sheets } };
    };
    const r = await post({ action: "approve", character_id: "c2", stage: null, view: "front" });
    expect(r.status).toBe(200);
    expect(at(storedSheets(), "c2", null, "front").status).toBe("approved");
    expect(at(storedSheets(), "c1", "a1", "front").status).toBe("approved");
    // And the answer is the merged list as stored, not this request's own copy.
    expect(at(r.body.sheets, "c1", "a1", "front").status).toBe("approved");
  });

  it("a chat turn's whole BRIEF after the approval keeps it (the trigger), so the next read still shows it approved", async () => {
    await madeFronts();
    expect((await post({ action: "approve", character_id: "c2", stage: null, view: "front" })).status).toBe(200);
    // The turn route's write with a copy of the sheets read before the approval.
    const stale = { ...(fake.state.session!.brief as Record<string, unknown>), title: "Turned", ref_sheets: [] };
    await fake.client.rpc("ai_chat_save_brief", { p_session: SESSION, p_brief: stale, p_step: "ready" });
    const g = await get();
    expect(at(g.body.sheets, "c2", null, "front").status).toBe("approved");
    expect((fake.state.session!.brief as { title: string }).title).toBe("Turned");
  });

  it("a list 0249 refuses is said by name, and nothing is held", async () => {
    fake.state.sheetsError = { code: "NS400", message: "too_many_sheets", details: "at most 40 sheets" };
    const r = await make();
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("too_many_sheets");
    expect(calls("create_creative_job")).toHaveLength(0);
  });

  it("the plan's state is said as 0249 reads it under the lock: not ready (with its step), handed off, a project's own", async () => {
    await madeFronts();
    const approve = () => post({ action: "approve", character_id: "c2", stage: null, view: "front" });
    fake.state.sheetsError = { code: "NS409", message: "plan_not_ready", details: "proposing" };
    expect(await approve()).toEqual({ status: 409, body: { error: "plan_not_ready", step: "proposing" } });
    fake.state.sheetsError = { code: "NS409", message: "session_closed", details: "handed off" };
    expect(await approve()).toEqual({ status: 409, body: { error: "session_closed" } });
    fake.state.sheetsError = { code: "NS409", message: "film_conversation", details: "x" };
    expect(await approve()).toEqual({ status: 409, body: { error: "film_conversation" } });
    fake.state.sheetsError = { code: "XX000", message: "relation does not exist", details: "" };
    expect(await approve()).toEqual({ status: 503, body: { error: "unavailable" } });
    fake.state.sheetsError = { code: "NS404", message: "session_not_found", details: "" };
    expect((await approve()).status).toBe(404);
    expect(calls("ai_chat_save_brief")).toHaveLength(0);
  });
});

describe("without 0249 (the function missing)", () => {
  it("falls back to #980's path: the conversation read again, merged here, the whole BRIEF through 0199", async () => {
    const r = await make();
    expect(r.status).toBe(200);
    // Each write asks 0249 first and is told it is not there (PGRST202), then saves as before.
    expect(calls("ai_chat_save_sheets")).toHaveLength(2);
    const briefs = calls("ai_chat_save_brief");
    expect(briefs).toHaveLength(2);
    expect(briefs.every((c) => c.args.p_step === "ready" && Array.isArray((c.args.p_brief as { ref_sheets?: unknown }).ref_sheets))).toBe(true);
    expect(storedSheets().flatMap((s) => s.views).filter((v) => v.status === "making" && v.job_id)).toHaveLength(3);
  });

  it("an approval is saved the same way", async () => {
    await madeFronts();
    const r = await post({ action: "approve", character_id: "c2", stage: null, view: "front" });
    expect(r.status).toBe(200);
    expect(at(storedSheets(), "c2", null, "front").status).toBe("approved");
  });
});
