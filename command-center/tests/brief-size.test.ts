import { describe, expect, it } from "vitest";
import { BRIEF_MAX_BYTES, NUMBER_WORST, briefBytes } from "@/lib/brain/brief-size";

/**
 * briefBytes against the database's own measure, octet_length(brief::jsonb::text). Every expected number below was read from
 * PostgreSQL 16 for the same value. What would break without these: the turn route answering a reply as stored for a BRIEF the
 * database then ended as brief_too_large (a count too low), or refusing one it would have stored (too high, outside numbers).
 */

describe("briefBytes measures a BRIEF as jsonb's text does", () => {
  it.each([
    ["an empty BRIEF", {}, 2],
    // ʻ (U+02BB) and ʼ (U+02BC) are two bytes each in UTF-8, as the owner's Uzbek writes them.
    ["Uzbek with ʻ and ʼ", { title: "Oʻzbekiston maʼlumot", n: 3 }, 43],
    ["two-, three- and four-byte text and a ZWJ sequence", { a: "Жизнь", b: "物語", c: "🎬👩‍👩‍👧" }, 65],
    ["control characters, a quote and a backslash, escaped", { t: "a\nb\tc\u0001d\"e\\f\u001f" }, 35],
    ["U+2028 and U+2029, which neither side escapes", { t: "x y z" }, 18],
    ["nested objects, arrays, null, true and a negative integer",
     { scenes: [{ id: "s1", in_frame: [{ character_id: "c1", age_stage: null }], ok: true, n: -12 }, []], e: {} }, 118],
  ])("%s", (_name, brief, bytes) => {
    expect(briefBytes(brief)).toBe(bytes);
  });

  it("leaves out an undefined member, as JSON and PostgREST do", () => {
    expect(briefBytes({ title: "Oʻzbekiston maʼlumot", n: 3, gone: undefined })).toBe(43);
  });

  it("never counts the character sheets or the film link, even when they alone are over the limit", () => {
    const huge = "p".repeat(BRIEF_MAX_BYTES + 10);
    const with_ = { title: "Oʻzbekiston maʼlumot", n: 3, ref_sheets: [{ character_id: "c1", stage: null, views: [{ prompt: huge }] }],
                    film_link: { film_id: huge, scenes: [] } };
    expect(briefBytes(with_)).toBe(43);
  });

  it("counts any number that is not a safe integer at jsonb's worst case, so it never counts low", () => {
    // jsonb prints 1e21 as 22 digits, 1e-7 as 0.0000001, 1e300 as 301 digits and -5e-324 as 327 characters.
    for (const n of [1e21, 1e-7, 1e300, -5e-324, 0.1, 2 ** 53]) {
      expect(briefBytes({ n })).toBe(7 + NUMBER_WORST);
    }
    expect(NUMBER_WORST).toBeGreaterThanOrEqual(327);
    expect(briefBytes({ n: 2 ** 53 - 1 })).toBe(7 + String(2 ** 53 - 1).length);
  });
});
