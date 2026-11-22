import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isValidChannelId } from "@/lib/channels";
import { RESERVED_ROOT_SEGMENTS } from "@/lib/public-paths";

// The app refuses a channel id that is a page of the site (isValidChannelId), and since migration 0217 the database
// does too (is_reserved_channel_id, behind a CHECK on channels.channel_id and create_channel). Two lists that drift
// apart mean either a channel the app lets someone name and the database then refuses with a raw error, or a channel
// the database accepts (the API, the service role) whose every screen a page of the site shadows. This holds them equal.

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
// Tolerant of spacing and case, and of a plain `create function`: a later redefinition written differently must still be found.
const DEFINES = /create\s+(or\s+replace\s+)?function\s+public\.is_reserved_channel_id\s*\(/i;
// Looser still: anything that looks like a definition of the function at all (quoted names, another schema spelling).
const MENTIONS = /create\s+(or\s+replace\s+)?function\s+[^(;]*is_reserved_channel_id[^(;]*\(/gi;

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.split("--")[0])
    .join("\n");
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

/** Every migration that defines the function, in order: the last one is the list in force. */
function definitions(): { file: string; sql: string }[] {
  return migrationFiles()
    .map((file) => ({ file, sql: stripComments(readFileSync(join(MIGRATIONS, file), "utf8")) }))
    .filter(({ sql }) => DEFINES.test(sql));
}

function newestDefinition(): { file: string; sql: string } {
  const defs = definitions();
  return defs[defs.length - 1];
}

/** The quoted words of the function's array literal. Throws when the body is not in the shape this test reads. */
function sqlWords(sql: string): string[] {
  const fn = sql.slice(sql.search(DEFINES));
  const end = fn.indexOf("$$;");
  if (end < 0) throw new Error("is_reserved_channel_id has no $$-quoted body the test can read");
  const array = /= any \(array\[([\s\S]*?)\]::text\[\]\)/.exec(fn.slice(0, end));
  if (!array) throw new Error("is_reserved_channel_id has no array literal the test can read");
  return [...array[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("reserved channel ids: the app and the database agree", () => {
  it("0217 is where the function is first defined", () => {
    expect(definitions()[0]?.file).toBe("0217_reserved_channel_ids.sql");
  });

  it("every definition of the function is one this test can read", () => {
    for (const file of migrationFiles()) {
      const sql = stripComments(readFileSync(join(MIGRATIONS, file), "utf8"));
      for (const m of sql.matchAll(MENTIONS)) {
        // A definition the tolerant pattern does not see would be a list nobody compares with the app's.
        expect(DEFINES.test(m[0]), `${file}: "${m[0]}" defines is_reserved_channel_id in a form the drift test cannot read`).toBe(true);
      }
      if (DEFINES.test(sql)) expect(() => sqlWords(sql), file).not.toThrow();
    }
  });

  it("the SQL list equals RESERVED_ROOT_SEGMENTS as a set", () => {
    const { file, sql } = newestDefinition();
    const words = sqlWords(sql);
    expect(new Set(words).size, `${file} lists a word twice`).toBe(words.length);
    expect([...new Set(words)].sort(), file).toEqual([...new Set<string>(RESERVED_ROOT_SEGMENTS)].sort());
  });

  it("the SQL list is all lowercase, because the function compares lower(id)", () => {
    for (const w of sqlWords(newestDefinition().sql)) expect(w).toBe(w.toLowerCase());
  });

  it("the language prefixes of the public site cannot be a channel id", () => {
    for (const id of ["en", "ru", "uz"]) {
      expect(RESERVED_ROOT_SEGMENTS).toContain(id);
      expect(isValidChannelId(id)).toBe(false);
    }
    // only the exact word is a page: an id that starts with one is an ordinary channel
    for (const id of ["russia", "ru-history", "uzbek-food", "english-tips"]) expect(isValidChannelId(id)).toBe(true);
  });
});
