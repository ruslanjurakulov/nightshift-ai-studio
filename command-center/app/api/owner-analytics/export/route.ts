import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { createClient, getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { lastAuthenticatedAt, ownerAccess, presentMode, recentEnough } from "@/lib/server/owner-analytics";
import { buildExport, buildReport, isExportable } from "@/lib/server/owner-analytics-export";
import { PDF_MAX_ROWS, tablesToPdf } from "@/lib/server/owner-analytics-pdf";
import { fill, tashkentDateTime } from "@/lib/owner-analytics/format";
import type { Table } from "@/lib/owner-analytics/export";
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
  if (!isExportable(what) || (format !== "csv" && format !== "xlsx" && format !== "pdf") || typeof body.query !== "string" || body.query.length > 300) {
    return json({ error: "invalid_request" }, 400);
  }
  // A CSV holds one table: the full report is XLSX or PDF only. Refused before the audit row, so no export that never
  // happened is recorded.
  if (what === "report.full" && format === "csv") return json({ error: "invalid_request" }, 400);
  if (!recentEnough(await lastAuthenticatedAt(), Date.now())) return json({ error: "reauth_required" }, 401);

  const sel = parseSelection(Object.fromEntries(new URLSearchParams(body.query)), new Date());
  const present = await presentMode();
  const supabase = await createClient();
  if (!supabase) return json({ error: "unavailable" }, 503);
  const audit = await supabase.rpc("owner_analytics_record_export", {
    p_what: what,
    p_format: format,
    p_from: sel.current.from,
    p_to: sel.current.to,
    p_present: present,
  });
  if (audit.error) {
    // 0107's second-factor gate is on and this session is password-only: the code, not a fresh password, is what is missing.
    if (audit.error.code === "NS401") return json({ error: "mfa_required" }, 401);
    return json({ error: audit.error.code === "42501" ? "forbidden" : "not_recorded" }, audit.error.code === "42501" ? 403 : 503);
  }

  const { t } = await getDictionary();
  const d = t.ownerAnalytics;
  let tables: Table[];
  let notes: string[] = [];
  if (what === "report.full") {
    const report = await buildReport(sel, t, present);
    if (!report.ok) return json({ error: report.reason === "forbidden" ? "forbidden" : "read_failed" }, report.reason === "forbidden" ? 403 : 503);
    tables = report.tables;
    notes = report.missing.length ? [fill(d.reportMissing, { parts: report.missing.join(", ") })] : [];
  } else {
    const built = await buildExport(what, sel, t, present);
    if (!built.ok) return json({ error: built.reason === "forbidden" ? "forbidden" : "read_failed" }, built.reason === "forbidden" ? 403 : 503);
    tables = [built.table];
  }
  // A CSV holds one table; the full report is offered as XLSX (one sheet each) or PDF only.
  if (format === "csv" && tables.length > 1) return json({ error: "invalid_request" }, 400);

  // Refused before a single row is drawn: past the ceiling the PDF would block the server; XLSX holds any number of rows.
  if (format === "pdf" && tables.reduce((n, tb) => n + tb.rows.length, 0) > PDF_MAX_ROWS) return json({ error: "pdf_too_large" }, 413);

  const stem = safeFileStem(`nightshift-${what}-${sel.current.startDay}-${sel.current.endDay}`);
  const bytes =
    format === "csv"
      ? toCsv(tables[0])
      : format === "xlsx"
        ? toXlsx(tables)
        : await tablesToPdf(tables, {
            title: what === "report.full" ? d.reportPdf : tables[0].name,
            periodLine: `${d.period}: ${sel.current.startDay} — ${sel.current.endDay} (Asia/Tashkent)`,
            // The header carries the first table's caveats; every other table prints its own under its heading.
            notes: [...(tables[0].preamble ?? []).slice(1), ...notes],
            generatedLine: fill(d.pdfGenerated, { when: tashkentDateTime(new Date().toISOString()) }),
            pageTemplate: d.pdfPage,
            unknownText: d.unknown,
          });
  const type =
    format === "csv" ? "text/csv; charset=utf-8" : format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
  return new NextResponse(new Blob([bytes as BlobPart]), {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": type,
      "content-disposition": `attachment; filename="${stem}.${format}"`,
      "x-content-type-options": "nosniff",
    },
  });
});
