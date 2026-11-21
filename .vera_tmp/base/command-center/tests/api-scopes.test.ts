import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_SCOPES,
  CREATIVE_SCOPES,
  ENDPOINT_SCOPES,
  KEY_RPM_MAX,
  LEGACY_SCOPES,
  createScopedKeyArgs,
  effectiveScopes,
  isApiScope,
  parseCreditLimit,
  parseRpmLimit,
} from "@/lib/api/scopes";
import { API_KEY_LIST_COLUMNS } from "@/lib/api/keys";

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0062_api_creative.sql"), "utf8");
const fn = (name: string) => new RegExp(`create or replace function public\\.${name}\\(.*?^\\$\\$;`, "ms").exec(SQL)![0];

describe("scopes: the TypeScript twin of 0062", () => {
  it("names the same scopes as api_scopes_valid", () => {
    const sqlScopes = [...fn("api_scopes_valid").matchAll(/'([a-z]+:[a-z]+)'/g)].map((m) => m[1]);
    expect([...API_SCOPES].sort()).toEqual([...sqlScopes].sort());
  });

  it("gives a key made before 0062 exactly the legacy scopes, never a creative one", () => {
    const sqlLegacy = [...fn("api_legacy_scopes").matchAll(/'([a-z]+:[a-z]+)'/g)].map((m) => m[1]);
    expect([...LEGACY_SCOPES]).toEqual(sqlLegacy);
    for (const s of CREATIVE_SCOPES) expect(LEGACY_SCOPES).not.toContain(s);
    expect(effectiveScopes(null)).toEqual(LEGACY_SCOPES);
    expect(effectiveScopes(undefined)).toEqual(LEGACY_SCOPES);
    expect(effectiveScopes(["creative:read", "root"])).toEqual(["creative:read"]);
  });

  it("maps every endpoint to the scope api_endpoint_scope gives it", () => {
    const body = fn("api_endpoint_scope");
    const sqlMap = Object.fromEntries(
      [...body.matchAll(/when '([a-z_.]+)' then (null|'([a-z]+:[a-z]+)')/g)].map((m) => [m[1], m[3] ?? null]),
    );
    expect(sqlMap).toEqual(ENDPOINT_SCOPES);
    expect(body).toContain("else 'none'");
  });

  it("limits a key's request rate to the same range as the database", () => {
    expect(SQL).toContain(`rpm_limit between 1 and ${KEY_RPM_MAX}`);
    expect(parseRpmLimit("")).toEqual({ ok: true, value: null });
    expect(parseRpmLimit("2")).toEqual({ ok: true, value: 2 });
    expect(parseRpmLimit("300")).toEqual({ ok: true, value: 300 });
    for (const bad of ["0", "301", "-1", "1.5", "abc", "1e2"]) expect(parseRpmLimit(bad), bad).toEqual({ ok: false });
  });

  it("reads a credit ceiling in whole credits or cents of a credit", () => {
    expect(parseCreditLimit("")).toEqual({ ok: true, value: null });
    expect(parseCreditLimit("12,5")).toEqual({ ok: true, value: 12.5 });
    expect(parseCreditLimit("0")).toEqual({ ok: true, value: 0 });
    for (const bad of ["-1", "1.234", "abc", "1000000000"]) expect(parseCreditLimit(bad), bad).toEqual({ ok: false });
  });

  it("recognises only real scopes", () => {
    expect(isApiScope("creative:create")).toBe(true);
    for (const bad of ["admin", "creative:*", "", null, 3]) expect(isApiScope(bad)).toBe(false);
  });

  it("sends create_scoped_api_key a sorted, de-duplicated list and nothing of a key", () => {
    const args = createScopedKeyArgs("org-1", "x".repeat(80), 500, ["creative:read", "account:read", "creative:read"], 5, 12);
    expect(args).toEqual({
      p_org: "org-1",
      p_name: "x".repeat(60),
      p_monthly_limit_cents: 500,
      p_scopes: ["account:read", "creative:read"],
      p_rpm_limit: 5,
      p_creative_monthly_credits: 12,
    });
    expect(Object.keys(args).join(",")).not.toMatch(/hash|key\b/);
  });

  it("lists a key's access without ever selecting the hash or a fragment", () => {
    const cols = API_KEY_LIST_COLUMNS.split(",");
    expect(cols).toEqual(["id", "name", "monthly_limit_cents", "created_at", "last_used_at", "revoked_at", "scopes", "rpm_limit", "creative_monthly_credits"]);
    expect(SQL).toContain("grant select (scopes, rpm_limit, creative_monthly_credits) on public.api_keys to authenticated, service_role;");
  });
});
