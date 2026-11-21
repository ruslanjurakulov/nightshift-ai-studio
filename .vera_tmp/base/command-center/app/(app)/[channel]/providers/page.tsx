import { ProvidersBoard } from "@/components/providers/ProvidersBoard";
import { PipelineRouting } from "@/components/providers/PipelineRouting";
import { PageHeader } from "@/components/PageHeader";
import "../../app-pages-g2.css";
import { providersByCategory } from "@/lib/providers";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { readVariables } from "@/lib/server/github-variables";
import { isGoogleOAuthConfigured } from "@/lib/server/google-oauth";
import { getDictionary } from "@/lib/i18n/server";
import { guardOperatorPage } from "@/lib/auth/org-roles";

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
  // The operator's own key names and routing, read with the server's GitHub
  // token: signed out → /login, anyone else → 404, before any read (BR-H-001).
  const mayReadGithub = await guardOperatorPage();
  const { t } = await getDictionary();
  const { channel } = await params;
  const { yt } = await searchParams;
  const groups = providersByCategory();

  let configured: string[] = [];
  let routingVars: Record<string, string> = {};
  if (isGithubConfigured && mayReadGithub) {
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
            : ytStatus === "forbidden"
              ? t.providers.ytForbidden
              : t.providers.ytFailed
    : "";

  const startHref = `/api/oauth/youtube/start?ref=${encodeURIComponent(channel)}`;

  return (
    <div className="rhythm ns-open">
      <PageHeader icon="providers" title={t.providers.title} subtitle={t.providers.subtitle} />

      {/* YouTube connection — the one credential the site can mint itself */}
      <section className="ns-desk g2-desk" aria-labelledby="yt-title">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 id="yt-title" className="g2-h2">{t.providers.ytTitle}</h2>
            <p className="g2-sub max-w-[62ch]">{t.providers.ytSubtitle}</p>
          </div>
          {isGoogleOAuthConfigured ? (
            <a href={startHref} className="btn-primary">
              {t.providers.ytConnect}
            </a>
          ) : (
            <span className="g2-note tnum">{t.providers.ytSetup}</span>
          )}
        </div>
        {ytMsg && (
          <p className={`mt-4 ${ytOk ? "g2-ok" : "g2-warn"}`} role="status">
            {ytMsg}
          </p>
        )}
      </section>

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
