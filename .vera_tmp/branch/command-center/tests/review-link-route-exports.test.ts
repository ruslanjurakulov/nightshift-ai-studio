import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `next build` refuses a route.ts that exports anything but HTTP handlers and
 * the route config fields (it fails the type check, which `tsc` does not run on
 * this rule), and a page.tsx that exports anything else than the page, its
 * config and metadata. This pins the review link's files to those lists.
 */
const ROUTE_ALLOWED = new Set([
  "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS",
  "runtime", "dynamic", "revalidate", "maxDuration", "fetchCache", "preferredRegion", "dynamicParams", "generateStaticParams",
]);
const PAGE_ALLOWED = new Set([
  "default", "metadata", "generateMetadata", "dynamic", "revalidate", "runtime", "maxDuration", "fetchCache", "preferredRegion",
  "dynamicParams", "generateStaticParams", "viewport", "generateViewport",
]);

function exportsOf(file: string): string[] {
  const src = readFileSync(join(__dirname, "..", file), "utf8");
  const names: string[] = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  if (/^export\s+default\b/m.test(src)) names.push("default");
  if (/^export\s*\{/m.test(src) || /^export\s+(?:type|interface|enum)\b/m.test(src)) names.push("<re-export, type or enum>");
  return names;
}

describe("review link route and page files export only what Next allows", () => {
  for (const f of ["app/api/review-links/route.ts", "app/api/review-links/[id]/route.ts", "app/r/[token]/video/route.ts"]) {
    it(f, () => {
      const bad = exportsOf(f).filter((n) => !ROUTE_ALLOWED.has(n));
      expect(bad).toEqual([]);
    });
  }
  it("app/r/[token]/page.tsx", () => {
    const bad = exportsOf("app/r/[token]/page.tsx").filter((n) => !PAGE_ALLOWED.has(n));
    expect(bad).toEqual([]);
  });
});
