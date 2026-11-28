import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILM, SESSION, USER, makeFake, sellable } from "./helpers/fakeSheetsDb";

/**
 * /api/brain/sheets through fakes (no database, no model, no spend). What would break without these: a price the browser made up or
 * one missing a view; a hold before the person's confirm; a double press holding twice; a side or back drawn from words instead of
 * from the front; a refusal turned into a generic error (or into a number); references written into a film whose key-frame model
 * cannot take them on the worker's path, which prices a film that then refuses at submit.
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
import { viewKey } from "@/lib/server/brain/ref-sheets";
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
const creates = () => fake.state.calls.filter((c) => c.fn === "create_creative_job");
const sheetsOf = (b: { sheets: RefSheet[] }) => b.sheets;
const view = (sheets: RefSheet[], ch: string, stage: string | null, v: string) => sheets.find((s) => s.character_id === ch && s.stage === stage)!.views.find((x) => x.view === v)!;

beforeEach(() => {
  process.env.NIGHTSHIFT_AI_CHAT = "on";
  fake = makeFake();
  age = "adult";
});

describe("the quote", () => {
  it("sums the database's own quote of every front, holds nothing, and says the side and back views wait for their front", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    // Mira child, Mira adult, Tom: three sheets, three fronts priced by quote_creative_job at 6 each.
    expect(body.quote.views).toHaveLength(3);
    expect(body.quote.views.every((v: { view: string }) => v.view === "front")).toBe(true);
    expect(body.quote.total).toBe(18);
    expect(body.quote.waiting).toBe(6);
    expect(fake.state.calls.filter((c) => c.fn === "quote_creative_job")).toHaveLength(3);
    expect(creates()).toHaveLength(0);
    expect(fake.state.saved).toHaveLength(0);
  });

  it("says the gate is closed for today's key-frame model, and names the model the sheets are drawn with", async () => {
    const { body } = await get();
    expect(body.gate).toEqual({ open: false, reason: "refs_not_on_keyframe" });
    expect(body.model).toEqual({ name: "Name of openai-gpt-image-2.6-sunburst", film_own: true });
  });

  it("refuses by name when no sellable model does both t2i and edit, and holds nothing", async () => {
    fake.state.edit = [];
    const { body } = await get();
    expect(body.refusal).toBe("no_sheet_model");
    expect(body.quote).toBeNull();
    const made = await post({ action: "make", max_credits: 100 });
    expect(made.status).toBe(409);
    expect(made.body.error).toBe("no_sheet_model");
    expect(creates()).toHaveLength(0);
  });

  it("passes a quote refusal on by name, never as a number", async () => {
    fake.state.prices.t2i = Number.NaN;
    const { body } = await get();
    expect(body.quote).toBeNull();
    expect(body.refusal).toBe("failed");
  });
});

describe("making the sheets", () => {
  it("needs the confirmed total, and refuses a higher price before anything is held", async () => {
    expect((await post({ action: "make" })).body.error).toBe("confirm_price");
    const r = await post({ action: "make", max_credits: 17 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("price_changed");
    expect(r.body.quote.total).toBe(18);
    expect(creates()).toHaveLength(0);
  });

  it("makes the fronts by t2i, one job per view with its own key; a second press replays them and holds nothing new", async () => {
    const r = await post({ action: "make", max_credits: 18 });
    expect(r.status).toBe(200);
    const c = creates();
    expect(c).toHaveLength(3);
    expect(c.every((x) => x.args.p_capability === "t2i" && x.args.p_mode === "exact")).toBe(true);
    expect(c.every((x) => x.args.p_max_credits === 6)).toBe(true);
    expect(new Set(c.map((x) => x.args.p_idempotency_key)).size).toBe(3);
    expect(c[0].args.p_idempotency_key).toBe(viewKey(SESSION, { character_id: "c1", stage: "a1" }, "front", 0));
    expect(view(sheetsOf(r.body), "c1", "a1", "front").status).toBe("making");
    // Nothing is makeable now (the fronts are running): a repeat is refused by name, never a second hold.
    const again = await post({ action: "make", max_credits: 18 });
    expect(again.body.error).toBe("nothing_to_make");
    expect(fake.state.jobs.size).toBe(3);
  });

  it("makes the side and the back as edits of the front's own picture, once the front is made (a refresh reads the job)", async () => {
    await post({ action: "make", max_credits: 18 });
    const frontJob = view(sheetsOf((await get()).body), "c2", null, "front").job_id!;
    const front = fake.finish(frontJob);
    const g = await get();
    expect(view(sheetsOf(g.body), "c2", null, "front")).toMatchObject({ status: "ready", asset_id: front });
    expect(g.body.quote.views).toEqual([{ character_id: "c2", stage: null, view: "side", credits: 5 }, { character_id: "c2", stage: null, view: "back", credits: 5 }]);
    const before = creates().length;
    await post({ action: "make", max_credits: 10 });
    const edits = creates().slice(before);
    expect(edits.map((x) => x.args.p_capability)).toEqual(["edit", "edit"]);
    expect(edits.every((x) => (x.args.p_params as { source_asset_id?: string }).source_asset_id === front)).toBe(true);
  });

  it("passes insufficient credits on by name, and keeps the jobs queued before it", async () => {
    fake.state.createError = { code: "NS402", message: "insufficient_credits", details: "available=3 needed=6" };
    const r = await post({ action: "make", max_credits: 18 });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("insufficient_credits");
    expect(r.body.available).toBe(3);
  });

  it("a failed front is retried as a new attempt (a new key), never a replay of the failure", async () => {
    await post({ action: "make", max_credits: 18 });
    const id = view(sheetsOf((await get()).body), "c2", null, "front").job_id!;
    fake.state.jobs.set(id, { ...fake.state.jobs.get(id), status: "failed", error_code: "provider_error" });
    const g = await get();
    expect(view(sheetsOf(g.body), "c2", null, "front")).toMatchObject({ status: "failed", error: "provider_error", attempt: 1 });
    expect(g.body.quote.views).toEqual([{ character_id: "c2", stage: null, view: "front", credits: 6 }]);
    const before = creates().length;
    await post({ action: "make", max_credits: 6 });
    expect(creates().slice(before)[0].args.p_idempotency_key).toBe(viewKey(SESSION, { character_id: "c2", stage: null }, "front", 1));
  });

  it("approves a made view and redoes it as a new, quoted job", async () => {
    await post({ action: "make", max_credits: 18 });
    const id = view(sheetsOf((await get()).body), "c2", null, "front").job_id!;
    fake.finish(id);
    expect((await post({ action: "approve", character_id: "c2", stage: null, view: "side" })).body.error).toBe("not_ready");
    const ok = await post({ action: "approve", character_id: "c2", stage: null, view: "front" });
    expect(view(sheetsOf(ok.body), "c2", null, "front").status).toBe("approved");
    const redo = await post({ action: "redo", character_id: "c2", stage: null, view: "front" });
    expect(view(sheetsOf(redo.body), "c2", null, "front")).toMatchObject({ status: "planned", asset_id: null, attempt: 1 });
    expect(creates()).toHaveLength(3);
  });
});

describe("the gate decides whether anything reaches the film", () => {
  async function approveAll() {
    expect((await post({ action: "make", film: FILM, max_credits: 18 })).status).toBe(200);
    for (const s of sheetsOf((await get(true)).body)) fake.finish(s.views[0].job_id!);
    expect((await post({ action: "make", film: FILM, max_credits: 30 })).status).toBe(200);
    for (const s of sheetsOf((await get(true)).body)) for (const v of s.views) if (v.status === "making") fake.finish(v.job_id!);
    for (const s of sheetsOf((await get(true)).body)) for (const v of s.views) await post({ action: "approve", film: FILM, character_id: s.character_id, stage: s.stage, view: v.view });
  }

  it("closed (today's key-frame model takes references on edit only): no reference is written, nothing is saved to the film", async () => {
    fake.state.film = fake.filmRow();
    await approveAll();
    const r = await post({ action: "attach", film: FILM });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "refs_not_supported", reason: "refs_not_on_keyframe" });
    expect(fake.state.calls.some((c) => c.fn === "save_film")).toBe(false);
  });

  it("closed when the registry has no ref_capabilities and the model is unknown to the adapters' twin", async () => {
    fake.state.t2i = [sellable("fake-new-image")];
    fake.state.edit = [sellable("fake-new-image")];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-new-image" });
    expect((await get(true)).body.gate).toEqual({ open: false, reason: "refs_unknown" });
  });

  it("closed for a terms-gated model, and for an 18+ model when the person has not confirmed their age", async () => {
    fake.state.t2i = [sellable("fake-gated", { terms_gate: "terms_review_required", ref_capabilities: ["t2i", "edit"] }), sellable("openai-gpt-image-2.6-sunburst")];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-gated" });
    expect((await get(true)).body.gate).toEqual({ open: false, reason: "terms_gated" });
    fake.state.t2i = [sellable("fake-gated", { requires_adult: true, ref_capabilities: ["t2i", "edit"] }), sellable("openai-gpt-image-2.6-sunburst")];
    age = "none";
    expect((await get(true)).body.gate).toEqual({ open: false, reason: "adult_attestation_required" });
  });

  it("open for a sellable Gemini-like model (t2i in ref_capabilities, 14 pictures): asset_id scene refs, one view per character", async () => {
    const gemini = sellable("fake-gemini", { ref_capabilities: ["t2i", "edit"], requires_adult: true, inputs: { image_refs_max: 14 }, image_sizes: ["1K", "2K", "4K"] });
    fake.state.t2i = [gemini, sellable("openai-gpt-image-2.6-sunburst")];
    fake.state.edit = [gemini];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-gemini" });
    expect((await get(true)).body.gate).toEqual({ open: true });
    await approveAll();
    // Sold by size: the sheets ask for the smallest one, which the quote prices.
    expect((creates()[0].args.p_params as { image_size?: string }).image_size).toBe("1K");
    const r = await post({ action: "attach", film: FILM });
    expect(r.status).toBe(200);
    expect(r.body.attached).toBe(2);
    const save = fake.state.calls.find((c) => c.fn === "save_film")!;
    const scenes = (save.args.p_patch as { scenes: { refs?: { kind: string; asset_id?: string; character_id?: string }[]; visual_prompt?: string }[] }).scenes;
    for (const s of scenes) {
      expect(s.refs!.length).toBeLessThanOrEqual(14);
      expect(s.refs!.every((x) => x.kind === "character" && typeof x.asset_id === "string" && x.character_id === undefined)).toBe(true);
    }
    // Scene 1: Mira as a child and Tom, front views (a wide shot); scene 2: adult Mira from behind, the back view.
    expect(scenes[0].refs).toHaveLength(2);
    expect(scenes[0].visual_prompt).toContain("Mira (child) should reference Image 0. Tom should reference Image 1.");
    const sheets = sheetsOf((await get(true)).body);
    expect(scenes[1].refs![0].asset_id).toBe(view(sheets, "c1", "a2", "back").asset_id);
    expect(r.body.film_quote).toMatchObject({ priced: true });
  });

  it("refuses by name, and writes nothing, when a picture's stored size is unknown", async () => {
    const gemini = sellable("fake-gemini", { ref_capabilities: ["t2i"], inputs: { image_refs_max: 14 } });
    fake.state.t2i = [gemini];
    fake.state.edit = [gemini];
    fake.state.film = fake.filmRow({ keyframe_model: "fake-gemini" });
    await approveAll();
    for (const [k, a] of fake.state.assets) fake.state.assets.set(k, { ...a, bytes: null });
    const r = await post({ action: "attach", film: FILM });
    expect(r.body).toEqual({ error: "ref_size_unknown", scene: 1 });
    expect(fake.state.calls.some((c) => c.fn === "save_film")).toBe(false);
  });
});
