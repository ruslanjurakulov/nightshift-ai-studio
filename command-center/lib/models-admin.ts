/**
 * The operator's model availability screen (migration 0035): the shapes the
 * page and the availability route share, and the input check the route runs
 * before anything reaches the database.
 *
 * Pure: no server imports, so the client board and tests use it as is. The
 * database is still the authority — CHECKs refuse beta/ga without a probe,
 * with an open vendor-terms gate or without a credit unit, and RLS refuses
 * anyone but a platform admin. This file only lets the screen say why first.
 */

export const AVAILABILITIES = ["hidden", "beta", "ga", "disabled"] as const;
export type Availability = (typeof AVAILABILITIES)[number];

/** The id shape 0035's model_registry_id_check accepts. */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{1,39}$/;

export function isAvailability(v: unknown): v is Availability {
  return typeof v === "string" && (AVAILABILITIES as readonly string[]).includes(v);
}

export function isModelId(v: unknown): v is string {
  return typeof v === "string" && MODEL_ID_RE.test(v);
}

/** beta/ga put a model in front of customers; the database needs proof first. */
export function isOnSale(a: Availability): boolean {
  return a === "beta" || a === "ga";
}

export type AvailabilityRequest = { ok: true; id: string; availability: Availability } | { ok: false; error: "bad_model_id" | "bad_availability" | "bad_request" };

/** `{ id, availability }` from a request body, or why not. Nothing else is accepted. */
export function parseAvailabilityRequest(body: unknown): AvailabilityRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "bad_request" };
  const { id, availability } = body as Record<string, unknown>;
  if (!isModelId(id)) return { ok: false, error: "bad_model_id" };
  if (!isAvailability(availability)) return { ok: false, error: "bad_availability" };
  return { ok: true, id, availability };
}

export interface ProbeSummary {
  ok: boolean;
  /** One of the capability layer's typed codes when the call failed. */
  errorCode: string | null;
  capability: string;
  at: string;
}

export interface AdminModel {
  id: string;
  displayName: string;
  provider: string;
  capabilities: string[];
  availability: Availability;
  verifiedAt: string | null;
  verifiedBy: string | null;
  creditUnit: string | null;
  entitlement: string | null;
  /** spec.terms_gate: vendor terms not yet satisfied (beta/ga refused). */
  termsGate: string | null;
  /** spec.removed_from_file: disabled because it left the reviewed JSON. */
  removedFromFile: boolean;
  updatedAt: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Rows from model_registry_admin() as typed models. Only the fields this
 * screen shows are kept: spec carries provider USD costs and internal notes,
 * so nothing of it but the terms gate and the removed flag leaves the server.
 */
export function coerceAdminModels(rows: unknown): AdminModel[] {
  if (!Array.isArray(rows)) return [];
  const out: AdminModel[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const id = str(r.id);
    const provider = str(r.provider);
    if (!id || !provider || !isAvailability(r.availability)) continue;
    const spec = isObj(r.spec) ? r.spec : {};
    out.push({
      id,
      displayName: str(r.display_name) ?? id,
      provider,
      capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c): c is string => typeof c === "string") : [],
      availability: r.availability,
      verifiedAt: str(r.verified_at),
      verifiedBy: str(r.verified_by),
      creditUnit: str(r.credit_unit),
      entitlement: str(r.entitlement),
      termsGate: str(spec.terms_gate),
      removedFromFile: spec.removed_from_file === true,
      updatedAt: str(r.updated_at),
    });
  }
  return out;
}

/** The newest probe per model, from model_probe_runs rows ordered newest first. */
export function latestProbes(rows: unknown): Record<string, ProbeSummary> {
  const out: Record<string, ProbeSummary> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!isObj(r)) continue;
    const id = str(r.model_id);
    const at = str(r.created_at);
    if (!id || !at || typeof r.ok !== "boolean") continue;
    const prev = out[id];
    if (prev && prev.at >= at) continue;
    out[id] = { ok: r.ok, errorCode: str(r.error_code), capability: str(r.capability) ?? "", at };
  }
  return out;
}

/**
 * Why `to` would be refused for `m` — the same three CHECKs 0035 enforces —
 * or null. Moving to hidden or disabled is always allowed.
 */
export type Blocker = "not_verified" | "terms_gate" | "no_credit_unit";

export function availabilityBlocker(m: Pick<AdminModel, "verifiedAt" | "termsGate" | "creditUnit">, to: Availability): Blocker | null {
  if (!isOnSale(to)) return null;
  if (!m.verifiedAt) return "not_verified";
  if (m.termsGate) return "terms_gate";
  if (!m.creditUnit) return "no_credit_unit";
  return null;
}
