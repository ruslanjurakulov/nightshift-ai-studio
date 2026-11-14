/**
 * Studio → Projects' shared module (lib/films.ts; migration 0166).
 * What would break without these: a database refusal read as the wrong word (a stale save shown as a generic failure, so a person
 * retries and overwrites nothing but never learns why); a 401 not read as an ended session; a save that re-sends an unchanged picture
 * and is refused because the picture was later deleted; a draft that stays "unsaved" forever because the database trims the text it
 * stores; the form's limits drifting from the database's; and the browser reaching the database (or a service key) directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CREATE_LIMITS,
  FILM_ERRORS,
  LIMIT_KEYS,
  cleanText,
  coerceFilmList,
  coerceFilmView,
  draftProblems,
  filmErrorFromResponse,
  filmsApi,
  mapFilmDbError,
  newIdempotencyKey,
  newSceneDraft,
  refsPatch,
  sceneToDraft,
  scenesPatch,
  settingsPatch,
  stationStates,
  IDEM_RE,

  type SceneDraft,
} from "../lib/films";

import { FILM, LIMITS, PIC, S1, S2, filmJson, migration, migrationLimits, root, sceneJson } from "./films-fixtures";

describe("the limits", () => {
  it("are the migration's film_limits(), every key, and the create form's copy agrees with them", () => {
    const m = migrationLimits();
    for (const k of LIMIT_KEYS) expect(m[k], k).toBeTypeOf("number");
    for (const [k, v] of Object.entries(CREATE_LIMITS)) expect(m[k], k).toBe(v);
  });

  it("a read model without its limits is not a read model (never filled in from a second copy)", () => {
    const j = filmJson();
    expect(coerceFilmView(j)).not.toBeNull();
    expect(coerceFilmView({ ...j, limits: undefined })).toBeNull();
    expect(coerceFilmView({ ...j, limits: { ...j.limits, max_scenes: undefined } })).toBeNull();
    expect(coerceFilmView({ ...j, editable: undefined })).toBeNull();
    expect(coerceFilmView(null)).toBeNull();
  });

  it("orders scenes by position and keeps an unknown as unknown (current_version null, not 0)", () => {
    const v = coerceFilmView(filmJson({}, [sceneJson(S2, 1), sceneJson(S1, 0)]))!;
    expect(v.scenes.map((s) => s.id)).toEqual([S1, S2]);
    expect(v.scenes[0].currentVersion).toBeNull();
    expect(v.totals).toEqual({ scenes: 2, plannedSeconds: 16 });
  });

  it("the list drops rows it cannot read rather than inventing fields", () => {
    const rows = coerceFilmList([
      { id: FILM, title: "A", status: "draft", language: "uz", aspect: "9:16", target_seconds: 120, updated_at: null, archived_at: null },
      { id: "nope", title: "B", status: "draft", language: "en", aspect: "16:9", target_seconds: 60 },
      { id: S1, title: "C", status: "weird", language: "en", aspect: "16:9", target_seconds: 60 },
    ]);
    expect(rows.map((r) => r.id)).toEqual([FILM]);
  });
});

describe("refusals", () => {
  it("maps every 0166 word to its own closed word and status", () => {
    const cases: [string, string, string, number][] = [
      ["42501", "forbidden", "forbidden", 403],
      ["P0002", "not_found", "not_found", 404],
      ["NS400", "invalid_params", "invalid_params", 400],
      ["NS400", "invalid_idempotency_key", "invalid_idempotency_key", 400],
      ["NS400", "limit_reached", "limit_reached", 400],
      ["NS400", "model_not_offered", "model_not_offered", 400],
      ["NS400", "model_not_available", "model_not_available", 400],
      ["NS400", "asset_not_usable", "asset_not_usable", 400],
      ["NS409", "film_changed", "film_changed", 409],
      ["NS409", "film_not_editable", "film_not_editable", 409],
      ["NS409", "idempotency_conflict", "idempotency_conflict", 409],
      ["NS409", "scene_has_takes", "scene_has_takes", 409],
      ["NS429", "rate_limited", "rate_limited", 429],
    ];
    for (const [code, message, error, status] of cases) expect(mapFilmDbError({ code, message }), `${code} ${message}`).toMatchObject({ error, status });
  });

  it("an unknown word under a known state is 'failed', never a guessed neighbour", () => {
    expect(mapFilmDbError({ code: "NS400", message: "something_new" })).toEqual({ error: "failed", status: 502 });
    expect(mapFilmDbError({ code: "NS409", message: "invalid_params" })).toEqual({ error: "failed", status: 502 });
    expect(mapFilmDbError({ code: "XX000", message: "boom" })).toEqual({ error: "failed", status: 502 });
    expect(mapFilmDbError(null)).toEqual({ error: "failed", status: 502 });
  });

  it("a migration that is not applied says so (not 'not found')", () => {
    for (const code of ["PGRST202", "42883", "42P01", "PGRST205"]) expect(mapFilmDbError({ code }).error).toBe("not_available");
  });

  it("passes the database's sentence for a refused value on, bounded", () => {
    const m = mapFilmDbError({ code: "NS400", message: "invalid_params", details: "scene 3: planned_seconds must be a whole number from 3 to 30" });
    expect(m.detail).toBe("scene 3: planned_seconds must be a whole number from 3 to 30");
    expect(mapFilmDbError({ code: "NS400", message: "invalid_params", details: "x".repeat(1000) }).detail).toHaveLength(300);
  });

  it("the browser reads a 401 as an ended session and keeps the route's word otherwise", () => {
    expect(filmErrorFromResponse(401, { error: "anything" })).toEqual({ error: "session_expired" });
    expect(filmErrorFromResponse(409, { error: "film_changed" })).toEqual({ error: "film_changed" });
    expect(filmErrorFromResponse(429, {})).toEqual({ error: "rate_limited" });
    expect(filmErrorFromResponse(500, { error: "made_up" })).toEqual({ error: "failed" });
  });

  it("names a sentence for every word in every language", async () => {
    for (const lang of ["en", "ru", "uz"]) {
      const mod = await import(`../lib/i18n/film-studio/${lang}.ts`);
      const d = Object.values(mod)[0] as { errors: Record<string, string> };
      for (const e of FILM_ERRORS) expect(d.errors[e], `${lang} ${e}`).toBeTruthy();
    }
  });
});

describe("what a save sends", () => {
  const base = (over: Partial<SceneDraft> = {}): SceneDraft => ({ ...newSceneDraft("k1", LIMITS), ...over });

  it("a new scene has no id and a planned length inside the limits; a saved one names its id", () => {
    const view = coerceFilmView(filmJson({}, [sceneJson(S1, 0)]))!;
    const out = scenesPatch([sceneToDraft(view.scenes[0]), base()]);
    expect(out[0].id).toBe(S1);
    expect(out[1]).not.toHaveProperty("id");
    expect(out[1].planned_seconds).toBeGreaterThanOrEqual(LIMITS.scene_seconds_min);
    expect(out[1].planned_seconds).toBeLessThanOrEqual(LIMITS.scene_seconds_max);
    // Only the fields this screen edits: models, clip parameters and a scene's own references are kept by omission.
    expect(Object.keys(out[1]).sort()).toEqual(["first_frame", "last_frame", "narration", "negative_prompt", "planned_seconds", "shot_count", "title", "visual_prompt"]);
  });

  it("sends a picture id only while its mode uses it, and only when it is new or changed", () => {
    expect(scenesPatch([base({ firstFrame: "asset", firstFrameAssetId: PIC })])[0].first_frame_asset_id).toBe(PIC);
    expect(scenesPatch([base({ firstFrame: "keyframe", firstFrameAssetId: PIC })])[0]).not.toHaveProperty("first_frame_asset_id");
    const view = coerceFilmView(filmJson({}, [sceneJson(S1, 0, { first_frame: "asset", first_frame_asset_id: PIC, first_frame_missing: true })]))!;
    const saved = new Map(view.scenes.map((s) => [s.id, s]));
    // The saved picture was deleted from the library since: an unrelated edit must not re-send it (0166 would refuse asset_not_usable).
    const out = scenesPatch([{ ...sceneToDraft(view.scenes[0]), narration: "New words." }], saved);
    expect(out[0]).not.toHaveProperty("first_frame_asset_id");
    expect(out[0].first_frame).toBe("asset");
  });

  it("references go as the database takes them", () => {
    expect(refsPatch([
      { kind: "character", characterId: S1, assetId: null, missing: false },
      { kind: "style", characterId: null, assetId: PIC, missing: false },
    ])).toEqual([{ kind: "character", character_id: S1 }, { kind: "style", asset_id: PIC }]);
  });

  it("sends text as the database will store it, so a half-typed space is not 'unsaved' forever", () => {
    expect(settingsPatch({ title: "  A   title ", language: "uz", aspect: "1:1", targetSeconds: 180 })).toEqual({ title: "A title", language: "uz", aspect: "1:1", target_seconds: 180 });
    expect(scenesPatch([base({ narration: "Line one  \r\nline two \n" })])[0].narration).toBe("Line one \nline two");
  });
});

describe("cleanText mirrors 0166's film_clean_text", () => {
  it("removes control and invisible characters, folds spaces, trims, and keeps line breaks only where they belong", () => {
    expect(cleanText("a​b‮c⁦d", true)).toBe("abcd");
    expect(cleanText("a\u0007b", false)).toBe("ab");
    expect(cleanText("a\tb", false)).toBe("a b");
    expect(cleanText("a\tb", true)).toBe("ab");
    expect(cleanText("a\nb", false)).toBe("a b");
    expect(cleanText("a\r\nb", true)).toBe("a\nb");
    expect(cleanText("a   b", true)).toBe("a b");
    expect(cleanText("  \n x \n ", true)).toBe("x");
    expect(cleanText("Oʻzbekcha", false)).toBe("Oʻzbekcha");
    expect(cleanText("tag\u{e0041}s", true)).toBe("tags");
  });

  it("its character list is the migration's own", () => {
    const fn = migration.slice(migration.indexOf("create or replace function public.film_clean_text"), migration.indexOf("create or replace function public.film_text_ok"));
    const ours = readFileSync(join(root, "lib/films.ts"), "utf8");
    for (const cp of ["\\u00ad", "\\u034f", "\\u061c", "\\u180b-\\u180f", "\\u200b-\\u200f", "\\u2028-\\u202e", "\\u2060-\\u206f", "\\ufe00-\\ufe0f", "\\ufeff", "\\U000e0000-\\U000e0fff"]) {
      expect(fn, cp).toContain(cp);
      // lib/films.ts writes them inside a string (doubled backslashes), astral ones as \u{...}.
      const js = cp === "\\U000e0000-\\U000e0fff" ? "\\\\u{e0000}-\\\\u{e0fff}" : cp.replaceAll("\\", "\\\\");
      expect(ours, cp).toContain(js);
    }
  });
});

describe("checks before a save", () => {
  const settings = { title: "T", language: "en" as const, aspect: "16:9" as const, targetSeconds: 300 };
  it("says what 0166 would refuse", () => {
    const s = (over: Partial<SceneDraft>) => ({ ...newSceneDraft("k", LIMITS), ...over });
    const codes = (scenes: SceneDraft[], st = settings) => draftProblems(st, scenes, [], LIMITS).map((p) => p.code);
    expect(codes([s({})])).toEqual([]);
    expect(codes([s({ firstFrame: "previous" })])).toContain("first_scene_previous");
    expect(codes([s({ lastFrame: "next_keyframe" })])).toContain("next_keyframe_needs_next");
    expect(codes([s({ lastFrame: "next_keyframe" }), s({ key: "b", firstFrame: "previous" })])).toContain("next_keyframe_needs_next");
    expect(codes([s({ lastFrame: "next_keyframe" }), s({ key: "b" })])).toEqual([]);
    expect(codes([s({ firstFrame: "asset" })])).toContain("first_frame_picture");
    expect(codes([s({ narration: "x".repeat(LIMITS.max_narration_chars + 1) })])).toContain("narration_too_long");
    expect(codes([s({ narration: "x".repeat(LIMITS.max_narration_chars) + "   " })])).toEqual([]);
    expect(codes([], { ...settings, title: "   " })).toContain("title_required");
    const long = Array.from({ length: 41 }, (_, i) => s({ key: `k${i}`, plannedSeconds: 30 }));
    expect(draftProblems(settings, long, [], LIMITS).find((p) => p.code === "film_too_long")).toMatchObject({ n: 1230, max: 1200 });
  });
});

describe("the station track", () => {
  it("lights the idea and marks the storyboard; nothing this release cannot do is lit", () => {
    expect(stationStates()).toEqual({ idea: "done", storyboard: "current", sound: "later", shoot: "later", assemble: "later", handoff: "later" });
  });
});

describe("the browser's calls", () => {
  it("go to the app's own routes, same origin, and read the answer as a read model", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ film: filmJson() }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = filmsApi(f);
    const r = await api.save(FILM, 3, { title: "x" });
    expect(r.ok).toBe(true);
    expect(seen[0].url).toBe(`/api/films/${FILM}`);
    expect(seen[0].init.method).toBe("PATCH");
    expect(seen[0].init.credentials).toBe("same-origin");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ version: 3, patch: { title: "x" } });
    await api.archive(FILM);
    expect(seen[1]).toMatchObject({ url: `/api/films/${FILM}/archive`, init: { method: "POST" } });
    await api.list(true);
    expect(seen[2].url).toBe("/api/films?archived=1");
  });

  it("a network failure is 'network', and an answer that is not a read model is 'failed'", async () => {
    const down = filmsApi((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(await down.get(FILM)).toEqual({ ok: false, error: "network" });
    const junk = filmsApi((async () => new Response(JSON.stringify({ film: { id: 1 } }), { status: 200 })) as unknown as typeof fetch);
    expect(await junk.get(FILM)).toEqual({ ok: false, error: "failed" });
    const conflict = filmsApi((async () => new Response(JSON.stringify({ error: "film_changed" }), { status: 409 })) as unknown as typeof fetch);
    expect(await conflict.save(FILM, 1, { title: "x" })).toEqual({ ok: false, error: "film_changed" });
  });

  it("idempotency keys fit 0166's rule and do not repeat", () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(IDEM_RE);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it("nothing on the Projects path holds the service key or talks to Supabase from the browser (rule 3)", () => {
    const files = [
      "lib/films.ts",
      "lib/server/films.ts",
      "app/api/films/route.ts",
      "app/api/films/[id]/route.ts",
      "app/api/films/[id]/archive/route.ts",
      "components/films/FilmList.tsx",
      "components/films/FilmCanvas.tsx",
      "components/films/useFilmProject.ts",
      "components/films/SceneBoard.tsx",
      "components/films/SceneDetail.tsx",
      "components/films/ProjectPanel.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/SERVICE_ROLE|service_role|serviceRole|SUPABASE_SERVICE|createServiceClient|createAdminClient/);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*FILM/);
    }
    for (const f of files.filter((x) => x.startsWith("components/") || x === "lib/films.ts")) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/@\/lib\/supabase|@supabase\/|process\.env/);
    }
    // The server side builds its client only from the member's own session (anon key + cookie).
    expect(readFileSync(join(root, "lib/server/films.ts"), "utf8")).toContain('import { createClient, getUser } from "@/lib/supabase/server"');
  });
});
