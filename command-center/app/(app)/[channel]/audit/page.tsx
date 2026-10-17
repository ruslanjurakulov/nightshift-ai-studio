import { createClient } from "@/lib/supabase/server";
import { ErrorState } from "@/components/ReadError";
import { readFailed } from "@/lib/readState";
import { getChannelScope } from "@/lib/channels-server";
import { orgWide, scopeQuery } from "@/lib/channels";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { ownerTime } from "@/lib/format";
import { formatAuditDetail, type AuditRow } from "@/lib/audit";
import { ScrollText } from "lucide-react";
import { DataList } from "@/components/g4/DataList";
import "../../app-pages-g4.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LIMIT = 100;

/** The time in the owner's own clock: 24 hours, Tashkent, "bugun 13:53" (lib/owner-time.ts). */
function renderAt(iso: string, locale: string): string {
  return ownerTime(iso, locale);
}

export default async function AuditPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t, locale } = await getDictionary();

  const supabase = await createClient();
  let rows: AuditRow[] = [];
  let failed = false;
  if (supabase) {
    // The whole current organization, whichever channel is selected. Rows
    // with no channel are platform-level and belong to the operator's
    // organization only — the rule 0018's policy draws, applied to the view
    // so a platform admin inside a tenant sees that tenant's log alone.
    const scope = orgWide(await getChannelScope());
    const res = await scopeQuery(supabase.from("app_audit_log").select("*"), scope, { nullIsGlobal: true })
      .order("at", { ascending: false })
      .limit(LIMIT);
    failed = readFailed(res);
    rows = (res.data as AuditRow[]) ?? [];
  }

  return (
    <div className="rhythm ns-open g4 stagger-enter">
      <PageHeader icon="audit" title={t.audit.title} subtitle={t.audit.subtitle} />
      <Panel title={t.audit.title}>
        {!supabase ? (
          <EmptyState icon={ScrollText}>{t.audit.notConfigured}</EmptyState>
        ) : failed ? (
          <ErrorState />
        ) : rows.length === 0 ? (
          <EmptyState icon={ScrollText}>{t.audit.empty}</EmptyState>
        ) : (
          <DataList
            caption={t.audit.title}
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: "time", label: t.audit.colTime, nowrap: true, render: (row) => <span className="tnum g4-muted">{renderAt(row.at, locale)}</span> },
              { key: "actor", label: t.audit.colActor, render: (row) => row.actor_email ?? "—" },
              {
                key: "action",
                label: t.audit.colAction,
                render: (row) => {
                  const detail = formatAuditDetail(row.detail);
                  return (
                    <>
                      <span className="mono" style={{ color: "var(--ns-act-ink)" }}>{row.action}</span>
                      {detail && <span className="mt-0.5 block g4-small g4-muted">{detail}</span>}
                    </>
                  );
                },
              },
              { key: "target", label: t.audit.colTarget, render: (row) => <span className="mono">{row.target ?? "—"}</span> },
              { key: "channel", label: t.audit.colChannel, render: (row) => <span className="tnum g4-muted">{row.channel_id ?? "—"}</span> },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
