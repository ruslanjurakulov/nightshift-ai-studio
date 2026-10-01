import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pins on migration 0049: who may call what, what a browser may touch, and the
// same-organization rule for a file's folder. The security lab
// (tests/security/test_sec_media_folders.py) attacks the same rules against a
// live database; these keep a careless edit from reaching it.

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0049_media_folders.sql"), "utf8");
const CODE = SQL.split("\n")
  .map((l) => l.split("--")[0])
  .join("\n");

describe("0049 media_folders", () => {
  it("has RLS, starts from no privileges, and a browser may only select", () => {
    expect(CODE).toContain("alter table public.media_folders enable row level security;");
    expect(CODE).toContain("revoke all on public.media_folders from public, anon, authenticated, service_role;");
    expect(CODE).toContain("grant select on public.media_folders to authenticated, service_role;");
    expect(CODE).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* to /);
  });

  it("scopes its one policy to the caller's organizations", () => {
    const policies = [...CODE.matchAll(/create policy (\w+) on public\.(\w+)\s+for (\w+) to (\w+)\s+using \(([^;]*)\);/g)];
    expect(policies.map((p) => [p[1], p[2], p[3], p[4]])).toEqual([["media_folders_select", "media_folders", "select", "authenticated"]]);
    expect(policies[0][5]).toMatch(/org_id in \(select public\.accessible_org_ids\(\)\)/);
  });

  it("bounds a name and keeps it unique per organization ignoring case", () => {
    expect(CODE).toMatch(/char_length\(name\) between 1 and 60/);
    expect(CODE).toMatch(/unique index if not exists media_folders_org_name_key on public\.media_folders \(org_id, lower\(name\)\)/);
    expect(CODE).toMatch(/>= 200 then\s+raise exception 'limit_reached'/);
  });

  it("puts a file only in a folder of its own organization, for every writer", () => {
    expect(CODE).toMatch(/references public\.media_folders \(id\) on delete set null/);
    expect(CODE).toMatch(/before insert or update of folder_id, org_id on public\.media_assets/);
    expect(CODE).toMatch(/f\.id = new\.folder_id and f\.org_id = new\.org_id/);
  });

  it("never deletes a file with its folder", () => {
    expect(CODE).not.toMatch(/delete from public\.media_assets/);
    expect(CODE).not.toMatch(/on delete cascade[^;]*folder/);
  });
});

describe("0049 functions", () => {
  const fns = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);

  it("all pin their search_path", () => {
    expect(fns.sort()).toEqual(
      ["delete_media_folder", "media_assets_folder_guard", "media_folder_clean_name", "media_folder_counts", "move_media_assets", "save_media_folder"].sort(),
    );
    for (const m of CODE.matchAll(/create or replace function public\.(\w+)\([\s\S]*?\$\$/g)) {
      expect(m[0], m[1]).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("are revoked from everyone; only the four callable ones are granted — to authenticated", () => {
    for (const fn of fns) {
      expect(CODE, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
    const grants = [...CODE.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);/g)].map((m) => [m[1], m[2]]);
    expect(grants).toEqual([
      ["save_media_folder", "authenticated"],
      ["delete_media_folder", "authenticated"],
      ["move_media_assets", "authenticated"],
      ["media_folder_counts", "authenticated"],
    ]);
  });

  it("the counts run with the caller's rights, so RLS decides what is counted", () => {
    const body = CODE.slice(CODE.indexOf("function public.media_folder_counts("));
    expect(body.slice(0, body.indexOf("$$"))).toMatch(/security invoker/);
  });

  it("check sign-in and editor membership before touching a row", () => {
    for (const fn of ["save_media_folder", "move_media_assets"]) {
      const body = CODE.slice(CODE.indexOf(`function public.${fn}(`));
      const write = body.search(/insert into public\.media_folders|update public\.media_assets/);
      expect(body.indexOf("auth.uid() is null")).toBeLessThan(write);
      expect(body.search(/is_org_member\((org_|p_org), 'editor'\)/)).toBeLessThan(write);
    }
    const del = CODE.slice(CODE.indexOf("function public.delete_media_folder("));
    expect(del.indexOf("is_org_member(f.org_id, 'editor')")).toBeLessThan(del.indexOf("delete from public.media_folders"));
  });

  it("refuse a move with one id that is not a live file of the org, all or nothing", () => {
    const body = CODE.slice(CODE.indexOf("function public.move_media_assets("));
    expect(body).toMatch(/n > 200 then\s+raise exception 'too_many_assets'/);
    expect(body).toMatch(/m\.org_id = p_org and m\.deleted_at is null\) <> uniq then\s+raise exception 'invalid_asset'/);
    expect(body.indexOf("'invalid_asset'\n")).toBeLessThan(body.indexOf("update public.media_assets"));
  });

  it("publish nothing, render nothing, spend nothing", () => {
    expect(CODE).not.toMatch(/reserve_credits|capture_credits|creative_jobs|render_jobs|publish|review_intents|http_post|net\.http/);
  });

  it("give anon nothing at all", () => {
    expect(CODE).not.toMatch(/to [a-z_, ]*\banon\b/);
  });
});
