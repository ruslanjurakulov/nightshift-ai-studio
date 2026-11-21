/**
 * The owner's model switch (migration 0124, docs/MODEL_SWITCH.md), as the Command Center reads and asks for it.
 *
 * Pure and free of server-only imports, so the route, the owner's board and the tests share ONE reading of what the database answers:
 *
 *  - the closed list of reasons (the same four words as the SQL CHECK and `owner_set_model_switch`),
 *  - the request checks the route makes before it calls the database (the database checks again; these exist so a malformed request is a
 *    400 with a code the screen can word, not a Postgres error),
 *  - the database's document (`owner_model_switches()`) as typed rows, a malformed row dropped and never guessed,
 *  - the small derivations the board needs.
 *
 * What the database decides is never decided here: whether a model is hidden comes from `hidden` in its document, never from this file's
 * reading of the rows. Nothing in here spends, publishes or calls a vendor.
 */

/** The closed list. SQL: model_availability_reason_check and the array in owner_set_model_switch. Keep the three in step. */
export const SWITCH_REASONS = ["out_of_funds", "vendor_outage", "terms_review", "other"] as const;
export type SwitchReason = (typeof SWITCH_REASONS)[number];

export const SWITCH_SCOPES = ["model", "provider"] as const;
export type SwitchScope = (typeof SWITCH_SCOPES)[number];

/** The note's length, in characters as Postgres counts them (code points). */
export const SWITCH_NOTE_MAX = 200;

/** Every refusal the database (owner_err) or the route can give to this screen. Each has a sentence in the screen's dictionary. */
export const SWITCH_REFUSALS = [
  // the front door of every owner function
  "mfa_required",
  "rate_limited",
  // this migration's own
  "owner_required",
  "not_enforced",
  "bad_scope",
  "bad_enabled",
  "unknown_target",
  "bad_reason",
  "bad_note",
  "confirm_required",
  "no_such_alert",
  // a route's own
  "unauthorized",
  "forbidden",
  "migration_missing",
  "not_found",
  "bad_request",
  "bad_reply",
  "rpc_failed",
  "not_configured",
] as const;
export type SwitchRefusal = (typeof SWITCH_REFUSALS)[number];

export function isSwitchRefusal(code: unknown): code is SwitchRefusal {
  return typeof code === "string" && (SWITCH_REFUSALS as readonly string[]).includes(code);
}

export function isSwitchReason(v: unknown): v is SwitchReason {
  return typeof v === "string" && (SWITCH_REASONS as readonly string[]).includes(v);
}

/** The flag's value: only the literal "on" turns the owner's section and route on. Empty or anything else is off. */
export function parseModelSwitchFlag(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "on";
}

// ── the request ─────────────────────────────────────────────────────────────

export type SwitchCall = { fn: string; args: Record<string, unknown> };
export type SwitchParse = { ok: true; call: SwitchCall } | { ok: false; error: SwitchRefusal };

const bad = (error: SwitchRefusal): SwitchParse => ({ ok: false, error });
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Registry ids and provider ids, in the shapes migration 0035 accepts (a lower-case token; no path, no space). */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,39}$/;
const PROVIDER_ID = /^[a-z0-9-]{2,32}$/;

/** Characters as Postgres counts them (char_length: code points), not UTF-16 units. */
function charCount(s: string): number {
  return Array.from(s).length;
}

function target(scope: SwitchScope, v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return (scope === "model" ? MODEL_ID : PROVIDER_ID).test(t) ? t : null;
}

/**
 * The body of POST /api/owner/model-switch. Three actions, each one database function and nothing else:
 *  - preview  { scope, target }                                   -> owner_model_switch_preview (counts, for the confirmation)
 *  - set      { scope, target, enabled, reason?, note?, confirm? } -> owner_set_model_switch
 *  - dismiss  { id }                                              -> owner_model_alert_dismiss
 */
export function parseModelSwitch(body: unknown): SwitchParse {
  const b = obj(body);
  if (!b) return bad("bad_request");
  const action = b.action;
  if (action === "dismiss") {
    const id = b.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return bad("no_such_alert");
    return { ok: true, call: { fn: "owner_model_alert_dismiss", args: { p_id: id } } };
  }
  if (action !== "preview" && action !== "set") return bad("bad_request");
  const scope = typeof b.scope === "string" ? (b.scope as SwitchScope) : null;
  if (scope === null || !(SWITCH_SCOPES as readonly string[]).includes(scope)) return bad("bad_scope");
  const id = target(scope, b.target);
  if (id === null) return bad("unknown_target");
  if (action === "preview") return { ok: true, call: { fn: "owner_model_switch_preview", args: { p_scope: scope, p_target: id } } };

  if (typeof b.enabled !== "boolean") return bad("bad_enabled");
  let reason: string | null = null;
  let note: string | null = null;
  if (!b.enabled) {
    if (!isSwitchReason(b.reason)) return bad("bad_reason");
    reason = b.reason;
    if (b.note !== undefined && b.note !== null) {
      if (typeof b.note !== "string") return bad("bad_note");
      const n = b.note.trim();
      if (charCount(n) > SWITCH_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(n)) return bad("bad_note");
      note = n === "" ? null : n;
    }
  }
  return {
    ok: true,
    call: {
      fn: "owner_set_model_switch",
      args: { p_scope: scope, p_target: id, p_enabled: b.enabled, p_reason: reason, p_note: note, p_confirm: b.confirm === true },
    },
  };
}

// ── the document ────────────────────────────────────────────────────────────

export interface SwitchInfo {
  enabled: boolean;
  /** null when the row is ON (it carries none) or the database sent a word this build does not know. */
  reason: SwitchReason | null;
  note: string | null;
  changedAt: string | null;
  changedBy: string | null;
}

export interface SwitchModel {
  id: string;
  displayName: string;
  capabilities: string[];
  /** The sale lifecycle of 0035 (hidden, beta, ga, disabled): shown beside the switch, never changed by it. */
  availability: string;
  /** This model's own row, or null: it was never switched (= enabled). */
  switch: SwitchInfo | null;
  /** Not offered to users right now (its own row or its provider's), and only while the switches are in force. */
  hidden: boolean;
}

export interface SwitchProvider {
  provider: string;
  switch: SwitchInfo | null;
  hidden: boolean;
  models: SwitchModel[];
}

export interface SwitchAlert {
  id: number;
  provider: string;
  failures: number;
  windowMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface SwitchLogRow {
  at: string | null;
  kind: "switch" | "settings" | "alert_dismissed";
  scope: SwitchScope | null;
  target: string | null;
  enabled: boolean | null;
  previousEnabled: boolean | null;
  reason: SwitchReason | null;
  note: string | null;
  jobsStopped: number;
  inFlight: number;
  actor: string | null;
}

export interface SwitchDoc {
  /** Are the owner's switches in force? While false nothing is hidden and nothing can be switched. */
  enforced: boolean;
  autoSuggest: boolean;
  suggestThreshold: number;
  suggestWindowMinutes: number;
  providers: SwitchProvider[];
  alerts: SwitchAlert[];
  log: SwitchLogRow[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function info(raw: unknown): SwitchInfo | null {
  const o = obj(raw);
  if (!o || typeof o.enabled !== "boolean") return null;
  return {
    enabled: o.enabled,
    reason: isSwitchReason(o.reason) ? o.reason : null,
    note: str(o.note),
    changedAt: str(o.changed_at),
    changedBy: str(o.changed_by_email),
  };
}

/** The database's `owner_model_switches()` as typed rows. A row that is not what it should be is dropped, never shown with a guess. */
export function coerceSwitchDoc(raw: unknown): SwitchDoc | null {
  const d = obj(raw);
  if (!d || typeof d.enforced !== "boolean") return null;
  const providers: SwitchProvider[] = [];
  for (const p of arr(d.providers)) {
    const po = obj(p);
    const id = po ? str(po.provider) : null;
    if (!po || !id || typeof po.hidden !== "boolean") continue;
    const models: SwitchModel[] = [];
    for (const m of arr(po.models)) {
      const mo = obj(m);
      const mid = mo ? str(mo.id) : null;
      if (!mo || !mid || typeof mo.hidden !== "boolean") continue;
      models.push({
        id: mid,
        displayName: str(mo.display_name) ?? mid,
        capabilities: arr(mo.capabilities).filter((c): c is string => typeof c === "string"),
        availability: str(mo.availability) ?? "hidden",
        switch: info(mo.switch),
        hidden: mo.hidden,
      });
    }
    providers.push({ provider: id, switch: info(po.switch), hidden: po.hidden, models });
  }
  const alerts: SwitchAlert[] = [];
  for (const a of arr(d.alerts)) {
    const ao = obj(a);
    const prov = ao ? str(ao.provider) : null;
    if (!ao || !prov || typeof ao.id !== "number") continue;
    alerts.push({
      id: ao.id,
      provider: prov,
      failures: int(ao.failures),
      windowMinutes: int(ao.window_minutes),
      firstAt: str(ao.first_at),
      lastAt: str(ao.last_at),
    });
  }
  const log: SwitchLogRow[] = [];
  for (const l of arr(d.log)) {
    const lo = obj(l);
    if (!lo) continue;
    const kind = lo.kind;
    if (kind !== "switch" && kind !== "settings" && kind !== "alert_dismissed") continue;
    log.push({
      at: str(lo.at),
      kind,
      scope: lo.scope === "model" || lo.scope === "provider" ? lo.scope : null,
      target: str(lo.target),
      enabled: typeof lo.enabled === "boolean" ? lo.enabled : null,
      previousEnabled: typeof lo.previous_enabled === "boolean" ? lo.previous_enabled : null,
      reason: isSwitchReason(lo.reason) ? lo.reason : null,
      note: str(lo.note),
      jobsStopped: int(lo.jobs_stopped),
      inFlight: int(lo.in_flight),
      actor: str(lo.actor_email),
    });
  }
  return {
    enforced: d.enforced,
    autoSuggest: d.auto_suggest === true,
    suggestThreshold: int(d.suggest_threshold),
    suggestWindowMinutes: int(d.suggest_window_minutes),
    providers,
    alerts,
    log,
  };
}

/** The numbers a confirmation shows: from `owner_model_switch_preview` or from a `confirm_required` answer. */
export interface SwitchCounts {
  /** Not yet sent to the vendor (queued, or claimed and not sent): they would be stopped and their credits returned. */
  waiting: number;
  /** Already with the vendor: they finish and are charged as before. */
  inFlight: number;
}

export function coerceCounts(raw: unknown): SwitchCounts | null {
  const o = obj(raw);
  if (!o || typeof o.waiting !== "number" || typeof o.in_flight !== "number") return null;
  return { waiting: int(o.waiting), inFlight: int(o.in_flight) };
}

/**
 * The ids a model list must not offer: what the database says is switched off. A platform admin's read of the registry is not
 * filtered by the policy (an admin sees every row), so the Command Center subtracts these from the Studio's list.
 */
export function withoutSwitchedOff<T extends { id: string }>(models: readonly T[], off: readonly string[]): T[] {
  if (off.length === 0) return [...models];
  const hidden = new Set(off);
  return models.filter((m) => !hidden.has(m.id));
}

/** `models_switched_off()` as ids; anything that is not a list of strings reads as "none", the safe direction for a list. */
export function coerceOffIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && MODEL_ID.test(x)) : [];
}
