/** Shared fixtures for the Studio → Projects tests (a film_json answer as 0166 shapes it, with the migration's own limits). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMIT_KEYS, type FilmLimits } from "../lib/films";

export const root = join(__dirname, "..");
export const migration = readFileSync(join(root, "..", "supabase", "migrations", "0166_films_core.sql"), "utf8");

/** The latest migration that writes film_limits() (0166, then 0198's 10-second films), read from the directory, not named. */
export function limitsMigration(): string {
  const dir = join(root, "..", "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  let out = migration;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    if (text.includes("create or replace function public.film_limits()")) out = text;
  }
  return out;
}

/** film_limits() as the latest migration writes it, read from its text. */
export function migrationLimits(): Record<string, number> {
  const text = limitsMigration();
  const body = text.slice(text.indexOf("create or replace function public.film_limits()"));
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

/** 0198's workspace switch as the member's client reads it: one row per workspace asked about, or none (`[]`, a workspace never switched). */
export type OrgSwitchAnswer = { data: unknown; error: { code?: string; message?: string } | null } | Error;

/**
 * A Supabase client's `from` that answers org_film_settings (the workspace switch filmGate reads under `on`) and hands every other
 * table to `rest`, so a test's own table mock never sees the switch read. `answer` defaults to ORG switched on.
 */
export function withOrgSwitch(rest: (table: string) => unknown, answer: () => OrgSwitchAnswer = () => ({ data: [{ org_id: ORG, film_studio_enabled: true }], error: null })) {
  return (table: string) => {
    if (table !== "org_film_settings") return rest(table);
    return {
      select: () => ({
        in: async () => {
          const a = answer();
          if (a instanceof Error) throw a;
          return a;
        },
      }),
    };
  };
}

/** The open workspace as getOrgContext gives it (ORG, an editor). */
export const ORG_CONTEXT = { supported: true, orgs: [], switchable: [], current: { id: ORG, role: "editor" } };
