import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Breach, PR #956: can an effect's model order or prompt, the provider display map or the ledger's vendor-named unit list
 * reach a browser while scripts/vendor-bundle-check.mjs still prints "clean"? Each case lays out a stand-in `.next` the way
 * `next build` does, puts one copy of the data in it in a shape a build, a page or the product's own code produces, and runs
 * the real script. Exit 0 on a leak is the hole: CI is green and the data ships.
 *
 * The forms marked SHIPS are not hypothetical: the product writes them today (a filled effect prompt is what canvasEffects
 * hands the Studio; the ledger units as dictionary keys are lib/creditUnits.ts FIXED, in the /credits page chunk of this
 * very build). The others are what a serializer or a later refactor writes. Controls first, so a red case cannot be a
 * harness that never ran the script.
 *
 * Three forms Breach found are not caught by the fix round of #956 and are not tests here (a skipped test is a test that
 * says nothing): the interned model ids, and the provider map as [slug, name] entries or { slug, name } objects. They are
 * listed for the guard PR in tests/security-vendor-bundle-check-pr3.todo.md.
 */
const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "vendor-bundle-check.mjs");
const SOURCES = ["lib/effects/effects.json", "lib/effects/catalog.ts", "lib/server/provider-names.ts", "lib/server/ledger-units.ts"];
const roots: string[] = [];

type Fx = { id: string; models: string[]; prompt: string; slotHint: string | null };
const EFFECTS = JSON.parse(readFileSync(path.join(CC, "lib/effects/effects.json"), "utf8")).effects as Fx[];
const byId = (id: string) => EFFECTS.find((e) => e.id === id)!;
// The longest preference list: its first two models, in order, are the routing a partial copy gives away.
const LONG = [...EFFECTS].sort((a, b) => b.models.length - a.models.length)[0];
// A words effect whose {subject} slot is inside the first 60 characters: the only part of a prompt the guard looks for.
const EARLY_SLOT = EFFECTS.find((e) => e.prompt.includes("{subject}") && e.prompt.indexOf("{subject}") < 60)!;

const PROVIDERS = [...readFileSync(path.join(CC, "lib/server/provider-names.ts"), "utf8").matchAll(/^\s*([a-z0-9_]+):\s*"([^"]+)",/gm)].map(
  (m) => [m[1], m[2]] as const,
);
const UNITS = [...readFileSync(path.join(CC, "lib/server/ledger-units.ts"), "utf8").matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);

function fakeBuild(): string {
  const root = mkdtempSync(path.join(tmpdir(), "breach-956-"));
  roots.push(root);
  for (const rel of SOURCES) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    copyFileSync(path.join(CC, rel), path.join(root, rel));
  }
  const chunks = path.join(root, ".next", "static", "chunks");
  mkdirSync(path.join(chunks, "app", "pricing"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(path.join(chunks, `${i}-filler.js`), `self.x${i}={a:1,b:"ok"};`);
  writeFileSync(path.join(chunks, "app", "pricing", "page-def.js"), "self.p=1;");
  writeFileSync(path.join(chunks, "70-desk.js"), 'e("ul",{className:"fx-grid"});e("ul",{className:"cv-effects"});e("div",{id:"credit-prices"})');
  mkdirSync(path.join(root, ".next", "server", "app"), { recursive: true });
  writeFileSync(path.join(root, ".next", "server", "app", "_not-found.html"), "<html>404</html>");
  return root;
}

const put = (root: string, rel: string, text: string) => {
  const file = path.join(root, ".next", rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const run = (root: string) => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("breach #956: vendor-bundle-check controls", () => {
  it("the harness runs the real script: a clean stand-in build passes and the shipped form fails", () => {
    expect(run(fakeBuild()).code).toBe(0);
    const root = fakeBuild();
    put(root, "static/chunks/155-a.js", `m=${JSON.stringify(LONG.models)}`);
    expect(run(root).code).toBe(1);
  });

  it("held: a lazy chunk with an odd name is scanned like any other .js under static/", () => {
    const root = fakeBuild();
    put(root, "static/chunks/9182.4af0c1d2e3b4a5f6.js", `(self.webpackChunk=self.webpackChunk||[]).push([[9182],{1:(e)=>{e.x=${JSON.stringify(LONG.models)}}}]);`);
    expect(run(root).code).toBe(1);
  });

  it("accepted by design: one or two self-named provider pairs are copy, not the map (MAP_PAIRS_MIN = 3)", () => {
    const root = fakeBuild();
    put(root, "static/chunks/80-copy.js", 'c={openai:"OpenAI",google:"Google"}');
    expect(run(root).code).toBe(0);
  });
});

describe("breach #956: forms vendor-bundle-check misses (each must exit 1)", () => {
  const cases: [string, string, () => string][] = [
    [
      // SHIPS: fillPrompt(effect, "") puts the slot hint where {subject} was, and canvasEffects hands that prefill to the Studio.
      // For an effect whose slot is in the first 60 characters, the 60-character needle never matches the filled prompt.
      "a filled prompt (slot hint in place of {subject}), as canvasEffects/effectPrefill write it",
      "static/chunks/155-filled.js",
      () => `p=${JSON.stringify(EARLY_SLOT.prompt.replace("{subject}", EARLY_SLOT.slotHint ?? "[subject]"))}`,
    ],
    [
      // The template cut at its slot, as isEffectPrompt splits it: the tail is most of the prompt and the head is under 60.
      "the template split at {subject} into head and tail",
      "static/chunks/155-split.js",
      () => `t=${JSON.stringify(EARLY_SLOT.prompt.split("{subject}"))}`,
    ],
    [
      // The first two choices of the longest list: the routing, without the full array the regex wants.
      "a prefix of an effect's model order (first and second choice)",
      "static/chunks/155-prefix.js",
      () => `r=${JSON.stringify(LONG.models.slice(0, 2))}`,
    ],
    [
      // A JSON string prop inside an RSC row inside the HTML's flight script: quotes are escaped twice, the guard unescapes once.
      "a doubly escaped JSON string in a prerendered page's flight data",
      "server/app/index.html",
      () => {
        const row = `5:${JSON.stringify({ cfg: JSON.stringify({ models: LONG.models }) })}`;
        return `<script>self.__next_f.push(${JSON.stringify([1, row])})</script>`;
      },
    ],
    [
      // JSON in an HTML attribute (data-*, a serialized prop): React writes " as &quot;.
      "HTML-entity-escaped JSON in a prerendered page's attribute",
      "server/app/pricing.html",
      () => `<div data-cfg="${JSON.stringify({ models: LONG.models }).replace(/"/g, "&quot;")}"></div>`,
    ],
    [
      // SHIPS: lib/creditUnits.ts FIXED keys every ledger unit, in LEDGER_UNITS order, and is in the /credits page chunk
      // (CreditPricesEditor, OwnerPriceHistory). The guard exempts `unit:"label"` as a dictionary, so the full list passes.
      "every ledger unit as dictionary keys (lib/creditUnits.ts FIXED)",
      "static/chunks/app/(app)/[channel]/credits/page-abc.js",
      () => `const F={video_minute:"videoMinute",job_minimum:"jobMinimum",${UNITS.map((u) => `${u}:"x"`).join(",")}}`,
    ],
    [
      "the ledger unit list as one split string",
      "static/chunks/743-split.js",
      () => `o=${JSON.stringify(UNITS.join(" "))}.split(" ")`,
    ],
    [
      // A prerendered route handler's response (.next/server/app/<route>.body, e.g. a force-static /api/effects) is served to
      // anyone at its URL; the guard reads only .html and .rsc under server/.
      "a prerendered route handler body (.body) under server/app",
      "server/app/api/effects.body",
      () => JSON.stringify({ effects: [{ id: LONG.id, models: LONG.models, prompt: LONG.prompt }] }),
    ],
  ];

  it.each(cases)("catches %s", (_label, rel, text) => {
    const root = fakeBuild();
    put(root, rel, text());
    const r = run(root);
    expect(r.out).not.toContain("clean");
    expect(r.code).toBe(1);
  });

  it("the fixtures use real data: the early-slot effect and the long list exist", () => {
    expect(EARLY_SLOT.prompt.indexOf("{subject}")).toBeLessThan(60);
    expect(LONG.models.length).toBeGreaterThanOrEqual(3);
    expect(byId(LONG.id)).toBeTruthy();
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(8);
    expect(UNITS.length).toBeGreaterThanOrEqual(5);
  });
});
