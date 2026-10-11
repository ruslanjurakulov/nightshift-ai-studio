import { PageHeader } from "@/components/PageHeader";
import { StatusPill, EmptyState } from "@/components/ui";
import { NotConfigured } from "@/components/NotConfigured";
import { SendTestAlert } from "@/components/alerts/SendTestAlert";
import { createClient } from "@/lib/supabase/server";
import { getChannelScope } from "@/lib/channels-server";
import { orgWide, scopeQuery } from "@/lib/channels";
import { isSupabaseConfigured } from "@/lib/config";
import { resolveRole, atLeast } from "@/lib/auth/roles";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { readVariables } from "@/lib/server/github-variables";
import { ALERT_SECRET_NAMES, deriveAlertConfig } from "@/lib/server/alerts";
import { getDictionary } from "@/lib/i18n/server";
import { relativeTime } from "@/lib/format";
import { DataList } from "@/components/g4/DataList";
import { Section } from "@/components/g4/Section";
import "../../app-pages-g4.css";
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
  // Reads the alert channels and ALERT_EMAIL_* addresses with the server's
  // GitHub token: signed out → /login, anyone else → 404, before any read
  // (BR-H-001).
  const mayReadGithub = await guardOperatorPage();
  const { t } = await getDictionary();
  const role = await resolveRole();
  const isAdmin = atLeast(role, "admin");

  // Configuration status, by name presence. Missing GitHub forwarding just
  // means we cannot see any config yet — the page still renders and explains.
  let slackConfigured = false;
  let emailConfigured = false;
  if (isGithubConfigured && mayReadGithub) {
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
    // The current organization's alerts, whichever channel is selected; alerts
    // with no channel are the operator's and show in the default org only.
    const scope = orgWide(await getChannelScope());
    const { data, error } = await scopeQuery(supabase.from("alert_events").select("*"), scope, { nullIsGlobal: true })
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
    <div className="rhythm ns-open g4 stagger-enter">
      <PageHeader icon="alerts" title={t.alerts.title} subtitle={t.alerts.subtitle} />

      {/* The desk: where alerts go, and the one control (admins send a test). */}
      <section className="ns-desk" aria-label={t.alerts.title}>
        <div className="g4-cols">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="t-panel">{t.alerts.slackTitle}</h2>
              <StatusPill
                tone={slackConfigured ? "ok" : "idle"}
                label={slackConfigured ? t.alerts.slackConfigured : t.alerts.slackMissing}
                live={slackConfigured}
              />
            </div>
            <p className="mono g4-muted text-sm m-0">SLACK_WEBHOOK_URL</p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="t-panel">{t.alerts.emailTitle}</h2>
              <StatusPill
                tone={emailConfigured ? "ok" : "idle"}
                label={emailConfigured ? t.alerts.emailConfigured : t.alerts.emailMissing}
                live={emailConfigured}
              />
            </div>
            <p className="tnum g4-muted text-sm m-0">RESEND_API_KEY · ALERT_EMAIL_TO · ALERT_EMAIL_FROM</p>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-4 border-t border-[var(--ns-rule)] pt-6">
          <p className="g4-note">{t.alerts.setupNote}</p>
          {isAdmin && <SendTestAlert />}
        </div>
      </section>

      {/* The durable feed */}
      <Section title={t.alerts.feedTitle}>
        {feedFailed || events.length === 0 ? (
          <EmptyState>{t.alerts.empty}</EmptyState>
        ) : (
          <DataList
            caption={t.alerts.feedTitle}
            rows={events}
            rowKey={(e) => e.id}
            columns={[
              { key: "time", label: t.alerts.colTime, nowrap: true, render: (e) => <span className="tnum g4-muted">{relativeTime(e.at)}</span> },
              { key: "kind", label: t.alerts.colKind, nowrap: true, render: (e) => <span className="tnum g4-muted">{e.kind}</span> },
              {
                key: "title",
                label: t.alerts.colTitle,
                render: (e) => (
                  <>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <StatusPill tone={SEVERITY_TONE[e.severity]} label={severityLabel[e.severity]} />
                      <span className="font-medium">{e.title}</span>
                    </div>
                    {e.body && <span className="mt-1 block g4-small g4-muted">{e.body}</span>}
                  </>
                ),
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}
