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
 * The forms Breach found that the fix round of #956 did not catch (the interned model ids, the provider map as [slug, name]
 * entries or { slug, name } objects, model ids and prompts split at run time) are the PR 3 block below, each with a
 * legitimate look-alike that must stay clean. What the script still cannot catch is written in its header comment.
 */
const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "vendor-bundle-check.mjs");
// The signed-in screens' sources too (lib/providers.ts, lib/imageProviders.ts, …): the script reads its patterns from them.
const { SIGNED_IN_SOURCES, BANNED_LIST_MIN, MAP_PAIRS_MIN } = (await import("../scripts/vendor-bundle-check.mjs")) as {
  SIGNED_IN_SOURCES: string[];
  BANNED_LIST_MIN: number;
  MAP_PAIRS_MIN: number;
};
const SOURCES = [
  "lib/effects/effects.json",
  "lib/effects/catalog.ts",
  "lib/server/provider-names.ts",
  "lib/server/ledger-units.ts",
  ...SIGNED_IN_SOURCES,
];
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
const BANNED = [
  ...(readFileSync(path.join(CC, "lib/marketing-banned.ts"), "utf8").match(/export const BANNED_PROVIDER_NAMES[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
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
  writeFileSync(
    path.join(chunks, "70-desk.js"),
    'e("ul",{className:"fx-grid"});e("ul",{className:"cv-effects"});e("div",{id:"credit-prices"});' +
      'e("div",{className:"g2-key-field"});a=t.providers.routingAutopilot;b=t.create.voiceModelDropped;t="00B / Direct model provider review"',
  );
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

// PR 3: the forms #956 listed for the guard PR. Each is built from the real data, the way a minifier, a serializer or a
// refactor would write it.
const [M0, M1] = LONG.models;
const half = (id: string) => [id.slice(0, Math.ceil(id.length / 2)), id.slice(Math.ceil(id.length / 2))] as const;
const q = (v: string) => JSON.stringify(v);
// Two effect models that are NOT consecutive in any effect's order: a picker may list ids side by side in its own order.
const ALL_MODELS = [...new Set(EFFECTS.flatMap((e) => e.models))];
const follows = (a: string, b: string) => EFFECTS.some((e) => e.models.some((m, i) => m === a && e.models[i + 1] === b));
const UNORDERED = ALL_MODELS.flatMap((a) => ALL_MODELS.filter((b) => b !== a && !follows(a, b) && !follows(b, a)).map((b) => [a, b] as const))[0];
// The longest literal part of a prompt, cut into pieces shorter than the 30-character window.
const PART = LONG.prompt.split(/\{[^}]*\}/).sort((a, b) => b.length - a.length)[0];
const pieces = (text: string, n: number) => [...text.matchAll(new RegExp(`[\\s\\S]{1,${n}}`, "g"))].map((m) => m[0]);

describe("breach #956 / PR 3: forms vendor-bundle-check now catches (each must exit 1)", () => {
  const cases: [string, string, () => string][] = [
    [
      // Form 1, the todo's own example: each id interned in a variable, so no two quoted ids are adjacent.
      "interned model ids (var v0=…,v1=…; x=[v0,v1])",
      "static/chunks/200-interned.js",
      () => `var v0=${q(M0)},v1=${q(M1)};x=[v0,v1]`,
    ],
    ["an interned id next to a quoted one", "static/chunks/200-mixed.js", () => `var v0=${q(M0)};x={models:[v0,${q(M1)}]}`],
    [
      // Form 2: the whole display map as [slug, name] tuples.
      "the provider map as new Map([[slug, name], …])",
      "static/chunks/201-map.js",
      () => `P=new Map(${JSON.stringify(PROVIDERS.map(([k, v]) => [k, v]))})`,
    ],
    ["the provider map as Object.entries, serialized", "static/chunks/201-entries.js", () => `e=JSON.parse(${q(JSON.stringify(PROVIDERS))})`],
    [
      // Form 3: the display map as an array of objects, under the keys a refactor would pick.
      "the provider map as [{ slug, name }, …]",
      "static/chunks/202-objects.js",
      () => `L=${JSON.stringify(PROVIDERS.map(([slug, name]) => ({ slug, name })))}`,
    ],
    ["the provider map as [{ name, id }, …], name first", "static/chunks/202-objects-rev.js", () => `L=[${PROVIDERS.map(([k, v]) => `{name:${q(v)},id:${q(k)}}`).join(",")}]`],
    [
      // Form 4: runtime-split strings, the shapes a build can still evaluate.
      'model ids split into ["…","…"].join("")',
      "static/chunks/203-join.js",
      () => `x=[${JSON.stringify(half(M0))}.join(""),${JSON.stringify(half(M1))}.join("")]`,
    ],
    ["model ids split into a + chain", "static/chunks/203-plus.js", () => `x=[${half(M0).map(q).join("+")},${half(M1).map(q).join(" + ")}]`],
    ["a model id as a template literal over a literal", "static/chunks/203-tpl.js", () => `x=[\`${half(M0)[0]}\${${q(half(M0)[1])}}\`,${q(M1)}]`],
    ["a model id as a template literal over an interned piece", "static/chunks/203-tpl-var.js", () => `var s=${q(half(M0)[1])};x=[\`${half(M0)[0]}\${s}\`,${q(M1)}]`],
    ["the model order as one string, split at run time", "static/chunks/203-split.js", () => `o=${q(LONG.models.join(","))}.split(",")`],
    ["the model order as one space-separated string", "static/chunks/203-split-sp.js", () => `o=${q(LONG.models.join(" "))}.split(" ")`],
    // Lens L3: the same pieces inside a grouping paren.
    ["model ids joined inside a grouping paren", "static/chunks/203-paren.js", () => `x=[(${half(M0).map(q).join("+")}),${q(M1)}]`],
    ["a prompt cut into 12-character + pieces", "static/chunks/204-prompt.js", () => `p=${pieces(PART, 12).map(q).join("+")}`],
    ["a prompt cut into pieces and joined", "static/chunks/204-prompt-join.js", () => `p=${JSON.stringify(pieces(PART, 10))}.join("")`],
    [
      // C3: the marketing board's banned names, the vendors' own, as lib/marketing-banned.ts wrote them into the page chunk.
      "the marketing board's banned provider name list",
      "static/chunks/app/(app)/[channel]/marketing/page-x.js",
      () => `let a=${JSON.stringify(BANNED)};`,
    ],
    ["the banned names, in another order and case", "static/chunks/205-banned.js", () => `b=${JSON.stringify(BANNED.slice(0, BANNED_LIST_MIN).reverse().map((n) => n.toUpperCase()))}`],
    [
      // C1: the dictionary sentence that named the per-unit cost variable to every signed-in page.
      "the per-unit cost variable's prefix in dictionary copy",
      "static/chunks/3425-dict.js",
      () => 'advSpendOvUnpriced:"Some costs are quantities only — set CHRONOS_PRICE_<UNIT> for each provider and the dollar figures fill in."',
    ],
    [
      // C2: the Channels screens built the per-channel token secret's name in the browser.
      "the per-channel token secret's prefix building a name",
      "static/chunks/app/(app)/[channel]/channels/page-x.js",
      () => 'function s(e){return"CHRONOS_YT_TOKEN_"+e.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}',
    ],
  ];

  it.each(cases)("catches %s", (_label, rel, text) => {
    const root = fakeBuild();
    put(root, rel, text());
    const r = run(root);
    expect(r.out).not.toContain("clean");
    expect(r.code).toBe(1);
  });
});

describe("PR 3 negative controls: legitimate code that looks like those forms stays clean (each must exit 0)", () => {
  const cases: [string, () => string][] = [
    // A picker may intern ids; the routing is only an effect's own consecutive order.
    ["two interned model ids in an order no effect uses", () => `var a=${q(UNORDERED[0])},b=${q(UNORDERED[1])};x=[a,b]`],
    // A Studio model id is shown by design; assembling ONE id is not a model order.
    ["one model id assembled from pieces", () => `id=${half(M0).map(q).join("+")};y=\`${half(M1)[0]}\${${q(half(M1)[1])}}\``],
    // A minifier's ordinary output: class names, joins and templates over values known only at run time.
    ["ordinary concatenation, joins and templates", () => 'c="btn "+"btn-primary";k=["a","b"].join(" ");w=`${e}px`;u="/api/"+t+"/x";[n,r]=useState(0)'],
    // Destructuring a state pair is not an array of data, even when the names are bound once elsewhere.
    ["a destructuring target", () => `var e=${q(M0)};const[e2,t]=[1,2];[e,t]=f()`],
    // Copy naming a vendor or two (MAP_PAIRS_MIN), as entries or objects too.
    ["fewer than MAP_PAIRS_MIN self-named pairs as entries and objects", () => `m=new Map([["openai","OpenAI"]]);o=[{id:"google",name:"Google"}]`],
    // A model picker's makers: fewer than BANNED_LIST_MIN banned names side by side.
    ["fewer than BANNED_LIST_MIN banned names together", () => `k=${JSON.stringify(BANNED.slice(0, BANNED_LIST_MIN - 1))}`],
    // The dictionary's generic sentence that replaced the variable's name.
    ["the generic 'not priced yet' copy", () => 'advSpendOvUnpriced:"Some costs are quantities only: their price per unit is not set yet, so those dollar figures read as unknown, not zero."'],
    // The YouTube secrets the wizard still names for every viewer (#958) are not the per-channel prefix.
    ["a CHRONOS_ word that is not one of the prefixes", () => 's="CHRONOS_YT";t="MY_CHRONOS_PRICE_X"'],
    // Lens M1: a parameter that shadows a module-level name holds the caller's value, not the module's literal.
    ["a function parameter shadowing an interned id", () => `let n=${q(M0)};x.map(function(n,r){return[n,r]});let r=${q(M1)};`],
    ["an arrow parameter shadowing an interned id", () => `let n=${q(M0)};x.map((n,r)=>[n,r]);let r=${q(M1)};`],
    ["catch and for-of variables shadowing interned ids", () => `let e=${q(M0)},t=${q(M1)};try{f()}catch(e){g([e,t])}for(const t of y)h([e,t])`],
    ["a destructured name shadowing an interned id", () => `var a=${q(M0)},b=${q(M1)};function f(){const[a,b]=g();return[a,b]}`],
  ];

  it.each(cases)("%s", (_label, text) => {
    const root = fakeBuild();
    put(root, "static/chunks/300-legit.js", text());
    const r = run(root);
    expect(r.out).toContain("clean");
    expect(r.code).toBe(0);
  });

  it("the fixtures use real data: a non-routing pair exists and the banned list is read", () => {
    expect(UNORDERED).toBeTruthy();
    expect(BANNED.length).toBeGreaterThanOrEqual(BANNED_LIST_MIN * 5);
    // Names, not the rules' regular expressions read by a regex that missed the list.
    expect(BANNED.every((n) => /^[a-z][a-z .-]*$/.test(n))).toBe(true);
    expect(PART.length).toBeGreaterThan(40);
    expect(MAP_PAIRS_MIN).toBeGreaterThan(1);
  });
});

// SW3-1: what the compiler actually writes. next's own SWC, at this build's browser target, turns a template literal into
// .concat(); each source below is compiled here, so the guard is tested against the compiler's output, not a guess at it.
const { transform } = (await import("next/dist/build/swc")) as unknown as {
  transform: (src: string, opts: Record<string, unknown>) => Promise<{ code: string }>;
};
const swc = async (src: string) =>
  (await transform(src, { jsc: { target: "es5", parser: { syntax: "ecmascript" }, minify: { compress: true, mangle: true } }, minify: true, module: { type: "es6" } }))
    .code;
const bt = (s: string) => "`" + s + "`";

describe("SW3-1: sources compiled by next's SWC (each must exit 1)", () => {
  const [slug, name] = PROVIDERS.find(([k, v]) => v.toLowerCase().replace(/[^a-z0-9]/g, "") !== k)!;
  const cases: [string, string][] = [
    ["the per-unit cost prefix from a template", `const KIND="PRICE"; export const priceEnvVar=(u)=>${bt("CHRONOS_${KIND}_${u.toUpperCase()}")};`],
    ["the token secret prefix from a template", `const P="YT_TOKEN"; export const s=(e)=>${bt("CHRONOS_${P}_${e}")};`],
    ["an effect's order with an id from a template", `const MAKER=${q(half(M0)[0])}; export const ORDER=[${bt("${MAKER}" + half(M0)[1])},${q(M1)}];`],
    ["a provider pair whose name comes from a template", `const A=${q(half(name)[0])}; export const M={${slug}:${bt("${A}" + half(name)[1])}};`],
  ];
  it.each(cases)("catches %s", async (_label, src) => {
    const code = await swc(src);
    expect(code).toContain(".concat(");
    const root = fakeBuild();
    put(root, "static/chunks/500-swc.js", code);
    const r = run(root);
    expect(r.out).not.toContain("clean");
    expect(r.code).toBe(1);
  });

  it("and an ordinary compiled template stays clean (exit 0)", async () => {
    const root = fakeBuild();
    put(root, "static/chunks/500-swc.js", await swc(`export const c=(s,n)=>[${bt("btn-${s}")},${bt("/api/videos/${n}")}];`));
    expect(run(root).code).toBe(0);
  });
});
