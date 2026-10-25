import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_ENV_NAMES,
  MODEL_KEY_PROVIDERS,
  MODEL_KEY_PROVIDER_IDS,
  buildCards,
  checkModelKeyShape,
  envKeySet,
  getModelKeyProvider,
  keySource,
  envNamesText,
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
  it("is exactly the ids the page lists, with no database list behind it", () => {
    expect(MODEL_KEY_PROVIDERS.map((p) => p.id).sort()).toEqual([...MODEL_KEY_PROVIDER_IDS].sort());
    expect(MODEL_KEY_PROVIDER_IDS).toHaveLength(18);
  });

  it("covers every provider of the model registry (but the placeholder), so no model has a vendor without a key page", () => {
    const registry = JSON.parse(read("schemas/model_registry.json")) as { models: { provider: string }[] } | { provider: string }[];
    const models = Array.isArray(registry) ? registry : registry.models;
    const providers = new Set(models.map((m) => m.provider));
    // The registry names Google "google", ByteDance "bytedance", Alibaba "alibaba": the same ids as here, on purpose.
    // `unassigned-video-vendor` is a placeholder for the generic video ops, not a vendor.
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
    recraft: "GET https://external.api.recraft.ai/v1/users/me",
    ideogram: "GET https://api.ideogram.ai/v2/account/api-keys",
    minimax: "GET https://api.minimax.io/v1/models",
    runway: "GET https://api.dev.runwayml.com/v1/organization",
    luma: "GET https://agents.lumalabs.ai/v1/files?limit=1",
    krea: "GET https://api.krea.ai/jobs?limit=1",
    alibaba: "GET https://dashscope-intl.aliyuncs.com/api/v1/models?page_size=1",
  };
  const FORMAT_ONLY = ["bytedance", "kling", "lightricks", "pika", "vidu"];

  it("pins every http vendor to one exact free read and lists the five with no check", () => {
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
      recraft: [401, 403],
      ideogram: [401],
      minimax: [401, 403],
      runway: [401, 403],
      luma: [401, 403],
      krea: [401],
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
      recraft: 'Authorization:bearer|{}|{"kind":"object"}',
      ideogram: 'Api-Key:raw|{}|{"kind":"field","name":"api_keys","type":"array"}',
      minimax: 'Authorization:bearer|{}|{"kind":"field","name":"data","type":"array"}',
      runway: 'Authorization:bearer|{"X-Runway-Version":"2024-11-06"}|{"kind":"field","name":"creditBalance","type":"number"}',
      luma: 'Authorization:bearer|{}|{"kind":"object"}',
      krea: 'Authorization:bearer|{}|{"kind":"field","name":"items","type":"array"}',
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
  it("is https, comes with the vendor documentation page it was read on, or is absent (Kling, Lightricks, Vidu) and the card says so", () => {
    for (const p of MODEL_KEY_PROVIDERS) {
      if (p.keyUrl === null) {
        expect(p.keyUrlSource, p.id).toBeNull();
        continue;
      }
      expect(new URL(p.keyUrl).protocol, p.id).toBe("https:");
      expect(p.keyUrlSource, p.id).toMatch(/^https:\/\//);
    }
    expect(MODEL_KEY_PROVIDERS.filter((p) => p.keyUrl === null).map((p) => p.id).sort()).toEqual(["kling", "lightricks", "vidu"]);
  });
});

describe("the environment names", () => {
  it("are names the worker deploy maps (deploy/.env.worker.example and deploy_web.yml)", () => {
    const example = read("deploy/.env.worker.example");
    const deploy = read(".github/workflows/deploy_web.yml");
    for (const p of MODEL_KEY_PROVIDERS) {
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
    // a listing that may be cut short: a name seen is set, a name not seen is UNKNOWN (never "not set")
    expect(envKeySet(google, ["VEO_API_KEY"], false)).toBe(true);
    expect(envKeySet(google, ["OTHER"], false)).toBeNull();
    expect(envKeySet(google, ["OTHER"], true)).toBe(false);
    expect(envKeySet(google, null, true)).toBeNull();
  });

  it("asks GitHub about every name any vendor's sets mention (the Providers board's allowlist leaves out six of them)", () => {
    for (const name of ["XAI_API_KEY", "ASSEMBLYAI_API_KEY", "RUNWAYML_API_SECRET", "LUMA_AGENTS_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY", "KLING_API_KEY", "SEEDANCE_API_KEY"]) {
      expect(ALL_ENV_NAMES, name).toContain(name);
    }
    expect(new Set(ALL_ENV_NAMES).size).toBe(ALL_ENV_NAMES.length);
    for (const p of MODEL_KEY_PROVIDERS) for (const set of p.envSets) for (const n of set) expect(ALL_ENV_NAMES).toContain(n);
  });
});

describe("key source: which key a run uses", () => {
  it("is env when the GitHub secret is set, none when it is not, and unknown when the names could not be read (never none for that)", () => {
    expect(keySource(true)).toBe("env");
    expect(keySource(false)).toBe("none");
    expect(keySource(null)).toBe("unknown");
  });

  it("is built per card from the GitHub secret names only", () => {
    const cards = buildCards(["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "SOMETHING_ELSE"]);
    const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(by.openai.source).toBe("env");
    expect(by.elevenlabs.source).toBe("env");
    expect(by.bfl.source).toBe("none");
    expect(by.kling.mode).toBe("format_only");
    expect(by.kling.host).toBeNull();
    expect(by.openai.host).toBe("api.openai.com");
    expect(buildCards(null).every((c) => c.source === "unknown")).toBe(true);
    // a listing that may be cut short: seen -> env, not seen -> unknown (never none)
    const cut = Object.fromEntries(buildCards(["OPENAI_API_KEY"], false).map((c) => [c.id, c.source]));
    expect(cut.openai).toBe("env");
    expect(cut.bfl).toBe("unknown");
    expect(Object.values(cut).includes("none")).toBe(false);
    expect(cards).toHaveLength(MODEL_KEY_PROVIDERS.length);
    // a card carries nothing about any key
    expect(Object.keys(cards[0]).sort()).toEqual(
      ["docUrl", "envNames", "host", "id", "keyUrl", "mode", "name", "pairedKey", "path", "regionBound", "scopedKeys", "source"],
    );
  });

  it("names the exact variable(s) to set: alternatives joined with 'or', a pair with '+'", () => {
    const by = Object.fromEntries(buildCards([]).map((c) => [c.id, c.envNames]));
    expect(by.openai).toBe("OPENAI_API_KEY");
    expect(by.kling).toBe("KLING_API_KEY or KLING_ACCESS_KEY + KLING_SECRET_KEY");
    expect(by.google).toBe("GEMINI_API_KEY or VEO_API_KEY");
    expect(by.runway).toBe("RUNWAYML_API_SECRET");
    expect(by.xai).toBe("XAI_API_KEY");
    expect(by.recraft).toBe("RECRAFT_API_TOKEN");
    expect(by.vidu).toBe("VIDU_API_KEY");
    expect(by.pika).toBe("PIKA_API_KEY");
    expect(envNamesText(getModelKeyProvider("bytedance") as ModelKeyProvider)).toBe("SEEDANCE_API_KEY");
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
});

describe("the switch", () => {
  it("is on only for the literal on", () => {
    for (const v of ["on", "ON", " on "]) expect(parseModelKeysFlag(v), v).toBe(true);
    for (const v of [undefined, null, "", "off", "0", "1", "true", "yes", "onn", "enabled"]) expect(parseModelKeysFlag(v as string | undefined), String(v)).toBe(false);
  });
});

describe("the request body", () => {
  const GOOD = "sk-test-AbCdEf0123456789-wxyz";
  it("accepts a verify for a listed vendor and nothing else", () => {
    const ok = parseModelKeyRequest({ action: "verify", provider: "openai", key: GOOD });
    expect(ok.ok && ok.request.provider.id).toBe("openai");
    expect(ok.ok && ok.request.key).toBe(GOOD);
    for (const action of ["save", "remove", "store", "delete", "", undefined]) {
      expect(parseModelKeyRequest({ action, provider: "openai", key: GOOD }), String(action)).toEqual({ ok: false, error: "bad_request" });
    }
  });

  it.each([
    [null, "bad_request"],
    [[], "bad_request"],
    ["verify", "bad_request"],
    [{ action: "verify" }, "unknown_provider"],
    [{ action: "verify", provider: "nonesuch", key: "sk-test-AbCdEf0123456789-wxyz" }, "unknown_provider"],
    [{ action: "verify", provider: 7 }, "unknown_provider"],
    [{ action: "verify", provider: "openai" }, "bad_key"],
    [{ action: "verify", provider: "openai", key: "short" }, "bad_key"],
    [{ action: "verify", provider: "openai", key: { toString: (): string => GOOD } }, "bad_key"],
  ])("refuses %j as %s", (body, code) => {
    const out = parseModelKeyRequest(body);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toBe(code);
  });

  it("asks for no confirmation: nothing is stored, so a format-only vendor is simply checked for shape", () => {
    const k = parseModelKeyRequest({ action: "verify", provider: "kling", key: "AKaaaaaaaaaaaa:SKbbbbbbbbbbbbbb" });
    expect(k.ok).toBe(true);
  });

  it("never carries the key in a refusal", () => {
    const out = parseModelKeyRequest({ action: "verify", provider: "openai", key: "sk bad key with spaces 12345" });
    expect(JSON.stringify(out)).not.toContain("sk bad");
  });
});

describe("nothing is persisted", () => {
  const PERSIST = /\.rpc\(|\.from\(\s*["'`]|supabase\/server|createClient|vault|logAudit|localStorage|sessionStorage|indexedDB|document\.cookie|cookies\(|writeFile|appendFile|createWriteStream|\.insert\(|\.upsert\(|\.update\(/i;
  const FILES = [
    "command-center/lib/model-keys.ts",
    "command-center/lib/server/model-keys.ts",
    "command-center/components/model-keys/ModelKeysBoard.tsx",
    "command-center/app/(app)/[channel]/model-keys/page.tsx",
  ];

  it("the feature's code has no database, Vault, audit, browser-storage, cookie or file write", () => {
    for (const f of FILES) {
      const code = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, f).not.toMatch(PERSIST);
    }
  });

  it("the route imports only the sign-in, role and gate helpers, and no database client", () => {
    const route = read("command-center/app/api/owner/model-keys/route.ts");
    const imports = [...route.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      "@/lib/auth/roles",
      "@/lib/model-keys",
      "@/lib/security/admin-mfa-server",
      "@/lib/server/admin-post-guard",
      "@/lib/server/json-body",
      "@/lib/server/model-keys",
      "@/lib/server/same-origin",
      "@/lib/server/secret-write",
      "@/lib/supabase/server",
      "next/server",
    ]);
    expect(route).toMatch(/import \{ getUser \} from "@\/lib\/supabase\/server"/);
    expect(route).not.toMatch(/createClient|\.rpc\(/);
  });

  it("there is no migration, no rollback and no SQL function for the keys", () => {
    const migrations = readdirSync(join(ROOT, "supabase/migrations"));
    const files = [...migrations, ...readdirSync(join(ROOT, "docs/sql"))];
    expect(files.filter((f) => /0123|model_api_key|model-api-key|model_key/i.test(f))).toEqual([]);
    const sql = migrations.filter((f) => f.endsWith(".sql")).map((f) => read(`supabase/migrations/${f}`)).join("\n");
    expect(sql).not.toMatch(/model_api_key|owner_model_key|model_key_provider_ok/);
  });
});
