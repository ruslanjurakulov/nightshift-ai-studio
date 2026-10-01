import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCreative, getCreativeJob, parseCreativeBody, quoteCreative, type ApiCaller, type Rpc } from "@/lib/api/operations";
import { toWire } from "@/lib/api/http";
import { openApiSpec } from "@/lib/api/openapi";

vi.mock("server-only", () => ({}));

const JOB = "0a1b2c3d-0000-4000-8000-00000000abcd";
const BODY = { capability: "t2i", model: "Some-Model", params: { prompt: "a lighthouse" }, max_credits: 6 };

function caller(answer: unknown = { ok: true, status: 200, data: {} }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    return { data: answer, error: null };
  };
  const c: ApiCaller = { keyHash: "b".repeat(64), requestId: "req_test", rpc, backend: "queue", downloads: false };
  return { c, calls };
}

const code = (r: { ok: boolean }) => (r.ok ? null : (r as { code: string }).code);

describe("POST /creative/jobs", () => {
  it("passes the key hash, the Studio-parsed request, the price confirmed and the idempotency key to api_creative_create", async () => {
    const { c, calls } = caller({ ok: true, status: 201, data: { id: JOB } });
    const r = await createCreative(c, BODY, " key-1 ");
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("api_creative_create");
    expect(calls[0].args).toMatchObject({
      p_key_hash: c.keyHash,
      p_capability: "t2i",
      p_model: "some-model",
      p_params: { prompt: "a lighthouse" },
      p_mode: "exact",
      p_max_credits: 6,
      p_idem_key: "key-1",
      p_request_id: "req_test",
    });
    expect(String(calls[0].args.p_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never sends an organization: the key's is the only one", async () => {
    const { c, calls } = caller();
    await createCreative(c, BODY, "k");
    expect(Object.keys(calls[0].args).filter((k) => /org/i.test(k))).toEqual([]);
    for (const evil of [{ ...BODY, org_id: "11111111-1111-4111-8111-111111111111" }, { ...BODY, idempotency_key: "k" }]) {
      const r = await createCreative(c, evil, "k");
      expect(code(r)).toBe("unknown_parameter");
    }
    expect(calls).toHaveLength(1);
  });

  it("refuses a missing or malformed Idempotency-Key and a missing max_credits before any database call", async () => {
    const { c, calls } = caller();
    expect(code(await createCreative(c, BODY, null))).toBe("idempotency_key_required");
    expect(code(await createCreative(c, BODY, "  "))).toBe("idempotency_key_required");
    expect(code(await createCreative(c, BODY, "not valid!"))).toBe("invalid_idempotency_key");
    const { max_credits: _omit, ...noPrice } = BODY;
    void _omit;
    expect(code(await createCreative(c, noPrice, "k"))).toBe("max_credits_required");
    expect(code(await createCreative(c, { ...BODY, max_credits: -1 }, "k"))).toBe("max_credits_required");
    expect(code(await createCreative(c, { ...BODY, max_credits: "6" }, "k"))).toBe("max_credits_required");
    expect(calls).toEqual([]);
  });

  it("refuses what the Studio refuses, with the API's own answer shape", async () => {
    const { c, calls } = caller();
    const cases: [unknown, number, string][] = [
      [null, 400, "invalid_body"],
      [[], 400, "invalid_body"],
      [{ ...BODY, capability: "teleport" }, 422, "capability_not_supported"],
      [{ ...BODY, params: { prompt: "x", surprise: 1 } }, 400, "invalid_params"],
      [{ ...BODY, capability: "edit", params: { prompt: "x" } }, 400, "invalid_params"],
      [{ ...BODY, capability: "upscale", params: { source_asset_id: JOB, factor: 3 } }, 400, "invalid_params"],
      [{ ...BODY, model: "" }, 400, "invalid_params"],
      [{ ...BODY, foo: 1 }, 400, "unknown_parameter"],
    ];
    for (const [body, status, want] of cases) {
      const r = await createCreative(c, body, "k");
      expect(r.ok, JSON.stringify(body)).toBe(false);
      expect([(r as { status: number }).status, code(r)], JSON.stringify(body)).toEqual([status, want]);
    }
    expect(calls).toEqual([]);
  });

  it("fingerprints the whole request, so the same key with another price or prompt is a different request", async () => {
    const { c, calls } = caller();
    await createCreative(c, BODY, "k");
    await createCreative(c, { ...BODY, max_credits: 7 }, "k");
    await createCreative(c, { ...BODY, params: { prompt: "another" } }, "k");
    // the same request as the first with its keys in another order: the same fingerprint
    await createCreative(c, { max_credits: 6, params: { prompt: "a lighthouse" }, model: "Some-Model", capability: "t2i" }, "k");
    const fps = calls.map((x) => x.args.p_fingerprint);
    expect(new Set(fps).size).toBe(3);
    expect(fps[0]).toBe(fps[3]);
  });

  it("turns the database's answer into the wire format, with the replay header", async () => {
    const { c } = caller({ ok: true, status: 201, data: { id: JOB, status: "queued" }, replayed: true, rate: { limit: 60, remaining: 59, reset: 30 } });
    const w = toWire(await createCreative(c, BODY, "k"), "req_1");
    expect(w.status).toBe(201);
    expect(w.headers["idempotent-replayed"]).toBe("true");
    expect(w.headers["x-ratelimit-limit"]).toBe("60");
  });

  it("shows a refusal as a typed error and keeps its details", async () => {
    const { c } = caller({
      ok: false,
      status: 402,
      error: { code: "insufficient_credits", message: "Not enough.", available_credits: 3, needed_credits: 6 },
    });
    const w = toWire(await createCreative(c, BODY, "k"), "req_1");
    expect(w.status).toBe(402);
    expect(w.body).toMatchObject({ error: { type: "billing_error", code: "insufficient_credits", available_credits: 3, needed_credits: 6 } });
  });

  it("says which migration is missing when the 0062 functions are not there", async () => {
    const rpc: Rpc = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const c: ApiCaller = { keyHash: "b".repeat(64), requestId: "req_t", rpc, backend: "queue", downloads: false };
    for (const r of [await createCreative(c, BODY, "k"), await quoteCreative(c, BODY), await getCreativeJob(c, JOB)]) {
      expect(r).toMatchObject({ ok: false, status: 503, code: "api_unavailable" });
      expect((r as { message: string }).message).toContain("0062");
    }
  });
});

describe("POST /creative/quote", () => {
  it("quotes without a price or an idempotency key, and holds nothing (one read-only call)", async () => {
    const { c, calls } = caller({ ok: true, status: 200, data: { quote: { credits: 6 } } });
    const { max_credits: _omit, ...noPrice } = BODY;
    void _omit;
    const r = await quoteCreative(c, noPrice);
    expect(r).toMatchObject({ ok: true, data: { quote: { credits: 6 } } });
    expect(calls.map((x) => x.fn)).toEqual(["api_creative_quote"]);
    expect(calls[0].args).not.toHaveProperty("p_max_credits");
    expect(calls[0].args).not.toHaveProperty("p_idem_key");
  });

  it("validates like create", async () => {
    const { c, calls } = caller();
    expect(code(await quoteCreative(c, { ...BODY, capability: "nope" }))).toBe("capability_not_supported");
    expect(code(await quoteCreative(c, { ...BODY, org_id: JOB }))).toBe("unknown_parameter");
    expect(calls).toEqual([]);
  });
});

describe("GET /creative/jobs/{id}", () => {
  it("looks a generation up by its uuid, lower-cased", async () => {
    const { c, calls } = caller({ ok: true, status: 200, data: { id: JOB } });
    await getCreativeJob(c, JOB.toUpperCase());
    expect(calls[0]).toMatchObject({ fn: "api_creative_get", args: { p_job_id: JOB } });
  });

  it("answers 404 for anything that is not a uuid, without a database call", async () => {
    const { c, calls } = caller();
    for (const id of ["1", "abc", "../me", "0a1b2c3d-0000-4000-8000", ""]) {
      expect(await getCreativeJob(c, id)).toMatchObject({ ok: false, status: 404, code: "job_not_found" });
    }
    expect(calls).toEqual([]);
  });
});

describe("parseCreativeBody", () => {
  it("parses exactly what the Studio parses (one source of truth for what a generation may be)", () => {
    const ok = parseCreativeBody(BODY, { requireMaxCredits: true });
    expect(ok.ok && ok.request).toEqual({ capability: "t2i", model: "some-model", params: { prompt: "a lighthouse" }, mode: "exact", maxCredits: 6 });
  });
});

describe("the routes and the OpenAPI document", () => {
  const ROOT = join(__dirname, "..");

  it("documents the three endpoints, their scopes and the required idempotency key", () => {
    const spec = openApiSpec("https://nightshift.test") as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { parameters: Record<string, { required: boolean }>; schemas: Record<string, { required?: string[] }> };
    };
    expect(spec.paths["/creative/quote"].post["x-required-scope"]).toBe("creative:quote");
    expect(spec.paths["/creative/jobs"].post["x-required-scope"]).toBe("creative:create");
    expect(spec.paths["/creative/jobs/{id}"].get["x-required-scope"]).toBe("creative:read");
    expect(spec.components.parameters.IdempotencyKeyRequired.required).toBe(true);
    expect(JSON.stringify(spec.paths["/creative/jobs"].post.parameters)).toContain("IdempotencyKeyRequired");
    expect(spec.components.schemas.CreativeCreateRequest.required).toEqual(["capability", "model", "params", "max_credits"]);
    // an organization is never a field of the request
    expect(JSON.stringify(spec.components.schemas.CreativeCreateRequest)).not.toContain("org_id");
  });

  it("states a scope for every operation, so nothing is documented as open by accident", () => {
    const spec = openApiSpec("https://nightshift.test") as { paths: Record<string, Record<string, Record<string, unknown>>> };
    for (const [path, ops] of Object.entries(spec.paths))
      for (const [method, op] of Object.entries(ops)) expect(typeof op["x-required-scope"], `${method} ${path}`).toBe("string");
    expect(spec.paths["/me"].get["x-required-scope"]).toContain("any valid key");
  });

  it("lists every error code the creative operations return", () => {
    const src = readFileSync(join(ROOT, "lib/api/openapi.ts"), "utf8");
    const sql = readFileSync(join(ROOT, "..", "supabase/migrations/0062_api_creative.sql"), "utf8");
    const emitted = new Set(
      [...sql.matchAll(/api_err\((?:[0-9]{3}), '([a-z_]+)'/g)].map((m) => m[1]),
    );
    for (const e of emitted) expect(src, e).toContain(`"${e}"`);
  });

  it("serves the creative routes from the shared API wrapper (key checked first)", () => {
    for (const f of ["app/api/v1/creative/quote/route.ts", "app/api/v1/creative/jobs/route.ts", "app/api/v1/creative/jobs/[id]/route.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).toContain("runApi(request");
      expect(src, f).not.toMatch(/SERVICE|service_role|createClient\(/);
    }
  });
});
