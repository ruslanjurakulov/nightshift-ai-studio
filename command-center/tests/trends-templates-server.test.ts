import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** A stand-in session client: the template read, the signed-in user, and sellable_models per capability. */
const s: {
  rows: { data: unknown; error: { code?: string; message?: string } | null };
  user: { id: string } | null;
  sellable: Record<string, { data: unknown; error: { code?: string } | null }>;
  eqs: [string, unknown][];
} = { rows: { data: [], error: null }, user: null, sellable: {}, eqs: [] };

function query() {
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => {
      s.eqs.push([col, v]);
      return q;
    },
    order: () => q,
    limit: () => q,
    then: (ok: (v: unknown) => unknown) => Promise.resolve(s.rows).then(ok),
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => query(),
    auth: { getUser: async () => ({ data: { user: s.user } }) },
    rpc: async (_fn: string, args: { p_capability: string }) => s.sellable[args.p_capability] ?? { data: [], error: null },
  }),
}));
vi.mock("@/lib/templates/media-manifest.json", () => ({ default: { "food-reveal": { preview: true, poster: false } } }));

const { loadTemplates, statusCode } = await import("@/lib/templates/server");

const row = {
  slug: "food-reveal",
  title: { en: "Food reveal", ru: "Подача", uz: "Taom" },
  description: { en: "d", ru: "d", uz: "d" },
  category: "lifestyle",
  kind: "video",
  prompt_template: "A {dish}",
  model_id: "minimax-h3",
  aspect: "9:16",
  duration_s: 5,
  quality: "768p",
  director: {},
  sort: 1,
};

const sold = (id: string, cap: string) => ({
  id,
  display_name: id,
  provider: "minimax",
  capabilities: [cap],
  availability: "beta",
  verified_at: "2026-11-13T00:00:00Z",
  credit_unit: "u",
  credits_per_unit: 1,
  spec: { output: "video", unit: "second", limits: { max_prompt_chars: 100, max_concurrent_per_org: 1 } },
});

beforeEach(() => {
  s.rows = { data: [row], error: null };
  s.user = null;
  s.sellable = {};
  s.eqs = [];
});

describe("loadTemplates", () => {
  it("asks for published rows only, whatever the policy says", async () => {
    await loadTemplates({ locale: "en" });
    expect(s.eqs).toContainEqual(["published", true]);
  });

  it("reads a missing table as not enabled (503), and any other failure as an error (502)", async () => {
    s.rows = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    expect((await loadTemplates({ locale: "en" })).status).toBe("not_enabled");
    s.rows = { data: null, error: { code: "42703", message: 'column "quality" does not exist' } };
    const broken = await loadTemplates({ locale: "en" });
    expect(broken.status).toBe("error");
    expect(statusCode(broken.status)).toBe(502);
    expect(statusCode("not_enabled")).toBe(503);
  });

  it("is unknown — never available — for a viewer the registry cannot answer for", async () => {
    const out = await loadTemplates({ locale: "en" });
    expect(out.templates[0].model_status).toBe("unknown");
    expect(out.templates[0].model_available).toBe(false);
  });

  it("is available only when the registry sells the model for text-to-video", async () => {
    s.user = { id: "u1" };
    s.sellable = { t2v: { data: [sold("minimax-h3", "t2v")], error: null }, t2i: { data: [], error: null } };
    const out = await loadTemplates({ locale: "en" });
    expect(out.templates[0]).toMatchObject({ model_available: true, model_status: "available" });
    expect(out.templates[0].preview_url).toBe("/templates/food-reveal/preview.mp4");
    expect(out.templates[0].poster_url).toBeUndefined();
  });

  it("is a measured unavailable when the registry answered without it", async () => {
    s.user = { id: "u1" };
    s.sellable = { t2v: { data: [sold("minimax-h3-lite", "t2v")], error: null }, t2i: { data: [], error: null } };
    const out = await loadTemplates({ locale: "en" });
    expect(out.templates[0]).toMatchObject({ model_available: false, model_status: "unavailable", model_id: "minimax-h3" });
  });

  it("falls back to unknown for every card when either registry read fails", async () => {
    s.user = { id: "u1" };
    s.sellable = { t2v: { data: [sold("minimax-h3", "t2v")], error: null }, t2i: { data: null, error: { code: "XX000" } } };
    const out = await loadTemplates({ locale: "en" });
    expect(out.templates[0].model_status).toBe("unknown");
  });
});
