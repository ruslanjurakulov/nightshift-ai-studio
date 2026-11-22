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
const DEFINES = /create or replace function public\.is_reserved_channel_id\(/;

/** The newest migration that defines the function: a later one that widens the list is the one in force. */
function newestDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const defining = files.filter((f) => DEFINES.test(readFileSync(join(MIGRATIONS, f), "utf8")));
  const file = defining[defining.length - 1];
  return { file, sql: readFileSync(join(MIGRATIONS, file), "utf8") };
}

/** The quoted words of the function's array literal, comments dropped. */
function sqlWords(sql: string): string[] {
  const code = sql
    .split("\n")
    .map((l) => l.split("--")[0])
    .join("\n");
  const fn = code.slice(code.search(DEFINES));
  const body = fn.slice(0, fn.indexOf("\n$$;"));
  const array = /= any \(array\[([\s\S]*?)\]::text\[\]\)/.exec(body);
  if (!array) throw new Error("is_reserved_channel_id has no array literal the test can read");
  return [...array[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("reserved channel ids: the app and the database agree", () => {
  it("0217 is where the function is first defined", () => {
    expect(readFileSync(join(MIGRATIONS, "0217_reserved_channel_ids.sql"), "utf8")).toMatch(DEFINES);
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
