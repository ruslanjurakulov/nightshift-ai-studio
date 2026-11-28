/**
 * A fake of what /api/brain/sheets reads and calls (fakes only: no database, no model, no spend). It keeps the person's conversation,
 * the creative jobs the route queues (one per idempotency key, as 0036 replays a key), the library's pictures and the film, and
 * answers sellable_models from a list each test sets.
 */
import type { Brief } from "@/lib/brain/logic";

export const ORG = "11111111-2222-4333-8444-555555555555";
export const OTHER_ORG = "99999999-2222-4333-8444-555555555555";
export const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
export const FILM = "bbbbbbbb-0000-4000-8000-000000000002";
export const USER = "cccccccc-0000-4000-8000-000000000003";
const uuid = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asset = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const look = (who: string) => ({ face: `${who} face`, hair: `${who} hair`, build: `${who} build`, outfit: `${who} outfit`, palette: `${who} palette`, signature: `${who} scarf` });

export function storyBrief(o: Partial<Brief> = {}): Brief {
  return {
    version: 1, session_id: SESSION, status: "ready", kind: "short", language: "English", audience: "families", style: "watercolour",
    aspect: "16:9", target_seconds: 30, voice: { mode: "off" }, music: { mode: "off" }, handoff: null, title: "T", idea: "I",
    visual_style: "soft watercolour, warm light",
    characters: [
      { id: "c1", name: "Mira", description: "", image_prompt: "", asset_id: null, character_id: null, source: "prompt", look: look("Mira adult"),
        age_stages: [{ id: "a1", label: "child", look: look("Mira child") }, { id: "a2", label: "adult", look: look("Mira adult") }] },
      { id: "c2", name: "Tom", description: "", image_prompt: "", asset_id: null, character_id: null, source: "prompt", look: look("Tom") },
    ],
    scenes: [
      { id: "s1", n: 1, title: "a", duration_s: 15, visual_prompt: "v1", dialogue: [], character_ids: ["c1", "c2"], location_id: null, prop_ids: [],
        keyframe_model: "openai-gpt-image-2.6-sunburst", clip_model: "minimax-h3", shot: "wide",
        in_frame: [{ character_id: "c1", age_stage: "a1" }, { character_id: "c2", age_stage: null }] },
      { id: "s2", n: 2, title: "b", duration_s: 15, visual_prompt: "v2", dialogue: [], character_ids: ["c1"], location_id: null, prop_ids: [],
        keyframe_model: "openai-gpt-image-2.6-sunburst", clip_model: "minimax-h3", shot: "medium", camera: { position: "from behind, low", move: "static" },
        in_frame: [{ character_id: "c1", age_stage: "a2" }] },
    ],
    film_link: { film_id: FILM, scenes: [{ brief: "s1", film: uuid(901) }, { brief: "s2", film: uuid(902) }] },
    ...o,
  } as Brief;
}

type Row = Record<string, unknown>;
export interface SellableRow { id: string; display_name: string; capabilities: string[]; spec: Row }

export function sellable(id: string, spec: Row = {}): SellableRow {
  return { id, display_name: `Name of ${id}`, capabilities: ["t2i", "edit"],
    spec: { inputs: { image_refs_max: 16 }, limits: { max_prompt_chars: 4000 }, ...spec } };
}

export function makeFake() {
  const state = {
    session: { id: SESSION, org_id: ORG, step: "ready", created_by: USER, brief: storyBrief() as unknown as Row } as Row | null,
    t2i: [sellable("openai-gpt-image-2.6-sunburst")] as SellableRow[],
    edit: [sellable("openai-gpt-image-2.6-sunburst")] as SellableRow[],
    prices: { t2i: 6, edit: 5 } as Record<string, number>,
    /** Answers create_creative_job with this error when set (insufficient credits, not a spender). */
    createError: null as { code?: string; message?: string; details?: string } | null,
    jobs: new Map<string, Row>(),
    byKey: new Map<string, string>(),
    assets: new Map<string, Row>(),
    film: null as Row | null,
    calls: [] as { fn: string; args: Row }[],
    reads: [] as { table: string; filters: Row; inKey: string }[],
    /** Fails the ai_chat_save_brief calls numbered here (1-based, counted from the start of the test). */
    failSaveAt: [] as number[],
    saveCount: 0,
    saved: [] as Row[],
    n: 0,
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let ins: unknown[] | null = null;
      let inKey = "";
      const b: Row = {};
      for (const m of ["select", "order", "limit", "neq", "not", "is"]) b[m] = () => b;
      b.eq = (k: string, v: unknown) => { filters[k] = v; return b; };
      b.in = (k: string, v: unknown[]) => { ins = v; inKey = k; return b; };
      b.maybeSingle = async () => {
        if (table === "ai_chat_sessions") {
          const s = state.session;
          return { data: s && s.id === filters.id && s.created_by === filters.created_by ? s : null, error: null };
        }
        if (table === "creative_jobs") return { data: state.jobs.get(String(filters.id)) ?? null, error: null };
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => void) => {
        if (table === "creative_jobs") {
          state.reads.push({ table, filters: { ...filters }, inKey });
          const rows = [...state.jobs.values()].filter((j) => j.org_id === filters.org_id && (ins ?? []).includes(j[inKey]));
          return resolve({ data: rows, error: null });
        }
        if (table === "media_assets") {
          const rows = (ins ?? []).map((id) => state.assets.get(String(id))).filter((r): r is Row => !!r && r.org_id === filters.org_id);
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: [], error: null });
      };
      return b;
    },
    rpc(fn: string, args: Row) {
      state.calls.push({ fn, args });
      const answer = (() => {
        if (fn === "sellable_models") return { data: args.p_capability === "edit" ? state.edit : state.t2i, error: null };
        if (fn === "quote_creative_job") {
          const p = args.p_params as Row;
          // The database refuses an edit with no picture (creative_params_problem): it can never be priced before its front exists.
          if (args.p_capability === "edit" && typeof p.source_asset_id !== "string") return { data: null, error: { code: "NS400", message: "invalid_params" } };
          return { data: { credits: state.prices[String(args.p_capability)] }, error: null };
        }
        if (fn === "create_creative_job") {
          const key = String(args.p_idempotency_key);
          const old = state.byKey.get(key);
          if (old) return { data: { job: state.jobs.get(old), replay: true }, error: null };
          if (state.createError) return { data: null, error: state.createError };
          const price = state.prices[String(args.p_capability)];
          if (typeof args.p_max_credits !== "number" || price > args.p_max_credits) return { data: null, error: { code: "NS409", message: "price_changed" } };
          state.n += 1;
          const id = uuid(state.n);
          state.jobs.set(id, { id, org_id: args.p_org, idempotency_key: key, status: "queued", capability: args.p_capability, params: args.p_params, quoted_credits: price, result_asset_ids: [] });
          state.byKey.set(key, id);
          return { data: { job: state.jobs.get(id), replay: false }, error: null };
        }
        if (fn === "ai_chat_save_brief") {
          state.saveCount += 1;
          if (state.failSaveAt.includes(state.saveCount)) return { data: null, error: { code: "XX000", message: "boom" } };
          state.saved.push(args.p_brief as Row);
          if (state.session) state.session = { ...state.session, brief: args.p_brief };
          return { data: null, error: null };
        }
        if (fn === "film_json") {
          const f = state.film;
          if (!f || f.org_id !== ORG) return { data: null, error: { code: "P0002", message: "not_found" } };
          return { data: f.json, error: null };
        }
        if (fn === "save_film") return { data: { film: { version: 8 } }, error: null };
        if (fn === "quote_film") return { data: { priced: true, total: 300, quote_id: "fq" }, error: null };
        return { data: null, error: null };
      })();
      const p = Promise.resolve(answer) as Promise<unknown> & { setHeader: () => unknown };
      p.setHeader = () => p;
      return p;
    },
  };
  /** The worker finishing a job: its picture is a PNG of `bytes` in the library. */
  const finish = (jobId: string, bytes: number | null = 900_000, mime = "image/png") => {
    state.n += 1;
    const a = asset(state.n);
    state.jobs.set(jobId, { ...state.jobs.get(jobId), status: "completed", result_asset_ids: [a] });
    state.assets.set(a, { id: a, org_id: ORG, bytes, mime });
    return a;
  };
  const filmRow = (o: Row = {}) => ({
    org_id: ORG,
    json: {
      film: { id: FILM, org_id: ORG, channel_id: null, version: 7, status: "draft", title: "T", source_kind: "script", source_text: "",
              language: "en", aspect: "16:9", target_seconds: 30, clip_model: "minimax-h3", keyframe_model: "openai-gpt-image-2.6-sunburst", ...o },
      editable: true, refs: [], totals: { scenes: 2 }, limits: { max_prompt_chars: 2000 },
      scenes: [{ id: uuid(901), visual_prompt: "v1", refs: [], keyframe_model: null }, { id: uuid(902), visual_prompt: "v2", refs: [], keyframe_model: null }],
    },
  });
  return { state, client, finish, filmRow };
}
