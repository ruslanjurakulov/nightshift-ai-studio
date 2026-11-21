import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY_ID_RE, STYLE_LIBRARY } from "../lib/styles/library";

// Pins on migration 0065: the one narrow door that creates a kit with no
// reference images, who may call it, and that nothing about the 0047 tables'
// privileges moved. The security lab (tests/security/test_sec_style_library.py)
// attacks the same rules against a live database; these keep a careless edit
// from reaching it.

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0065_style_library.sql"), "utf8");
const CODE = SQL.split("\n")
  .map((l) => l.split("--")[0])
  .join("\n");

describe("0065 column and index", () => {
  it("adds library_id guarded, with the same id shape the app uses", () => {
    expect(CODE).toContain("alter table public.style_kits add column if not exists library_id text;");
    expect(CODE).toMatch(/char_length\(library_id\) between 2 and 48 and library_id ~ '\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$'/);
    // The pattern in SQL is the pattern in the app: every library id passes both.
    for (const s of STYLE_LIBRARY) {
      expect(LIBRARY_ID_RE.test(s.id)).toBe(true);
      expect(s.id.length).toBeGreaterThanOrEqual(2);
      expect(s.id.length).toBeLessThanOrEqual(48);
    }
  });

  it("allows one kit per library style per organization — what makes a double press one kit", () => {
    expect(CODE).toMatch(/create unique index if not exists style_kits_org_library_key\s+on public\.style_kits \(org_id, library_id\) where library_id is not null;/);
  });
});

describe("0065 add_library_style_kit", () => {
  const fn = CODE.slice(CODE.indexOf("function public.add_library_style_kit("));

  it("is security definer with a pinned search_path, and is the only function it creates", () => {
    expect([...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])).toEqual(["add_library_style_kit"]);
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
  });

  it("is revoked from everyone and granted to authenticated alone — never anon or service_role", () => {
    expect(CODE).toContain("revoke all on function public.add_library_style_kit(uuid, text, text, text) from public, anon, authenticated, service_role;");
    expect([...CODE.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);/g)].map((m) => [m[1], m[2]])).toEqual([
      ["add_library_style_kit", "authenticated"],
    ]);
  });

  it("checks sign-in and editor membership before it reads or writes anything", () => {
    const at = (needle: string) => fn.indexOf(needle);
    expect(at("auth.uid() is null")).toBeGreaterThan(-1);
    expect(at("is_org_member(p_org, 'editor')")).toBeGreaterThan(-1);
    expect(at("auth.uid() is null")).toBeLessThan(at("select * into k"));
    expect(at("is_org_member(p_org, 'editor')")).toBeLessThan(at("select * into k"));
    expect(at("is_org_member(p_org, 'editor')")).toBeLessThan(at("insert into public.style_kits"));
  });

  it("keeps the 0047 limits: name 1-60, description 1-2000, 50 kits per organization, one writer at a time", () => {
    expect(fn).toMatch(/char_length\(name_\) not between 1 and 60/);
    expect(fn).toMatch(/char_length\(desc_\) not between 1 and 2000/);
    expect(fn).toMatch(/>= 50 then\s+raise exception 'limit_reached' using errcode = 'NS429'/);
    expect(fn).toContain("pg_advisory_xact_lock(hashtextextended('style_kits:' || p_org::text, 0))");
  });

  it("returns an existing kit untouched instead of overwriting a person's edits", () => {
    const existing = fn.slice(fn.indexOf("select * into k"), fn.indexOf("limit_reached"));
    expect(existing).toContain("'created', false");
    expect(existing).not.toMatch(/\bupdate\b/);
    // The cap is checked after the lookup: a full organization can still "add" what it already has.
    expect(fn.indexOf("select * into k")).toBeLessThan(fn.indexOf(">= 50"));
  });

  it("creates the kit with no references (the library's text is the direction) and writes nothing else", () => {
    expect(fn).toMatch(/insert into public\.style_kits \(org_id, name, description, created_by, library_id\)/);
    expect(CODE).not.toMatch(/style_kit_references/);
    expect(CODE).not.toMatch(/reserve_credits|capture_credits|creative_jobs|http_post|net\.http/);
  });
});

describe("0065 leaves the 0047 privileges alone", () => {
  it("grants nothing on tables and changes no policy", () => {
    expect(CODE).not.toMatch(/\bgrant\b[^;]*\bon (?:table )?public\./);
    expect(CODE).not.toMatch(/create policy|drop policy|alter table [^;]*(enable|disable|force) row level security/);
    expect(CODE).not.toMatch(/to [a-z_, ]*\banon\b/);
  });

  it("is additive: it drops nothing and replaces no earlier function", () => {
    expect(CODE).not.toMatch(/\bdrop (?:table|column|function|index|constraint|trigger)\b/i);
    for (const earlier of ["save_style_kit", "save_character", "style_check_assets", "style_clean_text", "creative_job_style"]) {
      expect(CODE).not.toContain(`create or replace function public.${earlier}`);
    }
  });

  it("ends with a Verify query", () => {
    expect(SQL).toMatch(/-- Verify \(run after applying/);
  });
});
