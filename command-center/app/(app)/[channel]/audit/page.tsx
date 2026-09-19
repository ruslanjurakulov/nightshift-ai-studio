import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { parseStoredTime } from "@/lib/format";
import { formatAuditDetail, type AuditRow } from "@/lib/audit";
import { ScrollText } from "lucide-react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LIMIT = 100;

/** A stable UTC rendering of the timestamp, safe for server-only render. */
function renderAt(iso: string): string {
  const d = parseStoredTime(iso);
  if (!d) return iso;
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function AuditPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();

  const supabase = await createClient();
  let rows: AuditRow[] = [];
  if (supabase) {
    const { data } = await supabase
      .from("app_audit_log")
      .select("*")
      .order("at", { ascending: false })
      .limit(LIMIT);
    rows = (data as AuditRow[]) ?? [];
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="audit" title={t.audit.title} subtitle={t.audit.subtitle} />
      <Panel title={t.audit.title}>
        {!supabase ? (
          <EmptyState icon={ScrollText}>{t.audit.notConfigured}</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState icon={ScrollText}>{t.audit.empty}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
                  <th className="py-2 pr-4 font-semibold">{t.audit.colTime}</th>
                  <th className="py-2 pr-4 font-semibold">{t.audit.colActor}</th>
                  <th className="py-2 pr-4 font-semibold">{t.audit.colAction}</th>
                  <th className="py-2 pr-4 font-semibold">{t.audit.colTarget}</th>
                  <th className="py-2 pr-4 font-semibold">{t.audit.colChannel}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const detail = formatAuditDetail(row.detail);
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-[var(--color-border)] align-top transition-colors hover:bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)]"
                    >
                      <td className="mono whitespace-nowrap py-2 pr-4 text-[var(--color-muted)]">
                        {renderAt(row.at)}
                      </td>
                      <td className="py-2 pr-4 text-[var(--color-fg)]">
                        {row.actor_email ?? "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <span className="mono text-[var(--color-primary)]">{row.action}</span>
                        {detail && (
                          <span className="mt-0.5 block text-[12px] font-light text-[var(--color-muted)]">
                            {detail}
                          </span>
                        )}
                      </td>
                      <td className="mono py-2 pr-4 text-[var(--color-fg)]">{row.target ?? "—"}</td>
                      <td className="mono py-2 pr-4 text-[var(--color-muted)]">
                        {row.channel_id ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
