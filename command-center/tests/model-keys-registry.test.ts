import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MODEL_KEY_PROVIDERS,
  MODEL_KEY_PROVIDER_IDS,
  buildCards,
  checkModelKeyShape,
  envKeySet,
  getModelKeyProvider,
  keySource,
  keyTail,
  maskedTail,
  parseModelKeyRequest,
  parseModelKeysFlag,
  type ModelKeyProvider,
} from "../lib/model-keys";

vi.mock("server-only", () => ({}));

/**
 * The vendor list and the rules around a typed key (lib/model-keys.ts).
 *
 * What would break without these: a vendor in the page that the database refuses (or the reverse), a "verify" request that is really a
 * generation call (it would cost money and make something), a key page link nobody read in the vendor's docs, an environment name the deploy
 * never maps (the page would say "no key" about a key that is set), and a key shape the database would refuse after the vendor accepted it.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the closed set of vendors", () => {
  it("is the same list in the page and in the database function", () => {
    const sql = read("supabase/migrations/0123_model_api_keys.sql");
    const body = /model_key_provider_ok\(p text\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/.exec(sql)?.[1] ?? "";
    const inSql = [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...MODEL_KEY_PROVIDER_IDS].sort());
    expect(MODEL_KEY_PROVIDERS.map((p) => p.id).sort()).toEqual([...MODEL_KEY_PROVIDER_IDS].sort());
  });

  it("covers every provider of the model registry (but the placeholder), so no model has a vendor without a key page", () => {
    const registry = JSON.parse(read("schemas/model_registry.json")) as { models: { provider: string }[] } | { provider: string }[];
    const models = Array.isArray(registry) ? registry : registry.models;
    const providers = new Set(models.map((m) => m.provider));
    // The registry names Google "google", ByteDance "bytedance", Alibaba "alibaba": the same ids as here, on purpose.
    // `unassigned-video-vendor` is a placeholder for the generic video ops, not a vendor. xAI is here ahead of its registry entries (#607).
    providers.delete("unassigned-video-vendor");
    const missing = [...providers].filter((p) => !(MODEL_KEY_PROVIDER_IDS as readonly string[]).includes(p));
    expect(missing, `registry providers with no entry in lib/model-keys.ts: ${missing}`).toEqual([]);
  });

  it("looks a vendor up by id only; anything else is no vendor", () => {
    expect(getModelKeyProvider("openai")?.name).toBe("OpenAI");
    for (const bad of ["OpenAI", "openai ", "", "__proto__", "constructor", "toString", "unassigned-video-vendor", "../openai"]) {
      expect(getModelKeyProvider(bad), bad).toBeNull();
    }
  });
});

describe("what a verify request is allowed to be", () => {
  // The EXACT request of every vendor, pinned. Changing one is a decision for review: it must still be a free read that makes nothing.
  const PINNED: Record<string, string> = {
    openai: "GET https://api.openai.com/v1/models",
    google: "GET https://generativelanguage.googleapis.com/v1beta/models",
    xai: "GET https://api.x.ai/v1/models",
    elevenlabs: "GET https://api.elevenlabs.io/v1/models",
    assemblyai: "GET https://api.assemblyai.com/v2/transcript?limit=1",
    bfl: "GET https://api.bfl.ai/v1/credits",
    ideogram: "GET https://api.ideogram.ai/v2/account/api-keys",
    minimax: "GET https://api.minimax.io/v1/models",
    runway: "GET https://api.dev.runwayml.com/v1/organization",
    luma: "GET https://agents.lumalabs.ai/v1/files?limit=1",
    alibaba: "GET https://dashscope-intl.aliyuncs.com/api/v1/models?page_size=1",
  };
  const FORMAT_ONLY = ["bytedance", "kling"];

  it("pins every http vendor to one exact free read and lists the two with no check", () => {
    const got: Record<string, string> = {};
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind === "http") got[p.id] = `GET ${p.strategy.origin}${p.strategy.path}${p.strategy.query ? `?${p.strategy.query}` : ""}`;
    }
    expect(got).toEqual(PINNED);
    expect(MODEL_KEY_PROVIDERS.filter((p) => p.strategy.kind === "format_only").map((p) => p.id).sort()).toEqual(FORMAT_ONLY);
  });

  it("pins which statuses each vendor reads as 'this key is not accepted' (the verify tests read them from the registry, so this is the independent copy)", () => {
    const got: Record<string, number[]> = {};
    for (const p of MODEL_KEY_PROVIDERS) if (p.strategy.kind === "http") got[p.id] = [...p.strategy.rejectStatuses];
    expect(got).toEqual({
      openai: [401, 403],
      google: [400, 401, 403],
      xai: [401, 403],
      elevenlabs: [401, 403],
      assemblyai: [401, 403],
      bfl: [401, 403],
      ideogram: [401],
      minimax: [401, 403],
      runway: [401, 403],
      luma: [401, 403],
      alibaba: [401, 403],
    });
  });

  it("pins the header each vendor takes the key in, the scheme, the fixed extra headers and the shape that counts as an answer", () => {
    const got: Record<string, string> = {};
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind !== "http") continue;
      const s = p.strategy;
      got[p.id] = `${s.auth.header}:${s.auth.scheme}|${JSON.stringify(s.headers)}|${JSON.stringify(s.expect)}`;
    }
    expect(got).toEqual({
      openai: 'Authorization:bearer|{}|{"kind":"field","name":"data","type":"array"}',
      google: 'x-goog-api-key:raw|{}|{"kind":"field","name":"models","type":"array"}',
      xai: 'Authorization:bearer|{}|{"kind":"field","name":"data","type":"array"}',
      elevenlabs: 'xi-api-key:raw|{}|{"kind":"array"}',
      assemblyai: 'Authorization:raw|{}|{"kind":"field","name":"page_details","type":"object"}',
      bfl: 'x-key:raw|{}|{"kind":"field","name":"credits","type":"number"}',
      ideogram: 'Api-Key:raw|{}|{"kind":"field","name":"api_keys","type":"array"}',
      minimax: 'Authorization:bearer|{}|{"kind":"field","name":"data","type":"array"}',
      runway: 'Authorization:bearer|{"X-Runway-Version":"2024-11-06"}|{"kind":"field","name":"creditBalance","type":"number"}',
      luma: 'Authorization:bearer|{}|{"kind":"object"}',
      alibaba: 'Authorization:bearer|{}|{"kind":"field","name":"output","type":"object"}',
    });
  });

  it("never names a generation, creation or prediction endpoint", () => {
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind !== "http") continue;
      expect(p.strategy.path, p.id).not.toMatch(/generat|create|predict|video|image|speech|audio|text-to|complet|chat|upload|submit|run\b|tasks?\b/i);
    }
  });

  it("uses an https origin with no path, user, port or query, and a path that starts with a slash", () => {
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind !== "http") continue;
      const o = new URL(p.strategy.origin);
      expect(o.protocol, p.id).toBe("https:");
      expect(`${o.protocol}//${o.host}`, p.id).toBe(p.strategy.origin);
      expect(o.username + o.password + o.search + o.hash, p.id).toBe("");
      expect(o.pathname, p.id).toBe("/");
      expect(p.strategy.path.startsWith("/"), p.id).toBe(true);
      expect(p.strategy.query, `no key in a query: ${p.id}`).not.toMatch(/key|token|secret|auth/i);
      expect(p.strategy.rejectStatuses.length, p.id).toBeGreaterThan(0);
      for (const code of p.strategy.rejectStatuses) expect([400, 401, 403], `${p.id} ${code}`).toContain(code);
      expect(new URL(p.strategy.docUrl).protocol, p.id).toBe("https:");
    }
  });

  it("sends the key in a header only, and never a header that is a secret in the registry", () => {
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.strategy.kind !== "http") continue;
      expect(p.strategy.auth.header, p.id).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
      for (const [k, v] of Object.entries(p.strategy.headers)) {
        expect(k.toLowerCase(), p.id).not.toBe(p.strategy.auth.header.toLowerCase());
        expect(v, `${p.id} header ${k}`).not.toMatch(/key|secret|token|bearer/i);
      }
    }
  });
});

describe("the key page link", () => {
  it("is https, comes with the vendor documentation page it was read on, or is absent (Kling) and the card says so", () => {
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.keyUrl === null) {
        expect(p.keyUrlSource, p.id).toBeNull();
        continue;
      }
      expect(new URL(p.keyUrl).protocol, p.id).toBe("https:");
      expect(p.keyUrlSource, p.id).toMatch(/^https:\/\//);
    }
    expect(MODEL_KEY_PROVIDERS.filter((p) => p.keyUrl === null).map((p) => p.id)).toEqual(["kling"]);
  });
});

describe("the environment names", () => {
  it("are names the worker deploy maps (deploy/.env.worker.example and deploy_web.yml), except xAI whose adapters are still in review", () => {
    const example = read("deploy/.env.worker.example");
    const deploy = read(".github/workflows/deploy_web.yml");
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.id === "xai") continue;
      for (const set of p.envSets) {
        for (const name of set) {
          expect(example, `${p.id} ${name} in deploy/.env.worker.example`).toMatch(new RegExp(`^${name}=`, "m"));
          expect(deploy, `${p.id} ${name} in deploy_web.yml`).toContain(`WORKERENV_${name}:`);
        }
      }
    }
  });

  it("reads as set when every name of any one set is configured, unknown when the secrets could not be read, unset otherwise", () => {
    const kling = getModelKeyProvider("kling") as ModelKeyProvider;
    expect(envKeySet(kling, ["KLING_API_KEY"])).toBe(true);
    expect(envKeySet(kling, ["KLING_ACCESS_KEY"])).toBe(false);
    expect(envKeySet(kling, ["KLING_ACCESS_KEY", "KLING_SECRET_KEY"])).toBe(true);
    expect(envKeySet(kling, [])).toBe(false);
    expect(envKeySet(kling, null)).toBeNull();
    const google = getModelKeyProvider("google") as ModelKeyProvider;
    expect(envKeySet(google, ["VEO_API_KEY"])).toBe(true);
  });
});

describe("key source: which key a run uses", () => {
  it("is env when the environment has it (even when Vault has one too), vault only when nothing else, none, and unknown", () => {
    expect(keySource({ envSet: true, vaultStored: true })).toBe("env");
    expect(keySource({ envSet: true, vaultStored: false })).toBe("env");
    expect(keySource({ envSet: false, vaultStored: true })).toBe("vault");
    expect(keySource({ envSet: false, vaultStored: false })).toBe("none");
    // Not readable is not "none": a key may well be set.
    expect(keySource({ envSet: null, vaultStored: false })).toBe("unknown");
    expect(keySource({ envSet: null, vaultStored: true })).toBe("unknown");
  });

  it("is built per card from what is stored and which secrets exist", () => {
    const cards = buildCards(
      [{ provider: "openai", status: "verified", last4: "wxyz", verifiedAt: "2026-10-25T10:00:00Z", checkedByEmail: "o@a.uz" }],
      ["OPENAI_API_KEY", "ELEVENLABS_API_KEY"],
    );
    const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(by.openai.source).toBe("env");
    expect(by.openai.stored?.last4).toBe("wxyz");
    expect(by.elevenlabs.source).toBe("env");
    expect(by.bfl.source).toBe("none");
    expect(by.kling.mode).toBe("format_only");
    expect(by.kling.host).toBeNull();
    expect(by.openai.host).toBe("api.openai.com");
    expect(buildCards([{ provider: "bfl", status: "format_only", last4: "abcd", verifiedAt: null, checkedByEmail: null }], null).find((c) => c.id === "bfl")?.source).toBe("unknown");
    expect(buildCards([{ provider: "bfl", status: "verified", last4: "abcd", verifiedAt: null, checkedByEmail: null }], []).find((c) => c.id === "bfl")?.source).toBe("vault");
    expect(cards).toHaveLength(MODEL_KEY_PROVIDERS.length);
  });
});

describe("the typed key", () => {
  const openai = getModelKeyProvider("openai") as ModelKeyProvider;
  const kling = getModelKeyProvider("kling") as ModelKeyProvider;
  const GOOD = "sk-test-AbCdEf0123456789-wxyz";

  it("is trimmed and accepted as one printable token of 16 to 512 characters", () => {
    expect(checkModelKeyShape(openai, `  ${GOOD}\n`)).toEqual({ ok: true, key: GOOD });
    expect(checkModelKeyShape(openai, "a".repeat(512))).toMatchObject({ ok: true });
    expect(checkModelKeyShape(openai, "a".repeat(513))).toEqual({ ok: false, reason: "too_long" });
    expect(checkModelKeyShape(openai, "a".repeat(15))).toEqual({ ok: false, reason: "too_short" });
    expect(checkModelKeyShape(openai, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkModelKeyShape(openai, 42 as unknown)).toEqual({ ok: false, reason: "bad_shape" });
  });

  it.each(["sk with a space 0123456789", "sk-$(id)-0123456789abcd", "sk-`id`-0123456789abcd", 'sk-"q"-0123456789abcdef', "sk-'q'-0123456789abcdef", "sk-back\\slash-0123456789", "sk-éé-0123456789abcdef", "sk-tab\t0123456789abcdef", "sk-nl\n0123456789abcdef"])(
    "refuses %j with a reason word that does not contain it",
    (bad) => {
      const out = checkModelKeyShape(openai, bad);
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain(bad.trim());
    },
  );

  it("takes a paired key only as two non-empty parts", () => {
    expect(checkModelKeyShape(kling, "AKaaaaaaaaaaaa:SKbbbbbbbbbbbbbb")).toMatchObject({ ok: true });
    expect(checkModelKeyShape(kling, "AKaaaaaaaaaaaaaaaaaaaaaaaaaa:")).toEqual({ ok: false, reason: "bad_pair" });
    expect(checkModelKeyShape(kling, ":SKbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toEqual({ ok: false, reason: "bad_pair" });
    expect(checkModelKeyShape(kling, "AKaaaaaaaaaaaa:SKbbbbbbbbbb:cc")).toEqual({ ok: false, reason: "bad_pair" });
    // a console key without a colon is the other documented mode and stays acceptable
    expect(checkModelKeyShape(kling, "consolekey0123456789abcdef")).toMatchObject({ ok: true });
  });

  it("shows only the last four characters", () => {
    expect(keyTail(GOOD)).toBe("wxyz");
    expect(maskedTail("wxyz")).toBe("•••• wxyz");
    expect(maskedTail("wxyz")).not.toContain("sk-");
  });
});

describe("the switch", () => {
  it("is on only for the literal on", () => {
    for (const v of ["on", "ON", " on "]) expect(parseModelKeysFlag(v), v).toBe(true);
    for (const v of [undefined, null, "", "off", "0", "1", "true", "yes", "onn", "enabled"]) expect(parseModelKeysFlag(v as string | undefined), String(v)).toBe(false);
  });
});

describe("the request body", () => {
  const GOOD = "sk-test-AbCdEf0123456789-wxyz";
  it("accepts a save for a listed vendor and a remove", () => {
    const save = parseModelKeyRequest({ action: "save", provider: "openai", key: GOOD });
    expect(save.ok && save.request.action === "save" && save.request.provider.id).toBe("openai");
    const rm = parseModelKeyRequest({ action: "remove", provider: "bfl" });
    expect(rm.ok && rm.request.action).toBe("remove");
  });

  it.each([
    [null, "bad_request"],
    [[], "bad_request"],
    ["save", "bad_request"],
    [{ action: "verify", provider: "openai" }, "bad_request"],
    [{ action: "save" }, "unknown_provider"],
    [{ action: "save", provider: "nonesuch", key: "sk-test-AbCdEf0123456789-wxyz" }, "unknown_provider"],
    [{ action: "remove", provider: 7 }, "unknown_provider"],
    [{ action: "save", provider: "openai" }, "bad_key"],
    [{ action: "save", provider: "openai", key: "short" }, "bad_key"],
    [{ action: "save", provider: "openai", key: { toString: (): string => GOOD } }, "bad_key"],
  ])("refuses %j as %s", (body, code) => {
    const out = parseModelKeyRequest(body);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toBe(code);
  });

  it("asks for the explicit confirmation of a vendor with no free check, and ignores it for a vendor that has one", () => {
    const k = { action: "save", provider: "kling", key: "AKaaaaaaaaaaaa:SKbbbbbbbbbbbbbb" };
    expect(parseModelKeyRequest(k)).toEqual({ ok: false, error: "confirm_required" });
    expect(parseModelKeyRequest({ ...k, confirm_format_only: "yes" })).toEqual({ ok: false, error: "confirm_required" });
    expect(parseModelKeyRequest({ ...k, confirm_format_only: true }).ok).toBe(true);
    const o = parseModelKeyRequest({ action: "save", provider: "openai", key: GOOD, confirm_format_only: true });
    expect(o.ok && o.request.action === "save" && o.request.provider.strategy.kind).toBe("http");
  });

  it("never carries the key in a refusal", () => {
    const out = parseModelKeyRequest({ action: "save", provider: "openai", key: "sk bad key with spaces 12345" });
    expect(JSON.stringify(out)).not.toContain("sk bad");
  });
});
