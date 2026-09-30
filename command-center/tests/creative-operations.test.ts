import { describe, expect, it } from "vitest";
import {
  CREATIVE_ERRORS,
  cancelJob,
  createGeneration,
  getJob,
  listJobs,
  mapCreativeError,
  parseGenerationInput,
  quote,
  type CreativeDb,
  type DbAnswer,
} from "@/lib/creative/operations";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const ORG = "11111111-2222-4333-8444-555555555555";
const JOB = "0f0e0d0c-0b0a-4000-8000-000000000001";

function fakeDb(answers: Partial<Record<string, DbAnswer>> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: CreativeDb = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      return answers[fn] ?? { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    },
    async readJob(id) {
      calls.push({ fn: "readJob", args: { id } });
      return answers.readJob ?? { data: null, error: null };
    },
    async listJobs(orgId, limit) {
      calls.push({ fn: "listJobs", args: { orgId, limit } });
      return answers.listJobs ?? { data: [], error: null };
    },
  };
  return { db, calls };
}

const body = { capability: "t2i", model: "img-x", params: { prompt: "a cat" }, max_credits: 6 };

function input(extra: Record<string, unknown> = {}, requirePrice = true) {
  const p = parseGenerationInput({ ...body, ...extra }, ORG, { requirePrice });
  if (!p.ok) throw new Error(JSON.stringify(p.result));
  return p.input;
}

describe("parseGenerationInput", () => {
  it("uses the open organization when the body names none", () => {
    expect(input().orgId).toBe(ORG);
  });

  it("refuses unknown fields and unknown params instead of dropping them", () => {
    const a = parseGenerationInput({ ...body, price: 0 }, ORG, { requirePrice: true });
    expect(a.ok || a.result.body.error).toBe("invalid_body");
    const b = parseGenerationInput({ ...body, params: { prompt: "x", credits: 0 } }, ORG, { requirePrice: true });
    expect(b.ok || b.result.body.error).toBe("invalid_params");
  });

  it("never lets the client name a price: max_credits is only the confirmed ceiling", () => {
    const p = parseGenerationInput({ ...body, max_credits: undefined }, ORG, { requirePrice: true });
    expect(p.ok || p.result.body.error).toBe("confirm_price");
  });

  it("needs an organization and a known capability", () => {
    const a = parseGenerationInput(body, null, { requirePrice: true });
    expect(a.ok || a.result.body.error).toBe("org_required");
    const b = parseGenerationInput({ ...body, capability: "i2v" }, ORG, { requirePrice: true });
    expect(b.ok || b.result.body.error).toBe("capability_not_supported");
  });

  it("takes the idempotency key from the header, and refuses two different ones", () => {
    const p = parseGenerationInput(body, ORG, { requirePrice: true, idempotencyHeader: "k-1" });
    expect(p.ok && p.input.idempotencyKey).toBe("k-1");
    const q = parseGenerationInput({ ...body, idempotency_key: "k-2" }, ORG, { requirePrice: true, idempotencyHeader: "k-1" });
    expect(q.ok || q.result.body.error).toBe("invalid_idempotency_key");
    const r = parseGenerationInput(body, ORG, { requirePrice: true, idempotencyHeader: "bad key!" });
    expect(r.ok || r.result.body.error).toBe("invalid_idempotency_key");
  });
});

describe("mapCreativeError", () => {
  it("reads a missing migration as 'not enabled here', never as a zero", () => {
    expect(mapCreativeError({ code: "PGRST202", message: "Could not find the function" }).body.error).toBe("creative_unavailable");
    expect(mapCreativeError({ code: "42P01", message: "relation does not exist" }).status).toBe(503);
  });

  it("keeps the registry being absent distinct from a model being unavailable", () => {
    expect(mapCreativeError({ code: "NS400", message: "registry_missing" }).body.error).toBe("registry_missing");
    expect(mapCreativeError({ code: "NS400", message: "model_not_sellable" }).body.error).toBe("model_not_sellable");
    expect(mapCreativeError({ code: "NS400", message: "unpriced" }).body.error).toBe("unpriced");
  });

  it("carries the shortfall of an insufficient-credits refusal", () => {
    const r = mapCreativeError({ code: "NS402", message: "insufficient credits", details: "available=4.00 needed=6.00" });
    expect(r).toEqual({ status: 402, body: { error: "insufficient_credits", available: 4, needed: 6 } });
  });

  it("maps membership and existence refusals", () => {
    expect(mapCreativeError({ code: "42501", message: "forbidden" }).status).toBe(403);
    expect(mapCreativeError({ code: "P0002", message: "not_found" }).status).toBe(404);
    expect(mapCreativeError({ code: "NS409", message: "not_cancellable" }).body.error).toBe("not_cancellable");
    expect(mapCreativeError({ code: "XX000", message: "boom" }).body.error).toBe("failed");
  });
});

describe("operations", () => {
  it("quote passes the request through and returns the database's number", async () => {
    const { db, calls } = fakeDb({ quote_creative_job: { data: { credits: 6, exempt: false }, error: null } });
    const r = await quote(db, input({}, false));
    expect(r).toEqual({ status: 200, body: { quote: { credits: 6, exempt: false } } });
    expect(calls[0]).toEqual({
      fn: "quote_creative_job",
      args: { p_org: ORG, p_capability: "t2i", p_model: "img-x", p_params: { prompt: "a cat" } },
    });
  });

  it("create sends the confirmed ceiling, and a replay answers 200 with the same job", async () => {
    const job = { id: JOB, status: "queued", quoted_credits: 6 };
    const first = fakeDb({ create_creative_job: { data: { job, replay: false }, error: null } });
    const r = await createGeneration(first.db, input({ idempotency_key: "k-1" }));
    expect(r.status).toBe(201);
    expect(first.calls[0].args).toMatchObject({ p_max_credits: 6, p_idempotency_key: "k-1", p_mode: "exact" });
    const again = fakeDb({ create_creative_job: { data: { job, replay: true }, error: null } });
    const r2 = await createGeneration(again.db, input({ idempotency_key: "k-1" }));
    expect(r2).toEqual({ status: 200, body: { job, replay: true } });
  });

  it("degrades honestly when 0036 is not applied", async () => {
    const { db } = fakeDb();
    expect((await createGeneration(db, input())).body.error).toBe("creative_unavailable");
    expect((await cancelJob(db, JOB)).body.error).toBe("creative_unavailable");
    const missingTable = fakeDb({ readJob: { data: null, error: { code: "42P01", message: 'relation "creative_jobs" does not exist' } } });
    expect((await getJob(missingTable.db, JOB)).status).toBe(503);
  });

  it("another organization's job reads as not found", async () => {
    const { db } = fakeDb({ readJob: { data: null, error: null } });
    expect(await getJob(db, JOB)).toEqual({ status: 404, body: { error: "not_found" } });
    expect((await getJob(db, "not-a-uuid")).status).toBe(404);
  });

  it("lists only with an organization, and caps the page", async () => {
    const { db, calls } = fakeDb({ listJobs: { data: [{ id: JOB }], error: null } });
    expect((await listJobs(db, null)).body.error).toBe("org_required");
    await listJobs(db, ORG, 5000);
    expect(calls.at(-1)).toEqual({ fn: "listJobs", args: { orgId: ORG, limit: 100 } });
  });

  it("cancel maps the database's refusal once the provider has the job", async () => {
    const { db } = fakeDb({ cancel_creative_job: { data: null, error: { code: "NS409", message: "not_cancellable" } } });
    expect(await cancelJob(db, JOB)).toMatchObject({ status: 409, body: { error: "not_cancellable" } });
  });
});

describe("creative i18n", () => {
  it("every error code the routes answer has a sentence in en, ru and uz", () => {
    for (const dict of [en, ru, uz]) {
      const errors = dict.creative.errors as Record<string, string>;
      for (const code of CREATIVE_ERRORS) expect(errors[code], code).toBeTruthy();
    }
  });
});
