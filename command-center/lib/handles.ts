/**
 * The unique @username ("handle"): the rules, without React or Supabase.
 *
 * The database is the authority (migration 0096: handle_valid(), set_handle(),
 * the unique index). This file mirrors its format and reserved-word rules so
 * the form can say what is wrong while the person types, without a round trip;
 * tests/user-handles.test.ts reads the migration and fails if the two lists
 * drift. A handle is a label shown in Settings — it is never a way to sign in
 * and never a way to find an account.
 *
 * What the pages are told is deliberately small: a handle is "available",
 * "taken" (a held name and a reserved word read the same) or "unknown" (the
 * check could not answer just now — the form lets the person go on and the
 * database decides when the handle is saved).
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
export const HANDLE_CHANGE_DAYS = 30;
/** Sign-up stores the chosen handle here (user metadata) until the first session can apply it. */
export const HANDLE_META_KEY = "signup_handle";

/** Kept in step with handle_reserved() in supabase/migrations/0096_user_handles.sql. */
export const RESERVED_HANDLES: readonly string[] = [
  "admin", "administrator", "root", "superuser", "sysadmin", "support", "help", "helpdesk",
  "billing", "payments", "payment", "invoice", "api", "mcp", "oauth", "auth", "security",
  "system", "staff", "team", "moderator", "mod", "operator", "owner", "official",
  "null", "undefined", "none", "true", "false", "nan", "void", "anonymous", "unknown",
  "login", "logout", "signin", "signout", "signup", "register", "account", "accounts",
  "settings", "profile", "dashboard", "console", "app", "www", "web", "mail", "email",
  "noreply", "postmaster", "webmaster", "hostmaster", "abuse", "info", "contact", "sales",
  "press", "legal", "privacy", "terms", "pricing", "docs", "blog", "about", "status",
  "channel", "channels", "everyone", "here", "all", "me", "you", "user", "users",
];
export const RESERVED_PREFIX = "nightshift";

/** What is wrong with the shape of a handle (the rule the form then states). */
export type HandleProblem = "too_short" | "too_long" | "characters" | "dots" | "no_letter";

/** Trim, drop one leading "@" (people type it), lowercase. */
export function normalizeHandleInput(raw: string): string {
  const t = raw.trim();
  return (t.startsWith("@") ? t.slice(1) : t).toLowerCase();
}

/** The first thing wrong with the shape of `handle` (already normalized), or null. */
export function checkHandleFormat(handle: string): HandleProblem | null {
  if (handle.length < HANDLE_MIN) return "too_short";
  if (handle.length > HANDLE_MAX) return "too_long";
  if (!/^[a-z0-9._]+$/.test(handle)) return "characters";
  if (/^\.|\.$|\.\./.test(handle)) return "dots";
  if (!/[a-z0-9]/.test(handle)) return "no_letter";
  return null;
}

/** A word that reads as the platform. Dots and underscores do not hide it ("a.d.m.i.n"). */
export function isReservedHandle(handle: string): boolean {
  const compact = handle.replace(/[._]/g, "");
  return compact.startsWith(RESERVED_PREFIX) || RESERVED_HANDLES.includes(compact);
}

/** What the form shows for a handle field. */
export type HandleStatus =
  | { kind: "idle" } // nothing typed yet
  | { kind: "rule"; problem: HandleProblem } // the shape is wrong: state the rule, no network
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" } // held by someone, or reserved: the same words either way
  | { kind: "same" } // it is already this person's handle
  | { kind: "unknown" }; // the check could not answer now

/** The availability functions answer true, false or null (asked too often). */
export function parseAvailability(data: unknown): "available" | "taken" | "unknown" {
  return data === true ? "available" : data === false ? "taken" : "unknown";
}

/** Can the form be submitted with this status? "unknown" may: the database decides on save. */
export function handleAllowsSubmit(status: HandleStatus): boolean {
  return status.kind === "available" || status.kind === "unknown";
}

export type SetHandleCode = "ok" | "same" | "invalid" | "taken" | "cooldown" | "rate_limited" | "failed";

export interface SetHandleResult {
  code: SetHandleCode;
  handle?: string;
  nextChangeAt?: string;
}

/** set_handle() answers a jsonb {code, handle?, next_change_at?}; anything else is "failed". */
export function parseSetHandle(data: unknown): SetHandleResult {
  if (!data || typeof data !== "object") return { code: "failed" };
  const d = data as Record<string, unknown>;
  const code = d.code;
  if (code !== "ok" && code !== "same" && code !== "invalid" && code !== "taken" && code !== "cooldown" && code !== "rate_limited")
    return { code: "failed" };
  return {
    code,
    handle: typeof d.handle === "string" ? d.handle : undefined,
    nextChangeAt: typeof d.next_change_at === "string" ? d.next_change_at : undefined,
  };
}

export interface HandleRow {
  handle: string;
  created_at: string;
  changed_at: string;
}

/**
 * When this person may change their handle next, or null when they may now.
 * The first set is free and does not start the clock (changed_at equals
 * created_at until the first change); a change starts 30 days.
 */
export function nextHandleChange(row: Pick<HandleRow, "created_at" | "changed_at"> | null, now: Date = new Date()): Date | null {
  if (!row) return null;
  const changed = Date.parse(row.changed_at);
  const created = Date.parse(row.created_at);
  if (!Number.isFinite(changed) || !Number.isFinite(created) || changed <= created) return null;
  const due = new Date(changed + HANDLE_CHANGE_DAYS * 86_400_000);
  return due.getTime() > now.getTime() ? due : null;
}

/** The handle a sign-up stored in the new account's metadata, if it is a well-formed one. */
export function pendingHandleFrom(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[HANDLE_META_KEY];
  if (typeof raw !== "string") return null;
  const h = normalizeHandleInput(raw);
  return checkHandleFormat(h) === null && !isReservedHandle(h) ? h : null;
}

/** Just enough of the Supabase client to ask for and apply a handle; both browser and server clients fit. */
export interface HandleClient {
  auth: {
    getUser(): Promise<{ data: { user: { user_metadata?: unknown } | null } }>;
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: string): {
    select(columns: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  };
}

/**
 * Apply the handle chosen at sign-up, once, on the first session. Quiet and
 * best-effort: a person who already has a handle is left alone, a name that was
 * taken meanwhile is simply not applied (Settings then asks for a new one), and
 * nothing here can fail a sign-in. Returns what happened for tests.
 */
export async function applyPendingHandle(supabase: HandleClient): Promise<"applied" | "none" | "taken" | "failed"> {
  try {
    const { data } = await supabase.auth.getUser();
    const wanted = pendingHandleFrom(data.user?.user_metadata);
    if (!wanted) return "none";
    const own = await supabase.from("user_handles").select("handle").maybeSingle();
    if (own.error) return "failed";
    if (own.data) return "none";
    const res = await supabase.rpc("set_handle", { p_handle: wanted });
    if (res.error) return "failed";
    const out = parseSetHandle(res.data);
    if (out.code === "ok" || out.code === "same") return "applied";
    return out.code === "taken" || out.code === "invalid" ? "taken" : "failed";
  } catch {
    return "failed";
  }
}
