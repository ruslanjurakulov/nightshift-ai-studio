/**
 * The editing core's seeded edits, for the OTHER validator: every state the run makes (seeds 7 and 99, which once
 * gave documents the editor saved and the worker refused, and the main seed; 15,000 edits over 1080p, 9:16, 1440p
 * and 4K frames at 24-60 fps) is written to samples/editor_core_fuzz_docs.json.gz, and
 * tests/test_editor_core_fuzz.py holds every one to modules/timeline.py `validate` and `resolve_assets`. This test
 * fails when the operations no longer make exactly those documents, so the Python check can never go stale:
 * regenerate with `UPDATE_CORE_FUZZ=1 npx vitest run tests/editor-core-fuzz.test.ts` and commit the file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { docAssetProblems, toDoc, validateTimeline } from "@/lib/editor";
import { fuzzAssets, runFuzz } from "./editor-core-fuzz";

const FILE = join(__dirname, "..", "..", "samples", "editor_core_fuzz_docs.json.gz");
const FUZZ_SEEDS = [7, 99, 20261112];

describe("the seeded edits the Python validator checks", () => {
  it("are exactly the documents the operations make now, and the TypeScript checks accept every one", () => {
    const docs: unknown[] = [];
    let edits = 0;
    for (const seed of FUZZ_SEEDS) {
      const run = runFuzz(seed, 250, 20, (m, where) => {
        const doc = toDoc(m);
        const why = [...validateTimeline(doc), ...docAssetProblems(doc, fuzzAssets)];
        if (why.length) throw new Error(`${where}: ${why.join("; ")}`);
      });
      edits += run.edits;
      docs.push(...run.states);
    }
    expect(edits).toBe(15000);
    const text = JSON.stringify({ seeds: FUZZ_SEEDS, assets: fuzzAssets, docs });
    if (process.env.UPDATE_CORE_FUZZ === "1") writeFileSync(FILE, gzipSync(text, { level: 9 }));
    const stored = gunzipSync(readFileSync(FILE)).toString("utf8");
    expect(stored.length, "regenerate samples/editor_core_fuzz_docs.json.gz (see the header)").toBe(text.length);
    expect(stored === text, "regenerate samples/editor_core_fuzz_docs.json.gz (see the header)").toBe(true);
  }, 120_000);
});
