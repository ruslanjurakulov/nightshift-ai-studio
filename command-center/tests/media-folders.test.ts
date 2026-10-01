import { describe, expect, it } from "vitest";
import {
  FOLDER_ERRORS,
  MOVE_MAX,
  cleanFolderName,
  cleanSearch,
  folderErrorWord,
  ilikeContains,
  isMissingFolders,
  mapFolderError,
  parseFolderName,
  parseMoveInput,
  shapeFolders,
} from "@/lib/media-folders";
import { coerceAssets } from "@/lib/media";
import { commonFolder, fileCount, inFolder } from "@/components/media/libraryView";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

/**
 * The pure half of library folders (migration 0049). What would break
 * without these: a name the database refuses sent anyway (or a valid one
 * refused here), a move body that half-validates, a search that turns "%" or
 * "*" into "match everything", a count that could not be read shown as 0, and
 * a database refusal that reaches the page as a 500 or a raw code.
 */

const F = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("folder names", () => {
  it("are cleaned the way the database stores them", () => {
    expect(cleanFolderName("  Brand\t\tphotos \n 2026 ")).toBe("Brand photos 2026");
    expect(cleanFolderName("Bell\u0007s")).toBe("Bells");
    expect(cleanFolderName(42)).toBe("");
  });

  it("are 1 to 60 characters after cleaning, counted as the database counts them", () => {
    expect(parseFolderName("Brand")).toEqual({ ok: true, value: "Brand" });
    expect(parseFolderName("   ")).toEqual({ ok: false, error: "invalid_name" });
    expect(parseFolderName("n".repeat(61))).toEqual({ ok: false, error: "invalid_name" });
    expect(parseFolderName("n".repeat(60)).ok).toBe(true);
    // 60 emoji are 120 UTF-16 units and still 60 characters to char_length().
    expect(parseFolderName("📁".repeat(60)).ok).toBe(true);
    expect(parseFolderName(null)).toEqual({ ok: false, error: "invalid_name" });
  });
});

describe("move input", () => {
  it("takes a folder or an explicit null, and 1-200 distinct ids", () => {
    expect(parseMoveInput({ folder_id: F(1), asset_ids: [F(2), F(3), F(2)] })).toEqual({
      ok: true,
      value: { folderId: F(1), assetIds: [F(2), F(3)] },
    });
    expect(parseMoveInput({ folder_id: null, asset_ids: [F(2)] })).toEqual({ ok: true, value: { folderId: null, assetIds: [F(2)] } });
  });

  it.each([
    ["no body", undefined, "bad_request"],
    ["an array", [], "bad_request"],
    ["no folder_id at all (not the same as null)", { asset_ids: [F(2)] }, "bad_request"],
    ["a path for a folder", { folder_id: "../x", asset_ids: [F(2)] }, "bad_request"],
    ["ids that are not a list", { folder_id: null, asset_ids: F(2) }, "bad_request"],
    ["no ids", { folder_id: null, asset_ids: [] }, "no_assets"],
    ["too many ids", { folder_id: null, asset_ids: Array.from({ length: MOVE_MAX + 1 }, (_, i) => F(i)) }, "too_many_assets"],
    ["a malformed id", { folder_id: null, asset_ids: [F(2), "x"] }, "invalid_asset"],
    ["an upper-case id", { folder_id: null, asset_ids: ["0F000000-0000-4000-8000-00000000000A"] }, "invalid_asset"],
  ])("refuses %s", (_label, body, error) => {
    expect(parseMoveInput(body)).toEqual({ ok: false, error });
  });
});

describe("server search text", () => {
  it("drops control characters and PostgREST's unescapable '*'; caps the length", () => {
    expect(cleanSearch("  beach\u0000 *photo* ")).toBe("beach photo");
    expect(cleanSearch("x".repeat(500))).toHaveLength(100);
    expect(cleanSearch(undefined)).toBe("");
  });

  it("escapes the ilike pattern's own metacharacters so '%' finds a '%'", () => {
    expect(ilikeContains("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    expect(ilikeContains("beach")).toBe("%beach%");
  });
});

describe("shaping folders", () => {
  const rows = [
    { id: F(1), name: "zeta" },
    { id: F(2), name: "Alpha" },
    { id: F(3), name: "folder 10" },
    { id: F(4), name: "folder 9" },
    { id: "not-an-id", name: "dropped" },
    { id: F(5), name: "" },
  ];

  it("sorts by name the way a person reads it, with counts and totals", () => {
    const out = shapeFolders(rows, [
      { folder_id: F(1), assets: 3 },
      { folder_id: null, assets: "7" },
      { folder_id: F(3), assets: 2 },
    ]);
    expect(out.folders.map((f) => f.name)).toEqual(["Alpha", "folder 9", "folder 10", "zeta"]);
    expect(out.folders.find((f) => f.id === F(1))?.count).toBe(3);
    // A folder with no row in a readable answer holds no live files.
    expect(out.folders.find((f) => f.id === F(2))?.count).toBe(0);
    expect(out.total).toBe(12);
    expect(out.unfiled).toBe(7);
  });

  it("an unreadable count is unknown, never 0", () => {
    const out = shapeFolders(rows, null);
    expect(out.folders.every((f) => f.count === null)).toBe(true);
    expect(out.total).toBeNull();
    expect(out.unfiled).toBeNull();
  });
});

describe("assets carry their folder only once it was read", () => {
  const row = { id: F(9), kind: "image", mime: "image/png", bytes: 10, source: "upload" };
  it("before 0049 there is no folderId at all; after it, null or the id", () => {
    expect("folderId" in coerceAssets([row])[0]).toBe(false);
    expect(coerceAssets([{ ...row, folder_id: null }])[0].folderId).toBeNull();
    expect(coerceAssets([{ ...row, folder_id: F(1) }])[0].folderId).toBe(F(1));
    expect(coerceAssets([{ ...row, folder_id: "../etc" }])[0].folderId).toBeNull();
  });

  it("a folder shows only its own files; 'All files' shows every file", () => {
    const a = [
      { id: "a", folderId: F(1) },
      { id: "b", folderId: null },
      { id: "c" },
    ];
    expect(inFolder(a, F(1)).map((x) => x.id)).toEqual(["a"]);
    expect(inFolder(a, null).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("the move picker knows where the selection already is", () => {
    const a = [
      { id: "a", folderId: F(1) },
      { id: "b", folderId: F(1) },
      { id: "c", folderId: null },
      { id: "d" },
    ];
    expect(commonFolder(a, new Set(["a", "b"]))).toBe(F(1));
    expect(commonFolder(a, new Set(["c"]))).toBeNull();
    expect(commonFolder(a, new Set(["a", "c"]))).toBeUndefined();
    expect(commonFolder(a, new Set(["d"]))).toBeUndefined();
    expect(commonFolder(a, new Set())).toBeUndefined();
  });
});

describe("the database's refusals", () => {
  it.each([
    [{ code: "NS400", message: "invalid_name" }, "invalid_name", 400],
    [{ code: "NS400", message: "invalid_asset" }, "invalid_asset", 400],
    [{ code: "NS400", message: "too_many_assets" }, "too_many_assets", 400],
    [{ code: "NS400", message: "no_assets" }, "no_assets", 400],
    [{ code: "NS400", message: "something new" }, "bad_request", 400],
    [{ code: "NS409", message: "name_taken" }, "name_taken", 409],
    [{ code: "23505", message: "duplicate key" }, "name_taken", 409],
    [{ code: "NS429", message: "limit_reached" }, "limit_reached", 409],
    [{ code: "42501", message: "forbidden" }, "forbidden", 403],
    [{ code: "P0002", message: "not_found" }, "not_found", 404],
    [{ code: "PGRST202", message: "Could not find the function" }, "not_available", 503],
    [{ code: "42P01", message: "relation does not exist" }, "not_available", 503],
    [{ code: "XX000", message: "boom" }, "failed", 502],
    [null, "failed", 502],
  ])("%j -> %s (%i)", (error, word, status) => {
    expect(mapFolderError(error)).toEqual({ error: word, status });
  });

  it("a word the page has no sentence for reads as a plain failure", () => {
    expect(folderErrorWord("name_taken")).toBe("name_taken");
    expect(folderErrorWord("<script>")).toBe("failed");
    expect(folderErrorWord(undefined)).toBe("failed");
  });

  it("a missing table or function is 'not applied yet', a broken read is not", () => {
    expect(isMissingFolders({ code: "42P01" })).toBe(true);
    expect(isMissingFolders({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(isMissingFolders({ code: "XX000", message: "boom" })).toBe(false);
    expect(isMissingFolders(null)).toBe(false);
  });

  it("every word has a plain sentence in English, Russian and Uzbek", () => {
    for (const dict of [en, ru, uz]) {
      for (const word of FOLDER_ERRORS) {
        const text = dict.media.folders.errors[word];
        expect(typeof text, `${word}`).toBe("string");
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toMatch(/NS\d{3}|P0002|42501|_/);
      }
    }
  });
});

describe("file counts read as words", () => {
  it("one file is not '1 files'", () => {
    expect(fileCount(en.media.folders, 1)).toBe("1 file");
    expect(fileCount(en.media.folders, 3)).toBe("3 files");
    expect(fileCount(ru.media.folders, 1)).toBe("Файлов: 1");
    expect(fileCount(uz.media.folders, 5)).toBe("5 ta fayl");
  });
});
