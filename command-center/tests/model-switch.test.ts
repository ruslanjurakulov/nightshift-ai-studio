import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's model switches (migration 0124): the request the route accepts, the document it reads, the words in three languages and the
 * route itself behind NIGHTSHIFT_MODEL_SWITCH.
 *
 * What would break without these: a switch-off sent with a reason that is not one of the four (the database would refuse it, but the
 * screen must not offer it), a model or provider id that is not a registry id reaching Postgres, a malformed database row shown as a
 * switch ("on" by guesswork), the three dictionaries drifting from the SQL's closed lists, the route answering while the variable is off,
 * a customer or a signed-out caller reaching the owner function, the owner's reason leaking into a customer-facing text, and the Studio's
 * list offering a model the database would refuse.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "owner@a.uz" } as { id: string; email: string } | null,
  role: "owner" as string | null,
  guard: null as Response | null,
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({ rpc: h.rpc }),
}));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => h.role }));
vi.mock("@/lib/server/admin-post-guard", () => ({ guardAdminPost: async () => h.guard }));

import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import {
  SWITCH_NOTE_MAX,
  SWITCH_REASONS,
  SWITCH_REFUSALS,
  coerceCounts,
  coerceOffIds,
  coerceSwitchDoc,
  parseModelSwitch,
  parseModelSwitchFlag,
  withoutSwitchedOff,
} from "../lib/model-switch";
import { providerLabel, reasonText, switchFailureText, switchRefusalText } from "../lib/model-switch-text";

const dicts = { en, ru, uz } as const;
const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "supabase", "migrations", "0124_model_switch.sql"), "utf8");

// ── the request ─────────────────────────────────────────────────────────────

describe("parseModelSwitch", () => {
  const SET = { action: "set", scope: "model", target: "seedance-1.5-pro", enabled: false, reason: "out_of_funds" };

  it("a switch-off is exactly one owner_set_model_switch call with six named arguments", () => {
    expect(parseModelSwitch({ ...SET, note: "  balance empty  ", confirm: true })).toEqual({
      ok: true,
      call: {
        fn: "owner_set_model_switch",
        args: { p_scope: "model", p_target: "seedance-1.5-pro", p_enabled: false, p_reason: "out_of_funds", p_note: "balance empty", p_confirm: true },
      },
    });
  });

  it("confirm is false unless it is the boolean true", () => {
    for (const confirm of [undefined, "true", 1, "yes", null]) {
      const out = parseModelSwitch({ ...SET, confirm });
      expect(out.ok && out.call.args.p_confirm).toBe(false);
    }
  });

  it("a switch-on carries no reason and no note, whatever the body says", () => {
    const out = parseModelSwitch({ action: "set", scope: "provider", target: "BYTEDANCE", enabled: true, reason: "other", note: "x" });
    expect(out).toEqual({
      ok: true,
      call: { fn: "owner_set_model_switch", args: { p_scope: "provider", p_target: "bytedance", p_enabled: true, p_reason: null, p_note: null, p_confirm: false } },
    });
  });

  it("an extra field is dropped, never forwarded", () => {
    const out = parseModelSwitch({ ...SET, p_scope: "x", service_key: "k", is_owner: true });
    expect(out.ok && Object.keys(out.call.args).sort()).toEqual(["p_confirm", "p_enabled", "p_note", "p_reason", "p_scope", "p_target"]);
  });

  it.each([
    [{ ...SET, scope: "planet" }, "bad_scope"],
    [{ ...SET, scope: undefined }, "bad_scope"],
    [{ ...SET, target: "../x" }, "unknown_target"],
    [{ ...SET, target: "a" }, "unknown_target"],
    [{ ...SET, target: "x".repeat(41) }, "unknown_target"],
    [{ ...SET, target: 5 }, "unknown_target"],
    [{ ...SET, scope: "provider", target: "has space" }, "unknown_target"],
    [{ ...SET, enabled: "false" }, "bad_enabled"],
    [{ ...SET, enabled: undefined }, "bad_enabled"],
    [{ ...SET, reason: undefined }, "bad_reason"],
    [{ ...SET, reason: "because" }, "bad_reason"],
    [{ ...SET, reason: "OUT_OF_FUNDS" }, "bad_reason"],
    [{ ...SET, note: "x".repeat(SWITCH_NOTE_MAX + 1) }, "bad_note"],
    [{ ...SET, note: "two\nlines" }, "bad_note"],
    [{ ...SET, note: "tab\there" }, "bad_note"],
    [{ ...SET, note: 5 }, "bad_note"],
    [{ ...SET, action: "toggle" }, "bad_request"],
    [{ ...SET, action: undefined }, "bad_request"],
    ["x", "bad_request"],
    [[], "bad_request"],
    [null, "bad_request"],
  ])("%j is refused as %s and never reaches the database", (body, error) => {
    expect(parseModelSwitch(body)).toEqual({ ok: false, error });
  });

  it("the note counts characters as Postgres does (an emoji is one)", () => {
    expect(parseModelSwitch({ ...SET, note: "😀".repeat(SWITCH_NOTE_MAX) }).ok).toBe(true);
    expect(parseModelSwitch({ ...SET, note: "😀".repeat(SWITCH_NOTE_MAX + 1) })).toEqual({ ok: false, error: "bad_note" });
  });

  it("preview and dismiss are their own functions", () => {
    expect(parseModelSwitch({ action: "preview", scope: "provider", target: "bytedance" })).toEqual({
      ok: true,
      call: { fn: "owner_model_switch_preview", args: { p_scope: "provider", p_target: "bytedance" } },
    });
    expect(parseModelSwitch({ action: "dismiss", id: 7 })).toEqual({ ok: true, call: { fn: "owner_model_alert_dismiss", args: { p_id: 7 } } });
    for (const id of [0, -1, 1.5, "7", null, undefined, Number.NaN]) expect(parseModelSwitch({ action: "dismiss", id })).toEqual({ ok: false, error: "no_such_alert" });
  });
});

describe("the flag", () => {
  it("only the literal on turns it on", () => {
    for (const v of [undefined, null, "", "off", "0", "true", "1", "yes", "onn"]) expect(parseModelSwitchFlag(v as string | undefined), String(v)).toBe(false);
    for (const v of ["on", " ON ", "On"]) expect(parseModelSwitchFlag(v)).toBe(true);
  });
});

// ── the closed lists agree with the database ────────────────────────────────

describe("the closed lists", () => {
  it("the four reasons are those of the SQL (the CHECK and the function)", () => {
    const check = /coalesce\(reason in \(([^)]*)\), false\)/.exec(MIGRATION);
    expect(check, "the CHECK").not.toBeNull();
    const words = (s: string) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(words(check![1])).toEqual([...SWITCH_REASONS]);
    const fn = /rs = any \(array\[([^\]]*)\]\)/.exec(MIGRATION);
    expect(words(fn![1])).toEqual([...SWITCH_REASONS]);
  });

  it("the note length is the SQL's", () => {
    expect(MIGRATION).toContain(`char_length(note) between 1 and ${SWITCH_NOTE_MAX}`);
    expect(MIGRATION).toContain(`char_length(nt) > ${SWITCH_NOTE_MAX}`);
  });

  it("every refusal the owner function can give is a code the screen words", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.owner_set_model_switch"));
    const given = new Set([...fn.matchAll(/owner_err\('(\w+)'/g)].map((m) => m[1]));
    for (const code of given) expect(SWITCH_REFUSALS as readonly string[], code).toContain(code);
    const dismiss = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.owner_model_alert_dismiss"));
    for (const m of dismiss.matchAll(/owner_err\('(\w+)'/g)) expect(SWITCH_REFUSALS as readonly string[], m[1]).toContain(m[1]);
  });
});

// ── the words ───────────────────────────────────────────────────────────────

const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("modelSwitch in three languages", () => {
  const source = leaves(en.modelSwitch);
  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].modelSwitch));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s words every refusal code and every reason", (loc) => {
    const err = dicts[loc].modelSwitch.err as Record<string, string>;
    for (const code of SWITCH_REFUSALS) expect(err[code], `${loc}.err.${code}`).toBeTruthy();
    for (const r of SWITCH_REASONS) expect(dicts[loc].modelSwitch.reasons[r], `${loc}.reasons.${r}`).toBeTruthy();
  });

  it.each(["ru", "uz"] as const)("%s does not answer in English", (loc) => {
    // A placeholder-only line and a word that is the same word in that language are the only legitimate equals.
    const same = ["switchLabel", "scope.model", "sale.beta"];
    for (const [key, text] of source.filter(([k]) => !same.includes(k))) {
      const got = new Map(leaves(dicts[loc].modelSwitch)).get(key)!;
      if (/^[^a-zа-я]*$/i.test(text)) continue;
      expect(got, `${loc}.${key}`).not.toBe(text);
    }
  });

  it("the creative errors carry the new refusal in every language, and no text a person reads names the owner's reasons", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const e = dicts[loc].create ? (dicts[loc] as typeof en).creative.errors : null;
      expect((e as unknown as Record<string, string>).model_temporarily_off, loc).toBeTruthy();
    }
    // The texts a PERSON (not the owner) reads: the creative error, the Studio's line, the job-error sentence.
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dicts[loc] as typeof en;
      const persons = [
        (d.creative.errors as unknown as Record<string, string>).model_temporarily_off,
        d.modelSwitch.studio.offTitle,
        d.modelSwitch.studio.offBody,
        d.modelSwitch.studio.offChoose,
        (d.create.jobError as Record<string, string>).switched_off,
      ];
      for (const text of persons) {
        // "other" is a substring of "another": the three reasons that say something are the ones that must never appear.
        const said = [d.modelSwitch.reasons.out_of_funds, d.modelSwitch.reasons.vendor_outage, d.modelSwitch.reasons.terms_review];
        for (const reason of said) expect(text.toLowerCase(), `${loc}: ${text}`).not.toContain(reason.toLowerCase());
      }
    }
    for (const text of [en.creative.errors.model_temporarily_off, en.modelSwitch.studio.offBody, (en.create.jobError as Record<string, string>).switched_off]) {
      expect(text).not.toMatch(/fund|balance|outage|terms|quota|vendor/i);
    }
  });
});

describe("the sentences", () => {
  it("a refusal is worded by its code with the note length filled", () => {
    expect(switchRefusalText(en, { ok: false, error: "bad_note" })).toContain(String(SWITCH_NOTE_MAX));
    expect(switchRefusalText(en, { error: "not_enforced" })).toBe(en.modelSwitch.err.not_enforced);
    expect(switchRefusalText(ru, { error: "owner_required" })).toBe(ru.modelSwitch.err.owner_required);
  });

  it("a code from a newer database is shown as the closed code, never as free text", () => {
    expect(switchRefusalText(en, { error: "new_thing" })).toBe("The switch was refused (new_thing). Nothing was changed.");
    expect(switchRefusalText(en, { error: "<script>alert(1)</script>" })).toContain("(?)");
    expect(switchRefusalText(en, undefined)).toContain("(?)");
  });

  it("a failed call keeps the owner buttons' wording for the session, the second step and the network", () => {
    const failed = (kind: string, data: Record<string, unknown> = {}) => switchFailureText(en, { kind, status: 0, data } as never);
    expect(failed("session")).toBe(en.ownerTruth.sessionEnded);
    expect(failed("mfa", { error: "mfa_required" })).toBe(en.ownerTruth.mfaRequired);
    expect(failed("network")).toBe(en.ownerTruth.offline);
    expect(failed("server", { ok: false, error: "owner_required" })).toBe(en.modelSwitch.err.owner_required);
    expect(failed("server", { ok: false, error: "confirm_required", waiting: 3 })).toBe(en.modelSwitch.err.confirm_required);
  });

  it("a reason is words, and a reason this build does not know is said to be unknown", () => {
    expect(reasonText(en, "out_of_funds")).toBe("Out of funds at the vendor");
    expect(reasonText(en, null)).toBe(en.modelSwitch.reasonUnknown);
  });

  it("a provider is recognisable by its first models", () => {
    expect(providerLabel({ provider: "bytedance", models: [{ displayName: "Seedance 1.0 Pro" }, { displayName: "Seedance 1.5 Pro" }, { displayName: "X" }] } as never)).toBe(
      "bytedance (Seedance 1.0 Pro, Seedance 1.5 Pro, …)",
    );
    expect(providerLabel({ provider: "bfl", models: [] } as never)).toBe("bfl");
  });
});

// ── the document ────────────────────────────────────────────────────────────

const DOC = {
  enforced: true,
  auto_suggest: false,
  suggest_threshold: 3,
  suggest_window_minutes: 60,
  providers: [
    {
      provider: "bytedance",
      switch: { enabled: false, reason: "out_of_funds", note: "empty", changed_at: "2026-10-25T10:00:00Z", changed_by_email: "owner@a.uz" },
      hidden: true,
      models: [
        { id: "seedance-1.5-pro", display_name: "Seedance 1.5 Pro", capabilities: ["t2v", "i2v"], availability: "ga", switch: null, hidden: true },
      ],
    },
  ],
  alerts: [{ id: 4, provider: "bytedance", kind: "may_be_out_of_funds", failures: 5, window_minutes: 60, first_at: "2026-10-25T09:00:00Z", last_at: "2026-10-25T09:50:00Z" }],
  log: [
    { at: "2026-10-25T10:00:00Z", kind: "switch", scope: "provider", target: "bytedance", enabled: false, previous_enabled: null, reason: "out_of_funds", note: "empty", jobs_stopped: 2, in_flight: 1, actor_email: "owner@a.uz", detail: {} },
  ],
};

describe("coerceSwitchDoc", () => {
  it("reads the database's document", () => {
    const doc = coerceSwitchDoc(DOC)!;
    expect(doc.enforced).toBe(true);
    expect(doc.providers[0].switch).toEqual({ enabled: false, reason: "out_of_funds", note: "empty", changedAt: "2026-10-25T10:00:00Z", changedBy: "owner@a.uz" });
    expect(doc.providers[0].models[0]).toMatchObject({ id: "seedance-1.5-pro", displayName: "Seedance 1.5 Pro", hidden: true, switch: null });
    expect(doc.alerts[0]).toEqual({ id: 4, provider: "bytedance", failures: 5, windowMinutes: 60, firstAt: "2026-10-25T09:00:00Z", lastAt: "2026-10-25T09:50:00Z" });
    expect(doc.log[0]).toMatchObject({ kind: "switch", enabled: false, jobsStopped: 2, inFlight: 1, actor: "owner@a.uz" });
  });

  it("is null for anything that is not the document, so the page says it could not read, never an empty board", () => {
    for (const raw of [null, undefined, [], "x", {}, { enforced: "yes" }]) expect(coerceSwitchDoc(raw)).toBeNull();
  });

  it("drops a malformed row and keeps the others, and a reason it does not know reads as none", () => {
    const doc = coerceSwitchDoc({
      ...DOC,
      providers: [{ provider: 5 }, { provider: "x-prov", hidden: "no", models: [] }, { ...DOC.providers[0], models: [{ id: "ok-model", hidden: false }, { id: 7, hidden: false }, { id: "no-hidden" }] }],
      alerts: [{ id: "x", provider: "p" }, DOC.alerts[0]],
      log: [{ kind: "weird" }, { ...DOC.log[0], reason: "bored" }],
    })!;
    expect(doc.providers.map((p) => p.provider)).toEqual(["bytedance"]);
    expect(doc.providers[0].models.map((m) => m.id)).toEqual(["ok-model"]);
    expect(doc.alerts).toHaveLength(1);
    expect(doc.log).toHaveLength(1);
    expect(doc.log[0].reason).toBeNull();
  });

  it("not hidden is never inferred from a missing flag", () => {
    const doc = coerceSwitchDoc({ ...DOC, providers: [{ ...DOC.providers[0], models: [{ id: "m-1", display_name: "M" }] }] })!;
    expect(doc.providers[0].models).toEqual([]);
  });
});

describe("the counts and the lists", () => {
  it("counts come from the database's answer, and an answer without them is none", () => {
    expect(coerceCounts({ ok: true, waiting: 3, in_flight: 2, queued: 2, running: 1 })).toEqual({ waiting: 3, inFlight: 2 });
    for (const raw of [null, {}, { waiting: "3", in_flight: 2 }, { waiting: 1 }]) expect(coerceCounts(raw)).toBeNull();
  });

  it("the Studio's list loses the switched-off ids and nothing else", () => {
    const models = [{ id: "a-1" }, { id: "b-2" }, { id: "c-3" }];
    expect(withoutSwitchedOff(models, ["b-2"]).map((m) => m.id)).toEqual(["a-1", "c-3"]);
    expect(withoutSwitchedOff(models, [])).toEqual(models);
    expect(withoutSwitchedOff(models, [])).not.toBe(models);
  });

  it("a switched-off list that is not a list of ids is none, and an id with a path in it is dropped", () => {
    expect(coerceOffIds(["a-1", "../x", 5, null, "b-2"])).toEqual(["a-1", "b-2"]);
    for (const raw of [null, undefined, {}, "a-1"]) expect(coerceOffIds(raw)).toEqual([]);
  });
});

// ── the route ───────────────────────────────────────────────────────────────

describe("POST /api/owner/model-switch", () => {
  const ORIGIN = "https://app.test";
  const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    new Request(`${ORIGIN}/api/owner/model-switch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const BODY = { action: "set", scope: "provider", target: "bytedance", enabled: false, reason: "out_of_funds", confirm: true };
  let route: (r: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    h.user = { id: "u1", email: "owner@a.uz" };
    h.role = "owner";
    h.guard = null;
    h.rpc.mockReset().mockResolvedValue({ data: { ok: true, jobs_stopped: 0 }, error: null });
    route = (await import("../app/api/owner/model-switch/route")).POST as never;
  });

  it("answers 404 and never touches the database while the variable is not exactly on", async () => {
    for (const v of ["", "off", "0", "true", "1", "yes"]) {
      vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", v);
      const res = await route(post(BODY));
      expect(res.status, JSON.stringify(v)).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    delete process.env.NIGHTSHIFT_MODEL_SWITCH;
    expect((await route(post(BODY))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  describe("with the variable on", () => {
    beforeEach(() => vi.stubEnv("NIGHTSHIFT_MODEL_SWITCH", "on"));

    it("a request from another site is refused before the session is read", async () => {
      for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
        expect((await route(post(BODY, headers))).status).toBe(403);
      }
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("signed out is 401, not an owner/admin is 403, the second-factor gate is its own answer", async () => {
      h.user = null;
      expect((await route(post(BODY))).status).toBe(401);
      h.user = { id: "u2", email: "customer@a.uz" };
      h.role = null;
      expect((await route(post(BODY))).status).toBe(403);
      h.role = "owner";
      h.guard = Response.json({ error: "mfa_required" }, { status: 401 });
      expect((await route(post(BODY))).status).toBe(401);
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("a body that is not the right shape is a 400 with the code the screen words, and never reaches the database", async () => {
      expect((await route(post("{not json"))).status).toBe(400);
      expect((await route(post("[]"))).status).toBe(400);
      const res = await route(post({ ...BODY, reason: "because" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "bad_reason" });
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("calls exactly one function, as the signed-in user's own client", async () => {
      const res = await route(post({ ...BODY, service_key: "x" }));
      expect(res.status).toBe(200);
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(h.rpc).toHaveBeenCalledWith("owner_set_model_switch", {
        p_scope: "provider",
        p_target: "bytedance",
        p_enabled: false,
        p_reason: "out_of_funds",
        p_note: null,
        p_confirm: true,
      });
    });

    it("a refusal of the database reaches the screen as its code, with the figures a confirmation needs, and its English text does not", async () => {
      h.rpc.mockResolvedValue({ data: { ok: false, error: "confirm_required", message: "Jobs that were not sent yet would be stopped", waiting: 3, in_flight: 1 }, error: null });
      const res = await route(post({ ...BODY, confirm: false }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "confirm_required", waiting: 3, in_flight: 1 });
      h.rpc.mockResolvedValue({ data: { ok: false, error: "owner_required", message: "Only the platform owner may switch models." }, error: null });
      const out = await route(post(BODY));
      expect(out.status).toBe(422);
      expect(await out.json()).toEqual({ ok: false, error: "owner_required" });
      h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "only the platform owner may do this" } });
      const denied = await route(post(BODY));
      expect(denied.status).toBe(403);
      expect(JSON.stringify(await denied.json())).not.toContain("platform owner");
    });

    it("preview and dismiss go to their own functions", async () => {
      await route(post({ action: "preview", scope: "model", target: "seedance-1.5-pro" }));
      expect(h.rpc).toHaveBeenLastCalledWith("owner_model_switch_preview", { p_scope: "model", p_target: "seedance-1.5-pro" });
      await route(post({ action: "dismiss", id: 3 }));
      expect(h.rpc).toHaveBeenLastCalledWith("owner_model_alert_dismiss", { p_id: 3 });
    });
  });
});

// ── the Studio's list ───────────────────────────────────────────────────────

describe("loadStudioModels (the picker's list)", () => {
  const rows = [
    { id: "seedance-1.5-pro", display_name: "Seedance 1.5 Pro", capabilities: ["t2v"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
    { id: "veo-3.1", display_name: "Veo 3.1", capabilities: ["t2v"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
  ];
  const run = async (off: unknown, offError: unknown = null) => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      getUser: async () => h.user,
      createClient: async () => ({
        from: () => {
          const q: Record<string, unknown> = {
            select: () => q,
            in: () => q,
            not: () => q,
            order: () => q,
            limit: () => Promise.resolve({ data: rows, error: null }),
          };
          return q;
        },
        rpc: async (fn: string) => {
          if (fn === "models_switched_off") return { data: off, error: offError };
          return { data: [], error: null };
        },
      }),
    }));
    vi.doMock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: null }) }));
    const mod = await import("../lib/server/creative");
    return (await mod.loadStudioModels()).map((m) => m.id);
  };

  it("a platform admin reads every row, so the switched-off ids are subtracted", async () => {
    expect(await run(["seedance-1.5-pro"])).toEqual(["veo-3.1"]);
  });

  it("with nothing switched off, or the function missing, the list is what it always was", async () => {
    expect(await run([])).toEqual(["seedance-1.5-pro", "veo-3.1"]);
    expect(await run(null, { code: "PGRST202", message: "could not find the function" })).toEqual(["seedance-1.5-pro", "veo-3.1"]);
  });
});
