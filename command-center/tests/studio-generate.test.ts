import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";
import { PARAM_KEYS } from "@/lib/creative/operations";
import {
  DISMISSED_KEY,
  addDismissed,
  apiErrorMessage,
  buildParams,
  coerceJobs,
  coerceModels,
  creditsLine,
  errorAction,
  failureReason,
  generateLabel,
  isActiveStatus,
  modelsFor,
  newIdempotencyKey,
  prefillFromJob,
  readDismissed,
  resultHref,
  statusView,
  truncate,
} from "@/lib/creative/studio";
import { IDEMPOTENCY_KEY_RE } from "@/lib/creative/operations";

const t = dictionaries.en;

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

const job = (over: Record<string, unknown> = {}) =>
  coerceJobs([
    {
      id: "j1",
      capability: "t2v",
      status: "queued",
      requested_model: "m-video",
      params: { prompt: "a forest", aspect_ratio: "9:16", duration_s: 10 },
      quoted_credits: 12.5,
      charged_credits: null,
      error_code: null,
      result: null,
      result_asset_ids: [],
      created_at: "2026-10-01T00:00:00Z",
      ...over,
    },
  ])[0];

describe("models", () => {
  it("keeps only verified beta/ga rows and filters by capability", () => {
    const models = coerceModels([
      { id: "a", display_name: "Alpha", capabilities: ["t2i"], availability: "ga", verified_at: "2026-01-01" },
      { id: "b", display_name: "", capabilities: ["t2v", "t2i"], availability: "beta", verified_at: "2026-01-01" },
      { id: "c", display_name: "Hidden", capabilities: ["t2i"], availability: "hidden", verified_at: "2026-01-01" },
      { id: "d", display_name: "Unproven", capabilities: ["t2i"], availability: "ga", verified_at: null },
      { id: "e", display_name: "No caps", capabilities: [], availability: "ga", verified_at: "x" },
      null,
    ]);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(models[1]).toMatchObject({ displayName: "b", beta: true });
    expect(modelsFor(models, "t2v").map((m) => m.id)).toEqual(["b"]);
    expect(coerceModels(null)).toEqual([]);
  });
});

describe("params", () => {
  it("sends only keys 0036 accepts for each kind", () => {
    const base = { prompt: "  hi  ", aspect: "1:1" as const, duration: 10 as const };
    expect(buildParams({ ...base, capability: "t2i" })).toEqual({ prompt: "hi", aspect_ratio: "1:1" });
    expect(buildParams({ ...base, capability: "t2v" })).toEqual({ prompt: "hi", aspect_ratio: "1:1", duration_s: 10 });
    expect(buildParams({ ...base, capability: "tts" })).toEqual({ prompt: "hi" });
    for (const cap of ["t2i", "t2v", "tts"] as const)
      for (const k of Object.keys(buildParams({ ...base, capability: cap })))
        expect(PARAM_KEYS as readonly string[]).toContain(k);
  });

  it("makes a fresh, valid idempotency key per click", () => {
    const a = newIdempotencyKey();
    expect(IDEMPOTENCY_KEY_RE.test(a)).toBe(true);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe("the button and errors", () => {
  it("puts the price on the button", () => {
    expect(generateLabel(t, { status: "idle" })).toBe("Generate");
    expect(generateLabel(t, { status: "quoting" })).toBe(t.gen.quoting);
    expect(generateLabel(t, { status: "ready", credits: 3.5 })).toBe("Generate · 3.5 credits");
    expect(generateLabel(t, { status: "error", code: "unpriced" })).toBe("Generate");
  });

  it("maps route codes to sentences and actions, never echoing an unknown code", () => {
    expect(apiErrorMessage(t, "insufficient_credits")).toBe(t.creative.errors.insufficient_credits);
    expect(apiErrorMessage(t, "something_internal")).toBe(t.creative.errors.failed);
    expect(errorAction("insufficient_credits")).toBe("credits");
    expect(errorAction("price_changed")).toBe("requote");
    expect(errorAction("run_limit_reached")).toBeNull();
  });
});

describe("jobs", () => {
  it("knows which statuses are still working", () => {
    for (const s of ["queued", "planning", "running", "provider_pending", "processing", "rendering"])
      expect(isActiveStatus(s)).toBe(true);
    for (const s of ["completed", "failed", "cancelled", "expired", undefined]) expect(isActiveStatus(s)).toBe(false);
  });

  it("says held / charged / returned", () => {
    expect(creditsLine(t, job())).toBe("held 12.5 credits");
    expect(creditsLine(t, job({ status: "completed", charged_credits: "10" }))).toBe("charged 10 credits");
    expect(creditsLine(t, job({ status: "failed" }))).toBe(t.gen.returned);
    expect(creditsLine(t, job({ status: "cancelled" }))).toBe(t.gen.returned);
  });

  it("explains failures in plain words, never the internal code", () => {
    expect(failureReason(t, { status: "failed", error_code: "policy" })).toBe(t.gen.reasons.policy);
    expect(failureReason(t, { status: "failed", error_code: "worker_lost" })).toBe(t.gen.reasons.service);
    expect(failureReason(t, { status: "expired", error_code: "not_picked_up" })).toBe(t.gen.reasons.expired);
    expect(failureReason(t, { status: "failed", error_code: "zzz_new" })).toBe(t.gen.reasons.generic);
    expect(statusView(t, "provider_pending")).toMatchObject({ tone: "run", live: true });
    expect(statusView(t, "queued").tone).toBe("idle");
  });

  it("only links https results", () => {
    expect(resultHref({ result: { url: "https://cdn.example/x.png" } })).toBe("https://cdn.example/x.png");
    expect(resultHref({ result: { files: [{ name: "x" }, { url: "https://a/b.mp4" }] } })).toBe("https://a/b.mp4");
    expect(resultHref({ result: { url: "javascript:alert(1)" } })).toBeNull();
    expect(resultHref({ result: { files: [{ path: "/data/x" }], storage: "worker" } })).toBeNull();
    expect(resultHref({ result: null })).toBeNull();
  });

  it("prefills Try again from the job, and only for kinds the panel makes", () => {
    expect(prefillFromJob(job({ status: "failed" }))).toEqual({
      capability: "t2v",
      model: "m-video",
      prompt: "a forest",
      aspect: "9:16",
      duration: 10,
      // 0048: a video can take a style kit; this job had none.
      styleKitId: null,
    });
    expect(prefillFromJob(job({ capability: "music" }))).toBeNull();
  });

  it("truncates long prompts", () => {
    expect(truncate("a  b\n c")).toBe("a b c");
    expect(truncate("x".repeat(200), 10)).toHaveLength(10);
  });
});

describe("dismissed ids", () => {
  it("round-trips through storage", () => {
    const s = memory();
    const list = addDismissed("j1", [], s);
    expect(addDismissed("j1", list, s)).toEqual(["j1"]);
    expect(readDismissed(s)).toEqual(["j1"]);
  });

  it("survives broken or blocked storage", () => {
    expect(readDismissed(memory({ [DISMISSED_KEY]: "{not json" }))).toEqual([]);
    expect(readDismissed(memory({ [DISMISSED_KEY]: '{"a":1}' }))).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDismissed(throwing)).toEqual([]);
    expect(addDismissed("j2", ["j1"], throwing)).toEqual(["j1", "j2"]);
    expect(readDismissed(null)).toEqual([]);
  });
});
