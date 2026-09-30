import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY_LIST_COLUMNS, API_KEY_PREFIX, createKeyArgs, generateApiKey, hashApiKey } from "@/lib/api/keys";
import { apiError } from "@/lib/api/http";

// CLAUDE.md #1: no part of a secret is stored or shown — "not its prefix".
// 0031 kept the first 8 random characters of every API key (api_keys.prefix)
// and showed / logged / audited them; migration 0040 retires that. These pin
// that no random character of a key is persisted, rendered or logged, and
// that the one place the whole key appears is the browser dialog right after
// it is created.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x", isSupabaseConfigured: true }));
vi.mock("@/lib/server/run-backend", () => ({ runBackend: "queue" }));
vi.mock("@/lib/server/downloads", () => ({ downloadsDir: () => null }));

const ROOT = join(__dirname, "..");
const REPO = join(ROOT, "..");
const SQL40 = readFileSync(join(REPO, "supabase/migrations/0040_api_keys_no_prefix.sql"), "utf8");
/** 0040 without its comments: what actually runs. */
const CODE40 = SQL40.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const CONSOLE = readFileSync(join(ROOT, "components/developers/DeveloperConsole.tsx"), "utf8");

function functions40(): { name: string; header: string; body: string }[] {
  return [...CODE40.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\$\$([\s\S]*?)\$\$;/g)].map((m) => ({
    name: m[1],
    header: m[2],
    body: m[3],
  }));
}

/** Every window of `n` characters of the key's random part. */
function windows(secret: string, n = 6): string[] {
  return Array.from({ length: secret.length - n + 1 }, (_, i) => secret.slice(i, i + n));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === ".next" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("migration 0040: nothing of a key is stored", () => {
  it("empties the stored fragment and forbids a new one", () => {
    expect(CODE40).toMatch(/alter table public\.api_keys drop constraint if exists api_keys_prefix_check;/);
    expect(CODE40).toMatch(/alter table public\.api_keys alter column prefix drop not null;/);
    expect(CODE40).toMatch(/update public\.api_keys set prefix = null where prefix is not null;/);
    expect(CODE40).toMatch(/add constraint api_keys_prefix_retired check \(prefix is null\);/);
    expect(CODE40).toMatch(/revoke select \(prefix\) on public\.api_keys from authenticated, service_role;/);
  });

  it("scrubs the fragment 0031 copied into the audit trail", () => {
    expect(CODE40).toMatch(/update public\.app_audit_log set detail = detail - 'api_key_prefix'\s+where detail \? 'api_key_prefix';/);
    expect(CODE40).toMatch(
      /update public\.app_audit_log set detail = detail - 'prefix'\s+where action in \('api_key\.create', 'api_key\.revoke'\) and detail \? 'prefix';/,
    );
  });

  it("drops the create_api_key that took a fragment and replaces it with one that takes only the hash", () => {
    expect(CODE40).toContain("drop function if exists public.create_api_key(uuid, text, text, text, bigint);");
    const create = functions40().find((f) => f.name === "create_api_key");
    expect(create).toBeDefined();
    expect(create!.header).not.toMatch(/prefix/);
    expect(create!.header).toMatch(/p_org uuid, p_name text, p_key_hash text, p_monthly_limit_cents bigint default null/);
    expect(CODE40).toContain("grant execute on function public.create_api_key(uuid, text, text, bigint) to authenticated;");
    expect(CODE40).not.toMatch(/grant execute on function public\.create_api_key\([^)]*\) to [^;]*anon/);
  });

  it("redefines every function that carried the fragment, and none of them mentions it", () => {
    const names = functions40().map((f) => f.name).sort();
    expect(names).toEqual(["api_audit", "api_auth", "api_begin", "create_api_key", "revoke_api_key"]);
    for (const f of functions40()) expect(`${f.header}${f.body}`, f.name).not.toMatch(/prefix/i);
  });

  it("names a key in GET /v1/me by its id and label", () => {
    const auth = functions40().find((f) => f.name === "api_auth")!;
    expect(auth.body).toMatch(/'key', \(select jsonb_build_object\('id', k\.id, 'name', k\.name\)/);
  });

  it("keeps 0031's organization check on create and revoke (another org's member is refused)", () => {
    const fns = functions40();
    expect(fns.find((f) => f.name === "create_api_key")!.body).toMatch(
      /if auth\.uid\(\) is null or not public\.is_org_member\(p_org, 'admin'\) then\s+raise exception/,
    );
    expect(fns.find((f) => f.name === "revoke_api_key")!.body).toMatch(
      /if k\.id is null or auth\.uid\(\) is null or not public\.is_org_member\(k\.org_id, 'admin'\) then\s+raise exception/,
    );
  });

  it("keeps the helpers private and the entry point anon-only", () => {
    for (const sig of ["api_begin(text, text, text)", "api_audit(jsonb, text, text, text, jsonb)"]) {
      expect(CODE40).toContain(`revoke all on function public.${sig} from public, anon, authenticated, service_role;`);
      expect(CODE40).not.toContain(`grant execute on function public.${sig}`);
    }
    expect(CODE40).toContain("grant execute on function public.api_auth(text, text) to anon;");
  });

  it("is idempotent and ends with a Verify block", () => {
    for (const stmt of CODE40.match(/^\s*(alter table|create|drop|comment)[^;]*/gim) ?? []) {
      expect(stmt, stmt).toMatch(/if exists|if not exists|or replace|drop not null|add constraint api_keys_prefix_retired|^\s*comment/i);
    }
    expect(SQL40).toMatch(/-- Verify \(run after applying/);
  });
});

describe("the browser keeps nothing of a key", () => {
  it("generates a key and nothing derived from it", () => {
    const made = generateApiKey();
    expect(Object.keys(made)).toEqual(["key"]);
  });

  it("sends only the key's SHA-256 to create_api_key", async () => {
    const { key } = generateApiKey();
    const secret = key.slice(API_KEY_PREFIX.length);
    const args = createKeyArgs("org-1", "Production", await hashApiKey(key), null);
    expect(Object.keys(args).sort()).toEqual(["p_key_hash", "p_monthly_limit_cents", "p_name", "p_org"]);
    expect(args.p_key_hash).toBe(await hashApiKey(key));
    const sent = JSON.stringify({ ...args, p_key_hash: undefined });
    for (const w of windows(secret)) expect(sent).not.toContain(w);
    expect(sent).not.toContain(API_KEY_PREFIX);
  });

  it("lists keys by name, id and times — never the retired fragment or the hash", () => {
    const cols = API_KEY_LIST_COLUMNS.split(",");
    expect(cols).toEqual(["id", "name", "monthly_limit_cents", "created_at", "last_used_at", "revoked_at"]);
  });

  it("uses the console's only create path, and shows the whole key only in the new-key dialog", () => {
    expect(CONSOLE).toContain('supabase.rpc("create_api_key", createKeyArgs(');
    expect(CONSOLE).toContain(".select(API_KEY_LIST_COLUMNS)");
    // The whole key lives in `shown`: set once after a successful create, rendered once.
    expect(CONSOLE.match(/setShown\(key\)/g)).toHaveLength(1);
    expect(CONSOLE.match(/\{shown\}/g)).toHaveLength(1);
    const dialog = CONSOLE.slice(CONSOLE.indexOf("{shown && ("), CONSOLE.indexOf("{d.newKeyTitle}") + 200);
    expect(dialog).toContain("{d.newKeyNote}");
    // A key's row shows its name, id, dates and limit — nothing of the key.
    const row = CONSOLE.slice(CONSOLE.indexOf("{keys.map((k) => ("), CONSOLE.indexOf("</tbody>"));
    const fields = new Set([...row.matchAll(/\bk\.(\w+)/g)].map((m) => m[1]));
    expect([...fields].sort()).toEqual(["created_at", "id", "last_used_at", "monthly_limit_cents", "name", "revoked_at"]);
    expect(row).not.toMatch(/shown|prefix/);
  });

  it("no source file stores, shows or logs a fragment of a key", () => {
    const offenders = [join(ROOT, "app"), join(ROOT, "components"), join(ROOT, "lib")]
      .flatMap(sourceFiles)
      .filter((p) => /p_prefix|keyPrefix|displayKey|api_key_prefix|API_KEY_DISPLAY_LENGTH|caller\.prefix/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("the API server logs nothing of a key", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the request id, status and code — no key, no fragment", async () => {
    const { runApi } = await import("@/lib/server/public-api");
    const { key } = generateApiKey();
    const secret = key.slice(API_KEY_PREFIX.length);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));

    const req = () => new Request("https://nightshift.test/api/v1/me", { headers: { authorization: `Bearer ${key}` } });
    const failed = await runApi(req(), async () => apiError(503, "api_unavailable", "down"));
    const thrown = await runApi(req(), async () => {
      throw new Error(`boom ${key}`);
    });
    expect(failed.status).toBe(503);
    expect(thrown.status).toBe(500);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[api\] \S+ 503 api_unavailable$/);
    expect(lines[1]).toMatch(/^\[api\] \S+ 500 Error$/);
    const all = lines.join("\n") + (await failed.text()) + (await thrown.text());
    expect(all).not.toContain(API_KEY_PREFIX);
    for (const w of windows(secret)) expect(all).not.toContain(w);
  });
});
