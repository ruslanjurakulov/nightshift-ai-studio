import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { coerceOffIds, coerceSwitchDoc, parseModelSwitchFlag, type SwitchDoc } from "@/lib/model-switch";

/**
 * NIGHTSHIFT_MODEL_SWITCH — a server env var, exactly `on` to show the owner's switches and let the route answer (default off).
 *
 * It is the SAME variable the queue worker reads (modules/model_switch.py), so one repository variable switches both. Off (empty or
 * anything else): the owner's Models page has no "Switches" view, no database read is made for it, and a same-origin POST to
 * /api/owner/model-switch answers 404. It does NOT put the switches in force: that is the database's own flag
 * (model_availability_settings.enforced, default false, set in the SQL editor), and while it is false nothing is hidden and nothing can be
 * switched whatever this variable says. The two are separate on purpose (docs/MODEL_SWITCH.md). Read on every call, never at import: a
 * restart is enough. The read names the variable literally because tests/test_deploy_self_host.py scans for exactly that, so the name is
 * also in deploy/.env.web.example and .github/workflows/deploy_web.yml.
 */
export function modelSwitchOn(): boolean {
  return parseModelSwitchFlag(process.env.NIGHTSHIFT_MODEL_SWITCH);
}

type PgError = { code?: string | null; message?: string | null } | null;

export type SwitchRead =
  | { status: "ok"; doc: SwitchDoc }
  /** Migration 0124 is not applied on this database. */
  | { status: "not_enabled" }
  /** The signed-in person is not the platform owner (the function refuses everyone else). */
  | { status: "forbidden" }
  | { status: "failed" };

/** 42883 / PGRST202: the function is not there (0124 not applied or the schema cache is stale). */
function missing(error: PgError): boolean {
  return ["42883", "PGRST202"].includes(error?.code ?? "");
}

/**
 * The owner's Models section, read as the signed-in person (the anon key and their session; never a service key). The database answers
 * the platform owner only; an admin who is not the owner gets `forbidden`, so does everybody else. A failed or malformed read is
 * "failed", which the page says, never an empty board that reads as "nothing is switched".
 */
export async function readModelSwitches(supabase: Pick<SupabaseClient, "rpc">): Promise<SwitchRead> {
  try {
    const { data, error } = await supabase.rpc("owner_model_switches");
    if (error) {
      if (missing(error)) return { status: "not_enabled" };
      if (error.code === "42501") return { status: "forbidden" };
      return { status: "failed" };
    }
    const doc = coerceSwitchDoc(data);
    return doc ? { status: "ok", doc } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

/**
 * The model ids a user is not offered right now (models_switched_off(), migration 0124), as the signed-in person. Without the migration,
 * or on any failure, none: today's behaviour (the quote and the create refuse a switched-off model anyway).
 */
export async function readSwitchedOffIds(supabase: Pick<SupabaseClient, "rpc">): Promise<string[]> {
  try {
    const { data, error } = await supabase.rpc("models_switched_off");
    return error ? [] : coerceOffIds(data);
  } catch {
    return [];
  }
}
