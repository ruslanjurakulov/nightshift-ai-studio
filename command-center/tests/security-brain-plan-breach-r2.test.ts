import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
/** 0211's plan lease, as the database keeps it (tests/helpers/fakePlanLease.ts). */
const lease = fakePlanLease();

/**
 * Breach round 2 on the S1 plan step (`POST /api/brain/turn` action `choose`, lib/server/brain/plan.ts, 0211's lease, the server's
 * model pick, the prompt limit). The database half is tests/security/test_sec_breach_plan_lease_r2.py.
 *
 * The fake database keeps the rules these attacks rely on: a request id is used once per person; a p_retry turn needs the last message
 * to be the person's; a film is saved only at its current version (0166 save_film's `film_changed`); create_film_draft refuses a
 * model that is not on sale (0166 film_check_model) and is idempotent by its key. Nothing reaches a vendor or a real database.
 *
 * Tests marked "HOLE" fail on 4256eef8 and pass once the flaw is fixed; they must not be skipped. The rest pin what held.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { FILM_MODEL_PREFERENCE } from "@/lib/brain/film-models";

const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const FILM_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const slots = (target: number, o: Record<string, unknown> = {}) =>
  ({ kind: "short", target_seconds: target, aspect: "9:16", style: "noir", language: "English", audience: "teens", ...o });
const outline = (seconds: number[], o: Record<string, unknown> = {}) => ({
  title: "The lost caravan", idea: "A guard must save a caravan.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
  locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
  chapters: seconds.map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beats: [{ at_s: 0, text: "beat" }] })),
  ...o,
});

/** One sellable_models row as lib/creative/registry coerceSellableModels takes it. */
const row = (id: string, cap: "i2v" | "t2i" | "edit", durations: number[], maxPrompt = 2000) => ({
  id, display_name: id.toUpperCase(), provider: "x", availability: "ga", verified_at: "2026-11-01",
  credit_unit: cap === "i2v" ? "second" : "image", credits_per_unit: 1, capabilities: [cap],
  spec: { output: cap === "i2v" ? "video" : "image", unit: cap === "i2v" ? "second" : "image",
          limits: { max_prompt_chars: maxPrompt, max_concurrent_per_org: 2 }, durations_s: durations },
});

type Part = { id: string; seconds: number };
type Answer = (parts: Part[], data: Record<string, unknown>, n: number) => Record<string, unknown>;
const scenesOf = (p: Part, prompt: string) => {
  const k = Math.ceil(p.seconds / 10);
  const lens = Array.from({ length: k }, (_, i) => Math.floor(p.seconds / k) + (i < p.seconds % k ? 1 : 0));
  return lens.map((d, i) => ({ title: `${p.id}-${i}`, duration_s: d, visual_prompt: `${prompt} ${i}`, character_ids: ["c1"], location_id: "l1" }));
};
const answerWith = (prompt: (n: number) => string): Answer => (parts, _data, n) =>
  ({ ok: true, tokensIn: 10, tokensOut: 20, text: JSON.stringify({ chapters: parts.map((p) => ({ id: p.id, scenes: scenesOf(p, prompt(n)) })) }) });

type Msg = { id: number; role: "user" | "assistant"; content: string; payload: unknown };
const db = {
  session: null as Record<string, unknown> | null,
  messages: [] as Msg[],
  requestIds: new Set<string>(),
  nextId: 100,
  answer: answerWith(() => "shot") as Answer,
  catalogue: { i2v: [] as unknown[], t2i: [] as unknown[], edit: [] as unknown[] },
  film: null as null | { version: number; key: string; clip_model: string | null; keyframe_model: string | null; scenes: unknown },
  /** Held open once, at the first ai_chat_finish_turn: the call is finished in the database, its answer is late. */
  stall: null as null | { reached: () => void; release: Promise<void> },
};
const rpc = vi.fn();
const llm = vi.fn();
const tick = () => new Promise((r) => setTimeout(r, 2));
const onSale = (id: unknown, caps: ("i2v" | "t2i" | "edit")[]) =>
  caps.some((c) => (db.catalogue[c] as { id: string }[]).some((m) => m.id === id));

function table(name: string) {
  const f: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.eq = (k: string, v: unknown) => { f[k] = v; return b; };
  b.maybeSingle = async () => ({ data: name === "ai_chat_sessions" ? db.session : name === "channels" ? { org_id: ORG, name: "Chan" } : null, error: null });
  b.then = (resolve: (v: unknown) => void) => {
    if (name !== "ai_chat_messages") return resolve({ data: [], error: null });
    const list = f.role ? db.messages.filter((m) => m.role === f.role) : db.messages;
    const last = list[list.length - 1];
    return resolve({ data: last ? [last] : [], error: null });
  };
  return b;
}

const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpc(fn, args);
    const leased = lease.rpc(fn, args as Record<string, unknown>);
    if (leased) return leased;
    await tick();
    if (fn === "sellable_models") {
      const cap = args.p_capability as string;
      if (cap === "i2v" || cap === "t2i" || cap === "edit") return { data: db.catalogue[cap], error: null };
      return { data: [{ id: "anthropic-claude-sonnet-5-5" }], error: null };
    }
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 300, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    if (fn === "ai_chat_reserve_turn") {
      const rid = args.p_request_id as string | null;
      if (rid && db.requestIds.has(rid)) return { data: null, error: { code: "NS409", message: "duplicate_request", details: SESSION } };
      if (args.p_retry) {
        if (db.messages[db.messages.length - 1]?.role !== "user") return { data: null, error: { code: "NS409", message: "nothing_to_retry" } };
      } else {
        db.messages.push({ id: db.nextId++, role: "user", content: String(args.p_text), payload: null });
      }
      if (rid) db.requestIds.add(rid);
      return { data: { call_id: `call-${db.requestIds.size}`, used: 4, limit: 300 }, error: null };
    }
    if (fn === "ai_chat_finish_turn") {
      const s = db.stall;
      if (s) { db.stall = null; s.reached(); await s.release; }
      return { data: null, error: null };
    }
    if (fn === "create_film_draft") {
      // 0166: a model not on sale for its role is refused; the key returns the film it made before.
      const st = args.p_settings as Record<string, unknown>;
      if (st.clip_model !== undefined && !onSale(st.clip_model, ["i2v"])) return { data: null, error: { code: "NS422", message: "model_not_available" } };
      if (st.keyframe_model !== undefined && !onSale(st.keyframe_model, ["t2i", "edit"])) return { data: null, error: { code: "NS422", message: "model_not_available" } };
      db.film ??= { version: 1, key: String(args.p_idempotency_key), clip_model: (st.clip_model as string) ?? null,
                    keyframe_model: (st.keyframe_model as string) ?? null, scenes: [] };
      return { data: { film: { id: FILM_ID, version: db.film.version, clip_model: db.film.clip_model }, limits: { max_shots: 3 } }, error: null };
    }
    if (fn === "save_film") {
      if (!db.film || args.p_version !== db.film.version) return { data: null, error: { code: "NS409", message: "film_changed" } };
      db.film.version += 1;
      db.film.scenes = (args.p_patch as { scenes: unknown }).scenes;
      return { data: { film: { id: FILM_ID, version: db.film.version } }, error: null };
    }
    if (fn === "quote_film") return { data: { priced: true, total: 240, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, available: 500 }, error: null };
    if (fn === "ai_chat_save_brief") {
      db.session = { ...(db.session ?? {}), brief: args.p_brief, step: args.p_step };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: ORG, source: "org" }) }));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => null }));
vi.mock("@/lib/server/age", () => ({ readAgeState: async () => "adult" }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG, role: "owner" } }) }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/server/films", () => ({ filmGate: async () => ({ ok: true, supabase: client, userId: "user-1" }) }));
vi.mock("@/lib/server/brain/facts", () => ({ readChannelFacts: async () => ({ state: "none", source: null, name: "Chan", statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] }) }));
vi.mock("@/lib/server/brain/quote", () => ({ chatPricing: async () => ({ ok: false }) }));
vi.mock("@/lib/server/brain/google-gate", () => ({ chatModelGate: async () => null }));
let llmCalls = 0;
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return {
    ...real, chatModelConfigured: () => true,
    callChatModel: async (...a: unknown[]) => {
      llm(...a);
      llmCalls += 1;
      const n = llmCalls;
      const data = JSON.parse(String(a[2]).split("\n").slice(1).join("\n")) as Record<string, unknown>;
      const parts = (data.write_chapters as { id: string; seconds: number }[]).map((p) => ({ id: p.id, seconds: p.seconds }));
      await tick();
      return db.answer(parts, data, n);
    },
  };
});

const { POST } = await import("@/app/api/brain/turn/route");
const post = (body: unknown) => POST(new Request("https://x/api/brain/turn", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const choose = (rid: string, body: Record<string, unknown> = {}) => post({ action: "choose", session: SESSION, index: 0, request_id: rid, ...body });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);

function setup(target: number, seconds: number[], o: Record<string, unknown> = {}, s: Record<string, unknown> = {}) {
  db.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", slots: slots(target, s), step: "proposing", card: null, brief: {} };
  db.messages = [
    { id: 40, role: "user", content: "a desert film", payload: null },
    { id: 41, role: "assistant", content: "Pick one", payload: { scenarios: [outline(seconds, o), outline(seconds, { title: "Other" })] } },
  ];
}

beforeEach(() => {
  lease.reset();
  lease.state.now = () => Date.now();
  rpc.mockReset();
  llm.mockReset();
  llmCalls = 0;
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  db.requestIds = new Set();
  db.nextId = 100;
  db.answer = answerWith(() => "shot");
  db.catalogue = { i2v: [row("minimax-h3", "i2v", [4, 6, 10, 15]), row("luma-ray-3.2", "i2v", [5, 10])],
                   t2i: [row("openai-gpt-image-2.6-sunburst", "t2i", []), row("flux-3-image", "t2i", [], 500)], edit: [] };
  db.film = null;
  db.stall = null;
});

describe("HOLE: a plan whose lease was taken over still writes (BR-S1-08)", () => {
  // route.ts:410-441. The lease's attempt fences only ai_chat_plan_end (0211); the route never asks whether it still holds the
  // lease before ai_chat_save_brief (step 5 and 8) or save_film. A plan whose server stalls past 320 s (a paused container, a slow
  // database after the bounded vendor calls; the self-hosted server ignores maxDuration) is taken over by a second tab, which
  // writes and prices its own storyboard. The first then wakes up and replaces that priced BRIEF with its own, unpriced one: the
  // conversation shows a storyboard that is not the film's, and "Create" has no price. 0211 already knows the first is stale
  // (its end is refused plan_not_current): the writes do not ask.
  it("HOLE: the late first plan never replaces the BRIEF the plan that took its lease over wrote", async () => {
    setup(60, [60]);
    db.answer = answerWith((n) => (n === 1 ? "late plan" : "fresh plan"));
    let reached!: () => void;
    const atFinish = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    db.stall = { reached: () => reached(), release: new Promise<void>((r) => { release = r; }) };

    const first = choose("pressAAAA1");
    await atFinish;
    // The first plan is past its vendor call, stalled. Its 320 s run out; a second tab chooses the same outline.
    lease.state.now = () => Date.now() + 400_000;
    const second = await choose("pressBBBB2");
    expect(second.status).toBe(200);
    const fresh = db.session!.brief as { price?: { state?: string }; scenes?: { visual_prompt: string }[] };
    expect(fresh.price?.state).toBe("priced");
    expect(fresh.scenes?.[0].visual_prompt).toContain("fresh plan");
    const filmAfterSecond = JSON.stringify(db.film!.scenes);

    release();
    const late = await first;
    expect(late.status).not.toBe(200);
    // What the conversation and the film say afterwards: the second plan's, priced.
    const kept = db.session!.brief as { price?: { state?: string }; scenes?: { visual_prompt: string }[] };
    expect(kept.price?.state).toBe("priced");
    expect(JSON.stringify(kept)).not.toContain("late plan");
    expect(JSON.stringify(db.film!.scenes)).toBe(filmAfterSecond);
  });
});

describe("HOLE: a stored BRIEF picks the film's models (BR-S1-07)", () => {
  // route.ts:281-290. Choosing an outline again re-reads the session's BRIEF and keeps "the models this draft was made with" from
  // its first scene, named() taking any well-formed id without looking at the catalogue or the server's order. The BRIEF is the
  // author's to write: ai_chat_save_brief is granted to authenticated (0199:595) and stores any object. So a member who writes
  // a BRIEF with their outline's title and idea and any model id makes the server draft the film with that model, name it on the
  // card as the server's pick, and measure the prompt against a limit that ignores it (promptLimitOf finds no row). The database
  // still refuses a model that is not on sale (film_check_model): what leaks is "a model on sale, but not the server's order".
  const storedBrief = (clip: string, keyframe: string) => ({
    version: 1, session_id: SESSION, status: "ready", kind: "short", language: "English", audience: "teens", style: "noir",
    aspect: "9:16", target_seconds: 60, title: "The lost caravan", idea: "A guard must save a caravan.",
    story: { logline: "l", conflict: "c" }, chapters: [{ id: "ch1", title: "Chapter 1", start_s: 0, beats: [{ at_s: 0, text: "beat" }] }],
    characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
    locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
    scenes: Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, chapter_id: "ch1", title: `s${i + 1}`, duration_s: 10,
      visual_prompt: "a wide desert", character_ids: ["c1"], location_id: "l1", dialogue: [], clip_model: clip, keyframe_model: keyframe })),
    voice: { mode: "off" }, music: { mode: "off" }, handoff: null, price: { state: "unpriced" },
  });

  it("HOLE: a model the author wrote into the BRIEF never becomes the draft's model when it is not in the server's order", async () => {
    setup(60, [60]);
    // Written straight through PostgREST: supabase.rpc("ai_chat_save_brief", { p_session, p_brief, p_step: "ready" }).
    db.session = { ...db.session!, step: "ready", brief: storedBrief("luma-ray-3.2", "flux-3-image") };
    const res = await choose("pressCCCC3");
    const settings = called("create_film_draft")[0]?.p_settings as Record<string, unknown> | undefined;
    const d = res.status === 200 ? await res.json() : null;
    // Either the server's own pick (minimax-h3 / gpt-image sunburst here), or a refusal: never the author's.
    if (settings?.clip_model !== undefined) expect(FILM_MODEL_PREFERENCE.clip as readonly string[]).toContain(settings.clip_model);
    if (settings?.keyframe_model !== undefined) expect(FILM_MODEL_PREFERENCE.keyframe as readonly string[]).toContain(settings.keyframe_model);
    expect(JSON.stringify(d?.models ?? null)).not.toMatch(/luma-ray|flux-3/);
  });

  it("HOLE: the prompt limit of the model the film is drafted with is the one a scene is measured against", async () => {
    setup(60, [60]);
    // flux-3-edit is on sale as a key-frame model (0166 film_check_model takes t2i or edit for keyframe_model) but is not in the
    // t2i catalogue the server reads, so promptLimitOf finds no row for it and measures against the film's 2000. Its own registry
    // row takes 500; the stored scenes' whole prompts are ~600.
    db.catalogue.edit = [row("flux-3-edit", "edit", [], 500)];
    const brief = storedBrief("minimax-h3", "flux-3-edit");
    brief.scenes = brief.scenes.map((s) => ({ ...s, visual_prompt: `a wide desert ${"under a red sky ".repeat(36)}`.trim() }));
    db.session = { ...db.session!, step: "ready", brief };
    const res = await choose("pressDDDD4");
    const settings = called("create_film_draft")[0]?.p_settings as Record<string, unknown> | undefined;
    // Drafted with flux-3-edit means measured against its 500; a prompt over it is refused, never saved into the film.
    if (settings?.keyframe_model === "flux-3-edit") {
      expect(res.status).toBe(422);
      expect(called("save_film")).toHaveLength(0);
    }
  });
});

describe("held: request ids, the lease and the prompt limit", () => {
  it("a plan call's request id is pl + sha256(session:proposal:index:attempt)[0:40] -wN, a new attempt is new ids", async () => {
    setup(60, [60]);
    db.answer = () => ({ ok: false, error: "vendor_error", tokensIn: null, tokensOut: null });
    expect((await choose("pressEEEE5")).status).toBe(502);
    db.answer = answerWith(() => "shot");
    expect((await choose("pressEEEE6")).status).toBe(200);
    const ids = called("ai_chat_reserve_turn").map((a) => a.p_request_id);
    expect(ids).toEqual([`pl${sha(`${SESSION}:41:0:1`).slice(0, 40)}-w1`, `pl${sha(`${SESSION}:41:0:2`).slice(0, 40)}-w1`]);
    // The second plan is a Retry of the stored choice: one message from the person, not two.
    expect(db.messages.filter((m) => m.role === "user" && m.content === "The lost caravan")).toHaveLength(1);
  });

  it("a request id the person pre-claimed for their own next attempt fails that plan closed: no vendor call, nothing drafted into", async () => {
    setup(60, [60]);
    // The author predicts attempt 1's id (session, proposal and index are theirs to know) and reserves it by hand first.
    db.requestIds.add(`pl${sha(`${SESSION}:41:0:1`).slice(0, 40)}-w1`);
    const res = await choose("pressFFFF7");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("duplicate_request");
    expect(llm).not.toHaveBeenCalled();
    expect(called("save_film")).toHaveLength(0);
    expect(called("ai_chat_plan_end")).toEqual([expect.objectContaining({ p_attempt: 1, p_state: "failed" })]);
  });

  it("a stored storyboard with an emoji-dense prompt is measured in UTF-16 units (an emoji is two), the stricter count", async () => {
    setup(60, [60]);
    const brief = {
      ...(db.session!.brief as object), version: 1, session_id: SESSION, status: "ready", kind: "short", language: "English",
      audience: "teens", style: "noir", aspect: "9:16", target_seconds: 60, title: "The lost caravan", idea: "A guard must save a caravan.",
      story: { logline: "l", conflict: "c" }, chapters: [{ id: "ch1", title: "Chapter 1", start_s: 0, beats: [{ at_s: 0, text: "beat" }] }],
      characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
      locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
      // ~1100 code points, ~2100 UTF-16 units once the characters, setting and style are added: under 2000 by code points only.
      scenes: Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, chapter_id: "ch1", title: `s${i + 1}`, duration_s: 10,
        visual_prompt: `desert ${"🐪".repeat(1000)}`, character_ids: ["c1"], location_id: "l1", dialogue: [],
        clip_model: "minimax-h3", keyframe_model: "openai-gpt-image-2.6-sunburst" })),
      voice: { mode: "off" }, music: { mode: "off" }, handoff: null,
    };
    db.session = { ...db.session!, step: "ready", brief };
    const res = await choose("pressGGGG8");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("prompt_too_long");
    expect(called("save_film")).toHaveLength(0);
  });

  it("a stored scene carrying negative_prompt, seed, a model or clip params of its own drafts none of them", async () => {
    setup(60, [60]);
    db.answer = (parts) => ({ ok: true, tokensIn: 1, tokensOut: 1, text: JSON.stringify({ chapters: parts.map((p) => ({ id: p.id,
      scenes: scenesOf(p, "shot").map((s) => ({ ...s, negative_prompt: "blurry", seed: 42, clip_model: "luma-ray-3.2", keyframe_model: "flux-3-image",
        clip_params: { audio: true, seed: 7, negative_prompt: "x", resolution: "4k" }, shot_count: 3, first_frame: "asset", first_frame_asset_id: "x" })) })) }) });
    expect((await choose("pressHHHH9")).status).toBe(200);
    const scenes = (called("save_film")[0].p_patch as { scenes: Record<string, unknown>[] }).scenes;
    for (const s of scenes) {
      expect(Object.keys(s).sort()).toEqual(expect.arrayContaining(["narration", "planned_seconds", "title", "visual_prompt"]));
      for (const k of ["negative_prompt", "seed", "clip_model", "keyframe_model", "first_frame", "first_frame_asset_id"]) expect(s).not.toHaveProperty(k);
      expect(s.clip_params ?? {}).toEqual({});
    }
    expect(called("create_film_draft")[0].p_settings).toMatchObject({ clip_model: "minimax-h3", keyframe_model: "openai-gpt-image-2.6-sunburst" });
  });

  it("choose never starts, holds or publishes: only the draft, its save and its quote", async () => {
    setup(60, [60]);
    expect((await choose("pressIIII0")).status).toBe(200);
    const names = new Set(rpc.mock.calls.map((c) => c[0] as string));
    for (const n of ["start_film", "reserve_credits", "capture_credits", "creative_hold", "creative_start", "ai_chat_record_handoff",
                     "approve_video_publish", "film_assemble"]) expect(names.has(n)).toBe(false);
  });
});
