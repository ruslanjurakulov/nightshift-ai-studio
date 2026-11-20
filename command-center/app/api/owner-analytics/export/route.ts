import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { createClient, getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { lastAuthenticatedAt, ownerAccess, presentMode, recentEnough } from "@/lib/server/owner-analytics";
import { buildExport, isExportable } from "@/lib/server/owner-analytics-export";
import { parseSelection } from "@/lib/owner-analytics/period";
import { safeFileStem, toCsv, toXlsx } from "@/lib/owner-analytics/export";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, private", pragma: "no-cache" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * One table of the owner analytics hub as CSV or XLSX.
 *
 * Order, and why: same origin (a cross-site page must not be able to make the owner's browser record an export), then the
 * owner (the database's own answer, 0182), then a sign-in within the last few minutes (an unlocked laptop is not a data room),
 * then the AUDIT ROW — written before the file is built, and if it cannot be written, no file is built. Only then is the table
 * read from the database, as the owner, and returned with no-store: no proxy or browser cache keeps a copy.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  // Who is asking comes before anything is parsed: a signed-out caller makes the server do no work.
  if (!(await getUser())) return json({ error: "unauthorized" }, 401);
  const access = await ownerAccess();
  if (access === "signed_out") return json({ error: "unauthorized" }, 401);
  if (access === "missing") return json({ error: "not_enabled" }, 503);
  if (access === "error" || access === "not_configured") return json({ error: "unavailable" }, 503);
  if (access !== "owner") return json({ error: "forbidden" }, 403);

  let body: { what?: unknown; format?: unknown; query?: unknown };
  try {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return json({ error: "invalid_request" }, 400);
    body = raw as typeof body;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const { what, format } = body;
  if (!isExportable(what) || (format !== "csv" && format !== "xlsx") || typeof body.query !== "string" || body.query.length > 300) {
    return json({ error: "invalid_request" }, 400);
  }
  if (!recentEnough(await lastAuthenticatedAt(), Date.now())) return json({ error: "reauth_required" }, 401);

  const sel = parseSelection(Object.fromEntries(new URLSearchParams(body.query)), new Date());
  const present = await presentMode();
  const supabase = await createClient();
  if (!supabase) return json({ error: "unavailable" }, 503);
  const audit = await supabase.rpc("owner_analytics_record_export", {
    p_what: what,
    p_format: format,
    // A runway file holds up to 180 days to now, whatever period is picked: the audit row says what the file actually covers.
    p_from: what.startsWith("runway.") ? new Date(Date.now() - 180 * 86_400_000).toISOString() : sel.current.from,
    p_to: what.startsWith("runway.") ? new Date().toISOString() : sel.current.to,
    p_present: present,
  });
  if (audit.error) {
    // 0107's second-factor gate is on and this session is password-only: the code, not a fresh password, is what is missing.
    if (audit.error.code === "NS401") return json({ error: "mfa_required" }, 401);
    return json({ error: audit.error.code === "42501" ? "forbidden" : "not_recorded" }, audit.error.code === "42501" ? 403 : 503);
  }

  const { t } = await getDictionary();
  const built = await buildExport(what, sel, t, present);
  if (!built.ok) return json({ error: built.reason === "forbidden" ? "forbidden" : "read_failed" }, built.reason === "forbidden" ? 403 : 503);

  const stem = safeFileStem(`nightshift-${what}-${sel.current.startDay}-${sel.current.endDay}`);
  const bytes = format === "csv" ? toCsv(built.table) : toXlsx([built.table]);
  return new NextResponse(new Blob([bytes as BlobPart]), {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${stem}.${format}"`,
      "x-content-type-options": "nosniff",
    },
  });
});
