import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILM, SESSION, USER, look, makeFake, sellable, storyBrief } from "./helpers/fakeSheetsDb";

/**
 * /api/brain/sheets through fakes (no database, no model, no spend). What would break without these: a price the browser made up or
 * one missing a view; a hold before the person's confirm, or on a set they did not confirm; a double press holding twice; a side or
 * back drawn from words instead of from the front; a paid picture lost from the sheet when a save fails; a refusal turned into a
 * generic error (or into a number); references written into a film whose key-frame model cannot take them on the worker's path,
 * which prices a film that then refuses at submit; or written into the wrong scenes.
 */

vi.mock("server-only", () => ({}));
let fake = makeFake();
let age: "adult" | "none" = "adult";
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client, getUser: async () => ({ id: USER }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: "x", source: "org" }) }));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => null }));
vi.mock("@/lib/server/age", () => ({ readAgeState: async () => age }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: null }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/geo", () => ({ geoRefusal: () => null }));
vi.mock("@/lib/server/geo-claim", () => ({ geoClaimHeaders: () => undefined }));
const films = vi.hoisted(() => ({ open: true }));
vi.mock("@/lib/server/films", () => ({ filmGateFor: async () => (films.open ? { ok: true } : { ok: false, response: new Response(JSON.stringify({ error: "not_found" }), { status: 404 }) }) }));

import { GET, POST } from "@/app/api/brain/sheets/route";
import type { RefSheet } from "@/lib/brain/ref-sheets";

const get = async (film = false) => {
  const res = await GET(new Request(`http://x/api/brain/sheets?session=${SESSION}${film ? `&film=${FILM}` : ""}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: Record<string, unknown>) => {
  const res = await POST(new Request("http://x/api/brain/sheets", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, ...body }) }));
  return { status: res.status, body: await res.json() };
};
/** The panel's press: the quote it was shown (total and token), sent back as the confirm. */
const make = async (film = false) => {
  const g = await get(film);
  return post({ action: "make", ...(film ? { film: FILM } : {}), max_credits: g.body.quote.total, quote_token: g.body.quote.token });
};
const creates = () => fake.state.calls.filter((c) => c.fn === "create_creative_job");
const sheetsOf = (b: { sheets: RefSheet[] }) => b.sheets;
const view = (sheets: RefSheet[], ch: string, stage: string | null, v: string) => sheets.find((s) => s.character_id === ch && s.stage === stage)!.views.find((x) => x.view === v)!;
const storedSheets = () => (fake.state.session!.brief as { ref_sheets: RefSheet[] }).ref_sheets;

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "on";
  fake = makeFake();
  age = "adult";
  films.open = true;
});

describe("the quote", () => {
  it("sums the database's own quote of every front, with the token of that set; holds and writes nothing", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    // Mira child, Mira adult, Tom: three sheets, three fronts priced by quote_creative_job at 6 each.
    expect(body.quote.views).toHaveLength(3);
    expect(body.quote.views.every((v: { view: string }) => v.view === "front")).toBe(true);
    expect(body.quote.total).toBe(18);
    expect(body.quote.waiting).toBe(6);
    expect(body.quote.token).toMatch(/^[0-9a-f]{32}$/);
    expect(creates()).toHaveLength(0);
    expect(fake.state.saved).toHaveLength(0);
  });

  it("says the gate is closed for today's key-frame model, and names the model the sheets are drawn with", async () => {
    const { body } = await get();
    expect(body.gate).toEqual({ open: false, reason: "refs_not_on_keyframe" });
    expect(body.model).toEqual({ name: "Name of openai-gpt-image-2.6-sunburst", film_own: "same" });
  });

  it("says why the model is not the film's own: none set, or one that cannot make sheets", async () => {
    fake.state.session = { ...fake.state.session!, brief: storyBrief({ scenes: storyBrief().scenes!.map((s) => ({ ...s, keyframe_model: null })) }) as unknown as Record<string, unknown> };
    expect((await get()).body.model.film_own).toBe("none");
    fake.state.film = fake.filmRow({ keyframe_model: "some-t2i-only" });
    expect((await get(true)).body.model.film_own).toBe("unable");
  });

  it("refuses by name when no sellable model does both t2i and edit, and holds nothing", async () => {
    fake.state.edit = [];
    const { body } = await get();
    expect(body.refusal).toBe("no_sheet_model");
    expect(body.quote).toBeNull();
    expect(body.gate).toBeNull();
    const made = await post({ action: "make", max_credits: 100, quote_token: "x" });
    expect(made.body.error).toBe("no_sheet_model");
    expect(creates()).toHaveLength(0);
  });

  it("passes a quote refusal on by name, never as a number", async () => {
    fake.state.prices.t2i = Number.NaN;
    const { body } = await get();
    expect(body.quote).toBeNull();
    expect(body.refusal).toBe("failed");
  });

  it("the states-only read the panel polls asks no catalogue and no quote", async () => {
    const res = await GET(new Request(`http://x/api/brain/sheets?session=${SESSION}&states=1`));
    expect(Object.keys(await res.json())).toEqual(["sheets"]);
    expect(fake.state.calls.filter((c) => c.fn === "quote_creative_job" || c.fn === "sellable_models")).toHaveLength(0);
  });
});

describe("making the sheets", () => {
  it("needs the confirmed set: no token, another token or a higher price is refused before anything is held", async () => {
    expect((await post({ action: "make", max_credits: 18 })).body.error).toBe("confirm_price");
    expect((await post({ action: "make", max_credits: 18, quote_token: "0".repeat(32) })).body.error).toBe("price_changed");
    const g = await get();
    const r = await post({ action: "make", max_credits: 17, quote_token: g.body.quote.token });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("price_changed");
    expect(r.body.quote.total).toBe(18);
    expect(creates()).toHaveLength(0);
  });

  it("saves every view's key BEFORE its create, makes the fronts by t2i one job per key, and a repeat holds nothing new", async () => {
    const r = await make();
    expect(r.status).toBe(200);
    const c = creates();
    expect(c).toHaveLength(3);
    expect(c.every((x) => x.args.p_capability === "t2i" && x.args.p_mode === "exact" && x.args.p_max_credits === 6)).toBe(true);
    // The first save is the intent: every view to make is "making" with the key its job is then created with, and no job id yet.
    const intent = (fake.state.saved[0].ref_sheets as RefSheet[]).flatMap((s) => s.views).filter((v) => v.status === "making");
    expect(intent).toHaveLength(3);
    expect(intent.every((v) => !v.job_id && /^sheet:[0-9a-f]{48}$/.test(v.key!))).toBe(true);
    expect(new Set(c.map((x) => x.args.p_idempotency_key))).toEqual(new Set(intent.map((v) => v.key)));
    expect(view(sheetsOf(r.body), "c1", "a1", "front").status).toBe("making");
    const again = await post({ action: "make", max_credits: 18, quote_token: "x" });
    expect(again.body.error).toBe("nothing_to_make");
    expect(fake.state.jobs.size).toBe(3);
  });

  it("a save that fails after the creates says the pictures were started (never 'nothing held'), and the keys find them again", async () => {
    // Save 1 is the intent; save 2, after the creates, fails.
    fake.state.failSaveAt = [2];
    const r = await make();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("sheets_not_saved");
    expect(r.body.started).toBe(3);
    expect(sheetsOf(r.body).flatMap((s) => s.views).filter((v) => v.job_id)).toHaveLength(3);
    // Stored: only the intent (keys, no ids). The next read finds each job by its key, in this workspace only.
    expect(storedSheets().flatMap((s) => s.views).filter((v) => v.job_id)).toHaveLength(0);
    const g = await get();
    expect(sheetsOf(g.body).flatMap((s) => s.views).filter((v) => v.status === "making" && v.job_id)).toHaveLength(3);
    expect(fake.state.reads.some((x) => x.inKey === "idempotency_key" && x.filters.org_id === fake.state.session!.org_id)).toBe(true);
    expect(g.body.quote.views).toHaveLength(0);
  });

  it("an intent that never reached create_creative_job is to make again, nothing held", async () => {
    fake.state.createError = { code: "NS402", message: "insufficient_credits", details: "available=0 needed=6" };
    fake.state.failSaveAt = [2];
    await make();
    const g = await get();
    expect(sheetsOf(g.body).flatMap((s) => s.views).filter((v) => v.status === "making")).toHaveLength(0);
    expect(g.body.quote.views).toHaveLength(3);
  });

  it("makes the side and the back as edits of the front's own picture, once the front is made (a refresh reads the job)", async () => {
    await make();
    const frontJob = view(sheetsOf((await get()).body), "c2", null, "front").job_id!;
    const front = fake.finish(frontJob);
    const g = await get();
    expect(view(sheetsOf(g.body), "c2", null, "front")).toMatchObject({ status: "ready", asset_id: front });
    expect(g.body.quote.views).toEqual([{ character_id: "c2", stage: null, view: "side", credits: 5 }, { character_id: "c2", stage: null, view: "back", credits: 5 }]);
    const before = creates().length;
    await make();
    const edits = creates().slice(before);
    expect(edits.map((x) => x.args.p_capability)).toEqual(["edit", "edit"]);
    expect(edits.every((x) => (x.args.p_params as { source_asset_id?: string }).source_asset_id === front)).toBe(true);
  });

  it("the side and back intents are stored before their creates too, over the stored 'planned' views", async () => {
    oneCharacter();
    await make();
    fake.finish(view(sheetsOf((await get()).body), "c2", null, "front").job_id!);
    const savesBefore = fake.state.saved.length;
    const createsBefore = creates().length;
    fake.state.failSaveAt = [fake.state.saveCount + 2];
    const r = await make();
    expect(r.body.error).toBe("sheets_not_saved");
    expect(creates().length - createsBefore).toBe(2);
    const intent = (fake.state.saved[savesBefore].ref_sheets as RefSheet[])[0].views.filter((v) => v.view !== "front");
    expect(intent.every((v) => v.status === "making" && v.key && !v.job_id)).toBe(true);
    // And the keys find both jobs on the next read, so neither is quoted or held again.
    const g = await get();
    expect(sheetsOf(g.body)[0].views.filter((v) => v.status === "making" && v.job_id)).toHaveLength(2);
    expect(g.body.quote.views).toHaveLength(0);
  });

  it("passes insufficient credits on by name, with what was started before it", async () => {
    fake.state.createError = { code: "NS402", message: "insufficient_credits", details: "available=3 needed=6" };
    const r = await make();
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: "insufficient_credits", available: 3, started: 0 });
  });

  it("a failed front is retried as a new attempt (a new key), never a replay of the failure", async () => {
    await make();
    const id = view(sheetsOf((await get()).body), "c2", null, "front").job_id!;
    fake.state.jobs.set(id, { ...fake.state.jobs.get(id), status: "failed", error_code: "provider_error" });
    const g = await get();
    expect(view(sheetsOf(g.body), "c2", null, "front")).toMatchObject({ status: "failed", error: "provider_error", attempt: 1 });
    expect(g.body.quote.views).toEqual([{ character_id: "c2", stage: null, view: "front", credits: 6 }]);
    const oldKey = creates()[0].args.p_idempotency_key;
    const before = creates().length;
    await make();
    const retry = creates().slice(before);
    expect(retry).toHaveLength(1);
    expect(new Set(creates().map((x) => x.args.p_idempotency_key)).size).toBe(4);
    expect(retry[0].args.p_idempotency_key).not.toBe(oldKey);
  });

  it("approves a made view; a redone front takes its made side and back with it, each a new attempt", async () => {
    oneCharacter();
    await make();
    fake.finish(view(sheetsOf((await get()).body), "c2", null, "front").job_id!);
    await make();
    for (const v of sheetsOf((await get()).body)[0].views) if (v.status === "making") fake.finish(v.job_id!);
    expect((await post({ action: "approve", character_id: "c2", stage: null, view: "side" })).status).toBe(200);
    const redo = await post({ action: "redo", character_id: "c2", stage: null, view: "front" });
    const views = sheetsOf(redo.body)[0].views;
    expect(views.map((v) => [v.view, v.status, v.attempt, v.asset_id])).toEqual([
      ["front", "planned", 1, null], ["side", "planned", 1, null], ["back", "planned", 1, null]]);
    expect(creates()).toHaveLength(3);
  });
});

function oneCharacter() {
  const b = storyBrief();
  b.characters = [b.characters![1]];
  b.scenes = b.scenes!.map((s) => ({ ...s, character_ids: ["c2"], in_frame: [{ character_id: "c2", age_stage: null }] }));
  fake.state.session = { ...fake.state.session!, brief: b as unknown as Record<string, unknown> };
}

describe("a chat turn and a choice again (Lens H1)", () => {
  async function madeTom() {
    oneCharacter();
    await make();
    fake.finish(view(sheetsOf((await get()).body), "c2", null, "front").job_id!);
  }
  /** What the turn route does now: a new BRIEF with the stored sheets carried (carrySheets), here with Tom's look `o`. */
  const chooseAgain = (o: Record<string, unknown>) => {
    const stored = fake.state.session!.brief as Record<string, unknown>;
    const b = storyBrief();
    b.characters = [{ ...b.characters![1], ...o }];
    b.scenes = b.scenes!.map((s) => ({ ...s, character_ids: ["c2"], in_frame: [{ character_id: "c2", age_stage: null }] }));
    fake.state.session = { ...fake.state.session!, brief: { ...(b as unknown as Record<string, unknown>), ref_sheets: stored.ref_sheets } };
  };

  it("with the same look: shown as already made, not priced again", async () => {
    await madeTom();
    chooseAgain({});
    const g = await get();
    expect(view(sheetsOf(g.body), "c2", null, "front").status).toBe("ready");
    expect(g.body.quote.views.map((v: { view: string }) => v.view)).toEqual(["side", "back"]);
  });

  it("with a changed look: exactly one new hold (the new front), under a new key", async () => {
    await madeTom();
    const oldKey = creates()[0].args.p_idempotency_key;
    chooseAgain({ look: look("Tom older") });
    const before = creates().length;
    const r = await make();
    expect(r.status).toBe(200);
    const fresh = creates().slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].args.p_idempotency_key).not.toBe(oldKey);
    expect(String((fresh[0].args.p_params as { prompt: string }).prompt)).toContain("Tom older face");
  });

  it("keeps what another writer saved meanwhile: only ref_sheets is merged into the BRIEF read right before the write", async () => {
    // A chat turn writes the BRIEF while this press is creating its jobs.
    const orig = fake.client.rpc.bind(fake.client);
    fake.client.rpc = (fn: string, args: Record<string, unknown>) => {
      if (fn === "create_creative_job") fake.state.session = { ...fake.state.session!, brief: { ...(fake.state.session!.brief as object), title: "Changed meanwhile" } };
      return orig(fn, args);
    };
    await make();
    expect((fake.state.session!.brief as { title: string }).title).toBe("Changed meanwhile");
    expect(storedSheets().flatMap((s) => s.views).filter((v) => v.job_id)).toHaveLength(3);
  });
});

describe("writes only while the plan is writable (Breach BR-RS-02, Lens L5)", () => {
  for (const [step, code] of [["created", "session_closed"], ["proposing", "plan_not_ready"], ["asking", "plan_not_ready"]] as const) {
    it(`step ${step}: make, approve, redo and attach are refused as ${code} before any quote or create`, async () => {
      fake.state.session = { ...fake.state.session!, step };
      for (const body of [{ action: "make", max_credits: 18, quote_token: "x" }, { action: "approve", character_id: "c2", stage: null, view: "front" },
                          { action: "redo", character_id: "c2", stage: null, view: "front" }, { action: "attach", film: FILM }]) {
        fake.state.film = fake.filmRow();
        const r = await post(body);
        expect(r.status).toBe(409);
        expect(r.body.error).toBe(code);
      }
      expect(fake.state.calls.filter((c) => c.fn === "quote_creative_job" || c.fn === "create_creative_job" || c.fn === "save_film")).toHaveLength(0);
    });
  }
});

describe("the gate decides whether anything reaches the film", () => {
  async function approveAll() {
    expect((await make(true)).status).toBe(200);
    for (const s of sheetsOf((await get(true)).body)) fake.finish(s.views[0].job_id!);
    expect((await make(true)).status).toBe(200);
    for (const s of sheetsOf((await get(true)).body)) for (const v of s.views) if (v.status === "making") fake.finish(v.job_id!);
    for (const s of sheetsOf((await get(true)).body)) for (const v of s.views) await post({ action: "approve", film: FILM, character_id: s.character_id, stage: s.stage, view: v.view });
  }
  const gemini = (o: Record<string, unknown> = {}) => sellable("fake-gemini", { requires_adult: true, inputs: { image_refs_max: 14, ref_capabilities: ["t2i", "edit"] }, image_sizes: ["1K", "2K", "4K"], ...o });
  function openGate(o: Record<string, unknown> = {}) {
    fake.state.t2i = [gemini(o), sellable("openai-gpt-image-2.6-sunburst")];
    fake.state.edit = [gemini(o)];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-gemini" });
  }
  const saves = () => fake.state.calls.filter((c) => c.fn === "save_film");

  it("closed (today's key-frame model takes references on edit only): no reference is written, nothing is saved to the film", async () => {
    fake.state.film = fake.filmRow();
    await approveAll();
    const r = await post({ action: "attach", film: FILM });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "refs_not_supported", reason: "refs_not_on_keyframe" });
    expect(saves()).toHaveLength(0);
  });

  it("closed when the registry has no ref_capabilities and the model is unknown to the adapters' twin", async () => {
    fake.state.t2i = [sellable("fake-new-image")];
    fake.state.edit = [sellable("fake-new-image")];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-new-image" });
    expect((await get(true)).body.gate).toEqual({ open: false, reason: "refs_unknown" });
  });

  it("closed for a terms-gated model, and for an 18+ model when the person has not confirmed their age", async () => {
    fake.state.t2i = [sellable("fake-gated", { terms_gate: "terms_review_required", inputs: { image_refs_max: 14, ref_capabilities: ["t2i"] } }), sellable("openai-gpt-image-2.6-sunburst")];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-gated" });
    expect((await get(true)).body.gate).toEqual({ open: false, reason: "terms_gated" });
    fake.state.t2i = [sellable("fake-gated", { requires_adult: true, inputs: { image_refs_max: 14, ref_capabilities: ["t2i"] } }), sellable("openai-gpt-image-2.6-sunburst")];
    age = "none";
    expect((await get(true)).body.gate).toEqual({ open: false, reason: "adult_attestation_required" });
  });

  it("open for a sellable Gemini-like model: asset_id refs on the LINKED scenes, one view per character, <= 14, <= 4 characters", async () => {
    openGate();
    expect((await get(true)).body.gate).toEqual({ open: true });
    await approveAll();
    // Sold by size: the sheets ask for the smallest one, which the quote prices.
    expect((creates()[0].args.p_params as { image_size?: string }).image_size).toBe("1K");
    const r = await post({ action: "attach", film: FILM });
    expect(r.status).toBe(200);
    expect(r.body.attached).toBe(2);
    const scenes = (saves()[0].args.p_patch as { scenes: { id: string; refs?: { kind: string; asset_id?: string; character_id?: string }[]; visual_prompt?: string }[] }).scenes;
    expect(scenes.map((s) => s.id)).toEqual(["dddddddd-0000-4000-8000-000000000901", "dddddddd-0000-4000-8000-000000000902"]);
    for (const s of scenes) {
      expect(s.refs!.length).toBeLessThanOrEqual(14);
      expect(s.refs!.length).toBeLessThanOrEqual(4);
      expect(s.refs!.every((x) => x.kind === "character" && typeof x.asset_id === "string" && x.character_id === undefined)).toBe(true);
    }
    // Scene 1: Mira as a child and Tom, front views (a wide shot); scene 2: adult Mira from behind, the back view.
    expect(scenes[0].refs).toHaveLength(2);
    expect(scenes[0].visual_prompt).toBe("v1\nReference pictures: Mira (child) should reference Image 0. Tom should reference Image 1.");
    expect(scenes[1].refs![0].asset_id).toBe(view(sheetsOf((await get(true)).body), "c1", "a2", "back").asset_id);
    expect(r.body.film_quote).toMatchObject({ priced: true });
  });

  it("a second attach says it is already attached, and writes nothing", async () => {
    openGate();
    await approveAll();
    await post({ action: "attach", film: FILM });
    const json = fake.state.film!.json as { scenes: Record<string, unknown>[] };
    const patch = (saves()[0].args.p_patch as { scenes: Record<string, unknown>[] }).scenes;
    json.scenes = json.scenes.map((s, i) => ({ ...s, refs: patch[i].refs, visual_prompt: patch[i].visual_prompt }));
    const again = await post({ action: "attach", film: FILM });
    expect(again.body.error).toBe("already_attached");
    expect(saves()).toHaveLength(1);
  });

  it("refuses a film that is not this plan's own draft, and a storyboard that no longer matches its link", async () => {
    openGate();
    await approveAll();
    const b = fake.state.session!.brief as Record<string, unknown>;
    fake.state.session = { ...fake.state.session!, brief: { ...b, film_link: { film_id: "ffffffff-0000-4000-8000-000000000001", scenes: [] } } };
    expect((await post({ action: "attach", film: FILM })).body.error).toBe("not_this_film");
    fake.state.session = { ...fake.state.session!, brief: b };
    const json = fake.state.film!.json as { scenes: Record<string, unknown>[] };
    json.scenes = [json.scenes[1]];
    expect((await post({ action: "attach", film: FILM })).body.error).toBe("storyboard_changed");
    expect(saves()).toHaveLength(0);
  });

  it("measures the prompt against the smaller of the film's and the model's limits, by scene; an unknown limit is named", async () => {
    openGate({ limits: { max_prompt_chars: 40 } });
    await approveAll();
    expect((await post({ action: "attach", film: FILM })).body).toMatchObject({ error: "attach_prompt_too_long", scene: 1, limit: 40 });
    openGate();
    (fake.state.film!.json as { limits?: unknown }).limits = {};
    expect((await post({ action: "attach", film: FILM })).body).toMatchObject({ error: "prompt_limit_unknown", scene: 1 });
    expect(saves()).toHaveLength(0);
  });

  it("refuses by name, and writes nothing, when a picture's stored size is unknown", async () => {
    openGate();
    await approveAll();
    for (const [k, a] of fake.state.assets) fake.state.assets.set(k, { ...a, bytes: null });
    const r = await post({ action: "attach", film: FILM });
    expect(r.body).toEqual({ error: "ref_size_unknown", scene: 1 });
    expect(saves()).toHaveLength(0);
  });
});
