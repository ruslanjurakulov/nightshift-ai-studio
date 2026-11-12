import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Character Studio's routes, model and strings (migration 0135, NIGHTSHIFT_CHARACTER_STUDIO).
 *
 * What would break without these: a route answering while the switch is off (or telling a signed-out visitor it exists, or answering a
 * cross-site page), the browser choosing the price (only the database does) or a swap started with no price ceiling, the consent sent
 * with fewer than the five declarations, a refusal turned into a 500 or a fake success, a price or a hold shown with a number the
 * database never gave, a model "on sale" without a number, a sample link that is not the CDN's https copy, a route reaching for the
 * service key or a vendor, and a Russian or Uzbek screen with a missing sentence.
 */

vi.mock("server-only", () => ({}));

const ORG = "0a000000-0000-4000-8000-00000000000a";
const VIDEO = "0b000000-0000-4000-8000-00000000000b";
const PIC = "0c000000-0000-4000-8000-00000000000c";
const CONSENT = "0d000000-0000-4000-8000-00000000000d";
const JOB = "0e000000-0000-4000-8000-00000000000e";

const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  current: { id: "0a000000-0000-4000-8000-00000000000a" } as { id: string } | null,
  rpc: {} as Record<string, { data: unknown; error: { code?: string; message?: string; details?: string } | null }>,
  tables: {} as Record<string, { data: unknown; error: { code?: string; message?: string } | null }>,
  calls: [] as { kind: string; name: string; args?: unknown; chain: { m: string; a: unknown[] }[] }[],
  getUser: 0,
}));

function builder(rec: { chain: { m: string; a: unknown[] }[] }, result: () => unknown): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...a: unknown[]) => {
        rec.chain.push({ m: String(prop), a });
        return q;
      };
    },
  });
  return q;
}

const client = {
  rpc: (name: string, args: unknown) => {
    const rec = { kind: "rpc", name, args, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    const rec = { kind: "from", name, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.tables[name] ?? { data: [], error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client,
  getUser: async () => {
    h.getUser++;
    return h.user;
  },
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, orgs: [], current: h.current }) }));

const root = await import("../app/api/character-studio/route");
const quote = await import("../app/api/character-studio/quote/route");
const consent = await import("../app/api/character-studio/consent/route");
const swaps = await import("../app/api/character-studio/swaps/route");
const cancel = await import("../app/api/character-studio/swaps/[id]/cancel/route");
const model = await import("../lib/characterStudio/model");
const { CHARACTER_STUDIO_STRINGS, characterStudioStrings } = await import("../lib/i18n/character-studio");
const { characterStudioEn } = await import("../lib/i18n/character-studio/en");

function req(url: string, method: string, body?: unknown, headers: Record<string, string> = { Origin: "http://x" }) {
  return new Request(`http://x${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined || method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const rpcs = () => h.calls.filter((c) => c.kind === "rpc");

const DECL = { rights_to_video: true, performers_consented: true, no_minors: true, references_owned_or_licensed: true, data_to_provider: true };
const CONSENT_BODY = { model: "kling-4.0-omni-edit", input: VIDEO, references: [PIC], declarations: DECL };
const SWAP_BODY = {
  input: VIDEO, references: [PIC], prompt: "Replace the person with @Image 1", model: "kling-4.0-omni-edit", resolution: "720p",
  consent_id: CONSENT, max_credits: 18.8, idem: "cs-0123456789abcdef",
};
const EVERY: [string, () => Promise<Response>][] = [
  ["GET /api/character-studio", () => root.GET(req("/api/character-studio", "GET"))],
  ["GET /api/character-studio/quote", () => quote.GET(req(`/api/character-studio/quote?input=${VIDEO}&resolution=720p`, "GET"))],
  ["POST /api/character-studio/consent", () => consent.POST(req("/api/character-studio/consent", "POST", CONSENT_BODY))],
  ["POST /api/character-studio/swaps", () => swaps.POST(req("/api/character-studio/swaps", "POST", SWAP_BODY))],
  ["POST /api/character-studio/swaps/:id/cancel", () => cancel.POST(req(`/api/character-studio/swaps/${JOB}/cancel`, "POST", {}), ctx(JOB))],
];
const POSTS = EVERY.slice(2);

beforeEach(() => {
  process.env.NIGHTSHIFT_CHARACTER_STUDIO = "on";
  h.user = { id: "u1" };
  h.current = { id: ORG };
  h.rpc = {};
  h.tables = {};
  h.calls.length = 0;
  h.getUser = 0;
});
afterEach(() => {
  delete process.env.NIGHTSHIFT_CHARACTER_STUDIO;
});

describe("the switch", () => {
  it("is on for exactly \"on\", the worker's rule, and off for anything else", () => {
    delete process.env.NIGHTSHIFT_CHARACTER_STUDIO;
    expect(model.characterStudioEnabled()).toBe(false);
    for (const v of ["", "off", "0", "false", "no", "enabled", "1", "true", "yes", "onn"]) expect(model.characterStudioEnabled(v), v).toBe(false);
    for (const v of ["on", " ON ", "On"]) expect(model.characterStudioEnabled(v), v).toBe(true);
  });

  it.each(EVERY)("%s is a 404 while the switch is off, before the origin, the session or the database is looked at", async (_n, call) => {
    for (const v of [undefined, "", "off"]) {
      if (v === undefined) delete process.env.NIGHTSHIFT_CHARACTER_STUDIO;
      else process.env.NIGHTSHIFT_CHARACTER_STUDIO = v;
      expect(await json(await call())).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(h.getUser).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it.each(POSTS)("%s with the switch off is a 404 even for a cross-site page (nothing says the route exists)", async (name) => {
    delete process.env.NIGHTSHIFT_CHARACTER_STUDIO;
    const bad = { Origin: "https://evil.example" };
    const res =
      name.includes("consent") ? await consent.POST(req("/api/character-studio/consent", "POST", CONSENT_BODY, bad))
        : name.includes("cancel") ? await cancel.POST(req(`/api/character-studio/swaps/${JOB}/cancel`, "POST", {}, bad), ctx(JOB))
          : await swaps.POST(req("/api/character-studio/swaps", "POST", SWAP_BODY, bad));
    expect(res.status).toBe(404);
  });

  it.each(EVERY)("%s is a 401 for a signed-out caller, and the database is not asked", async (_n, call) => {
    h.user = null;
    expect(await json(await call())).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(h.calls).toEqual([]);
  });

  it.each(POSTS)("%s refuses a request that is not from our own page, before the session", async (name) => {
    for (const headers of [{ Origin: "https://evil.example" }, {} as Record<string, string>, { Origin: "null" }]) {
      const res =
        name.includes("consent") ? await consent.POST(req("/api/character-studio/consent", "POST", CONSENT_BODY, headers))
          : name.includes("cancel") ? await cancel.POST(req(`/api/character-studio/swaps/${JOB}/cancel`, "POST", {}, headers), ctx(JOB))
            : await swaps.POST(req("/api/character-studio/swaps", "POST", SWAP_BODY, headers));
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(h.getUser).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("the quote", () => {
  it("is the database's, per model, and a model without a number is not on sale", async () => {
    h.rpc.quote_character_swap = {
      data: {
        seconds: 9.2, billed_seconds: 10, resolution: "1080p", exempt: false,
        models: [
          { model: "kling-4.0-omni-edit", on_sale: true, credits: 28.2, hold: 30, problem: null },
          { model: "seedance-2.5-edit", on_sale: true, credits: null, hold: null, problem: "needs_own_generated_clip" },
          { model: "made-up", on_sale: true, credits: 1, hold: 1 },
        ],
      },
      error: null,
    };
    const out = await json(await quote.GET(req(`/api/character-studio/quote?input=${VIDEO}&resolution=1080p`, "GET")));
    expect(out.status).toBe(200);
    expect(out.body.quote).toEqual({
      seconds: 9.2, billedSeconds: 10, resolution: "1080p", exempt: false,
      models: [
        { model: "kling-4.0-omni-edit", onSale: true, credits: 28.2, hold: 30, problem: null },
        { model: "seedance-2.5-edit", onSale: false, credits: null, hold: null, problem: "needs_own_generated_clip" },
      ],
    });
    expect(rpcs()[0].args).toEqual({ p_org: ORG, p_input: VIDEO, p_resolution: "1080p" });
  });

  it("refuses a resolution or an input that is not one, and never asks with them", async () => {
    for (const q of [`input=${VIDEO}&resolution=4k`, "input=x&resolution=720p", `input=${VIDEO}`]) {
      expect((await quote.GET(req(`/api/character-studio/quote?${q}`, "GET"))).status, q).toBe(400);
    }
    expect(rpcs()).toEqual([]);
  });

  it("an answer that is not a quote is a failure, never a made-up price", async () => {
    h.rpc.quote_character_swap = { data: { seconds: 10 }, error: null };
    expect(await json(await quote.GET(req(`/api/character-studio/quote?input=${VIDEO}&resolution=720p`, "GET")))).toEqual({ status: 502, body: { error: "failed" } });
  });
});

describe("the consent and the request", () => {
  it("the consent sends the five declarations and this page's consent version, nothing the browser added", async () => {
    h.rpc.record_character_swap_consent = { data: { id: CONSENT }, error: null };
    const out = await json(await consent.POST(req("/api/character-studio/consent", "POST", { ...CONSENT_BODY, declarations: { ...DECL } })));
    expect(out).toEqual({ status: 201, body: { consent_id: CONSENT } });
    expect(rpcs()[0].args).toEqual({ p_org: ORG, p_model: "kling-4.0-omni-edit", p_input: VIDEO, p_refs: [PIC], p_declarations: DECL, p_version: "v1" });
  });

  it("a declaration left out, false or extra is refused before the database", async () => {
    for (const declarations of [{ ...DECL, no_minors: false }, { ...DECL, extra: true }, { rights_to_video: true }, "yes"]) {
      expect((await consent.POST(req("/api/character-studio/consent", "POST", { ...CONSENT_BODY, declarations }))).status).toBe(400);
    }
    expect(rpcs()).toEqual([]);
  });

  it("the request carries the shown charge as its ceiling and the press's key", async () => {
    h.rpc.request_character_swap = { data: { id: JOB, status: "requested", credits: 18.8, hold: 30, replayed: false }, error: null };
    const out = await json(await swaps.POST(req("/api/character-studio/swaps", "POST", SWAP_BODY)));
    expect(out).toEqual({ status: 201, body: { id: JOB, status: "requested", credits: 18.8, hold: 30, replayed: false } });
    expect(rpcs()[0].args).toEqual({
      p_org: ORG, p_project: null, p_input: VIDEO, p_refs: [PIC], p_prompt: SWAP_BODY.prompt, p_model: "kling-4.0-omni-edit", p_resolution: "720p",
      p_consent: CONSENT, p_max_credits: 18.8, p_idem: SWAP_BODY.idem,
    });
  });

  it("no ceiling, a ceiling that is not a number, an unknown model or a bad key is refused before the database", async () => {
    for (const over of [{ max_credits: undefined }, { max_credits: "18.8" }, { max_credits: -1 }, { max_credits: 1e9 }, { model: "kling-v3" },
                        { resolution: "4k" }, { idem: "short" }, { references: [] }, { references: ["x"] }, { consent_id: "x" },
                        { prompt: "x".repeat(2001) }, { project_id: "x" }]) {
      expect((await swaps.POST(req("/api/character-studio/swaps", "POST", { ...SWAP_BODY, ...over }))).status, JSON.stringify(over)).toBe(400);
    }
    expect(rpcs()).toEqual([]);
  });

  it.each([
    [{ code: "NS409", message: "not_on_sale" }, 409, { error: "not_on_sale" }],
    [{ code: "NS409", message: "price_changed", details: "charge=20.5" }, 409, { error: "price_changed", charge: 20.5 }],
    [{ code: "NS402", message: "swap_hold_unavailable", details: "hold=30 charge=18.8" }, 402, { error: "swap_hold_unavailable", charge: 18.8, hold: 30 }],
    [{ code: "NS409", message: "consent_required" }, 409, { error: "consent_required" }],
    [{ code: "NS400", message: "prompt_real_person" }, 400, { error: "prompt_real_person" }],
    [{ code: "NS400", message: "needs_own_generated_clip" }, 400, { error: "needs_own_generated_clip" }],
    [{ code: "NS429", message: "org_daily_limit" }, 429, { error: "org_daily_limit" }],
    [{ code: "NS429", message: "platform_busy" }, 429, { error: "platform_busy" }],
    [{ code: "NS429", message: "parallel run limit reached (2 of 2)" }, 429, { error: "parallel_limit" }],
    [{ code: "NS409", message: "job_in_progress" }, 409, { error: "job_in_progress" }],
    [{ code: "42501", message: "forbidden" }, 403, { error: "forbidden" }],
    [{ code: "XX000", message: "something internal at line 42" }, 502, { error: "failed" }],
    [{ code: "PGRST202", message: "Could not find the function" }, 503, { error: "not_available" }],
  ])("a refusal %j is a closed word, never the database's own text", async (error, status, body) => {
    h.rpc.request_character_swap = { data: null, error };
    expect(await json(await swaps.POST(req("/api/character-studio/swaps", "POST", SWAP_BODY)))).toEqual({ status, body });
  });

  it("cancel names the job, and another organization's job reads as not found", async () => {
    h.rpc.cancel_character_swap = { data: { id: JOB, status: "cancelled", replayed: false }, error: null };
    expect(await json(await cancel.POST(req(`/api/character-studio/swaps/${JOB}/cancel`, "POST", {}), ctx(JOB)))).toEqual({ status: 200, body: { id: JOB, status: "cancelled" } });
    h.rpc.cancel_character_swap = { data: null, error: { code: "P0002", message: "not_found" } };
    expect((await cancel.POST(req(`/api/character-studio/swaps/${JOB}/cancel`, "POST", {}), ctx(JOB))).status).toBe(404);
    expect((await cancel.POST(req("/api/character-studio/swaps/x/cancel", "POST", {}), ctx("x"))).status).toBe(404);
  });
});

describe("the state", () => {
  it("reads the gallery, the samples, the jobs and the library under the member's session, and never the prices table", async () => {
    h.tables.character_swap_templates = {
      data: [{ id: "1a000000-0000-4000-8000-00000000001a", slug: "two-characters", position: 1, title_en: "Two", title_ru: "Два", title_uz: "Ikki", prompt: "Replace @Image 1", characters: 2 }],
      error: null,
    };
    h.tables.character_swap_template_samples = {
      data: [
        { template_id: "1a000000-0000-4000-8000-00000000001a", model_id: "kling-4.0-omni-edit", web_url: "https://cdn.example.com/s/two.mp4", poster_url: null },
        { template_id: "1a000000-0000-4000-8000-00000000001a", model_id: "seedance-2.5-edit", web_url: "javascript:alert(1)", poster_url: null },
      ],
      error: null,
    };
    const out = await json(await root.GET(req("/api/character-studio", "GET")));
    expect(out.status).toBe(200);
    const tpl = (out.body.templates as { samples: Record<string, unknown> }[])[0];
    expect(tpl.samples["kling-4.0-omni-edit"]).toEqual({ model: "kling-4.0-omni-edit", webUrl: "https://cdn.example.com/s/two.mp4", posterUrl: null });
    expect(tpl.samples["seedance-2.5-edit"], "a link that is not the CDN's https copy is an empty slot").toBeNull();
    const read = h.calls.filter((c) => c.kind === "from").map((c) => c.name).sort();
    expect(read).toEqual(["character_swap_jobs", "character_swap_template_samples", "character_swap_templates", "media_assets", "media_assets"]);
    const jobs = h.calls.find((c) => c.name === "character_swap_jobs")!;
    expect(jobs.chain).toContainEqual({ m: "eq", a: ["org_id", ORG] });
  });

  it("a missing table is not_available and a failed read is read_failed, never an empty studio", async () => {
    h.tables.character_swap_jobs = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    expect((await root.GET(req("/api/character-studio", "GET"))).status).toBe(503);
    h.tables.character_swap_jobs = { data: null, error: { code: "57014", message: "timeout" } };
    expect(await json(await root.GET(req("/api/character-studio", "GET")))).toEqual({ status: 502, body: { error: "read_failed" } });
  });
});

describe("the files", () => {
  it("no route or helper reaches for the service key, a vendor or a NEXT_PUBLIC switch", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const files = [...walk(join(__dirname, "..", "app", "api", "character-studio")), join(__dirname, "..", "lib", "server", "character-studio.ts"),
                   join(__dirname, "..", "lib", "characterStudio", "model.ts"), ...walk(join(__dirname, "..", "components", "character-studio"))];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/SERVICE_ROLE|SERVICE_KEY|service_role/);
      expect(src, f).not.toMatch(/klingai\.com|bytepluses\.com|KLING_API_KEY|SEEDANCE_API_KEY/);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*CHARACTER/);
    }
  });

  it("the worker signs input links the way the web app does (lib/server/media.ts signMedia)", async () => {
    // The same vector as tests/test_character_swap_worker.py: both implementations of the HMAC agree.
    const { signMedia } = await import("../lib/server/media");
    expect(signMedia(Buffer.from("k".repeat(32), "utf8"), "11111111-1111-1111-1111-111111111111", "original", "video/mp4", 2_000_000_000)).toBe(
      "XVu_umBhDtx2MGPwU9LMW4zudqnl2rZzPzdAfpJ0t00",
    );
    expect(createHmac("sha256", "k".repeat(32)).update("nightshift-media-v1\n11111111-1111-1111-1111-111111111111\noriginal\nvideo/mp4\n2000000000").digest("base64url")).toBe(
      "XVu_umBhDtx2MGPwU9LMW4zudqnl2rZzPzdAfpJ0t00",
    );
  });
});

describe("the strings", () => {
  const leaves = (o: unknown, p = ""): [string, string][] =>
    typeof o === "string" ? [[p, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k));

  it.each(["ru", "uz"])("%s has every English key, the same {fillers}, and no empty string", (loc) => {
    const en = new Map(leaves(characterStudioEn));
    const other = new Map(leaves(CHARACTER_STUDIO_STRINGS[loc]));
    expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [k, v] of en) {
      const fill = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(fill(other.get(k)!), `${loc}.${k}`).toEqual(fill(v));
      expect(other.get(k)!.trim(), `${loc}.${k}`).not.toBe("");
    }
  });

  it("every refusal the database or a route can give has words in every language", () => {
    const words: import("../lib/characterStudio/model").SwapError[] = ["not_on_sale", "price_changed", "consent_required", "swap_hold_unavailable", "needs_own_generated_clip", "parallel_limit", "not_cancellable", "platform_busy"];
    for (const loc of ["en", "ru", "uz"]) {
      const t = characterStudioStrings(loc);
      for (const w of words) expect((t.errors as Record<string, string>)[w], `${loc}.${w}`).toBeTruthy();
    }
    expect(characterStudioStrings("de")).toBe(characterStudioEn);
  });

  it("the Uzbek card says what the owner asked for", () => {
    expect(CHARACTER_STUDIO_STRINGS.uz.gallery.try).toBe("Sinab koʻrish");
    expect(CHARACTER_STUDIO_STRINGS.uz.gallery.sampleSoon).toBe("Namuna tez orada");
  });
});
