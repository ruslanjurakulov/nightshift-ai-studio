/**
 * The platforms the results dashboard knows about, and what it may honestly say about each one.
 *
 * A registry, not a list of if-statements: the dashboard draws one card per entry, and a card's wording follows from two
 * facts only, (1) can a person connect this platform today and (2) does the dashboard have results for it today. Adding
 * a platform is one line here plus its words in lib/i18n/results-dashboard; nothing else in the page changes.
 *
 * `worker` mirrors the worker's publisher registry (modules/publishers.py): `live` = registered and connectable
 * (instagram, tiktok, youtube), `dark` = registered but nothing can reach it yet (no connect flow, no platform app:
 * Facebook, X), `none` = no publisher at all (nobody today). `publish` ("a person can connect it and cross-post today") is
 * `available` only for `live`, so a dark publisher's card still says "coming". tests/results-dashboard-platforms.test.ts reads
 * modules/social_publish.py and fails when the two disagree, so a platform cannot become connectable on the worker while this
 * page still says "coming".
 *
 * `results` is `live` only where this repository already collects results (YouTube Analytics through the daily poll into
 * metrics_snapshots). Instagram insights need a scope the connect flow does not request, TikTok's video list needs one it
 * does not request, and X / Facebook cannot be connected at all (docs/RESULTS_DASHBOARD.md, "What each platform allows"): all `planned`, and a
 * planned platform never shows a number, not even zero.
 */

export const PLATFORM_IDS = ["youtube", "instagram", "tiktok", "x", "facebook"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export interface PlatformSpec {
  id: PlatformId;
  /** Is a publisher registered on the worker, and can it be reached? `dark` = registered, not connectable. */
  worker: "live" | "dark" | "none";
  /** Can an organization connect this platform and cross-post to it today (a registered worker publisher)? */
  publish: "available" | "none";
  /** Does the dashboard have results for it today? */
  results: "live" | "planned";
}

export const PLATFORMS: readonly PlatformSpec[] = [
  { id: "youtube", worker: "live", publish: "available", results: "live" },
  { id: "instagram", worker: "live", publish: "available", results: "planned" },
  { id: "tiktok", worker: "live", publish: "available", results: "planned" },
  { id: "x", worker: "dark", publish: "none", results: "planned" },
  { id: "facebook", worker: "dark", publish: "none", results: "planned" },
];

/**
 * - `live`: connected, and results are shown for it.
 * - `connected_results_coming`: connected, but this dashboard has no results for the platform yet.
 * - `not_connected`: can be connected today, and is not.
 * - `coming`: cannot be connected yet (no publisher), so there is nothing to connect.
 */
export type PlatformState = "live" | "connected_results_coming" | "not_connected" | "coming" | "unknown";

/**
 * `connected` null means the read of the connected accounts failed or the table is not there: the card then says it could
 * not check, instead of "not connected" (an unknown is not a no, CLAUDE.md #5). A platform nobody can connect yet is
 * "coming" whatever the read says.
 */
export function platformState(spec: PlatformSpec, connected: number | null): PlatformState {
  if (spec.publish === "none") return "coming";
  if (connected === null) return "unknown";
  if (!Number.isFinite(connected) || connected <= 0) return "not_connected";
  return spec.results === "live" ? "live" : "connected_results_coming";
}

export interface PlatformCard {
  id: PlatformId;
  state: PlatformState;
  /** How many accounts of this organization are connected right now: 0 for a platform that cannot be connected, null when unknown. */
  connected: number | null;
}

/**
 * One card per registry entry, in registry order. `connectedByPlatform` holds the counts the server read under RLS; a
 * platform missing from it (or null) is unknown, not zero.
 */
export function platformCards(connectedByPlatform: Partial<Record<PlatformId, number | null>>): PlatformCard[] {
  return PLATFORMS.map((spec) => {
    const raw = connectedByPlatform[spec.id];
    const connected = spec.publish === "none" ? 0 : typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : null;
    return { id: spec.id, state: platformState(spec, connected), connected };
  });
}
