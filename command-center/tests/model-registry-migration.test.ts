import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pins on migration 0035: nothing is sold before a real probe, and nobody but
// the operator and the probe tool can change that.

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0035_model_registry.sql"), "utf8");
const code = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

function fn(name: string): string {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`));
  expect(m, name).not.toBeNull();
  return m![0];
}

function grantsFor(name: string): string[] {
  return [...code.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s+to ([a-z_, ]+);`, "g"))].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()),
  );
}

describe("0035 the sale rule", () => {
  it("refuses beta/ga without verified_at in a CHECK, not only in code", () => {
    expect(code).toMatch(/model_registry_verified_before_sale\s+check \(availability not in \('beta', 'ga'\) or verified_at is not null\)/);
  });

  it("refuses beta/ga while a vendor-terms gate is set", () => {
    expect(code).toMatch(/model_registry_terms_before_sale\s+check \(availability not in \('beta', 'ga'\) or coalesce\(spec ->> 'terms_gate', ''\) = ''\)/);
  });

  it("ties verified_at to a successful probe of the same model, adapter and vendor model", () => {
    const guard = fn("model_registry_guard");
    expect(guard).toMatch(/not p\.ok/);
    expect(guard).toMatch(/p\.model_id <> new\.id/);
    expect(guard).toMatch(/p\.adapter <> new\.adapter/);
    expect(guard).toMatch(/new\.verified_at := p\.created_at/);
    expect(code).toMatch(/check \(\(verified_at is null\) = \(verified_probe_id is null\)\)/);
  });

  it("drops verification when what is called changes", () => {
    const guard = fn("model_registry_guard");
    expect(guard).toMatch(/new\.spec -> 'vendor_model' is distinct from old\.spec -> 'vendor_model'/);
    expect(guard).toMatch(/new\.availability := 'hidden'/);
  });

  it("sells only verified, priced, ungated models and keeps web-only models off the API and MCP", () => {
    const sellable = fn("sellable_models");
    expect(sellable).toMatch(/m\.availability in \('beta', 'ga'\)/);
    expect(sellable).toMatch(/m\.verified_at is not null/);
    expect(sellable).toMatch(/cp\.credits_per_unit > 0/);
    expect(sellable).toMatch(/coalesce\(m\.spec ->> 'terms_gate', ''\) = ''/);
    expect(sellable).toMatch(/p_surface = 'web' or coalesce\(m\.spec ->> 'api_exposure', 'any'\) <> 'web_only'/);
    // provider costs stay platform-only
    expect(sellable).not.toMatch(/'pricing', m\.spec/);
    expect(sellable).not.toMatch(/'probe'/);
  });
});

describe("0035 grants and RLS", () => {
  it("gives anon nothing", () => {
    expect(code).toMatch(/revoke all on public\.model_registry from anon, authenticated, service_role;/);
    expect(code).toMatch(/revoke all on public\.model_probe_runs from anon, authenticated, service_role;/);
    expect(code).not.toMatch(/to anon/);
    expect(code).toMatch(/revoke all on function public\.sellable_models\(text, text\) from public, anon;/);
  });

  it("keeps sync and probe recording to the service role", () => {
    expect(grantsFor("sync_model_registry")).toEqual(["service_role"]);
    expect(grantsFor("record_model_probe")).toEqual(["service_role"]);
    expect(grantsFor("sellable_models")).toEqual(["authenticated", "service_role"]);
  });

  it("lets signed-in users select only the public columns, and update only the operator's columns", () => {
    const select = code.match(/grant select \(([^)]*)\)\s+on public\.model_registry to authenticated;/);
    expect(select).not.toBeNull();
    expect(select![1]).not.toMatch(/\bspec\b|verified_by|verified_probe_id/);
    const update = code.match(/grant update \(([^)]*)\) on public\.model_registry to authenticated;/);
    expect(update![1].split(",").map((s) => s.trim()).sort()).toEqual(["availability", "credit_unit", "display_name", "entitlement"]);
  });

  it("guards reads and writes with platform admin", () => {
    expect(code).toMatch(/create policy model_registry_select[\s\S]*?using \(public\.is_platform_admin\(\) or \(availability in \('beta', 'ga'\) and verified_at is not null\)\)/);
    expect(code).toMatch(/create policy model_registry_admin_update[\s\S]*?using \(public\.is_platform_admin\(\)\)\s+with check \(public\.is_platform_admin\(\)\)/);
    expect(code).toMatch(/create policy model_probe_runs_select[\s\S]*?using \(public\.is_platform_admin\(\)\)/);
    expect(fn("model_registry_admin")).toMatch(/if not public\.is_platform_admin\(\) then/);
  });

  it("keeps probe runs append-only", () => {
    expect(code).toMatch(/before update or delete on public\.model_probe_runs/);
    expect(code).not.toMatch(/grant (insert|update|delete)[^;]*on public\.model_probe_runs/);
  });

  it("pins search_path on every security-definer function", () => {
    const definers = [...code.matchAll(/create or replace function public\.(\w+)[\s\S]*?as \$\$/g)].filter((m) => /security definer/.test(m[0]));
    expect(definers.length).toBeGreaterThanOrEqual(5);
    for (const d of definers) expect(d[0], d[1]).toMatch(/set search_path = public, pg_temp/);
  });

  it("is idempotent", () => {
    expect(code).toMatch(/create table if not exists public\.model_registry/);
    expect(code).toMatch(/create table if not exists public\.model_probe_runs/);
    for (const m of code.matchAll(/add constraint (\w+)/g)) {
      expect(code, m[1]).toMatch(new RegExp(`drop constraint if exists ${m[1]};`));
    }
    for (const m of code.matchAll(/create policy (\w+)/g)) {
      expect(code, m[1]).toMatch(new RegExp(`drop policy if exists ${m[1]} on`));
    }
  });
});
