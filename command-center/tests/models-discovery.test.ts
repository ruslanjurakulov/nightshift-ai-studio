/**
 * The Models catalog's logic (lib/models-discovery.ts) and its server reads
 * (lib/server/model-discovery.ts).
 *
 * What would break without these: an unpriced model or variant drawn as 0
 * credits, a model offered as "available" that the database would refuse, a
 * provider cost or vendor id reaching the browser through the operator's spec,
 * file formats that drift from what the database accepts, a "Use in Studio"
 * link that opens a tool the Studio does not have, and filters or search that
 * hide a model they should show.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import {
  INPUT_KINDS,
  NO_FILTERS,
  PICTURE_MIME,
  RECORDING_EXTRA_MIME,
  RECORDING_MIME,
  REGISTRY_CAPABILITIES,
  STUDIO_TOOL_CAPS,
  TASKS,
  VIDEO_MIME,
  discoverySpec,
  filtersFromQuery,
  fold,
  frameAspect,
  fromAdminRow,
  fromSellableRow,
  inputKindsOf,
  linkFor,
  linksFor,
  lowestRate,
  matchesFilters,
  matchesQuery,
  planGate,
  prefillModel,
  priceVariants,
  priceView,
  promptLimit,
  PROMPT_CAP,
  providerName,
  SHOW_PROVIDER_TO_CUSTOMERS,
  showsProvider,
  widestShape,
  publicSpecOf,
  queryFor,
  rateText,
  dayOf,
  sortModels,
  sourceRule,
  taskCounts,
  tasksOf,
  type AdminRow,
  type DiscoveryModel,
  type Filters,
} from "../lib/models-discovery";
import { STUDIO_TOOLS } from "../lib/navigation";
import { COMPOSER_CAPABILITIES, prefillFromQuery } from "../lib/creative/studio";
import { CAPABILITIES } from "../lib/creative/registry";
import { readCustomerModels, readOperatorModels } from "../lib/server/model-discovery";
import { FAILED, supabaseStub, type StubResult } from "./helpers/supabaseStub";

const ROOT = path.resolve(process.cwd(), "..");
const sql = (f: string) => readFileSync(path.join(ROOT, "supabase", "migrations", f), "utf8");
const fnBody = (src: string, name: string) => {
  const start = src.lastIndexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("$$;", start));
};

// ── fixtures: shaped like schemas/model_registry.json rows ───────────────────

const videoSpec = {
  output: "video",
  inputs: { image_refs_max: 1 },
  aspect_ratios: ["16:9", "9:16"],
  resolutions: ["480p", "720p", "1080p"],
  default_resolution: "720p",
  durations_s: [5, 10],
  audio_out: true,
  async: true,
  unit: "second",
  price_variants_by: "resolution_audio",
  api_exposure: "any",
  limits: { max_prompt_chars: 2000, max_concurrent_per_org: 1 },
  quality_tier: 4,
  speed_tier: 3,
};
const imageSpec = {
  output: "image",
  inputs: { image_refs_max: 16 },
  aspect_ratios: ["1:1", "16:9"],
  qualities: ["low", "medium", "high"],
  unit: "image",
  price_variants_by: "quality",
  limits: { max_prompt_chars: 4000, max_concurrent_per_org: 2 },
};
const captionSpec = {
  output: "text",
  languages: ["uz", "ru", "en"],
  unit: "second",
  api_exposure: "web_only",
  limits: { max_prompt_chars: 200, max_concurrent_per_org: 2, max_source_seconds: 1800 },
};

function sellable(over: Record<string, unknown> = {}) {
  return {
    id: "vid-a",
    display_name: "Vid A",
    provider: "bytedance",
    capabilities: ["t2v", "i2v"],
    availability: "ga",
    verified_at: "2026-09-30T10:00:00Z",
    credit_unit: "model_vid_a_second",
    entitlement: null,
    credits_per_unit: 3,
    margin: 1.5,
    spec: videoSpec,
    ...over,
  };
}

function admin(over: Partial<AdminRow> = {}): AdminRow {
  return {
    id: "img-a",
    displayName: "Img A",
    provider: "openai",
    capabilities: ["t2i", "edit"],
    availability: "ga",
    verifiedAt: "2026-09-30T10:00:00Z",
    creditUnit: "model_img_a_image",
    entitlement: null,
    termsGate: null,
    removedFromFile: false,
    publicSpec: imageSpec,
    ...over,
  };
}

const imagePrices = { model_img_a_image: 5, model_img_a_image_low: 2, model_img_a_image_medium: 5, model_img_a_image_high: 9 };

// ── tasks and kinds ──────────────────────────────────────────────────────────

describe("tasks", () => {
  it("offers eleven task categories, each backed by a registry capability, none twice", () => {
    expect(TASKS.map((t) => t.id)).toEqual([
      "image", "edit", "video_text", "video_image", "voice",
      "sound", "upscale", "remove_bg", "dub", "describe", "captions",
    ]);
    // One capability, one key: the same model is never listed under two names for one job.
    const caps = TASKS.flatMap((t) => [...t.caps]);
    expect(new Set(caps).size).toBe(caps.length);
    for (const t of TASKS) for (const c of t.caps) expect(REGISTRY_CAPABILITIES).toContain(c);
    // Every capability the registry has sits under at least one task.
    for (const c of REGISTRY_CAPABILITIES) expect(TASKS.some((t) => (t.caps as readonly string[]).includes(c))).toBe(true);
  });

  it("keeps the registry's capability list in step with the server reader's", () => {
    expect([...REGISTRY_CAPABILITIES].sort()).toEqual([...CAPABILITIES].sort());
  });

  it("names a model's tasks in catalog order", () => {
    expect(tasksOf(["i2v", "t2v"])).toEqual(["video_text", "video_image"]);
    expect(tasksOf(["captions"])).toEqual(["captions"]);
    expect(tasksOf(["voice_change"])).toEqual(["voice"]);
  });

  it("derives what a model takes from its capabilities (not from reference slots no tool sends)", () => {
    const m = fromSellableRow(sellable(), null)!;
    expect(inputKindsOf(m)).toEqual(["text", "image"]);
    const t2i = fromSellableRow(sellable({ capabilities: ["t2i"], spec: imageSpec }), null)!;
    expect(t2i.spec.imageRefsMax).toBe(16);
    expect(inputKindsOf(t2i)).toEqual(["text"]);
    const caps = fromSellableRow(sellable({ capabilities: ["captions"], spec: captionSpec }), null)!;
    expect(inputKindsOf(caps)).toEqual(["video", "audio"]);
    expect(INPUT_KINDS).toEqual(["text", "image", "video", "audio"]);
  });
});

describe("source formats", () => {
  it("are the database's own lists (creative_picture_problem, creative_source_problem)", () => {
    const picture = fnBody(sql("0052_video_tools.sql"), "creative_picture_problem");
    for (const m of PICTURE_MIME) expect(picture).toContain(`'${m}'`);
    expect(picture).toContain("a GIF cannot be a source");
    expect(PICTURE_MIME as readonly string[]).not.toContain("image/gif");

    const source = fnBody(sql("0072_captions.sql"), "creative_source_problem");
    for (const m of VIDEO_MIME) expect(source).toContain(`'${m}'`);
    for (const m of RECORDING_MIME) expect(source).toContain(`'${m}'`);
    for (const m of RECORDING_EXTRA_MIME) expect(source).toContain(`'${m}'`);
    expect(source).toContain("a.duration_s > 300");
    expect(source).toContain("a.duration_s > 1800");
    expect(source).toContain("a.bytes > 209715200");
  });

  it("says what each tool starts from, with the shorter of the database's and the model's limits", () => {
    expect(sourceRule("t2i")).toBeNull();
    expect(sourceRule("edit")).toMatchObject({ kind: "picture", formats: ["JPEG", "PNG", "WebP", "HEIC", "HEIF"] });
    expect(sourceRule("video_upscale", 30)).toMatchObject({ kind: "video", maxSeconds: 30, maxMb: 200 });
    expect(sourceRule("voice_change")).toMatchObject({ kind: "recording", maxSeconds: 300 });
    expect(sourceRule("voice_change")!.formats).not.toContain("AAC");
    expect(sourceRule("dub")!.formats).toContain("AAC");
    expect(sourceRule("captions", 1800)!.maxSeconds).toBe(1800);
  });
});

// ── price: unknown is never 0 ────────────────────────────────────────────────

describe("price", () => {
  it("reads a flat model's base row, and says 'not priced' (null), never 0, when it is missing or zero", () => {
    const spec = discoverySpec({ output: "audio", unit: "character" });
    expect(priceView("u_tts", spec, { u_tts: 0.02 })).toEqual({ kind: "flat", rate: 0.02 });
    expect(priceView("u_tts", spec, {})).toEqual({ kind: "flat", rate: null });
    expect(priceView("u_tts", spec, { u_tts: 0 })).toEqual({ kind: "flat", rate: null });
    expect(priceView("u_tts", spec, { u_tts: -3 })).toEqual({ kind: "flat", rate: null });
    expect(lowestRate(priceView("u_tts", spec, {}))).toBeNull();
  });

  it("is 'unread' when the list could not be read, and 'no unit' without a credit unit", () => {
    const spec = discoverySpec(imageSpec);
    expect(priceView("u", spec, null)).toEqual({ kind: "unread" });
    expect(priceView(null, spec, {})).toEqual({ kind: "no_unit" });
    expect(lowestRate({ kind: "unread" })).toBeNull();
  });

  it("names the variant rows the quote reads (quality, resolution × sound, sound, pinned resolution, upscale size)", () => {
    expect(priceVariants("u", discoverySpec(imageSpec))!.map((v) => v.key)).toEqual(["u_low", "u_medium", "u_high"]);
    // The row ids stay on the server: the browser gets the variant and its rate.
    const view = priceView("u", discoverySpec(imageSpec), { u: 1, u_low: 1 });
    expect(JSON.stringify(view)).not.toContain("u_low");
    expect(priceVariants("u", discoverySpec(videoSpec))!.map((v) => v.key)).toEqual([
      "u_480p_silent", "u_480p_audio", "u_720p_silent", "u_720p_audio", "u_1080p_silent", "u_1080p_audio",
    ]);
    expect(priceVariants("u", discoverySpec({ price_variants_by: "audio", audio_out: true }))!.map((v) => v.key)).toEqual(["u_silent", "u_audio"]);
    expect(priceVariants("u", discoverySpec({ price_variants_by: "resolution", resolutions: ["720p", "1080p"], default_resolution: "720p" }))!.map((v) => v.key)).toEqual(["u_720p", "u_1080p"]);
    expect(priceVariants("u", discoverySpec({ price_variants_by: "upscale_target", upscale_targets: ["720p", "4k"] }))!.map((v) => v.key)).toEqual(["u_720p", "u_4k"]);
    // A resolution model without a pinned default is quoted by its base row (0070).
    expect(priceVariants("u", discoverySpec({ price_variants_by: "resolution", resolutions: ["720p", "4k"] }))).toBeNull();
    // image_size variants are not read by the quote: one flat rate.
    expect(priceVariants("u", discoverySpec({ price_variants_by: "image_size", image_sizes: ["1K"] }))).toBeNull();
  });

  it("keeps an unpriced variant as unknown and starts 'from' the lowest known one", () => {
    const view = priceView("u", discoverySpec(imageSpec), { u: 5, u_low: 2, u_high: 9 });
    expect(view.kind).toBe("variants");
    if (view.kind !== "variants") return;
    expect(view.rows.map((r) => r.rate)).toEqual([2, null, 9]);
    expect(view.from).toBe(2);
    const none = priceView("u", discoverySpec(imageSpec), { u: 5 });
    expect(none.kind === "variants" && none.from).toBeNull();
  });
});

// ── availability ─────────────────────────────────────────────────────────────

describe("availability", () => {
  it("reads the plan gate exactly as creative_price does: only any/paid can pass", () => {
    const price = fnBody(sql("0072_captions.sql"), "creative_price");
    expect(price).toContain("if coalesce(m_ent, 'any') not in ('any', 'paid') then");
    expect(planGate(null)).toBeNull();
    expect(planGate("any")).toBeNull();
    // Every other entitlement is refused for every workspace today: "not open", with no tier promised.
    expect(planGate("models_image:basic")).toEqual({ kind: "not_open", key: "models_image", value: "basic" });
    expect(planGate("models_video:premium")).toEqual({ kind: "not_open", key: "models_video", value: "premium" });
    expect(planGate("api_access")).toEqual({ kind: "not_open", key: "api_access", value: null });
    // paid: resolved against the organization when its purchases were read, conditional when not.
    expect(planGate("paid", true)).toBeNull();
    expect(planGate("paid", false)).toEqual({ kind: "first_purchase", known: true });
    expect(planGate("paid")).toEqual({ kind: "first_purchase", known: false });
  });

  it("shows a realistic models_*:basic model as not open — unavailable, never plan-gated — even on a plan that 'has' basic", () => {
    const basic = fromSellableRow(sellable({ entitlement: "models_image:basic" }), {})!;
    expect(basic.state).toBe("unavailable");
    expect(basic.reasons).toEqual([{ kind: "not_open", key: "models_image", value: "basic" }]);
    expect(fromSellableRow(sellable(), {})!.state).toBe("available");
    expect(fromSellableRow(sellable({ entitlement: "any" }), {})!.state).toBe("available");
  });

  it("opens a paid model once the organization has bought (or is exempt), and gates it until then", () => {
    expect(fromSellableRow(sellable({ entitlement: "paid" }), {}, true)!.state).toBe("available");
    const before = fromSellableRow(sellable({ entitlement: "paid" }), {}, false)!;
    expect(before.state).toBe("plan_gated");
    expect(before.reasons).toEqual([{ kind: "first_purchase", known: true }]);
    expect(fromSellableRow(sellable({ entitlement: "paid" }), {}, null)!.reasons).toEqual([{ kind: "first_purchase", known: false }]);
  });

  it("never turns a row sellable_models() could not have returned into a model", () => {
    expect(fromSellableRow(sellable({ availability: "hidden" }), {})).toBeNull();
    expect(fromSellableRow(sellable({ capabilities: ["nope"] }), {})).toBeNull();
    expect(fromSellableRow(null, {})).toBeNull();
  });

  it("falls back to the joined base rate for a flat model when the list was unreadable, never for variants", () => {
    const flat = fromSellableRow(sellable({ capabilities: ["tts"], spec: { output: "audio", unit: "character", limits: {} }, credits_per_unit: 0.02 }), null)!;
    expect(flat.price).toEqual({ kind: "flat", rate: 0.02 });
    expect(fromSellableRow(sellable(), null)!.price).toEqual({ kind: "unread" });
  });

  it("gives the operator each state from real registry facts, with every reason", () => {
    const p = imagePrices;
    expect(fromAdminRow(admin(), null, p).state).toBe("available");
    const unverified = fromAdminRow(admin({ verifiedAt: null, availability: "hidden" }), { ok: false, errorCode: "auth", at: "2026-09-29T00:00:00Z" }, p);
    expect(unverified.state).toBe("needs_probe");
    expect(unverified.reasons.map((r) => r.kind)).toEqual(["not_verified", "probe_failed", "hidden"]);
    expect(fromAdminRow(admin({ availability: "disabled" }), null, p).state).toBe("unavailable");
    expect(fromAdminRow(admin({ removedFromFile: true, availability: "disabled", verifiedAt: null }), null, p).reasons[0]).toEqual({ kind: "removed" });
    expect(fromAdminRow(admin({ termsGate: "plan_required:scale", availability: "hidden" }), null, p).state).toBe("unavailable");
    expect(fromAdminRow(admin({ creditUnit: null, availability: "hidden" }), null, p).reasons.map((r) => r.kind)).toContain("no_unit");
    expect(fromAdminRow(admin({ availability: "hidden" }), null, p).state).toBe("unavailable");
    expect(fromAdminRow(admin({ entitlement: "models_image:premium" }), null, p).state).toBe("unavailable");
    expect(fromAdminRow(admin({ entitlement: "paid" }), null, p).state).toBe("plan_gated");
  });

  it("calls a model unpriced only when the list was read and holds no positive rate for it", () => {
    const unpriced = fromAdminRow(admin(), null, { model_img_a_image: 5 });
    expect(unpriced.reasons.map((r) => r.kind)).toContain("unpriced");
    expect(unpriced.state).toBe("unavailable");
    const unread = fromAdminRow(admin(), null, null);
    expect(unread.reasons.map((r) => r.kind)).not.toContain("unpriced");
    expect(unread.price).toEqual({ kind: "unread" });
    expect(unread.state).toBe("available");
  });
});

// ── the operator's spec never leaks ──────────────────────────────────────────

describe("publicSpecOf", () => {
  it("keeps exactly sellable_models()'s public keys and drops costs, vendor ids, evidence and notes", () => {
    const full = {
      ...imageSpec,
      unit: undefined,
      vendor_model: "secret-vendor-id",
      pricing: { unit: "image", provider_usd_per_unit: 0.04, variants: { by: "quality", prices: { low: 0.01 } }, note: "internal" },
      api_documented: { url: "https://example.com", evidence: "x" },
      terms_gate: "plan_required:scale",
      terms_notes: ["n"],
      probe: { prompt: "p" },
      credit_unit: "u",
    };
    const pub = publicSpecOf(full);
    const text = JSON.stringify(pub);
    for (const leak of ["secret-vendor-id", "provider_usd", "0.04", "internal", "evidence", "plan_required", "terms_notes", "probe", "example.com"]) {
      expect(text).not.toContain(leak);
    }
    expect(pub.unit).toBe("image");
    expect(pub.price_variants_by).toBe("quality");
    // The same keys the SQL builds (0072's sellable_models jsonb_build_object).
    const body = fnBody(sql("0072_captions.sql"), "sellable_models");
    for (const k of Object.keys(pub)) expect(body).toContain(`'${k}'`);
  });
});

// ── search and filters ───────────────────────────────────────────────────────

describe("search and filters", () => {
  const models: DiscoveryModel[] = [
    fromSellableRow(sellable(), {})!,
    fromSellableRow(sellable({ id: "img-b", display_name: "Img B", provider: "openai", capabilities: ["t2i", "edit"], spec: imageSpec, entitlement: "models_image:premium" }), {})!,
    fromSellableRow(sellable({ id: "cap-a", display_name: "Scribe", provider: "elevenlabs", capabilities: ["captions"], spec: captionSpec }), {})!,
  ];
  const f = (over: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...over });

  it("matches every word of the query, across names, ids and providers, ignoring case and accents", () => {
    expect(matchesQuery("Vid A vid-a bytedance ByteDance", "vid byte")).toBe(true);
    expect(matchesQuery("Vid A", "vid xyz")).toBe(false);
    expect(matchesQuery("anything", "   ")).toBe(true);
    expect(fold("Oʻzbek")).toBe(fold("O'zbek"));
    // The operator searches providers; a customer, who is not shown them, cannot find a model by one.
    expect(models.filter((m) => matchesFilters(m, f({ q: "ByteDance" }), [], true)).map((m) => m.id)).toEqual(["vid-a"]);
    expect(models.filter((m) => matchesFilters(m, f({ q: "openai img" }), [], true)).map((m) => m.id)).toEqual(["img-b"]);
    expect(models.filter((m) => matchesFilters(m, f({ q: "ByteDance" }))).map((m) => m.id)).toEqual([]);
    expect(models.filter((m) => matchesFilters(m, f({ q: "img" }))).map((m) => m.id)).toEqual(["img-b"]);
  });

  it("searches the person's own words for tasks (passed in by the screen)", () => {
    const words = (m: DiscoveryModel) => (m.capabilities.includes("captions") ? ["Субтитры"] : []);
    expect(models.filter((m) => matchesFilters(m, f({ q: "субтитры" }), words(m))).map((m) => m.id)).toEqual(["cap-a"]);
  });

  it("filters by task, input, output, availability and plan", () => {
    const ids = (x: Partial<Filters>) => models.filter((m) => matchesFilters(m, f(x))).map((m) => m.id);
    expect(ids({ task: "video_image" })).toEqual(["vid-a"]);
    expect(ids({ task: "captions" })).toEqual(["cap-a"]);
    expect(ids({ task: "remove_bg" })).toEqual([]);
    expect(ids({ input: "audio" })).toEqual(["cap-a"]);
    expect(ids({ input: "image" })).toEqual(["vid-a", "img-b"]);
    expect(ids({ output: "text" })).toEqual(["cap-a"]);
    expect(ids({ state: "unavailable" })).toEqual(["img-b"]);
    expect(ids({ state: "available" })).toEqual(["vid-a", "cap-a"]);
  });

  it("counts each task over what the other filters leave", () => {
    const counts = taskCounts(models, f({ output: "video" }));
    expect(counts.video_text).toBe(1);
    expect(counts.image).toBe(0);
    expect(taskCounts(models, NO_FILTERS).image).toBe(1);
  });

  it("lists what can be used first, then by name", () => {
    expect(sortModels(models).map((m) => m.id)).toEqual(["cap-a", "vid-a", "img-b"]);
  });

  it("round-trips filters through the URL, and reads anything unknown as 'all'", () => {
    const x = f({ task: "dub", q: "eleven", input: "audio", output: "audio", state: "available" });
    const q = Object.fromEntries(new URLSearchParams(queryFor(x, "m-1").slice(1)));
    expect(filtersFromQuery(q)).toEqual(x);
    expect(q.model).toBe("m-1");
    expect(queryFor(NO_FILTERS, null)).toBe("");
    expect(filtersFromQuery({ task: "nope", input: "smell", state: "free", q: ["a", "b"] })).toEqual(NO_FILTERS);
  });
});

// ── where a model is used ────────────────────────────────────────────────────

describe("Use in Studio", () => {
  it("knows exactly the Studio composer's tools", () => {
    expect([...STUDIO_TOOL_CAPS]).toEqual([...COMPOSER_CAPABILITIES]);
    expect([...STUDIO_TOOL_CAPS]).toEqual([...STUDIO_TOOLS]);
  });

  it("opens /create with the tool and the model, captions in the Editor, and nothing for a tool no screen has", () => {
    expect(linkFor("t2v", "veo-3.1")).toEqual({ kind: "studio", cap: "t2v", href: "/create?tool=t2v&model=veo-3.1" });
    expect(linkFor("captions", "x")).toEqual({ kind: "editor", cap: "captions", href: "/editor" });
    expect(linkFor("sfx", "x")).toEqual({ kind: "none", cap: "sfx" });
    expect(linksFor({ id: "v", capabilities: ["t2v", "i2v"] }, "video_image").map((l) => l.cap)).toEqual(["i2v"]);
    expect(linksFor({ id: "v", capabilities: ["i2v", "t2v"] }).map((l) => l.cap)).toEqual(["t2v", "i2v"]);
  });

  it("every Studio link is one the Create page accepts as a prefill, and the model only fills the form", () => {
    for (const cap of STUDIO_TOOL_CAPS) {
      const href = linkFor(cap, "m-1");
      if (href.kind !== "studio") throw new Error(cap);
      const q = new URLSearchParams(href.href.split("?")[1]);
      const base = prefillFromQuery(q.get("tool"), undefined);
      expect(base).not.toBeNull();
      const withModel = prefillModel(base, q.get("model"));
      expect(withModel?.model).toBe("m-1");
      expect(withModel?.capability).toBe(cap);
      // The prompt and the source are untouched: nothing can be priced from the link alone.
      expect(withModel?.prompt).toBe("");
    }
  });

  it("ignores a malformed model, and adds none without a tool", () => {
    const base = prefillFromQuery("t2i", undefined);
    expect(prefillModel(base, "../../etc")?.model).toBe("");
    expect(prefillModel(base, "UPPER")?.model).toBe("");
    expect(prefillModel(base, ["a", "b"])?.model).toBe("");
    expect(prefillModel(null, "veo-3.1")).toBeNull();
  });
});

describe("figures", () => {
  it("keeps a sub-credit rate's digits instead of rounding a real price to 0", () => {
    expect(rateText(0.004)).toBe("0.004");
    expect(rateText(0.008)).toBe("0.008");
    expect(rateText(2.6)).toBe("2.6");
    expect(rateText(13.4)).toBe("13.4");
    expect(rateText(1250)).toBe("1,250");
    expect(rateText(0.004, "ru")).toBe("0,004");
  });

  it("prints a day the same way on the server and in any browser", () => {
    expect(dayOf("2026-09-30T23:30:00-02:00")).toBe("2026-10-01");
    expect(dayOf("not a date")).toBe("not a date");
  });
});

describe("prompt length", () => {
  it("is the shorter of the model's limit and the database's 4000-character cap", () => {
    expect(fnBody(sql("0072_captions.sql"), "creative_params_problem")).toContain("prompt is longer than 4000 characters");
    expect(PROMPT_CAP).toBe(4000);
    expect(promptLimit({ maxPromptChars: 40000 })).toBe(4000);
    expect(promptLimit({ maxPromptChars: 10000 })).toBe(4000);
    expect(promptLimit({ maxPromptChars: 2000 })).toBe(2000);
    expect(promptLimit({ maxPromptChars: null })).toBe(4000);
  });
});

describe("provider names", () => {
  it("are the operator's by default; one switch shows them to customers", () => {
    expect(SHOW_PROVIDER_TO_CUSTOMERS).toBe(false);
    expect(showsProvider(true)).toBe(true);
    expect(showsProvider(false)).toBe(false);
  });
});

describe("identity", () => {
  it("writes the providers' names as they do, and an unknown slug as it is", () => {
    expect(providerName("bfl")).toBe("Black Forest Labs");
    expect(providerName("openai")).toBe("OpenAI");
    expect(providerName("newco")).toBe("newco");
  });

  it("draws a frame in the model's own first shape, capped for tall ones", () => {
    expect(frameAspect({ spec: discoverySpec(imageSpec) })).toBe("16 / 9");
    expect(frameAspect({ spec: discoverySpec({ ...imageSpec, aspect_ratios: ["1:1", "21:9", "16:9"] }) })).toBe("21 / 9");
    expect(frameAspect({ spec: discoverySpec(videoSpec) })).toBe("16 / 9");
    expect(frameAspect({ spec: discoverySpec({ ...videoSpec, aspect_ratios: ["9:16"] }) })).toBe("9 / 16");
    expect(frameAspect({ spec: discoverySpec({ output: "image" }) })).toBe("3 / 2");
    expect(frameAspect({ spec: discoverySpec(captionSpec) })).toBe("3 / 1");
    expect(widestShape(discoverySpec({ aspect_ratios_by_capability: { t2v: ["9:16", "16:9"] } }))).toBe("16:9");
    expect(widestShape(discoverySpec({}))).toBeNull();
  });

  it("reads no setting the registry does not declare", () => {
    const s = discoverySpec({ output: "image" });
    expect(s).toMatchObject({ qualities: [], resolutions: [], durationsS: [], qualityTier: null, speedTier: null, maxPromptChars: null, audioOut: false });
  });
});

// ── the server reads ─────────────────────────────────────────────────────────

describe("readCustomerModels", () => {
  const prices: StubResult = {
    data: [
      { unit: "model_vid_a_second", credits_per_unit: 3, margin: 1.5, note: "secret note" },
      { unit: "model_vid_a_second_720p_silent", credits_per_unit: 2.6, margin: 1.5, note: null },
    ],
    error: null,
  };

  it("shows what sellable_models() returns, priced from the live list", async () => {
    const db = supabaseStub((name) => (name === "sellable_models" ? { data: [sellable()], error: null } : prices));
    const read = await readCustomerModels(db as never);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.models.map((m) => m.id)).toEqual(["vid-a"]);
    const price = read.models[0].price;
    expect(price.kind === "variants" && price.from).toBe(2.6);
    expect(price.kind === "variants" && price.rows.find((r) => r.parts.join("_") === "1080p_audio")?.rate).toBeNull();
    expect(JSON.stringify(read)).not.toContain("secret note");
    expect(read.pricesRead).toBe(true);
  });

  it("drops a row the shared gate refuses (unverified, unpriced) even if the function returned it", async () => {
    const rows = [sellable(), sellable({ id: "bad", verified_at: null }), sellable({ id: "free", credits_per_unit: 0 })];
    const db = supabaseStub((name) => (name === "sellable_models" ? { data: rows, error: null } : prices));
    const read = await readCustomerModels(db as never);
    expect(read.status === "ok" && read.models.map((m) => m.id)).toEqual(["vid-a"]);
  });

  it("says why when it cannot read: not applied, refused, or failed — never an empty catalog", async () => {
    const missing = supabaseStub((name) => (name === "sellable_models" ? { data: null, error: { code: "PGRST202", message: "x" } } : prices));
    expect((await readCustomerModels(missing as never)).status).toBe("not_enabled");
    const refused = supabaseStub((name) => (name === "sellable_models" ? { data: null, error: { code: "42501" } } : prices));
    expect((await readCustomerModels(refused as never)).status).toBe("forbidden");
    expect((await readCustomerModels(supabaseStub(() => FAILED) as never)).status).toBe("error");
  });

  it("reads the price list failing as 'unread', not as free", async () => {
    const db = supabaseStub((name) => (name === "sellable_models" ? { data: [sellable()], error: null } : FAILED));
    const read = await readCustomerModels(db as never);
    expect(read.status === "ok" && read.pricesRead).toBe(false);
    expect(read.status === "ok" && read.models[0].price).toEqual({ kind: "unread" });
  });
});

describe("readOperatorModels", () => {
  it("passes on only the public half of each spec", async () => {
    const row = {
      id: "img-a",
      display_name: "Img A",
      provider: "openai",
      adapter: "image.openai",
      capabilities: ["t2i"],
      availability: "hidden",
      verified_at: null,
      credit_unit: "model_img_a_image",
      entitlement: "models_image:premium",
      spec: { ...imageSpec, vendor_model: "vendor-xyz", pricing: { unit: "image", provider_usd_per_unit: 0.123 }, terms_gate: null },
    };
    const db = supabaseStub((name) =>
      name === "model_registry_admin"
        ? { data: [row], error: null }
        : name === "model_probe_runs"
          ? { data: [{ model_id: "img-a", ok: false, error_code: "auth", capability: "t2i", created_at: "2026-09-30T00:00:00Z" }], error: null }
          : { data: [], error: null },
    );
    const read = await readOperatorModels(db as never);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    const text = JSON.stringify(read);
    expect(text).not.toContain("vendor-xyz");
    expect(text).not.toContain("0.123");
    expect(text).not.toContain("image.openai");
    expect(read.models[0].state).toBe("needs_probe");
    expect(read.models[0].probe).toEqual({ ok: false, code: "auth", at: "2026-09-30T00:00:00Z" });
    expect(read.probesRead).toBe(true);
  });

  it("reports the database's refusal for a non-operator", async () => {
    const db = supabaseStub((name) => (name === "model_registry_admin" ? { data: null, error: { code: "42501" } } : { data: [], error: null }));
    expect((await readOperatorModels(db as never)).status).toBe("forbidden");
  });
});
