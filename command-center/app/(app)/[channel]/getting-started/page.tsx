import Link from "next/link";
import { CheckCircle2, Circle, Rocket, ArrowRight } from "lucide-react";
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
import { getChannelPath } from "@/lib/channels-path-server";
import { PageHeader } from "@/components/PageHeader";
import { Panel, StatusPill } from "@/components/ui";
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
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const s = t.onboarding;

  // --- Backend wiring (env / GitHub), read by name only, never values. ---
  const supabaseConfigured = isSupabaseConfigured;
  const user = await getUser();

  let providerKeySet = false;
  let routingSet = false;
  if (isGithubConfigured) {
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

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="onboarding" title={s.title} subtitle={s.subtitle} />

      <Panel
        title={s.progress}
        right={
          <StatusPill
            tone={allDone ? "ok" : "idle"}
            label={`${progress.done}/${progress.total} · ${progress.pct}%`}
          />
        }
      >
        <div className="rhythm">
          {/* Progress bar */}
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.pct}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress.pct}%`,
                background: allDone ? "var(--color-ok)" : "var(--color-primary)",
              }}
            />
          </div>

          {allDone && (
            <div className="flex items-center gap-3 rounded-xl border border-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_10%,transparent)] px-4 py-3">
              <Rocket aria-hidden className="size-5 shrink-0 text-[var(--color-ok)]" strokeWidth={1.75} />
              <p className="m-0 text-[14px] font-light text-[var(--color-fg)]">{s.allDone}</p>
            </div>
          )}

          {/* The checklist */}
          <ul className="flex list-none flex-col gap-2 p-0">
            {items.map((item) => {
              const Icon = item.done ? CheckCircle2 : Circle;
              return (
                <li
                  key={item.key}
                  className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-3 transition-colors hover:border-[var(--color-primary-dim)]"
                >
                  <Icon
                    aria-hidden
                    className="mt-0.5 size-5 shrink-0"
                    strokeWidth={1.75}
                    style={{ color: item.done ? "var(--color-ok)" : "var(--color-muted)" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[14px] font-medium text-[var(--color-fg)]">
                        {titleFor(item.key)}
                      </span>
                      <StatusPill
                        tone={item.done ? "ok" : "idle"}
                        label={item.done ? s.done : s.todo}
                      />
                    </div>
                    <p className="mt-1 text-[13px] font-light leading-relaxed text-[var(--color-muted)]">
                      {hintFor(item.key)}
                    </p>
                  </div>
                  {!item.done && (
                    <Link
                      href={path(item.href)}
                      className="btn-sky is-quiet pill mt-0.5 inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[12px]"
                    >
                      {s.fix}
                      <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
