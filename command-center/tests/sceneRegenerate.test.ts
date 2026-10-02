import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries } from "@/lib/i18n";
import {
  canPress,
  cleanPrompt,
  isIdempotencyKey,
  latestByScene,
  mapRegenError,
  newIdempotencyKey,
  parseQuote,
  parseRegenRows,
  reasonText,
  regenErrorText,
  rowText,
} from "@/lib/sceneRegenerate";

/**
 * Scene regeneration v2 (migration 0076): the quote, the press and the copy.
 *
 * What would break without these: an unpriced or malformed quote shown as a
 * price (or as 0); a viewer offered the priced button; a refusal turned into a
 * 500 that says nothing, or into text that leaks a provider name or a role
 * word; a route that sends anything but the person's own price and one key;
 * the copy missing in Russian or Uzbek.
 */

vi.mock("server-only", () => ({}));

const t = dictionaries.en.sceneRegen;

describe("the quote", () => {
  it("is a price only when the database priced it with a positive number", () => {
    expect(parseQuote({ status: "priced", credits: 10, may_start: true, source_kind: "generated" })).toMatchObject({
      status: "priced",
      credits: 10,
      mayStart: true,
      hadGenerated: true,
    });
    expect(parseQuote({ status: "priced", credits: "12.50", may_start: true }).credits).toBe(12.5);
    // A "priced" quote without a number, or with 0, is not a price.
    expect(parseQuote({ status: "priced", credits: null }).status).toBe("unavailable");
    expect(parseQuote({ status: "priced", credits: 0 }).status).toBe("unavailable");
    expect(parseQuote(null).status).toBe("unavailable");
    expect(parseQuote({ status: "weird", credits: 5 }).credits).toBeNull();
  });

  it("an unpriced quote never carries a number", () => {
    const q = parseQuote({ status: "unpriced", credits: 0, missing_unit: "scene_regenerate" });
    expect(q.status).toBe("unpriced");
    expect(q.credits).toBeNull();
    expect(canPress(q)).toBe(false);
  });

  it("keeps the reason, and an unknown one reads as unknown", () => {
    expect(parseQuote({ status: "unavailable", reason: "published" }).reason).toBe("published");
    expect(parseQuote({ status: "unavailable", reason: "drop table" }).reason).toBe("unknown");
    expect(parseQuote({ status: "unavailable", reason: "generator_not_recorded", had_generated: true }).hadGenerated).toBe(true);
  });

  it("only someone who may start runs gets the button", () => {
    expect(canPress(parseQuote({ status: "priced", credits: 5, may_start: false }))).toBe(false);
    expect(canPress(parseQuote({ status: "priced", credits: 5, may_start: true }))).toBe(true);
    expect(canPress(parseQuote({ status: "included", may_start: true }))).toBe(true);
    expect(canPress(parseQuote({ status: "unavailable", reason: "in_progress", may_start: true }))).toBe(false);
  });
});

describe("the press", () => {
  it("a key per press, in the shape the database accepts", () => {
    const k = newIdempotencyKey(() => "11111111-1111-4111-8111-111111111111");
    expect(isIdempotencyKey(k)).toBe(true);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    expect(isIdempotencyKey("short")).toBe(false);
    expect(isIdempotencyKey("has spaces in it")).toBe(false);
  });

  it("a prompt edit is trimmed, bounded and free of control characters", () => {
    expect(cleanPrompt("  wider shot  ")).toBe("wider shot");
    expect(cleanPrompt("   ")).toBeUndefined();
    expect(cleanPrompt(undefined)).toBeUndefined();
    expect(cleanPrompt("x".repeat(1001))).toBeNull();
    expect(cleanPrompt("a\nb")).toBeNull();
    expect(cleanPrompt(42)).toBeNull();
  });
});

describe("the database's refusals", () => {
  it("map to answers that carry only the person's own numbers", () => {
    expect(mapRegenError({ code: "42501", message: "forbidden" })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(mapRegenError({ code: "NS402", message: "insufficient credits", details: "available=3 needed=10" }).body).toEqual({
      error: "insufficient_credits",
      needed: 10,
      available: 3,
    });
    expect(mapRegenError({ code: "NS409", message: "price_changed", details: "credits=12" }).body).toEqual({
      error: "price_changed",
      credits: 12,
    });
    expect(mapRegenError({ code: "NS409", message: "in_progress" }).body.error).toBe("in_progress");
    expect(mapRegenError({ code: "NS409", message: "published" }).body.error).toBe("published");
    expect(mapRegenError({ code: "NS409", message: "idempotency_conflict" }).body.error).toBe("idempotency_conflict");
    expect(mapRegenError({ code: "NS400", message: "unpriced", details: "scene_regenerate_clip_kling" }).body).toEqual({
      error: "unpriced",
    });
    expect(mapRegenError({ code: "NS400", message: "scene_unavailable", details: "mixed_generators" }).body).toEqual({
      error: "scene_unavailable",
      reason: "mixed_generators",
    });
    expect(mapRegenError({ code: "NS429", message: "parallel run limit reached" }).status).toBe(429);
    expect(mapRegenError({ code: "42883", message: "function does not exist" })).toEqual({
      status: 503,
      body: { error: "regen_unavailable" },
    });
    expect(mapRegenError({ code: "XX000", message: "secret internal text" })).toEqual({
      status: 502,
      body: { error: "regen_failed" },
    });
  });

  it("become sentences with the numbers in them", () => {
    expect(regenErrorText({ error: "price_changed", credits: 12 }, t)).toContain("12");
    expect(regenErrorText({ error: "insufficient_credits", needed: 10, available: 3 }, t)).toMatch(/10.*3/);
    expect(regenErrorText({ error: "scene_unavailable", reason: "published" }, t)).toBe(t.reasons.published);
    expect(regenErrorText({ error: "nonsense" }, t)).toBe(t.errors.failed);
    expect(reasonText("not-a-reason", t)).toBe(t.reasons.unknown);
  });
});

describe("the rows", () => {
  const rows = parseRegenRows([
    { id: "a", scene_id: "s001", status: "failed", source_kind: "generated", created_at: "2026-10-01T10:00:00Z", error_code: "provider_unavailable", charged_credits: "0" },
    { id: "b", scene_id: "s001", status: "succeeded", source_kind: "stock", explicit_stock: true, created_at: "2026-10-02T10:00:00Z", charged_credits: "10.00", previous_asset_ids: ["a_old"] },
    { id: "c", scene_id: "bad", status: "queued" },
    { id: "d", scene_id: "s002", status: "weird" },
  ]);

  it("keeps only well-formed rows and the newest per scene", () => {
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(latestByScene(rows).get("s001")?.id).toBe("b");
  });

  it("say what was charged, that stock was chosen, and that a failure cost nothing", () => {
    const [failed, done] = rows;
    expect(rowText(done, t)).toContain("10");
    expect(rowText(done, t)).toContain(t.status.stockChosen);
    expect(rowText(failed, t)).toContain(t.status.failed);
    expect(rowText(failed, t)).toContain(t.failures.provider_unavailable);
  });
});

describe("the copy", () => {
  function leaves(o: unknown, prefix = ""): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string") out[prefix + k] = v;
      else Object.assign(out, leaves(v, `${prefix}${k}.`));
    }
    return out;
  }
  const en = leaves(dictionaries.en.sceneRegen);
  const ru = leaves(dictionaries.ru.sceneRegen);
  const uz = leaves(dictionaries.uz.sceneRegen);

  it("is complete in en, ru and uz", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(uz).sort()).toEqual(Object.keys(en).sort());
    for (const d of [en, ru, uz]) for (const v of Object.values(d)) expect(v.trim()).not.toBe("");
    for (const k of Object.keys(en)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(ru[k]), k).toEqual(ph(en[k]));
      expect(ph(uz[k]), k).toEqual(ph(en[k]));
    }
  });

  it("names no provider or model, and no role", () => {
    const banned = /\b(kling|minimax|hailuo|higgsfield|veo|seedance|wan|pexels|gemini|openai|google|owner|admin|editor|viewer|владел|админ|редактор)\b/i;
    for (const d of [en, ru, uz]) for (const [k, v] of Object.entries(d)) expect(v, k).not.toMatch(banned);
  });
});

// ── the route ───────────────────────────────────────────────────────────────

type Err = { code?: string; message?: string; details?: string };
type Result = { data: unknown; error: Err | null };
const VID = "run-0123456789abcdef0123";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result>,
  calls: [] as { kind: string; name: string; args?: unknown }[],
  audits: [] as { action: string; target?: string; channelId?: string }[],
}));

function thenable(result: () => Result): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return () => q;
    },
  });
  return q;
}

const client = {
  rpc: (name: string, args: unknown) => {
    h.calls.push({ kind: "rpc", name, args });
    return thenable(() => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    h.calls.push({ kind: "from", name });
    return thenable(() => ({ data: { channel_id: "chan-b" }, error: null }));
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/server/audit", () => ({
  logAudit: async (e: { action: string; target?: string; channelId?: string }) => void h.audits.push(e),
}));

const route = await import("../app/api/videos/[id]/scenes/[scene]/regenerate/route");
const ctx = (id = VID, scene = "s001") => ({ params: Promise.resolve({ id, scene }) });
const post = (body: unknown) =>
  new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const KEY = "scene-regen:11111111-1111-4111-8111-111111111111";

describe("GET / POST /api/videos/<id>/scenes/<scene>/regenerate", () => {
  beforeEach(() => {
    h.user = { id: "u1", email: "me@example.com" };
    h.rpc = {};
    h.calls = [];
    h.audits = [];
    process.env.NIGHTSHIFT_RUN_BACKEND = "queue";
  });

  it("is for signed-in people only, and a malformed id never reaches the database", async () => {
    h.user = null;
    expect((await route.GET(new Request("http://x/api"), ctx())).status).toBe(401);
    expect((await route.POST(post({}), ctx())).status).toBe(401);
    h.user = { id: "u1", email: "me@example.com" };
    expect((await route.GET(new Request("http://x/api"), ctx("../x"))).status).toBe(404);
    expect((await route.POST(post({ idempotency_key: KEY }), ctx(VID, "3;drop"))).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it("the quote is the database's, read with the person's session; another org's reads as not found", async () => {
    h.rpc.quote_scene_regenerate = { data: { status: "priced", credits: 10, may_start: true, source_kind: "generated" }, error: null };
    const res = await route.GET(new Request("http://x/api?source=stock"), ctx());
    const body = await res.json();
    expect(body.quote.credits).toBe(10);
    expect(body.queue).toBe(true);
    expect(h.calls[0]).toEqual({ kind: "rpc", name: "quote_scene_regenerate", args: { p_video: VID, p_scene: "s001", p_source: "stock" } });
    h.rpc.quote_scene_regenerate = { data: null, error: { code: "42501", message: "forbidden" } };
    expect((await route.GET(new Request("http://x/api"), ctx())).status).toBe(404);
    expect((await route.GET(new Request("http://x/api?source=best"), ctx())).status).toBe(400);
  });

  it("the press sends exactly the confirmed price, one key, the choice and the prompt — nothing else", async () => {
    h.rpc.request_scene_regenerate = { data: { id: "r1", status: "queued", render_job_id: 9, credits_held: "10.00", replayed: false }, error: null };
    const res = await route.POST(post({ max_credits: 10, idempotency_key: KEY, source: "stock", prompt: "  wider  ", extra: "ignored" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "r1", job_id: 9, credits_reserved: 10, replayed: false });
    const call = h.calls.find((c) => c.name === "request_scene_regenerate");
    expect(call?.args).toEqual({ p_video: VID, p_scene: "s001", p_prompt: "wider", p_source: "stock", p_max_credits: 10, p_idem: KEY });
    expect(h.audits).toEqual([expect.objectContaining({ action: "scene.regenerate", target: VID, channelId: "chan-b" })]);
  });

  it("a replayed press is not audited twice", async () => {
    h.rpc.request_scene_regenerate = { data: { id: "r1", status: "queued", render_job_id: 9, credits_held: 10, replayed: true }, error: null };
    const res = await route.POST(post({ max_credits: 10, idempotency_key: KEY }), ctx());
    expect((await res.json()).replayed).toBe(true);
    expect(h.audits).toEqual([]);
  });

  it("refuses a malformed press before the database, and anything off the queue backend", async () => {
    for (const bad of [
      { idempotency_key: "short" },
      { idempotency_key: KEY, max_credits: -1 },
      { idempotency_key: KEY, max_credits: "10" },
      { idempotency_key: KEY, source: "best" },
      { idempotency_key: KEY, prompt: "a\u0007b" },
    ])
      expect((await route.POST(post(bad), ctx())).status).toBe(400);
    process.env.NIGHTSHIFT_RUN_BACKEND = "actions";
    const res = await route.POST(post({ idempotency_key: KEY, max_credits: 10 }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("queue_required");
    expect(h.calls.filter((c) => c.name === "request_scene_regenerate")).toEqual([]);
  });

  it("a changed price comes back with the new number and nothing else", async () => {
    h.rpc.request_scene_regenerate = { data: null, error: { code: "NS409", message: "price_changed", details: "credits=12" } };
    const res = await route.POST(post({ max_credits: 10, idempotency_key: KEY }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "price_changed", credits: 12 });
    expect(h.audits).toEqual([]);
  });
});

describe("the migration the route calls", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0076_scene_regenerate.sql"), "utf8");
  it("defines exactly the functions and arguments the route uses", () => {
    expect(sql).toContain("create or replace function public.quote_scene_regenerate(p_video text, p_scene text, p_source text default 'same')");
    expect(sql).toContain("p_video text, p_scene text, p_prompt text, p_source text, p_max_credits numeric, p_idem text");
  });
});
