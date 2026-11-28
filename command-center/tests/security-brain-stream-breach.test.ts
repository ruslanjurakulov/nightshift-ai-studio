import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
import { readStreamLines, type BrainStreamEvent } from "@/lib/brain/stream-events";

/**
 * Breach on S1's NDJSON stream (BR-ST-*): POST /api/brain/turn with stream:true, against a fake database and a fake model only.
 * What breaks if these fail: one person's checked windows reaching another person's stream; a window shown that `end` then refuses
 * by a limit the route knew before the plan began (and turns spent on a plan that could never be saved); the switch or the lab's fake
 * vendor reachable from a request or a near-miss value; an internal error's detail in `end`.
 */

const lease = fakePlanLease();
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SA = "aaaaaaaa-0000-0000-0000-00000000000a";
const SB = "aaaaaaaa-0000-0000-0000-00000000000b";
const FILM = "bbbbbbbb-0000-0000-0000-000000000002";
const slots = { kind: "short", target_seconds: 1200, aspect: "9:16", style: "noir", language: "English", audience: "teens" };
const outline = (title: string) => ({
  title, idea: "A guard must save a caravan.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
  locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
  chapters: [300, 300, 300, 300].map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beats: [{ at_s: 0, text: "beat" }] })),
});
const row = (id: string, cap: "i2v" | "t2i" | "edit", durations: number[], maxPrompt = 2000) => ({
  id, display_name: id.toUpperCase(), provider: "x", availability: "ga", verified_at: "2026-11-01",
  credit_unit: cap === "i2v" ? "second" : "image", credits_per_unit: 1, capabilities: [cap],
  spec: { output: cap === "i2v" ? "video" : "image", unit: cap === "i2v" ? "second" : "image",
          limits: { max_prompt_chars: maxPrompt, max_concurrent_per_org: 2 }, durations_s: durations },
});

const state = {
  sessions: new Map<string, Record<string, unknown>>(),
  catalogue: { i2v: [] as unknown[], t2i: [] as unknown[], edit: [] as unknown[] },
  draft: { clip_model: null as string | null, keyframe_model: null as string | null },
  delayMs: 5,
  promptPad: "",
  saveThrows: false,
};
const rpc = vi.fn();
const llm = vi.fn();

function table(name: string) {
  const f: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.eq = (k: string, v: unknown) => { f[k] = v; return b; };
  b.maybeSingle = async () => ({ data: name === "ai_chat_sessions" ? state.sessions.get(String(f.id)) ?? null : name === "channels" ? { org_id: ORG, name: "Chan" } : null, error: null });
  b.then = (resolve: (v: unknown) => void) => {
    if (name !== "ai_chat_messages") return resolve({ data: [], error: null });
    const sid = String(f.session_id ?? "");
    const title = sid === SB ? "Caravan BBB" : "Caravan AAA";
    if (f.role === "assistant") return resolve({ data: [{ id: 41, payload: { scenarios: [outline(title)] } }], error: null });
    return resolve({ data: [{ id: 41, role: "assistant", content: "Pick one" }], error: null });
  };
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpc(fn, args);
    const leased = lease.rpc(fn, args);
    if (leased) return leased;
    if (fn === "sellable_models") {
      if (args.p_capability === "describe") return { data: [{ id: "anthropic-claude-sonnet-5-5" }], error: null };
      return { data: state.catalogue[args.p_capability as "i2v" | "t2i" | "edit"] ?? [], error: null };
    }
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 300, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    if (fn === "ai_chat_reserve_turn") return { data: { call_id: `call-${Math.random()}`, used: 4, limit: 300 }, error: null };
    if (fn === "create_film_draft") return { data: { film: { id: FILM, version: 1, ...state.draft }, limits: { max_shots: 3 } }, error: null };
    if (fn === "save_film") {
      if (state.saveThrows) throw new Error("connect ECONNREFUSED 10.0.0.7:5432 at Pool.connect (/app/node_modules/pg/lib/pool.js:45)");
      return { data: { film: { id: FILM, version: 2 } }, error: null };
    }
    if (fn === "quote_film") return { data: { priced: true, total: 240, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, available: 500 }, error: null };
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
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return {
    ...real, chatModelConfigured: () => true,
    callChatModel: async (...a: unknown[]) => {
      llm(...a);
      const data = JSON.parse(String(a[2]).split("\n").slice(1).join("\n")) as Record<string, unknown>;
      // The film's own title marks every scene, so a scene in the wrong stream names whose it is.
      const mark = String((data.film as { title?: string }).title ?? "?").replace(/\W+/g, "_");
      const parts = (data.write_chapters as { id: string; seconds: number }[]);
      // Uneven delays interleave the two plans' windows.
      await new Promise((r) => setTimeout(r, state.delayMs + Math.floor(Math.random() * 15)));
      const max = Number((data.limits as { max_scenes: number }).max_scenes);
      return { ok: true, tokensIn: 1, tokensOut: 1, text: JSON.stringify({ chapters: parts.map((p) => {
        const room = Math.max(1, Math.floor(max / parts.length));
        const k = Math.max(Math.ceil(p.seconds / 30), Math.min(room, Math.ceil(p.seconds / 10)));
        const lens = Array.from({ length: k }, (_, i) => Math.floor(p.seconds / k) + (i < p.seconds % k ? 1 : 0));
        return { id: p.id, scenes: lens.map((d, j) => ({ title: `${mark}-${p.id}-${j}`, duration_s: d, visual_prompt: `shot of ${mark} ${p.id}${state.promptPad}`,
                                                       character_ids: ["c1"], location_id: "l1", dialogue: [] })) };
      }) }) };
    },
  };
});

const { POST } = await import("@/app/api/brain/turn/route");
const req = (body: Record<string, unknown>, init: RequestInit = {}, q = "") => new Request(`https://x/api/brain/turn${q}`,
  { method: "POST", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: JSON.stringify(body) });
const choose = (sid: string, o: Record<string, unknown> = {}) => ({ action: "choose", session: sid, index: 0, request_id: `press-${sid.slice(-1)}`, stream: true, ...o });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
async function eventsOf(res: Response): Promise<BrainStreamEvent[]> {
  const out: BrainStreamEvent[] = [];
  for await (const e of readStreamLines(res.body!)) out.push(e);
  return out;
}

beforeEach(() => {
  lease.reset();
  rpc.mockReset();
  llm.mockReset();
  state.sessions.clear();
  for (const sid of [SA, SB]) state.sessions.set(sid, { id: sid, org_id: ORG, channel_id: "chan-1", slots, step: "proposing", card: null, brief: {} });
  state.catalogue = { i2v: [], t2i: [], edit: [] };
  state.draft = { clip_model: null, keyframe_model: null };
  state.delayMs = 5;
  state.promptPad = "";
  state.saveThrows = false;
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  process.env.NIGHTSHIFT_AI_STREAM = "on";
  delete process.env.NIGHTSHIFT_AI_LAB;
  delete process.env.NIGHTSHIFT_AI_FAKE_BASE_URL;
});

describe("BR-ST-01: the request-scoped sink (AsyncLocalStorage) under concurrency", () => {
  it("two plans streamed at once for two conversations: each stream carries only its own scenes, and each ends with its own answer", async () => {
    const [ra, rb] = await Promise.all([POST(req(choose(SA))), POST(req(choose(SB)))]);
    const [ea, eb] = await Promise.all([eventsOf(ra), eventsOf(rb)]);
    const wa = JSON.stringify(ea.filter((e) => e.type === "plan.window"));
    const wb = JSON.stringify(eb.filter((e) => e.type === "plan.window"));
    expect(wa).toContain("Caravan_AAA");
    expect(wb).toContain("Caravan_BBB");
    expect(wa).not.toContain("Caravan_BBB");
    expect(wb).not.toContain("Caravan_AAA");
    // Exactly one plan.begun and one end per stream: no event of the other request doubled into it.
    for (const ev of [ea, eb]) {
      expect(ev.filter((e) => e.type === "plan.begun")).toHaveLength(1);
      expect(ev.filter((e) => e.type === "end")).toHaveLength(1);
    }
    const endA = ea[ea.length - 1] as Extract<BrainStreamEvent, { type: "end" }>;
    const endB = eb[eb.length - 1] as Extract<BrainStreamEvent, { type: "end" }>;
    expect(JSON.stringify(endA.body)).not.toContain("Caravan_BBB");
    expect(JSON.stringify(endB.body)).not.toContain("Caravan_AAA");
  });

  it("a streamed request and a JSON request at once: the JSON one is never turned into a stream by the other's accept", async () => {
    const [ra, rb] = await Promise.all([POST(req(choose(SA))), POST(req(choose(SB, { stream: undefined })))]);
    expect(ra.headers.get("content-type")).toBe("application/x-ndjson");
    expect(rb.headers.get("content-type")).toBe("application/json");
    await eventsOf(ra);
    expect(JSON.stringify(await rb.json())).not.toContain("Caravan_AAA");
  });
});

describe("BR-ST-02 (HOLE): a window is streamed by a prompt limit looser than the one end applies", () => {
  it("a draft made with a key-frame model of a 300-char limit: no window over 300 is shown, and no plan turn is spent on a storyboard end must refuse", async () => {
    // The server's pick takes 2000; the draft (replayed: the person changed its key-frame model in the Studio after a failed plan,
    // to an edit model 0166 accepts) takes 300. create_film_draft says so BEFORE the plan begins (draftedLimit in the route).
    state.catalogue = { i2v: [row("minimax-h3", "i2v", [6, 10])], t2i: [row("openai-gpt-image-2.6-sunburst", "t2i", [])],
                        edit: [row("tiny-edit", "edit", [], 300)] };
    state.draft = { clip_model: "minimax-h3", keyframe_model: "tiny-edit" };
    state.promptPad = " " + "golden dunes at dusk, ".repeat(16); // ~370 chars of visual_prompt: under 2000, over 300
    const res = await POST(req(choose(SA)));
    const ev = await eventsOf(res);
    const end = ev[ev.length - 1] as Extract<BrainStreamEvent, { type: "end" }>;
    expect(end).toMatchObject({ type: "end", status: 422, body: { error: "prompt_too_long", limit: 300 } });
    const shown = ev.filter((e) => e.type === "plan.window") as Extract<BrainStreamEvent, { type: "plan.window" }>[];
    // Shown as "Written" in the panel, then refused at end by a number the route already had before the first call.
    expect(shown.flatMap((w) => w.parts.flatMap((p) => p.scenes)).filter((s) => s.visual_prompt.length > 300)).toEqual([]);
    // And the turns: every window was asked (and charged) with a 2000 limit for a film that takes 300.
    expect(called("ai_chat_finish_turn").filter((f) => f.p_outcome === "ok")).toHaveLength(0);
  });
});

describe("BR-ST-03: the switch cannot be reached from the request", () => {
  it.each([
    ["off", { stream: true }, {}, ""],
    ["off", { stream: "true" }, { accept: "application/x-ndjson" }, "?stream=1"],
    ["lab", { stream: true }, { accept: "application/x-ndjson", cookie: "NIGHTSHIFT_AI_LAB=1" }, "?lab=1"],
    [undefined, { stream: 1 }, { "x-nightshift-ai-stream": "on" }, ""],
  ])("NIGHTSHIFT_AI_STREAM=%s with %o: plain JSON", async (mode, extra, headers, q) => {
    if (mode === undefined) delete process.env.NIGHTSHIFT_AI_STREAM; else process.env.NIGHTSHIFT_AI_STREAM = mode;
    const res = await POST(req({ ...choose(SA), ...extra }, { headers: headers as Record<string, string> }, q));
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("on, but stream given as a string, a number or an object: plain JSON (only the literal true asks)", async () => {
    for (const v of ["true", 1, { on: true }, [true]]) {
      lease.reset();
      const res = await POST(req(choose(SA, { stream: v, request_id: `p${Math.random().toString(36).slice(2, 10)}` })));
      expect(res.headers.get("content-type")).toBe("application/json");
      await res.text();
    }
  });
});

describe("BR-ST-04: the fake-vendor seam's flag cannot be near-missed", () => {
  it.each(["true", "TRUE", "yes", "on", "01", "1.0", "1​", "١", "１"])("NIGHTSHIFT_AI_LAB=%j with a fake base: refused by name, never honoured", async (flag) => {
    const { fakeVendorSeam } = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
    expect(fakeVendorSeam({ NIGHTSHIFT_AI_LAB: flag, NIGHTSHIFT_AI_FAKE_BASE_URL: "http://127.0.0.1:9911" })).toEqual({ state: "refused" });
  });

  it.each(["file:///etc/passwd", "gopher://127.0.0.1:6379/_x", "data:text/plain,x", "http://u:p@127.0.0.1:9911", "http://127.0.0.1:9911/?k=1",
           "http://127.0.0.1:9911/#x", "javascript:alert(1)", "//127.0.0.1"])("in the lab, a base of %j is refused", async (base) => {
    const { fakeVendorSeam } = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
    expect(fakeVendorSeam({ NIGHTSHIFT_AI_LAB: "1", NIGHTSHIFT_AI_FAKE_BASE_URL: base })).toEqual({ state: "refused" });
  });

  it("the vendor call itself: with the base set and no lab flag, nothing is fetched and no key leaves", async () => {
    const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
    process.env.NIGHTSHIFT_AI_FAKE_BASE_URL = "https://attacker.example";
    process.env.NIGHTSHIFT_AI_LAB = "true";
    const fetchImpl = vi.fn();
    const r = await real.callChatModel("anthropic-claude-sonnet-5-5" as never, "sys", "user", { keys: { anthropic: "sk-ant-FAKE", openai: "x", gemini: "y" } as never, fetchImpl: fetchImpl as never });
    expect(r).toMatchObject({ ok: false, error: "fake_vendor_unflagged" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("BR-ST-05: an internal error after the stream began", () => {
  it("end is {status:500, body:null}: no message, host or stack of the error", async () => {
    state.saveThrows = true;
    const res = await POST(req(choose(SA)));
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const ev = await eventsOf(res);
    const end = ev[ev.length - 1];
    expect(end).toEqual({ type: "end", status: 500, body: null });
    expect(JSON.stringify(ev)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|node_modules|pool\.js/);
  });
});
