import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pins on migration 0038: who may call what, what a browser may touch, and
// that a file's path can only come from its id.

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0038_media_assets.sql"), "utf8");
const CODE = SQL.split("\n")
  .map((l) => l.split("--")[0])
  .join("\n");

function grantsFor(name: string): string[] {
  return [...CODE.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to ([a-z_, ]+);`, "g"))].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()),
  );
}

const USER = ["request_upload", "begin_upload_receive", "finish_upload_receive", "soft_delete_asset"];
const SERVICE = ["claim_media_upload", "reject_media_upload", "register_asset", "claim_media_purge", "mark_asset_purged"];

describe("0038 grants", () => {
  it("gives the upload and delete entry points to signed-in users only", () => {
    for (const fn of USER) expect(grantsFor(fn), fn).toEqual(["authenticated"]);
  });

  it("keeps registering, claiming and purging to the service role", () => {
    for (const fn of SERVICE) expect(grantsFor(fn), fn).toEqual(["service_role"]);
  });

  it("grants nothing on the helpers and revokes every function from everyone first", () => {
    const fns = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(fns.length).toBeGreaterThan(10);
    for (const fn of fns) {
      expect(CODE, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated, service_role;`));
      if (![...USER, ...SERVICE].includes(fn)) expect(grantsFor(fn), fn).toEqual([]);
    }
  });

  it("gives anon nothing at all", () => {
    expect(CODE).not.toMatch(/\bto anon\b/);
    expect(CODE).not.toMatch(/to [a-z_, ]*\banon\b/);
  });
});

describe("0038 tables", () => {
  const tables = ["media_assets", "media_uploads", "org_storage_quota", "media_storage_settings"];

  it("are read-only to a browser", () => {
    for (const t of tables) {
      expect(CODE).toContain(`alter table public.${t} enable row level security;`);
      expect(CODE).toContain(`grant select on public.${t} to authenticated, service_role;`);
    }
    expect(CODE).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* to [^;]*\bauthenticated\b/);
  });

  it("show a member only their organization's live assets", () => {
    expect(CODE).toMatch(
      /create policy media_assets_select on public\.media_assets\s+for select to authenticated\s+using \(deleted_at is null and org_id in \(select public\.accessible_org_ids\(\)\)\);/,
    );
  });

  it("derive the storage key from the id alone", () => {
    expect(CODE).toContain("storage_key     text generated always as (substr(id::text, 1, 2) || '/' || id::text) stored");
  });
});
