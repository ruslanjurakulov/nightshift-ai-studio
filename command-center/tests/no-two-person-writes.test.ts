/**
 * The two-person publish rule (channels.agent_config.require_two_person_publish)
 * is not offered to customers (docs/security/LEDGER.md, lead 1). The backend gate
 * still honours the flag where it is already set, but nothing in the app may
 * write it. Every UI write of agent_config merges into the live config (so an
 * existing value is carried through untouched) and never names the key.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const KEY = /require_two_person_publish/;
// The type declaration documents the key as read-only; nothing else may name it.
const ALLOWED = new Set(["lib/types.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("require_two_person_publish is never written by the app", () => {
  it("no app, component or lib source names the key (except the read-only type)", () => {
    const hits = ["app", "components", "lib"]
      .flatMap((d) => walk(join(ROOT, d)))
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => KEY.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("no i18n string in any language offers the two-person switch", () => {
    for (const f of ["en", "ru", "uz"]) {
      const src = readFileSync(join(ROOT, "lib/i18n", `${f}.ts`), "utf8");
      expect(src, f).not.toMatch(/requireToggle|requireUnknown|requireOn:|requireOff:/);
    }
  });
});
