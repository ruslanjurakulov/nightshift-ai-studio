import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Breach, PR #952: can the showcase manifest's private fields (vendor, vendor model, preview flag, file hash, maker's credit) reach
 * a browser while scripts/showcase-bundle-check.mjs still says "none carries"? Each case builds a stand-in `.next` the way
 * `next build` lays one out, puts one leak in it in a shape the build really produces, and runs the real script on it. The script
 * exiting 0 on a leak is the hole: CI is green and the data ships.
 *
 * The controls come first, so a pass of the holes cannot be a harness that never ran the script.
 */

const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "showcase-bundle-check.mjs");
const DATA = path.join(CC, "lib", "site", "showcase.json");
const REGISTRY = path.join(CC, "..", "schemas", "model_registry.json");

type Entry = { jobId: string; sha256: string; assetId?: string; provider: string; attribution?: { text: string } | null; cost?: { vendor?: { vendorModel: string }[] } };
const ENTRIES: Entry[] = JSON.parse(readFileSync(DATA, "utf8")).entries;
const E = ENTRIES.find((e) => e.attribution && e.cost?.vendor?.length) ?? ENTRIES[0];
const VENDOR_MODEL = E.cost?.vendor?.[0]?.vendorModel ?? "gen4.5";
const CREDIT = E.attribution?.text ?? "Powered by Runway";

// What SHOWCASE_CARDS minifies to in a public chunk: the script's positive control looks for it.
const SLICE = `const c=[{jobId:"${E.jobId}",modelId:"x",capability:"t2v",kind:"video",width:1,height:1,slot:null,input:{kind:"none"}}];`;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * A stand-in build: `public` is the chunk / loads, `studio` the chunk /{channel}/create loads, `lazy` a chunk no page lists (what an
 * `import()` or next/dynamic in a client component becomes), `server` files under .next/server/app (prerendered HTML and RSC).
 */
function run(parts: { public?: string; studio?: string; lazy?: string; server?: Record<string, string> }): number {
  const root = mkdtempSync(path.join(os.tmpdir(), "breach-952-"));
  roots.push(root);
  const cc = path.join(root, "cc");
  mkdirSync(path.join(cc, "lib", "site"), { recursive: true });
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  cpSync(DATA, path.join(cc, "lib", "site", "showcase.json"));
  cpSync(REGISTRY, path.join(root, "schemas", "model_registry.json"));
  const chunks = path.join(cc, ".next", "static", "chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(path.join(chunks, "1111-pub.js"), SLICE + (parts.public ?? ""));
  writeFileSync(path.join(chunks, "2222-studio.js"), parts.studio ?? "");
  writeFileSync(path.join(chunks, "7575.lazy.js"), parts.lazy ?? "");
  writeFileSync(
    path.join(cc, ".next", "app-build-manifest.json"),
    JSON.stringify({ pages: { "/page": ["static/chunks/1111-pub.js"], "/(app)/[channel]/create/page": ["static/chunks/2222-studio.js"] } }),
  );
  for (const [rel, body] of Object.entries(parts.server ?? {})) {
    const p = path.join(cc, ".next", "server", "app", rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return spawnSync(process.execPath, [SCRIPT], { cwd: cc, encoding: "utf8" }).status ?? -1;
}

describe("showcase-bundle-check: controls (the harness runs the real script)", () => {
  it("passes a clean build that ships only the slice", () => {
    expect(run({})).toBe(0);
  });

  it("fails the JSON-import shape in a public chunk (webpack's JSON.parse('…'))", () => {
    expect(run({ public: `e.exports=JSON.parse('{"entries":[{"provider":"${E.provider}","vendorModel":"${VENDOR_MODEL}"}]}')` })).toBe(1);
  });

  it("fails a minified literal in a public page's own chunk", () => {
    expect(run({ public: `const v={jobId:"${E.jobId}",provider:"${E.provider}",operatorPreview:!0};` })).toBe(1);
  });
});

describe("showcase-bundle-check: evasions (each a leak the check passes)", () => {
  it("HOLE: a lazily loaded chunk (import() / next/dynamic from a public client component) is never read by checks 2 and 3", () => {
    // A public page's dynamic chunk is in no page's list in app-build-manifest.json; check 1 reads it but only for `"field":`.
    expect(run({ lazy: `const v={provider:"${E.provider}",vendorModel:"${VENDOR_MODEL}",sha256:"${E.sha256}",operatorPreview:!0,t:${JSON.stringify(CREDIT)}};` })).toBe(1);
  });

  it("HOLE: the Studio's chunk (any signed-up account's browser) is checked for quoted JSON keys only", () => {
    expect(run({ studio: `const v={provider:"${E.provider}",vendorModel:"${VENDOR_MODEL}",sha256:"${E.sha256}"},a=${JSON.stringify(CREDIT)};` })).toBe(1);
  });

  it("HOLE: a file hash or asset id under another key (or none) passes: no check looks at the manifest's values", () => {
    expect(run({ public: `const h=["${E.sha256}"],x={hash:"${E.sha256}",asset:"${E.assetId ?? E.sha256}"};` })).toBe(1);
  });

  it("HOLE: the JSON shape inside a double-quoted string (\\\"provider\\\":) passes check 1 and check 2", () => {
    expect(run({ public: `const r=JSON.parse("{\\"provider\\":\\"${E.provider}\\",\\"vendorModel\\":\\"${VENDOR_MODEL}\\"}");` })).toBe(1);
  });

  it("HOLE: a full entry in a prerendered page's RSC payload or HTML (a Server Component handing an entry to a Client Component) is never scanned", () => {
    const flight = `1:["$","div",null,{"children":["$","$L2",null,{"entry":${JSON.stringify(E)}}]}]`;
    expect(run({ server: { "solutions/creative-studio.rsc": flight, "solutions/creative-studio.html": `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>` } })).toBe(1);
  });
});

describe("the server-only guard has no side door (holds today; keeps holding)", () => {
  it("nothing but lib/site/showcase.ts imports the data file: a direct JSON import skips `server-only` entirely", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && /["'][^"']*site\/showcase\.json["']/.test(readFileSync(p, "utf8"))) hits.push(path.relative(CC, p));
      }
    };
    for (const d of ["app", "components", "lib"]) walk(path.join(CC, d));
    expect(hits).toEqual(["lib/site/showcase.ts"]);
  });
});
