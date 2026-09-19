import { PageHeader } from "@/components/PageHeader";
import { StatusPill, EmptyState } from "@/components/ui";
import { NotConfigured } from "@/components/NotConfigured";
import { SendTestAlert } from "@/components/alerts/SendTestAlert";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { resolveRole, atLeast } from "@/lib/auth/roles";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { readVariables } from "@/lib/server/github-variables";
import { ALERT_SECRET_NAMES, deriveAlertConfig } from "@/lib/server/alerts";
import { getDictionary } from "@/lib/i18n/server";
import { relativeTime } from "@/lib/format";
import type { AlertEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FEED_LIMIT = 50;

const SEVERITY_TONE: Record<AlertEventRow["severity"], "idle" | "warn" | "fail"> = {
  info: "idle",
  warn: "warn",
  critical: "fail",
};

/**
 * Alerts — the operator notification surface.
 *
 * Shows (a) which channels are configured, read by secret/variable NAME
 * presence only (the web app can never read a secret value); (b) an admin-only
 * "Send test alert" that writes the durable feed and delivers over Slack when
 * the webhook is present in the server runtime; (c) the recent alert feed.
 */
export default async function AlertsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const role = await resolveRole();
  const isAdmin = atLeast(role, "admin");

  // Configuration status, by name presence. Missing GitHub forwarding just
  // means we cannot see any config yet — the page still renders and explains.
  let slackConfigured = false;
  let emailConfigured = false;
  if (isGithubConfigured) {
    let secretNames: string[] = [];
    let variables: Record<string, string> = {};
    try {
      secretNames = await listConfiguredSecretNames(ALERT_SECRET_NAMES);
    } catch {
      secretNames = [];
    }
    try {
      variables = await readVariables();
    } catch {
      variables = {};
    }
    ({ slackConfigured, emailConfigured } = deriveAlertConfig(secretNames, variables));
  }

  // The durable feed — latest first, most-recent 50.
  const supabase = await createClient();
  let events: AlertEventRow[] = [];
  let feedFailed = false;
  if (supabase) {
    const { data, error } = await supabase
      .from("alert_events")
      .select("*")
      .order("at", { ascending: false })
      .limit(FEED_LIMIT);
    if (error) feedFailed = true;
    events = (data as AlertEventRow[]) ?? [];
  }

  const severityLabel: Record<AlertEventRow["severity"], string> = {
    info: t.alerts.severity_info,
    warn: t.alerts.severity_warn,
    critical: t.alerts.severity_critical,
  };

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="alerts" title={t.alerts.title} subtitle={t.alerts.subtitle} />

      {/* Channel configuration */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              {t.alerts.slackTitle}
            </h2>
            <StatusPill
              tone={slackConfigured ? "ok" : "idle"}
              label={slackConfigured ? t.alerts.slackConfigured : t.alerts.slackMissing}
              live={slackConfigured}
            />
          </div>
          <p className="mono mt-3 text-[11px] text-[var(--color-muted)]">SLACK_WEBHOOK_URL</p>
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              {t.alerts.emailTitle}
            </h2>
            <StatusPill
              tone={emailConfigured ? "ok" : "idle"}
              label={emailConfigured ? t.alerts.emailConfigured : t.alerts.emailMissing}
              live={emailConfigured}
            />
          </div>
          <p className="mono mt-3 text-[11px] text-[var(--color-muted)]">
            RESEND_API_KEY · ALERT_EMAIL_TO · ALERT_EMAIL_FROM
          </p>
        </div>
      </div>

      {/* Setup note + admin-only test control */}
      <div className="panel p-4">
        <p className="text-[13px] text-[var(--color-muted)]">{t.alerts.setupNote}</p>
        {isAdmin && (
          <div className="mt-4">
            <SendTestAlert />
          </div>
        )}
      </div>

      {/* The durable feed */}
      <section className="section-open">
        <header className="section-head">
          <h2 className="t-panel">{t.alerts.feedTitle}</h2>
        </header>
        {feedFailed || events.length === 0 ? (
          <EmptyState>{t.alerts.empty}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[var(--color-muted)]">
                  <th className="border-b border-[var(--color-border)] py-2 pr-4 font-medium">
                    {t.alerts.colTime}
                  </th>
                  <th className="border-b border-[var(--color-border)] py-2 pr-4 font-medium">
                    {t.alerts.colKind}
                  </th>
                  <th className="border-b border-[var(--color-border)] py-2 font-medium">
                    {t.alerts.colTitle}
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="border-b border-[var(--color-border)] py-2 pr-4 mono text-[12px] text-[var(--color-muted)] whitespace-nowrap">
                      {relativeTime(e.at)}
                    </td>
                    <td className="border-b border-[var(--color-border)] py-2 pr-4 mono text-[12px] text-[var(--color-muted)] whitespace-nowrap">
                      {e.kind}
                    </td>
                    <td className="border-b border-[var(--color-border)] py-2 text-[var(--color-fg)]">
                      <div className="flex items-start gap-2">
                        <StatusPill tone={SEVERITY_TONE[e.severity]} label={severityLabel[e.severity]} />
                        <span className="font-medium">{e.title}</span>
                      </div>
                      {e.body && (
                        <span className="mt-1 block text-[12px] font-light text-[var(--color-muted)]">
                          {e.body}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
