import { BILLED_PROVIDERS } from "@/lib/billing";
import { roleName } from "@/lib/owner-rpc";

/**
 * Reading what the owner functions and tables return (migrations 0106 and 0107), pure and defensive.
 *
 * Every figure here follows the project's rule: an unknown is not a zero. A value the database did not send, or sent
 * in a shape this code does not know, becomes `null` and the screen says "unknown"; it is never defaulted to 0, to
 * "off" or to an empty list that would read as "nothing happened".
 */

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
function fin(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// ─── The Security page: owner_security_get() and owner_security_events() ──────────────────────────────

export interface OwnerAdmin {
  email: string;
  role: string;
  /** The roster row is tied to an account that has signed in. */
  bound: boolean;
  verifiedFactors: number | null;
}

export interface OwnerSecurity {
  gateOn: boolean;
  recentMfaMinutes: number | null;
  grantMaxPerCall: number | null;
  grantMax24h: number | null;
  priceMaxRatio: number | null;
  reverseWindowDays: number | null;
  /** Would THIS session pass the gate if it were on right now? (`why` names the reason in the database's words.) */
  caller: { passes: boolean | null; why: string | null; aal: string | null; hasVerifiedFactor: boolean | null };
  wouldBlockAfterEnable: boolean | null;
  admins: OwnerAdmin[];
  /** False when auth.mfa_factors could not be read: the factor counts are then unknown, not zero. */
  factorsReadable: boolean;
  canEnable: boolean | null;
}

/** The document owner_security_get() returns, or null when it is not one (the page then says it could not read it). */
export function coerceOwnerSecurity(data: unknown): OwnerSecurity | null {
  const d = rec(data);
  if (!d || d.ok !== true) return null;
  const s = rec(d.settings);
  if (!s || typeof s.admin_aal2_required !== "boolean") return null;
  const caller = rec(d.caller) ?? {};
  const factorsReadable = d.factors_readable === true;
  const admins = Array.isArray(d.admins)
    ? d.admins.flatMap((a): OwnerAdmin[] => {
        const r = rec(a);
        const email = text(r?.email);
        if (!r || !email) return [];
        return [{ email, role: roleName(r.role) ?? String(r.role ?? ""), bound: r.bound === true, verifiedFactors: factorsReadable ? fin(r.verified_factors) : null }];
      })
    : [];
  return {
    gateOn: s.admin_aal2_required,
    recentMfaMinutes: fin(s.recent_mfa_minutes),
    grantMaxPerCall: fin(s.grant_max_per_call),
    grantMax24h: fin(s.grant_max_per_24h),
    priceMaxRatio: fin(s.price_max_change_ratio),
    reverseWindowDays: fin(s.reverse_window_days),
    caller: {
      passes: typeof caller.ok === "boolean" ? caller.ok : null,
      why: text(caller.why),
      aal: text(caller.aal),
      hasVerifiedFactor: typeof caller.has_verified_factor === "boolean" ? caller.has_verified_factor : null,
    },
    wouldBlockAfterEnable: typeof d.would_block_after_enable === "boolean" ? d.would_block_after_enable : null,
    admins,
    factorsReadable,
    canEnable: typeof d.can_enable === "boolean" ? d.can_enable : null,
  };
}

export interface SecurityEvent {
  id: number;
  at: string;
  kind: string;
  severity: "info" | "notice" | "warning" | "critical";
  actorEmail: string | null;
  actorRole: string | null;
  target: string | null;
  /** The free-text reason the owner typed, when the event carries one. Nothing else of `detail` is shown. */
  reason: string | null;
}

const SEVERITIES = ["info", "notice", "warning", "critical"] as const;

export function coerceSecurityEvents(data: unknown): SecurityEvent[] | null {
  if (!Array.isArray(data)) return null;
  return data.flatMap((row): SecurityEvent[] => {
    const r = rec(row);
    const id = fin(r?.id);
    const at = text(r?.at);
    const kind = text(r?.kind);
    if (!r || id === null || !at || !kind) return [];
    const severity = (SEVERITIES as readonly string[]).includes(String(r.severity)) ? (r.severity as SecurityEvent["severity"]) : "notice";
    return [{ id, at, kind, severity, actorEmail: text(r.actor_email), actorRole: text(r.actor_role), target: text(r.target), reason: text(rec(r.detail)?.reason) }];
  });
}

// ─── The price history (credit_price_history, admin-readable) ──────────────────────────────────────────

export interface PriceHistoryEntry {
  id: number;
  at: string;
  unit: string;
  action: "set" | "delete" | "restore";
  oldRate: number | null;
  oldMargin: number | null;
  newRate: number | null;
  newMargin: number | null;
  reason: string | null;
  /** `direct`: written straight to the table by a browser, not through an owner function. */
  source: "rpc" | "direct";
}

export function coercePriceHistory(rows: unknown): PriceHistoryEntry[] | null {
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((row): PriceHistoryEntry[] => {
    const r = rec(row);
    const id = fin(r?.id);
    const at = text(r?.at);
    const unit = text(r?.unit);
    const action = r?.action;
    if (!r || id === null || !at || !unit || (action !== "set" && action !== "delete" && action !== "restore")) return [];
    return [
      {
        id,
        at,
        unit,
        action,
        oldRate: fin(r.old_credits_per_unit),
        oldMargin: fin(r.old_margin),
        newRate: fin(r.new_credits_per_unit),
        newMargin: fin(r.new_margin),
        reason: text(r.reason),
        source: r.source === "direct" ? "direct" : "rpc",
      },
    ];
  });
}

// ─── Billing: owner_provider_spend(p_days) ────────────────────────────────────────────────────────────

export interface SpendRow {
  /** 'YYYY-MM-DD' (UTC), or null for a row whose recorded_at is not an ISO date: shown, never hidden. */
  day: string | null;
  provider: string;
  /** Null when ANY row of that day and provider has no price: a partial sum would read as the whole cost. */
  usd: number | null;
  usdPriced: number | null;
  unpricedRows: number;
  units: number | null;
  unit: string | null;
  runs: number | null;
}

export function coerceProviderSpend(data: unknown): SpendRow[] | null {
  if (!Array.isArray(data)) return null;
  return data.flatMap((row): SpendRow[] => {
    const r = rec(row);
    const provider = text(r?.provider);
    if (!r || !provider) return [];
    return [
      {
        day: text(r.day),
        provider: provider.toLowerCase(),
        usd: fin(r.usd),
        usdPriced: fin(r.usd_priced),
        unpricedRows: fin(r.unpriced_rows) ?? 0,
        units: fin(r.units),
        unit: text(r.unit),
        runs: fin(r.runs),
      },
    ];
  });
}

/**
 * Names that are NOT a provider's bill: the ledger has no real provider on these rows, so owner_provider_spend names
 * them after the first word of their unit (0106). Their dollars are whatever estimate was recorded.
 */
export const ESTIMATE_NAMES = ["render", "pexels", "upload", "vision", "video", "image"] as const;

export interface ProviderSpend {
  provider: string;
  /** The provider's name as the Billing page writes it (lib/billing.ts), or null for a name that is not one of those. */
  label: string | null;
  kind: "billed" | "estimate";
  /** Total dollars, or null when ANY of its rows is unpriced (then `atLeastUsd` is the priced part). */
  usd: number | null;
  atLeastUsd: number | null;
  unpricedRows: number;
  /** Units when every day used the same unit and a quantity; null otherwise (mixed units do not add up). */
  units: number | null;
  unit: string | null;
  days: number;
  dateUnknown: boolean;
}

export interface SpendGroup {
  /** Null when any provider in the group is partly unpriced. */
  usd: number | null;
  atLeastUsd: number | null;
  unpricedRows: number;
}

export interface SpendSummary {
  providers: ProviderSpend[];
  billed: SpendGroup;
  estimates: SpendGroup;
}

const LABELS = new Map(BILLED_PROVIDERS.map((p) => [p.id, p.name]));

/** One line per provider over the whole window, billed providers first, biggest known spend first. */
export function summarizeProviderSpend(rows: readonly SpendRow[]): SpendSummary {
  const by = new Map<string, SpendRow[]>();
  for (const r of rows) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
  const providers: ProviderSpend[] = [...by.entries()].map(([provider, rs]) => {
    const unpricedRows = rs.reduce((s, r) => s + r.unpricedRows, 0);
    const anyUnknown = rs.some((r) => r.usd === null);
    const priced = rs.filter((r) => r.usdPriced !== null);
    const units = new Set(rs.map((r) => r.unit));
    const oneUnit = units.size === 1 && rs[0].unit !== null && rs[0].unit !== "mixed" && rs.every((r) => r.units !== null);
    return {
      provider,
      label: LABELS.get(provider) ?? null,
      kind: (ESTIMATE_NAMES as readonly string[]).includes(provider) ? "estimate" : "billed",
      usd: anyUnknown ? null : rs.reduce((s, r) => s + (r.usd ?? 0), 0),
      atLeastUsd: priced.length ? priced.reduce((s, r) => s + (r.usdPriced ?? 0), 0) : null,
      unpricedRows,
      units: oneUnit ? rs.reduce((s, r) => s + (r.units ?? 0), 0) : null,
      unit: oneUnit ? rs[0].unit : null,
      days: new Set(rs.filter((r) => r.day !== null).map((r) => r.day)).size,
      dateUnknown: rs.some((r) => r.day === null),
    };
  });
  const order = (p: ProviderSpend) => (p.usd ?? p.atLeastUsd ?? -1);
  providers.sort((a, b) => Number(a.kind === "estimate") - Number(b.kind === "estimate") || order(b) - order(a) || a.provider.localeCompare(b.provider));
  const group = (kind: ProviderSpend["kind"]): SpendGroup => {
    const ps = providers.filter((p) => p.kind === kind);
    const priced = ps.filter((p) => p.atLeastUsd !== null);
    return {
      usd: ps.length && ps.every((p) => p.usd !== null) ? ps.reduce((s, p) => s + (p.usd ?? 0), 0) : null,
      atLeastUsd: priced.length ? priced.reduce((s, p) => s + (p.atLeastUsd ?? 0), 0) : null,
      unpricedRows: ps.reduce((s, p) => s + p.unpricedRows, 0),
    };
  };
  return { providers, billed: group("billed"), estimates: group("estimate") };
}
