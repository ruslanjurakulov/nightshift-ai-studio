// Shared-case check for the timeline year reader.
//
// `extractTimeline` (src/text.ts) decides what the Timeline component draws;
// its Python twin, modules/graphic_recipes.timeline_dates, decides when the IR
// compiler may pick the `timeline` recipe. Both read
// samples/timeline_year_cases.json, so a change on one side that the other
// does not follow fails here and in tests/test_graphic_recipes.py.
//
// Run (Node 22, no install needed):
//   node --experimental-strip-types --no-warnings --test tests/text-cases.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractTimeline } from "../src/text.ts";

type Case = { name: string; text: string; dates: string[]; years: number[]; timeline: boolean };

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "..", "..", "samples", "timeline_year_cases.json"), "utf-8"),
) as { min_years: number; cases: Case[] };

for (const c of doc.cases) {
  test(`timeline: ${c.name}`, () => {
    const events = extractTimeline(c.text);
    assert.deepEqual(
      events.map((e) => e.date),
      c.dates,
    );
    const years = [...new Set(events.map((e) => e.year))].sort((a, b) => a - b);
    assert.deepEqual(years, c.years);
    assert.equal(years.length >= doc.min_years, c.timeline);
  });
}
