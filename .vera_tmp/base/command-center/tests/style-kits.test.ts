import { describe, expect, it } from "vitest";
import {
  CHARACTER_LIMITS,
  CHARACTER_NAME_RE,
  KIT_LIMITS,
  cleanDescription,
  cleanKitName,
  coerceCharacters,
  coerceKits,
  coerceReferenceRows,
  coverOf,
  isMissingRelation,
  mapStyleError,
  missingCount,
  normalizeCharacterName,
  parseAssetIds,
  parseCharacterInput,
  parseKitInput,
  type ReferenceAsset,
} from "../lib/style-kits";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pins on the client-safe half of style kits and characters (migration 0047):
// the form must refuse exactly what the database refuses, so a person is told
// what is wrong before a round trip, and a database refusal maps to a word.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i + 1));

describe("limits agree with the migration", () => {
  const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0047_style_kits_characters.sql"), "utf8");

  it("the @name rule is the check constraint's, verbatim", () => {
    expect(SQL).toContain(`check (name ~ '${CHARACTER_NAME_RE.source}')`);
  });

  it("reference bounds and text sizes are the database's", () => {
    expect(SQL).toContain(`style_check_assets(org_, p_assets, ${KIT_LIMITS.minRefs}, ${KIT_LIMITS.maxRefs})`);
    expect(SQL).toContain(`style_check_assets(org_, p_assets, ${CHARACTER_LIMITS.minRefs}, ${CHARACTER_LIMITS.maxRefs})`);
    expect(SQL).toContain(`position between 0 and ${KIT_LIMITS.maxRefs - 1}`);
    expect(SQL).toContain(`position between 0 and ${CHARACTER_LIMITS.maxRefs - 1}`);
    expect(SQL).toContain(`char_length(name) between 1 and ${KIT_LIMITS.nameMax}`);
    expect(SQL).toContain(`char_length(description) <= ${KIT_LIMITS.descriptionMax}`);
    expect(SQL).toContain(`>= ${KIT_LIMITS.perOrg} then`);
    expect(SQL).toContain(`>= ${CHARACTER_LIMITS.perOrg} then`);
  });
});

describe("parseKitInput", () => {
  const ok = { name: "Warm doc", description: "film grain", asset_ids: ids(3) };

  it("accepts a valid kit and cleans its text", () => {
    const r = parseKitInput({ ...ok, name: "  Warm\u0007 doc ", description: "a\r\nb\u0001\tc  " });
    expect(r).toEqual({ ok: true, value: { name: "Warm doc", description: "a\nb\tc", assetIds: ids(3) } });
  });

  it("needs a name of 1-60 characters (counted as code points)", () => {
    expect(parseKitInput({ ...ok, name: "   " })).toEqual({ ok: false, error: "invalid_name" });
    expect(parseKitInput({ ...ok, name: "x".repeat(61) })).toEqual({ ok: false, error: "invalid_name" });
    // 60 emoji are 120 UTF-16 units but 60 characters to Postgres.
    expect(parseKitInput({ ...ok, name: "😀".repeat(60) }).ok).toBe(true);
    expect(parseKitInput({ ...ok, name: 5 })).toEqual({ ok: false, error: "invalid_name" });
  });

  it("caps the description at 2000 characters", () => {
    expect(parseKitInput({ ...ok, description: "d".repeat(2000) }).ok).toBe(true);
    expect(parseKitInput({ ...ok, description: "d".repeat(2001) })).toEqual({ ok: false, error: "invalid_description" });
    expect(parseKitInput({ ...ok, description: { x: 1 } })).toEqual({ ok: false, error: "bad_request" });
  });

  it("needs 3-12 distinct uuids", () => {
    expect(parseKitInput({ ...ok, asset_ids: ids(2) })).toEqual({ ok: false, error: "too_few_references" });
    expect(parseKitInput({ ...ok, asset_ids: ids(13) })).toEqual({ ok: false, error: "too_many_references" });
    expect(parseKitInput({ ...ok, asset_ids: ids(12) }).ok).toBe(true);
    expect(parseKitInput({ ...ok, asset_ids: [id(1), id(1), id(2)] })).toEqual({ ok: false, error: "duplicate_reference" });
    expect(parseKitInput({ ...ok, asset_ids: [id(1), id(2), "../../etc/passwd"] })).toEqual({ ok: false, error: "invalid_reference" });
    expect(parseKitInput({ ...ok, asset_ids: "nope" })).toEqual({ ok: false, error: "bad_request" });
  });

  it("refuses a body that is not an object", () => {
    for (const b of [null, undefined, "x", [ok]]) expect(parseKitInput(b)).toEqual({ ok: false, error: "bad_request" });
  });
});

describe("parseCharacterInput", () => {
  const ok = { name: "hero", asset_ids: ids(1) };

  it("normalizes '@Hero' to 'hero' and defaults the kind", () => {
    expect(parseCharacterInput({ ...ok, name: " @Hero_2 " })).toEqual({
      ok: true,
      value: { name: "hero_2", kind: "character", description: "", assetIds: ids(1) },
    });
  });

  it.each(["a", "has space", "x".repeat(33), "a-b", "émoji", "@", ""])("refuses the @name %j", (name) => {
    expect(parseCharacterInput({ ...ok, name })).toEqual({ ok: false, error: "invalid_name" });
  });

  it("accepts only character or product", () => {
    expect(parseCharacterInput({ ...ok, kind: "product" }).ok).toBe(true);
    expect(parseCharacterInput({ ...ok, kind: "villain" })).toEqual({ ok: false, error: "invalid_kind" });
  });

  it("needs 1-8 references", () => {
    expect(parseCharacterInput({ ...ok, asset_ids: [] })).toEqual({ ok: false, error: "too_few_references" });
    expect(parseCharacterInput({ ...ok, asset_ids: ids(9) })).toEqual({ ok: false, error: "too_many_references" });
    expect(parseCharacterInput({ ...ok, asset_ids: ids(8) }).ok).toBe(true);
  });
});

describe("text helpers", () => {
  it("drop control characters but keep a description's line breaks", () => {
    expect(cleanKitName("a\nb\u0000c")).toBe("abc");
    expect(cleanDescription("one\r\ntwo\u0008")).toBe("one\ntwo");
    expect(normalizeCharacterName("@@x")).toBe("@x");
  });

  it("parseAssetIds keeps the order (the first is the cover)", () => {
    expect(parseAssetIds([id(3), id(1), id(2)], 1, 5)).toEqual({ ok: true, value: [id(3), id(1), id(2)] });
  });
});

describe("rows", () => {
  const refs = coerceReferenceRows(
    [
      { kit_id: id(100), asset_id: id(2), position: 1 },
      { kit_id: id(100), asset_id: id(1), position: 0 },
      { kit_id: id(100), asset_id: id(3), position: 2 },
      { kit_id: "nope", asset_id: id(4), position: 0 },
    ],
    "kit_id",
  );
  const assets = new Map<string, ReferenceAsset>([
    [id(2), { mime: "image/png", width: 10, height: 10, thumbUrl: "/t2" }],
    [id(3), { mime: "image/png", width: 10, height: 10, thumbUrl: "/t3" }],
  ]);

  it("orders references, marks a deleted image as not live, and covers with the first live one", () => {
    const [kit] = coerceKits([{ id: id(100), name: "K", description: null }], refs, assets);
    expect(kit.references.map((r) => [r.assetId, r.live])).toEqual([
      [id(1), false],
      [id(2), true],
      [id(3), true],
    ]);
    expect(coverOf(kit.references)?.thumbUrl).toBe("/t2");
    expect(missingCount(kit.references)).toBe(1);
    expect(kit.description).toBe("");
  });

  it("drops malformed rows and reads an unknown kind as a character", () => {
    const chars = coerceCharacters(
      [{ id: id(7), name: "hero", kind: "weird" }, { id: "x", name: "bad" }, null],
      [],
      new Map(),
    );
    expect(chars).toHaveLength(1);
    expect(chars[0].kind).toBe("character");
    expect(coverOf(chars[0].references)).toBeNull();
  });
});

describe("mapStyleError", () => {
  it.each([
    [{ code: "NS400", message: "invalid_reference" }, "invalid_reference", 400],
    [{ code: "NS400", message: "too_few_references" }, "too_few_references", 400],
    [{ code: "NS400", message: "something new" }, "bad_request", 400],
    [{ code: "NS409", message: "name_taken" }, "name_taken", 409],
    [{ code: "23505", message: "duplicate key" }, "name_taken", 409],
    [{ code: "NS429", message: "limit_reached" }, "limit_reached", 409],
    [{ code: "42501", message: "forbidden" }, "forbidden", 403],
    [{ code: "P0002", message: "not_found" }, "not_found", 404],
    [{ code: "PGRST202", message: "x" }, "not_available", 503],
    [{ code: "42P01", message: "x" }, "not_available", 503],
    [{ code: "XX000", message: "boom" }, "failed", 502],
    [null, "failed", 502],
  ])("%j -> %s %i", (err, word, status) => {
    expect(mapStyleError(err)).toEqual({ error: word, status });
  });

  it("tells 'not applied' from a failed read", () => {
    expect(isMissingRelation({ code: "42P01" })).toBe(true);
    expect(isMissingRelation({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(isMissingRelation({ code: "XX000", message: "boom" })).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
  });
});
