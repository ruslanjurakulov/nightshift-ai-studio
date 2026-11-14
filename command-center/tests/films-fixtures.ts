/** Shared fixtures for the Studio → Projects tests (a film_json answer as 0166 shapes it, with the migration's own limits). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMIT_KEYS, type FilmLimits } from "../lib/films";

export const root = join(__dirname, "..");
export const migration = readFileSync(join(root, "..", "supabase", "migrations", "0166_films_core.sql"), "utf8");

/** film_limits() as 0166 writes it, read from the migration's text. */
export function migrationLimits(): Record<string, number> {
  const body = migration.slice(migration.indexOf("create or replace function public.film_limits()"));
  const obj = body.slice(body.indexOf("jsonb_build_object("), body.indexOf("$$;"));
  return Object.fromEntries([...obj.matchAll(/'([a-z_]+)',\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
}

export const FILM = "0f000000-0000-4000-8000-00000000000f";
export const ORG = "0a000000-0000-4000-8000-00000000000a";
export const S1 = "51000000-0000-4000-8000-000000000001";
export const S2 = "52000000-0000-4000-8000-000000000002";
export const PIC = "0c000000-0000-4000-8000-00000000000c";
export const LIMITS: FilmLimits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, migrationLimits()[k]])) as FilmLimits;

export function filmJson(over: Record<string, unknown> = {}, scenes: Record<string, unknown>[] = []) {
  return {
    film: {
      id: FILM, org_id: ORG, channel_id: null, title: "The stadium in orbit", source_kind: "topic", source_text: "Football in 2050",
      language: "en", aspect: "16:9", target_seconds: 300, status: "draft", version: 3, created_at: "2026-11-14T08:00:00Z",
      updated_at: "2026-11-14T09:00:00Z", archived_at: null, ...over,
    },
    editable: (over.status ?? "draft") === "draft" || over.status === "planned",
    totals: { scenes: scenes.length, planned_seconds: scenes.reduce((s, x) => s + Number(x.planned_seconds ?? 0), 0) },
    refs: [],
    scenes,
    takes: [],
    events: [],
    events_total: 1,
    events_truncated: false,
    limits: migrationLimits(),
  };
}

export function sceneJson(id: string, position: number, over: Record<string, unknown> = {}) {
  return {
    id, position, title: `Scene ${position + 1}`, narration: "Words.", visual_prompt: "A stadium.", negative_prompt: "",
    planned_seconds: 8, shot_count: 1, first_frame: "keyframe", first_frame_asset_id: null, last_frame: "none",
    last_frame_asset_id: null, keyframe_model: null, clip_model: null, clip_params: {}, transition_in: null,
    current_version: null, status: "draft", first_frame_missing: false, last_frame_missing: false, refs: [], takes: [], ...over,
  };
}
