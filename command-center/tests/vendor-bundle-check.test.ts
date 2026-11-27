import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/vendor-bundle-check.mjs against a fake `.next` tree. The real sources are copied in (effects.json and its catalog,
 * the provider map, the ledger units), so the values the script looks for are the real ones. Each leak form here is one that
 * shipped (the minified effects catalog, the minified provider map, the unit array) or one a narrower check would miss.
 */
const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "vendor-bundle-check.mjs");
const SOURCES = ["lib/effects/effects.json", "lib/effects/catalog.ts", "lib/server/provider-names.ts", "lib/server/ledger-units.ts"];
const roots: string[] = [];

const effects = JSON.parse(readFileSync(path.join(CC, "lib/effects/effects.json"), "utf8")).effects as { id: string; models: string[]; prompt: string }[];

function fakeBuild(over: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "vendor-check-"));
  roots.push(root);
  for (const rel of SOURCES) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    if (rel in over) writeFileSync(path.join(root, rel), over[rel]);
    else copyFileSync(path.join(CC, rel), path.join(root, rel));
  }
  const chunks = path.join(root, ".next", "static", "chunks");
  mkdirSync(path.join(chunks, "app", "pricing"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(path.join(chunks, `${i}-filler.js`), `self.x${i}={a:1,b:"ok"};`);
  writeFileSync(path.join(chunks, "app", "pricing", "page-def.js"), "self.p=1;");
  // The screens the positive control looks for.
  writeFileSync(path.join(chunks, "70-desk.js"), 'e("ul",{className:"fx-grid"});e("ul",{className:"cv-effects"});e("div",{id:"credit-prices"})');
  mkdirSync(path.join(root, ".next", "server", "pages"), { recursive: true });
  writeFileSync(path.join(root, ".next", "server", "pages", "500.html"), "<html>500</html>");
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

const e0 = [...effects].sort((a, b) => b.models.length - a.models.length)[0];
const FILLED = effects.find((e) => e.prompt.includes("{subject}"))!;

describe("vendor-bundle-check", () => {
  it("passes a clean build, and what the site may show is not a leak", () => {
    const root = fakeBuild();
    // A model's display name and id alone (the Studio picker names models by design), one vendor name in some copy, a dictionary
    // that labels a vendor-free unit, and an effect's id and colours.
    put(root, "static/chunks/77-ok.js", 'm={id:"runway-gen4.5",name:"Runway Gen-4.5"};c={runway:"Runway"};u={tts_characters:"TTS characters"};f={id:"photo-to-life",hues:["#f6d365","#fda085"]}');
    const r = run(root);
    expect(r.out).toContain("clean");
    expect(r.code).toBe(0);
  });

  it.each([
    ["the minified effects catalog", "static/chunks/155-a.js", `{id:"${e0.id}",models:${JSON.stringify(e0.models)}}`, `effect ${e0.id} model order`],
    ["single-quoted with spaces", "static/chunks/155-b.js", `x=[${e0.models.map((m) => `'${m}'`).join(", ")}]`, `effect ${e0.id} model order`],
    ["an escaped JSON string", "static/chunks/155-c.js", `JSON.parse("{\\"models\\":${JSON.stringify(e0.models).replace(/"/g, '\\"')}}")`, `effect ${e0.id} model order`],
    ["an effect's prompt", "static/chunks/155-d.js", `p=${JSON.stringify(e0.prompt)}`, `effect ${e0.id} prompt`],
    ["the minified provider map", "static/chunks/674-a.js", 'F={openai:"OpenAI",anthropic:"Anthropic",google:"Google",bfl:"Black Forest Labs"}', "provider display map"],
    ["three quoted pairs of the map", "static/chunks/674-b.js", '{"openai":"OpenAI","kling":"Kling","luma":"Luma"}', "provider display map"],
    ["the one pair only the map holds", "static/chunks/674-c.js", "x={bfl:'Black Forest Labs'}", "provider display map"],
    ["the ledger unit list", "static/chunks/743-a.js", 'o=["gemini_input_tokens","gemini_output_tokens","tts_characters"]', "ledger unit list"],
    ["a lazy chunk no manifest lists", "static/chunks/9999-lazy.js", 'o=["pexels_requests","upload_bytes"]', "ledger unit list"],
    ["a prerendered .rsc payload", "server/app/index.rsc", `1:{"models":${JSON.stringify(e0.models)}}`, `effect ${e0.id} model order`],
    ["two consecutive choices only", "static/chunks/155-e.js", `r=${JSON.stringify(e0.models.slice(1, 3))}`, `effect ${e0.id} model order`],
    ["a filled prompt", "static/chunks/155-f.js", `p=${JSON.stringify(FILLED.prompt.replace("{subject}", "a red fox"))}`, `effect ${FILLED.id} prompt`],
    ["HTML-entity JSON", "server/app/x.html", `<i data-x="${JSON.stringify({ m: e0.models }).replace(/"/g, "&#34;")}">`, `effect ${e0.id} model order`],
    ["a thrice-escaped JSON string", "static/chunks/155-g.js", JSON.stringify(JSON.stringify(JSON.stringify({ m: e0.models }))), `effect ${e0.id} model order`],
    ["a route handler .body", "server/app/api/x.body", JSON.stringify({ m: e0.models }), `effect ${e0.id} model order`],
    ["a vendor-named unit as a dictionary key", "static/chunks/3425-a.js", 'units:{gemini_input_tokens:"tokens"}', "vendor-named ledger unit gemini_input_tokens"],
    ["a vendor-named unit inside a longer string", "static/chunks/3425-b.js", '"unit pexels_requests is unpriced"', "vendor-named ledger unit pexels_requests"],
  ])("fails on %s", (_label, rel, text, expected) => {
    const root = fakeBuild();
    put(root, rel, text);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(expected);
  });

  it("reads every effect from effects.json: each one's model order is caught", () => {
    for (const e of effects.filter((x) => x.models.length > 1)) {
      const root = fakeBuild();
      put(root, "static/chunks/1-e.js", `m=${JSON.stringify(e.models)}`);
      expect(run(root).out, e.id).toContain(`effect ${e.id} model order`);
    }
  });

  it("says plainly when no app page was prerendered, and does not count an error page as one", () => {
    const r = run(fakeBuild());
    expect(r.code).toBe(0);
    expect(r.out).toContain("(0 app pages prerendered)");
  });

  it("does not scan the server's own code under server/app (it legitimately holds the catalog)", () => {
    const root = fakeBuild();
    put(root, "server/app/(app)/[channel]/create/page.js", `m=${JSON.stringify(e0.models)}`);
    put(root, "server/app/(app)/[channel]/create/page.js.nft.json", '{"files":["../../lib/effects/effects.json"]}');
    expect(run(root).code).toBe(0);
  });

  // Positive controls: a pass must never come from scanning nothing, or from a source the script can no longer read.
  it("exits 2 when the static directory is not a whole build", () => {
    const root = fakeBuild();
    rmSync(path.join(root, ".next", "static"), { recursive: true });
    mkdirSync(path.join(root, ".next", "static"));
    expect(run(root).code).toBe(2);
  });

  it("exits 2 when a screen that carried the data is not in the build", () => {
    const root = fakeBuild();
    put(root, "static/chunks/70-desk.js", 'e("ul",{className:"cv-effects"});e("div",{id:"credit-prices"})');
    const r = run(root);
    expect(r.code).toBe(2);
    expect(r.out).toContain("fx-grid");
  });

  it.each(SOURCES.filter((s) => s.endsWith(".ts")))("exits 2 when %s is no longer server-only", (rel) => {
    const src = readFileSync(path.join(CC, rel), "utf8").replace('import "server-only";', "");
    expect(run(fakeBuild({ [rel]: src })).code).toBe(2);
  });

  it("exits 2 when the provider map or the unit list is no longer in the shape it reads", () => {
    const providers = readFileSync(path.join(CC, "lib/server/provider-names.ts"), "utf8").replace("const PROVIDER_NAMES", "const RENAMED");
    expect(run(fakeBuild({ "lib/server/provider-names.ts": providers })).code).toBe(2);
    const units = readFileSync(path.join(CC, "lib/server/ledger-units.ts"), "utf8").replace("export const LEDGER_UNITS", "export const RENAMED");
    expect(run(fakeBuild({ "lib/server/ledger-units.ts": units })).code).toBe(2);
    expect(run(fakeBuild({ "lib/effects/effects.json": '{"version":1,"effects":[]}' })).code).toBe(2);
  });
});

describe("vendor-bundle-check as a module", () => {
  it("importing it runs no scan (main() only when run as a script), and its helpers read the forms the product writes", async () => {
    const exit = process.exitCode;
    const mod = (await import("../scripts/vendor-bundle-check.mjs")) as {
      normalize: (s: string) => string;
      promptWindows: (p: string) => string[];
      PROMPT_WINDOW: number;
    };
    expect(process.exitCode).toBe(exit);
    expect(mod.normalize('a=\\\\\\"x\\\\\\"&quot;y&#34;&#x22;&#39;')).toBe(`a="x""y""'`);
    // Every part between slots that is long enough gives windows, each PROMPT_WINDOW long and in the prompt.
    for (const e of effects) {
      const w = mod.promptWindows(e.prompt);
      expect(w.length, e.id).toBeGreaterThan(0);
      for (const x of w) expect(x.length === mod.PROMPT_WINDOW && e.prompt.includes(x), `${e.id}: ${x}`).toBe(true);
    }
  });
});
