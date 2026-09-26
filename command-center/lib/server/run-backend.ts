import "server-only";
import { isSupabaseConfigured } from "../config";
import { isGithubConfigured } from "./github-secrets";
import { isRunConfigured, resolveRunBackend, type RunBackend } from "../runBackend";

/** This deployment's "Run now" backend (server env NIGHTSHIFT_RUN_BACKEND). */
export const runBackend: RunBackend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });

/** Whether "Run now" can start a run on that backend — what the pages pass to
 *  the button, so it explains what is missing instead of failing on click. */
export const isRunNowConfigured = isRunConfigured(runBackend, {
  github: isGithubConfigured,
  supabase: isSupabaseConfigured,
});
