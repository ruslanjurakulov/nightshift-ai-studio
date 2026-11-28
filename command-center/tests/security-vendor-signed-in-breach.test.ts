import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPipelineOptions } from "@/lib/server/pipeline-options";
import { EXAMPLE_MODELS } from "@/lib/server/creative-examples";
import { TTS_MODEL_LABELS, TTS_PICKER_MODELS } from "@/lib/ttsModels";

/**
 * Breach, PR #958 (vendor sweep 2, signed-in screens): can the operator's routing data reach a browser while
 * scripts/vendor-bundle-check.mjs still prints "clean"? Same harness as tests/security-vendor-bundle-check-breach.test.ts: a
 * stand-in `.next` with the real sources copied in, one copy of the data in a chunk, the real script run on it. Exit 0 on a
 * leak is the hole: CI is green and the data ships.
 *
 * The forms marked PROP are not hypothetical: they are the exact JSON the PR's own server props serialize to
 * (createPipelineOptions(), exampleModelsFor()), i.e. what any client module that imported the props' builder, or a
 * prerendered page that drew them, would carry. The guard only knows the shapes the data had BEFORE the PR moved it
 * (`eleven_v4:["uz",…]`, `{id,mode,modelId}`, `{id:"kling",name:"Kling"}`), not the shapes the PR gave it.
 */
const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "vendor-bundle-check.mjs");
const { SIGNED_IN_SOURCES } = (await import("../scripts/vendor-bundle-check.mjs")) as { SIGNED_IN_SOURCES: string[] };
const SOURCES = ["lib/effects/effects.json", "lib/effects/catalog.ts", "lib/server/provider-names.ts", "lib/server/ledger-units.ts", ...SIGNED_IN_SOURCES];
const roots: string[] = [];

function fakeBuild(over: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "breach-958-"));
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

const pipeline = createPipelineOptions();

describe("breach #958: controls", () => {
  it("the harness runs the real script: clean passes, the old shapes the guard knows fail", () => {
    expect(run(fakeBuild()).code).toBe(0);
    for (const text of [
      `{${TTS_PICKER_MODELS[0]}:["uz","ru","en"]}`,
      JSON.stringify(pipeline.video),
      'x={id:"tea_pour",mode:"video",modelId:"kling-v3"}',
      't="GEMINI_API_KEY"',
    ]) {
      const root = fakeBuild();
      put(root, "static/chunks/155-control.js", text);
      expect(run(root).code, text).toBe(1);
    }
  });

  it("held: the routing panel's props ({id,name,secretName}) are caught by the secret names", () => {
    const root = fakeBuild();
    put(root, "static/chunks/156-routing.js", JSON.stringify([{ id: "nano-banana", name: "Google Nano Banana 2", secretName: "GEMINI_API_KEY" }]));
    expect(run(root).code).toBe(1);
  });
});

describe("breach #958: forms vendor-bundle-check misses (each must exit 1)", () => {
  const cases: [string, () => string][] = [
    [
      // PROP: CreateStudio's `pipeline.tts` — each narration model with the languages it speaks, as an option object. The
      // guard's table regex wants the model id as a KEY directly before the language array; here the key is `speaks`.
      "the narration vendor's model -> languages table as the PR's own PipelineTtsOption[] prop",
      () => JSON.stringify({ tts: pipeline.tts, ttsReadOn: pipeline.ttsReadOn }),
    ],
    [
      // The narration vendor's model ids and labels (TTS_MODEL_LABELS, minified). ttsModels.ts was made server-only for
      // exactly these, but only the language table is a pattern.
      "the narration vendor's model id -> label map (TTS_MODEL_LABELS)",
      () => `L={${TTS_PICKER_MODELS.map((m) => `${m}:${JSON.stringify(TTS_MODEL_LABELS[m])}`).join(",")}}`,
    ],
    [
      "the narration vendor's model id list (TTS_PICKER_MODELS / TTS_MODELS)",
      () => `M=${JSON.stringify(TTS_PICKER_MODELS)}`,
    ],
    [
      // PROP: StudioHome's `exampleModels` — example id -> the model it was written for. The guard only knows the old
      // {id:"…",modelId:"…"} object; the PR's new prop shape (and EXAMPLE_MODELS itself, minified) is a plain map.
      "the starter -> model pairs as the PR's own exampleModels prop (and EXAMPLE_MODELS minified)",
      () => JSON.stringify({ exampleModels: EXAMPLE_MODELS }),
    ],
    [
      // PROP: CreateStudio's `pipeline.image` — our image generator ids and their vendor names. Only the video list is a
      // pattern; the image list has no secret name and no default model, so nothing in it is looked for.
      "the operator's image generator options as the PR's own pipeline.image prop",
      () => JSON.stringify({ image: pipeline.image }),
    ],
    [
      // The video options as ids only: a select's value list, a zod enum, lib/runBackend.ts VIDEO_PROVIDERS. The guard
      // needs id and name side by side.
      "the operator's video pipeline ids as an enum array",
      () => `z.enum(${JSON.stringify(pipeline.video.map((v) => v.id))})`,
    ],
    [
      // The compiled <option> with one more prop between value and children (className, disabled, title…): the guard's
      // regex wants `value` and `children` adjacent.
      "the compiled video <option>s with a className between value and children",
      () => pipeline.video.map((o) => `(0,r.jsx)("option",{value:"${o.id}",className:"opt",children:"${o.name}"},"${o.id}")`).join(","),
    ],
    [
      // The Agent Builder registry's third state key: only licensingState and pricingMode are patterns.
      "the agent registry's apiState (third state key)",
      () => 'P={ideogram:{developer:"Ideogram",capabilities:["vector"],apiState:"verification_required"}}',
    ],
  ];

  it.each(cases)("%s", (_label, text) => {
    const root = fakeBuild();
    put(root, "static/chunks/200-leak.js", text());
    const r = run(root);
    expect(r.code, r.out).toBe(1);
  });

  it("a vendor whose envSets is wrapped over several lines (prettier at the line limit) is read and its secret name caught", () => {
    // The secret-name reader is `envSets:\s*\[([^\n]*?)\],?\s*$`: one line only. A wrapped entry is silently skipped, and the
    // 12-block floor still passes with one missing, so the new vendor's key name ships unflagged.
    const src = readFileSync(path.join(CC, "lib/model-keys.ts"), "utf8");
    const wrapped = src.replace(
      'envSets: [["SEEDANCE_API_KEY"]],',
      'envSets: [\n      ["SEEDANCE_API_KEY"],\n      ["BREACH_NEW_VENDOR_ACCESS_KEY", "BREACH_NEW_VENDOR_SECRET_KEY"],\n    ],',
    );
    expect(wrapped).not.toBe(src);
    const root = fakeBuild({ "lib/model-keys.ts": wrapped });
    put(root, "static/chunks/201-leak.js", 't="Set BREACH_NEW_VENDOR_SECRET_KEY in the worker"');
    const r = run(root);
    expect(r.code, r.out).toBe(1);
  });
});
