/**
 * The editor's `ms` (lib/editor.ts) is Python's `round(v, 3)` bit for bit: modules/timeline.py `_ms` validates and
 * renders with it, and the database's editor_ms (migration 0136) prices paid exports and caps lengths with it, so a
 * length the editor works out must be the one the worker and the database work out. samples/ms_round_cases.json.gz is
 * Python's own answers (tools/ms_round_table.py): random values of every size and sign, every k/16 (the exact ties),
 * k/32 and k/1000 with their neighbours one ulp either side, the database test's tie set, and every value the
 * renderer rounds while measuring that test's 2,282-document corpus.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ms } from "@/lib/editor";

const table = JSON.parse(
  gunzipSync(readFileSync(join(__dirname, "..", "..", "samples", "ms_round_cases.json.gz"))).toString("utf8"),
) as { x: number[]; y: number[]; from_corpus: number };

describe("ms is Python's round(v, 3)", () => {
  it("on every value of the table, sign of zero included", () => {
    expect(table.x.length).toBeGreaterThan(100_000);
    expect(table.from_corpus).toBeGreaterThan(40_000);
    const bad: [number, number, number][] = [];
    for (let i = 0; i < table.x.length; i += 1) {
      const got = ms(table.x[i]);
      if (!Object.is(got, table.y[i])) bad.push([table.x[i], table.y[i], got]);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("takes an exact tie to the even neighbour, where Math.round went up", () => {
    expect(ms(0.0625)).toBe(0.062);
    expect(ms(0.1875)).toBe(0.188);
    expect(ms(-0.0625)).toBe(-0.062);
    expect(ms(123456789.0625)).toBe(123456789.062);
    // not ties: their binary value is just under or over the half
    expect(ms(0.7745)).toBe(0.774);
    expect(ms(2.675)).toBe(2.675);
    expect(ms(1.0005)).toBe(1);
  });

  it("passes inf and nan through and keeps the sign of zero", () => {
    expect(ms(Infinity)).toBe(Infinity);
    expect(ms(-Infinity)).toBe(-Infinity);
    expect(Number.isNaN(ms(NaN))).toBe(true);
    expect(Object.is(ms(-0), -0)).toBe(true);
    expect(Object.is(ms(-0.0004), -0)).toBe(true);
    expect(ms(2 ** 60)).toBe(2 ** 60);
  });
});
