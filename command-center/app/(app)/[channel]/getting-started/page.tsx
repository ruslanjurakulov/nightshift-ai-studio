import Link from "next/link";
import { Rocket, ArrowRight } from "lucide-react";
import { isSupabaseConfigured } from "@/lib/config";
import { getChannelScope } from "@/lib/channels-server";
import { orgWide, scopeQuery, type ChannelScope } from "@/lib/channels";
import { createClient, getUser } from "@/lib/supabase/server";
import {
  isGithubConfigured,
  listConfiguredSecretNames,
} from "@/lib/server/github-secrets";
import { readVariables } from "@/lib/server/github-variables";
import { isGoogleOAuthConfigured } from "@/lib/server/google-oauth";
import { getDictionary } from "@/lib/i18n/server";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { getChannelPath } from "@/lib/channels-path-server";
import { PageHeader } from "@/components/PageHeader";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Meter } from "@/components/ui/Meter";
import "../../app-pages-g5.css";
import { computeChecklist, type OnboardingStepKey } from "@/lib/onboarding";
import type { ChannelCredentialRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const truthy = (v: string | undefined) => !!v && TRUTHY.has(v.trim().toLowerCase());

/** A soft `count` for a table that may not exist yet — 0 on any error. */
async function tableCount(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  table: string,
  scope?: ChannelScope,
): Promise<number> {
  const query = supabase.from(table).select("*", { count: "exact", head: true });
  const { count, error } = await (scope ? scopeQuery(query, scope) : query);
  return error ? 0 : (count ?? 0);
}

/**
 * Getting Started — a health checklist that inspects the live configured state
 * and shows exactly what remains to go from zero to a first automated video.
 *
 * Every item reflects REAL state: Supabase config, the signed-in user, the
 * GitHub forwarding token, which provider secrets and routing variables GitHub
 * actually reports, a connected YouTube credential (or the OAuth capability),
 * and the channel / team / series row counts. Nothing is marked done unless its
 * signal is genuinely true, and each item links to the page that fixes it.
 */
export default async function GettingStartedPage() {
  // The deployment's health check reads provider key names and routing with
  // the server's GitHub token: signed out → /login, anyone else → 404, before
  // any read (BR-H-001).
  const mayReadGithub = await guardOperatorPage();
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const s = t.onboarding;

  // --- Backend wiring (env / GitHub), read by name only, never values. ---
  const supabaseConfigured = isSupabaseConfigured;
  const user = await getUser();

  let providerKeySet = false;
  let routingSet = false;
  if (isGithubConfigured && mayReadGithub) {
    try {
      const configured = await listConfiguredSecretNames();
      providerKeySet = configured.length > 0;
    } catch {
      providerKeySet = false;
    }
    try {
      const vars = await readVariables();
      // The pipeline renders with a generator only once a routing variable
      // names it (or an enable flag is on) — mirrors config.py / PipelineRouting.
      routingSet =
        Boolean(vars.CHRONOS_VIDEO_PROVIDER) ||
        truthy(vars.CHRONOS_ENABLE_VIDEO_GEN) ||
        truthy(vars.CHRONOS_ENABLE_MINIMAX_BROLL);
    } catch {
      routingSet = false;
    }
  }

  // --- Supabase-backed counts (soft when a table isn't migrated yet). ---
  let hasChannel = false;
  let hasMember = false;
  let hasSeries = false;
  let credentialConnected = false;
  const supabase = await createClient();
  if (supabase) {
    // The checklist is about the organization being set up, not every tenant
    // a platform admin can read.
    const scope = orgWide(await getChannelScope());
    const [channels, members, series, creds] = await Promise.all([
      tableCount(supabase, "channels", scope),
      tableCount(supabase, "app_members"),
      tableCount(supabase, "content_series", scope),
      scopeQuery(supabase.from("channel_credentials").select("status"), scope),
    ]);
    hasChannel = channels > 0;
    hasMember = members > 0;
    hasSeries = series > 0;
    credentialConnected = ((creds.data as Pick<ChannelCredentialRow, "status">[]) ?? []).some(
      (c) => c.status === "connected",
    );
  }

  const checklist = computeChecklist({
    supabaseConfigured,
    signedIn: Boolean(user),
    githubConfigured: isGithubConfigured,
    providerKeySet,
    routingSet,
    // A channel is genuinely connected, or the OAuth flow is at least configured
    // so an operator can connect one from the Providers page.
    youtubeConnected: credentialConnected || isGoogleOAuthConfigured,
    hasChannel,
    hasMember,
    hasSeries,
  });

  const { items, progress } = checklist;
  const allDone = progress.done === progress.total;

  const titleFor = (key: OnboardingStepKey) => s[`step_${key}` as const];
  const hintFor = (key: OnboardingStepKey) => s[`step_${key}_hint` as const];

  const next = items.find((i) => !i.done) ?? null;

  return (
    <div className="rhythm ns-open g5-page stagger-enter">
      <PageHeader icon="onboarding" title={s.title} subtitle={s.subtitle} />

      {/* The desk: how far along, and the one next job */}
      <section className="panel ns-desk" aria-labelledby="gs-progress">
        <div className="g5-desk-grid" data-two>
          <div className="flex flex-col gap-4">
            <h2 id="gs-progress" className="g5-k">
              {s.progress}
            </h2>
            <p className="g5-progress-line">
              <span className="g5-figure">
                {progress.done}
                <span className="g5-figure-unit"> / {progress.total}</span>
              </span>
              <span className="g5-v">{progress.pct}%</span>
            </p>
            <Meter
              value={progress.done}
              max={progress.total}
              segments={progress.total}
              size="lg"
              label={s.progress}
              valueText={`${progress.done}/${progress.total} · ${progress.pct}%`}
            />
          </div>

          {allDone || !next ? (
            <div className="flex items-start gap-3">
              <Rocket aria-hidden className="mt-1 size-5 shrink-0 text-[var(--color-ok)]" strokeWidth={1.75} />
              <p className="g5-sub" style={{ marginTop: 0 }}>
                {s.allDone}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-4">
              <div>
                <p className="g5-num" aria-hidden>
                  {String(items.indexOf(next) + 1).padStart(2, "0")}
                </p>
                <h3 className="g5-h mt-1">{titleFor(next.key)}</h3>
                <p className="g5-sub">{hintFor(next.key)}</p>
              </div>
              <Link href={path(next.href)} className="btn-primary">
                {s.fix}
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* The checklist: every step, each with its own lamp and its way in */}
      <section className="panel g5-bare" aria-label={s.progress}>
        <ol className="g5-rows">
          {items.map((item, i) => (
            <li
              key={item.key}
              className="g5-row g5-step"
              data-next={next?.key === item.key ? "true" : undefined}
              aria-current={next?.key === item.key ? "step" : undefined}
            >
              <span className="g5-num" aria-hidden>
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div className="g5-step-top">
                  <h3 className="g5-row-title">{titleFor(item.key)}</h3>
                  <StatusLamp tone={item.done ? "ok" : "idle"} label={item.done ? s.done : s.todo} />
                </div>
                <p className="g5-row-meta">{hintFor(item.key)}</p>
              </div>
              {!item.done ? (
                <Link href={path(item.href)} className="btn-quiet">
                  {s.fix}
                  <ArrowRight aria-hidden className="size-4" />
                </Link>
              ) : (
                <span aria-hidden />
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
