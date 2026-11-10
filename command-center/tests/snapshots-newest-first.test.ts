/**
 * A page that reads metrics_snapshots with a row limit must ask for the newest rows first.
 * Without an order the server decides which rows the limit keeps, and a video's latest reading can be the one cut away.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "tests") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Each read of the table: the text from `.from("metrics_snapshots")` to the end of its statement or array element. */
function reads(text: string): string[] {
  const found: string[] = [];
  const marker = '.from("metrics_snapshots")';
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    let depth = 0;
    let end = at;
    for (; end < text.length; end += 1) {
      const c = text[end];
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if ((c === "," || c === ";") && depth === 0) break;
    }
    found.push(text.slice(at, end));
  }
  return found;
}

describe("metrics_snapshots reads with a row limit", () => {
  const limited = [join(ROOT, "app"), join(ROOT, "lib")]
    .flatMap((dir) => sources(dir))
    .flatMap((path) => reads(readFileSync(path, "utf8")).map((read) => ({ path: path.slice(ROOT.length + 1), read })))
    .filter(({ read }) => read.includes(".limit("));

  it("finds the readers it is meant to check", () => {
    const files = new Set(limited.map(({ path }) => path));
    expect(files).toContain("app/(app)/[channel]/analytics/page.tsx");
    expect(files).toContain("app/(app)/[channel]/measurement/page.tsx");
    expect(limited.length).toBeGreaterThanOrEqual(6);
  });

  it.each(limited)("$path asks for the newest rows before it limits them", ({ read }) => {
    const order = read.indexOf('.order("snapshot_date", { ascending: false })');
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(read.indexOf(".limit("));
  });
});
