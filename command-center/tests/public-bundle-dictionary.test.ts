import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No page a signed-out visitor can open ships the signed-in app's dictionary to the browser.
 *
 * lib/i18n/index.ts imports all three dictionaries (every screen of the app, in en/ru/uz, with the operator's setup
 * notes), so a single client component on a public page that took `fmt` from "@/lib/i18n" instead of
 * "@/lib/i18n/core" put about 2 MB of the whole app's copy into /pricing's JavaScript. That is what this catches: it
 * walks the import graph from every public route's entry files, follows the server/client boundary ("use client"), and
 * fails if client code reaches the full dictionaries or the app's provider (which imports them).
 *
 * scripts/public-bundle-check.mjs checks the same thing on the built output (frontend.yml runs it after `next build`);
 * this one runs with the unit tests and names the import chain to fix.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "app");

/** The modules that carry, or load, every dictionary. lib/i18n/core.ts and public-context.tsx are the public ones. */
const FULL_DICTIONARY = new Set(
  ["lib/i18n/index.ts", "lib/i18n/en.ts", "lib/i18n/ru.ts", "lib/i18n/uz.ts", "lib/i18n/context.tsx", "lib/i18n/dev.ts"].map((f) =>
    path.join(ROOT, f),
  ),
);

/**
 * Route folders under app/ that are not public. (app) is the signed-in app; api holds route handlers, which have no
 * client bundle; /welcome is the first run of a signed-in account (its page sends anyone signed out to /login before
 * rendering, and its layout mounts the app's providers on purpose). scripts/public-bundle-check.mjs skips the same three.
 */
const SIGNED_IN_ROOTS = new Set(["(app)", "api", "welcome"]);

/**
 * The one allowed way in, with its reason: the root error boundary replaces the root layout and so loses the public
 * slice the layout provides; it fetches the words only when it shows (a dynamic import), never with the page.
 */
const ALLOWED_DYNAMIC = new Set([`${path.join(APP, "global-error.tsx")} -> @/lib/i18n`]);

const ENTRY = /^(page|layout|template|loading|error|not-found|global-error|default)\.(tsx|ts|jsx|js)$/;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package: not our dictionaries
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  for (const ext of EXTENSIONS) if (existsSync(path.join(base, `index${ext}`))) return path.join(base, `index${ext}`);
  return null;
}

// Static `import … from`, `export … from`, a bare `import "x"`, and `import("x")`. Type-only imports are erased by the
// compiler and ship nothing, so `import type …` and an import whose every name is `type X` are skipped.
const IMPORT_RE =
  /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

type Edge = { spec: string; dynamic: boolean };

const sourceCache = new Map<string, string>();
function source(file: string): string {
  let s = sourceCache.get(file);
  if (s === undefined) {
    s = readFileSync(file, "utf8");
    sourceCache.set(file, s);
  }
  return s;
}

function importsOf(file: string): Edge[] {
  const out: Edge[] = [];
  for (const m of source(file).matchAll(IMPORT_RE)) {
    if (m[3]) {
      if (m[1]) continue;
      const names = /^\{([\s\S]*)\}$/.exec(m[2].trim());
      const parts = names?.[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (parts && parts.length > 0 && parts.every((s) => s.startsWith("type "))) continue;
      out.push({ spec: m[3], dynamic: false });
    } else if (m[4]) out.push({ spec: m[4], dynamic: false });
    else if (m[5]) out.push({ spec: m[5], dynamic: true });
  }
  return out;
}

function hasDirective(file: string, directive: string): boolean {
  return new RegExp(`^(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*["']${directive}["']`).test(source(file));
}

function routeEntries(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) routeEntries(p, out);
    else if (ENTRY.test(entry.name)) out.push(p);
  }
  return out;
}

function publicEntries(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(APP, { withFileTypes: true })) {
    const p = path.join(APP, entry.name);
    if (entry.isDirectory()) {
      if (!SIGNED_IN_ROOTS.has(entry.name)) routeEntries(p, out);
    } else if (ENTRY.test(entry.name)) out.push(p);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f);

/**
 * Every module that ends up in the browser from these entries, with the chain that got it there. A server module is
 * followed (it may render a client component) but is not itself client code; everything a "use client" module imports
 * is. A "use server" module imported from the client is a reference to a server action, not code in the bundle.
 */
function clientGraph(entries: string[]) {
  const via = new Map<string, string | null>(); // `${file}|${client}` -> who imported it
  const leaks: string[][] = [];
  const stack: [string, boolean, string | null][] = entries.map((f) => [f, false, null]);
  const chain = (key: string | null): string[] => {
    const out: string[] = [];
    for (let k = key; k; k = via.get(k) ?? null) out.unshift(rel(k.slice(0, k.lastIndexOf("|"))));
    return out;
  };
  while (stack.length > 0) {
    const [file, parentClient, from] = stack.pop()!;
    const client = parentClient || hasDirective(file, "use client");
    const key = `${file}|${client}`;
    if (via.has(key)) continue;
    via.set(key, from);
    if (client && hasDirective(file, "use server")) continue;
    for (const edge of importsOf(file)) {
      const target = resolveImport(file, edge.spec);
      if (!target || !/\.(?:[jt]sx?|mjs)$/.test(target)) continue;
      // Imported from client code, or a client module itself: either way it is in the browser bundle.
      const targetClient = client || hasDirective(target, "use client");
      if (targetClient && FULL_DICTIONARY.has(target)) {
        if (edge.dynamic && ALLOWED_DYNAMIC.has(`${file} -> ${edge.spec}`)) continue;
        leaks.push([...chain(key), rel(target)]);
        continue;
      }
      stack.push([target, client, key]);
    }
  }
  const clientFiles = new Set([...via.keys()].filter((k) => k.endsWith("|true")).map((k) => rel(k.slice(0, k.lastIndexOf("|")))));
  return { leaks, clientFiles };
}

describe("public pages' client bundles", () => {
  const entries = publicEntries();
  const { leaks, clientFiles } = clientGraph(entries);

  it("never reach the signed-in app's dictionaries (import from @/lib/i18n/core and the public slice instead)", () => {
    expect(leaks.map((c) => c.join("\n  -> "))).toEqual([]);
  });

  it("covers the public pages the audit named, so the check above is not vacuous", () => {
    const routes = new Set(entries.map((f) => rel(path.dirname(f))));
    for (const route of ["app", "app/pricing", "app/login", "app/signup", "app/forgot-password", "app/reset-password", "app/invite", "app/trust", "app/mcp", "app/roadmap", "app/referral", "app/solutions", "app/studio", "app/privacy", "app/terms", "app/refund", "app/docs/api", "app/oauth/authorize"]) {
      expect(routes, route).toContain(route);
    }
    // The pricing page's interactive parts are seen as client code, through the server page that renders them.
    for (const file of ["components/pricing/PlanFinder.tsx", "components/pricing/PlanMatrix.tsx", "components/pricing/PackCards.tsx", "lib/i18n/public-context.tsx"]) {
      expect(clientFiles, file).toContain(file);
    }
  });

  it("would catch it: the signed-in app's layout does reach them", () => {
    const app = clientGraph([path.join(APP, "(app)", "layout.tsx")]);
    expect(app.leaks.length).toBeGreaterThan(0);
  });
});
