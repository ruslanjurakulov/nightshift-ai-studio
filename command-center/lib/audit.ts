/**
 * Audit-trail shared helpers — pure, dependency-free, safe to import from both
 * the server helper and the (server) page. No secret values ever flow through
 * here: the detail blob carries names and counts only.
 */

/** One row of `public.app_audit_log`, as read back over the wire. */
export type AuditRow = {
  id: string;
  at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  channel_id: string | null;
};

/**
 * Render an audit `detail` blob as a compact, human-readable one-liner for the
 * table. Arrays are joined, scalars printed, objects flattened to `k=v`; an
 * empty or absent blob yields "" so the cell simply stays blank. Never throws.
 */
export function formatAuditDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const entries = Object.entries(detail as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(", ");
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(" ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
