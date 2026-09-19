import { ProvidersBoard } from "@/components/providers/ProvidersBoard";
import { PipelineRouting } from "@/components/providers/PipelineRouting";
import { PageHeader } from "@/components/PageHeader";
import { providersByCategory } from "@/lib/providers";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { readVariables } from "@/lib/server/github-variables";
import { isGoogleOAuthConfigured } from "@/lib/server/google-oauth";
import { getDictionary } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Providers — per-account API keys (entered here → GitHub Actions secrets) plus
 * a one-click "Connect YouTube" that runs the OAuth flow and seals the channel's
 * upload token into its secret. The configured/not status is read by name only.
 */
export default async function ProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ yt?: string }>;
}) {
  const { t } = await getDictionary();
  const { channel } = await params;
  const { yt } = await searchParams;
  const groups = providersByCategory();

  let configured: string[] = [];
  let routingVars: Record<string, string> = {};
  if (isGithubConfigured) {
    try {
      configured = await listConfiguredSecretNames();
    } catch {
      configured = [];
    }
    try {
      routingVars = await readVariables();
    } catch {
      routingVars = {};
    }
  }

  // OAuth result banner (?yt=connected|denied|no_refresh|…), if we just returned.
  const ytStatus = (yt ?? "").trim();
  const ytOk = ytStatus === "connected";
  const ytMsg = ytStatus
    ? ytOk
      ? t.providers.ytConnected
      : ytStatus === "denied"
        ? t.providers.ytDenied
        : ytStatus === "no_refresh"
          ? t.providers.ytNoRefresh
          : ytStatus === "not_configured"
            ? t.providers.ytNotConfigured
            : t.providers.ytFailed
    : "";

  const startHref = `/api/oauth/youtube/start?ref=${encodeURIComponent(channel)}`;

  return (
    <div className="rhythm">
      <PageHeader icon="providers" title={t.providers.title} subtitle={t.providers.subtitle} />

      {/* YouTube connection — the one credential the site can mint itself */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t.providers.ytTitle}</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.providers.ytSubtitle}</p>
          </div>
          {isGoogleOAuthConfigured ? (
            <a href={startHref} className="btn-sky pill px-4 py-1.5 text-[13px]">
              {t.providers.ytConnect}
            </a>
          ) : (
            <span className="mono text-[11px] text-[var(--color-muted)]">{t.providers.ytSetup}</span>
          )}
        </div>
        {ytMsg && (
          <p
            className="mt-3 text-[13px]"
            style={{ color: ytOk ? "var(--color-primary)" : "var(--color-warn, #e2a03f)" }}
            role="status"
          >
            {ytMsg}
          </p>
        )}
      </div>

      <ProvidersBoard groups={groups} configured={configured} githubConfigured={isGithubConfigured} />

      {/* Which generator the pipeline actually uses — writes GH Actions vars. */}
      <PipelineRouting
        initial={routingVars}
        configured={configured}
        githubConfigured={isGithubConfigured}
      />
    </div>
  );
}
