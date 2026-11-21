import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pins on migration 0047: who may call what, what a browser may touch, and the
// same-organization rule for references and a channel's default kit. The
// security lab (tests/security/test_sec_style_kits.py) attacks the same rules
// against a live database; these keep a careless edit from reaching it.

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0047_style_kits_characters.sql"), "utf8");
const CODE = SQL.split("\n")
  .map((l) => l.split("--")[0])
  .join("\n");

const TABLES = ["style_kits", "characters", "style_kit_references", "character_references"];

describe("0047 tables", () => {
  it("all have RLS and start from no privileges at all", () => {
    for (const t of TABLES) {
      expect(CODE).toContain(`alter table public.${t} enable row level security;`);
      expect(CODE).toContain(`revoke all on public.${t} from public, anon, authenticated, service_role;`);
    }
  });

  it("give a browser select (and delete on kits/characters) — never insert or update", () => {
    expect(CODE).not.toMatch(/grant [^;]*\b(insert|update)\b[^;]* to [^;]*\b(authenticated|service_role)\b/);
    expect(CODE).toContain("grant select, delete on public.style_kits to authenticated;");
    expect(CODE).toContain("grant select, delete on public.characters to authenticated;");
    expect(CODE).toContain("grant select on public.style_kit_references to authenticated;");
    expect(CODE).toContain("grant select on public.character_references to authenticated;");
  });

  it("scope every policy to the caller's organizations, deletes to editors", () => {
    const policies = [...CODE.matchAll(/create policy (\w+) on public\.(\w+)\s+for (\w+) to (\w+)\s+using \(([^;]*)\);/g)];
    expect(policies.length).toBe(6);
    for (const [, , , cmd, role, using] of policies) {
      expect(role).toBe("authenticated");
      expect(using).toMatch(cmd === "delete" ? /accessible_org_ids\('editor'\)/ : /org_id in \(select public\.accessible_org_ids\(\)\)/);
    }
  });

  it("pin references to the owner's org by key and to the asset's org by trigger", () => {
    expect(CODE).toMatch(/foreign key \(kit_id, org_id\)\s+references public\.style_kits \(id, org_id\) on delete cascade/);
    expect(CODE).toMatch(/foreign key \(character_id, org_id\)\s+references public\.characters \(id, org_id\) on delete cascade/);
    expect(CODE).toMatch(/a\.id = new\.asset_id and a\.org_id = new\.org_id\s+and a\.kind = 'image' and a\.deleted_at is null/);
    expect(CODE).toMatch(/before insert or update on public\.style_kit_references/);
    expect(CODE).toMatch(/before insert or update on public\.character_references/);
  });

  it("check a channel's default kit against the channel's own org", () => {
    expect(CODE).toMatch(/before insert or update of default_style_kit_id, org_id on public\.channels/);
    expect(CODE).toMatch(/k\.id = new\.default_style_kit_id and k\.org_id = new\.org_id/);
    expect(CODE).toMatch(/references public\.style_kits \(id\) on delete set null/);
  });
});

describe("0047 functions", () => {
  const fns = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);

  it("all pin their search_path", () => {
    expect(fns.length).toBe(7);
    for (const m of CODE.matchAll(/create or replace function public\.(\w+)\([\s\S]*?\$\$/g)) {
      expect(m[0], m[1]).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("are revoked from everyone, and only the two saves are granted — to authenticated", () => {
    for (const fn of fns) {
      expect(CODE, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
    const grants = [...CODE.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);/g)].map((m) => [m[1], m[2]]);
    expect(grants).toEqual([
      ["save_style_kit", "authenticated"],
      ["save_character", "authenticated"],
    ]);
  });

  it("check membership before anything else, editor to write", () => {
    for (const fn of ["save_style_kit", "save_character"]) {
      const body = CODE.slice(CODE.indexOf(`function public.${fn}(`));
      expect(body.indexOf("auth.uid() is null")).toBeLessThan(body.indexOf("style_check_assets"));
      expect(body.indexOf("is_org_member(org_, 'editor')")).toBeLessThan(body.indexOf("style_check_assets"));
    }
  });

  it("call no model and spend nothing", () => {
    expect(CODE).not.toMatch(/reserve_credits|capture_credits|creative_jobs|http_post|net\.http/);
  });

  it("give anon nothing at all", () => {
    expect(CODE).not.toMatch(/to [a-z_, ]*\banon\b/);
  });
});
