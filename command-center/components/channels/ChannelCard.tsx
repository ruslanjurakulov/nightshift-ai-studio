"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { isChannelVerified } from "@/lib/channels";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusPill } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import type { ChannelHealth, HealthTone } from "@/lib/channels";
import type { ChannelCredentialRow, ChannelRow } from "@/lib/types";
import { ChannelTokenPanel, type ChannelTokenPanelProps } from "@/components/channels/ChannelTokenPanel";

/**
 * One channel: identity, configuration, credential status and health.
 *
 * The only mutation offered is pause/activate. There is no delete: retiring a
 * channel by pausing it keeps its videos, learning and history intact and is
 * reversible, and the RLS policy added by migration 0001 grants insert and
 * update on `channels` only — never delete, and never on any data table.
 *
 * Nothing here can show a credential. The row this renders (channel_credentials)
 * has no column that could hold one; the operator's channels are connected on a
 * trusted machine via tools/connect_channel.py (or the Providers board). A
 * customer organization's channel is connected here instead (`vault`, migration
 * 0022): its token goes to Supabase Vault and only its status comes back.
 */
export function ChannelCard({
  channel,
  slug,
  credential,
  health,
  queued,
  videos,
  vault,
  dna,
  canControl = false,
}: {
  channel: ChannelRow;
  /** The channel's URL segment — its name, not its internal id. */
  slug: string;
  credential?: ChannelCredentialRow;
  health: ChannelHealth;
  queued: number;
  videos: number;
  /** Set for a customer organization's channel: its Vault connection panel. */
  vault?: Omit<ChannelTokenPanelProps, "channelId">;
  /** The channel's DNA card (components/channels/ChannelDnaSection), when the page has it. */
  dna?: ReactNode;
  /**
   * May the caller change the controls that hold a render (auto publish and
   * storyboard review)? An administrator of the organization, since migration
   * 0086: a trigger refuses the write from anyone else (BR-G-003), so without
   * this the switches are shown but disabled.
   */
  canControl?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [auto, setAuto] = useState(Boolean(channel.auto_publish));
  const [review, setReview] = useState(channel.agent_config?.storyboard_review === true);
  const [reviewBusy, setReviewBusy] = useState(false);

  const agent = channel.agent_config ?? {};
  const schedule = channel.schedule_config ?? {};
  const active = channel.status === "ACTIVE";
  /**
   * Has YouTube ever answered for this channel?
   *
   * `default` is exempt: it predates the registry and its identity comes from
   * config.py rather than from a form. Everything else needs both halves —
   * a `verified_at` stamp and the id the lookup returned — or it is a draft:
   * a name, a niche, and a guess. A draft cannot be activated here, the
   * database refuses the same transition (migration 0005), and the scheduler
   * skips it. Three checks that agree beat one that carries all the weight.
   */
  const verified = isChannelVerified(channel);

  /**
   * Auto publish, per channel.
   *
   * Off (the default) means a rendered video stays private until someone
   * approves it on the video page. On means the pipeline may take it public by
   * itself — and the publish gate still runs in front of that, exactly as it
   * does today. This switch removes the human step; it never removes a check.
   */
  async function toggleAuto() {
    const supabase = createClient();
    if (!supabase) return;
    setAutoBusy(true);
    setError(null);
    const next = !auto;
    const { error: err } = await supabase
      .from("channels")
      .update({ auto_publish: next, updated_at: new Date().toISOString() })
      .eq("channel_id", channel.channel_id);
    setAutoBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setAuto(next);
    startTransition(() => router.refresh());
  }

  /**
   * Storyboard review, per channel (migration 0057). On: every run of this
   * channel — scheduled ones too — stops after the script and scene plan and
   * waits for a person to approve the render at one price. Off (the default):
   * runs go straight to the render, exactly as before. Merged into the live
   * agent_config so no other setting is overwritten (the Approvals page's
   * pattern); an unreadable config is not merged into.
   */
  async function toggleReview() {
    const supabase = createClient();
    if (!supabase) return;
    setReviewBusy(true);
    setError(null);
    const next = !review;
    const { data: current, error: readErr } = await supabase
      .from("channels")
      .select("agent_config")
      .eq("channel_id", channel.channel_id)
      .maybeSingle();
    if (readErr) {
      setReviewBusy(false);
      setError(readErr.message);
      return;
    }
    const merged = { ...((current?.agent_config as Record<string, unknown> | null) ?? {}), storyboard_review: next };
    const { error: err } = await supabase
      .from("channels")
      .update({ agent_config: merged, updated_at: new Date().toISOString() })
      .eq("channel_id", channel.channel_id);
    setReviewBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setReview(next);
    startTransition(() => router.refresh());
  }

  async function toggleStatus() {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const next = active ? "PAUSED" : "ACTIVE";
    // `status` is written through set_channel_status (migration 0086): the
    // table's own column is closed to the browser, and activating still needs a
    // channel YouTube has confirmed.
    const { error: err } = await supabase.rpc("set_channel_status", {
      p_channel_id: channel.channel_id,
      p_status: next,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="panel flex flex-col gap-3 p-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {/* The channel's own avatar, pulled from YouTube when the channel was
              confirmed. Public, and the fastest way to see at a glance that the
              right channel is wired up. */}
          {channel.credential_ref?.youtube_thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={channel.credential_ref.youtube_thumbnail}
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 shrink-0 rounded-full border border-[var(--color-border)] object-cover"
            />
          )}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{channel.name}</h2>
            <p className="tnum truncate text-xs text-[var(--color-muted)]">
              {channel.credential_ref?.youtube_custom_url || channel.channel_id}
              {channel.niche ? ` · ${channel.niche}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill
            tone={!verified ? "warn" : active ? "ok" : "idle"}
            label={!verified ? t.channels.verifyGate : active ? t.channels.active : t.channels.paused}
          />
          <button
            type="button"
            onClick={toggleStatus}
            disabled={busy || pending || (!active && !verified)}
            title={!active && !verified ? t.channels.verifyRequired : undefined}
            className="btn-sky ghost pill px-4 py-2 text-xs disabled:opacity-50"
          >
            {busy ? t.channels.saving : active ? t.channels.pause : t.channels.activate}
          </button>
        </div>
      </header>

      {!verified && (
        <p className="max-w-[72ch] text-xs leading-relaxed text-[var(--color-warn)]">
          {t.channels.verifyRequired}
        </p>
      )}

      {/* Auto publish. Off is the default and the safe direction; the switch
          says which way it is currently pointing, in words, not just colour. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs text-[var(--color-muted)]">
            {t.channels.autoLabel}
          </div>
          <p className="m-0 mt-1 max-w-[52ch] text-xs leading-relaxed text-[var(--color-muted)]">
            {auto ? t.channels.autoOnHint : t.channels.autoOffHint}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={auto}
          onClick={toggleAuto}
          disabled={autoBusy || pending || !canControl}
          title={canControl ? undefined : t.channels.adminOnly}
          className="btn-sky pill shrink-0 px-4 py-2 text-xs disabled:opacity-50"
          style={{
            borderColor: auto ? "var(--color-warn)" : "var(--color-border)",
            color: auto ? "var(--color-warn)" : "var(--color-muted)",
          }}
        >
          {autoBusy ? t.channels.saving : auto ? t.channels.autoOn : t.channels.autoOff}
        </button>
      </div>

      {/* Storyboard review. Off is the default; on adds a checkpoint before
          the render is paid for — it never replaces the publish gate. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs text-[var(--color-muted)]">
            {t.storyboardReview.toggleLabel}
          </div>
          <p className="m-0 mt-1 max-w-[52ch] text-xs leading-relaxed text-[var(--color-muted)]">
            {review ? t.storyboardReview.toggleOnHint : t.storyboardReview.toggleOffHint}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={review}
          aria-label={t.storyboardReview.toggleLabel}
          onClick={toggleReview}
          disabled={reviewBusy || pending || !canControl}
          title={canControl ? undefined : t.channels.adminOnly}
          className="btn-sky pill shrink-0 px-4 py-2 text-xs disabled:opacity-50"
          style={{
            borderColor: review ? "var(--color-primary)" : "var(--color-border)",
            color: review ? "var(--color-primary)" : "var(--color-muted)",
          }}
        >
          {reviewBusy ? t.channels.saving : review ? t.storyboardReview.toggleOn : t.storyboardReview.toggleOff}
        </button>
      </div>

      {error && (
        <p className="tnum text-xs text-[var(--color-fail)]">
          {t.channels.saveFailed}: {error}
        </p>
      )}

      {/* -- health ------------------------------------------------------ */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-muted)]">
            {t.channels.health}
          </span>
          <StatusPill
            tone={health.tone === "fail" ? "fail" : health.tone === "warn" ? "warn" : health.tone}
            label={
              health.actionRequired
                ? t.channels.actionRequired
                : health.tone === "ok"
                  ? t.channels.healthy
                  : health.tone === "warn"
                    ? t.status.warn
                    : health.tone === "fail"
                      ? t.status.failed
                      : t.status.idle
            }
          />
        </div>
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          {health.subsystems.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: toneColor(s.tone) }}
              />
              <span className="min-w-0">
                <span className="block truncate text-xs text-[var(--color-fg)]">
                  {subsystemLabel(s.key, t)}
                </span>
                {s.detail && (
                  <span className="tnum block truncate text-xs text-[var(--color-muted)]">{s.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* -- youtube ----------------------------------------------------- */}
      <div className="rounded-md border border-[var(--color-border)] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-muted)]">
            {t.channels.youtube}
          </span>
          {credential ? (
            <StatusPill
              tone={credentialTone(credential.status)}
              label={credentialLabel(credential.status, t)}
            />
          ) : (
            <StatusPill tone="idle" label={t.channels.notConnected} />
          )}
        </div>
        {credential ? (
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 tnum text-xs text-[var(--color-muted)]">
            {credential.youtube_channel_id && (
              <div>
                <dt className="inline">{t.channels.youtube}: </dt>
                <dd className="inline text-[var(--color-fg)]">{credential.youtube_channel_id}</dd>
              </div>
            )}
            {credential.last_verified_at && (
              <div>
                <dt className="inline">{t.channels.lastVerified}: </dt>
                <dd className="inline text-[var(--color-fg)]">{relativeTime(credential.last_verified_at)}</dd>
              </div>
            )}
            {credential.expires_at && (
              <div>
                <dt className="inline">{t.channels.expiresAt}: </dt>
                <dd className="inline text-[var(--color-fg)]">{relativeTime(credential.expires_at)}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-2 tnum text-xs text-[var(--color-muted)]">{t.channels.noCredential}</p>
        )}
        {credential?.detail && (
          <p className="mt-1.5 text-xs text-[var(--color-muted)]">{credential.detail}</p>
        )}
        {/* The GitHub-secret hint is the operator's path; a customer channel
            connects in the panel below instead. */}
        {credential?.status !== "connected" && !vault && (
          <p className="mt-1.5 text-xs text-[var(--color-muted)]">
            {fmt(t.channels.connectHint, {
              id: channel.channel_id,
              secret: secretName(channel),
            })}
          </p>
        )}
        {vault && <ChannelTokenPanel channelId={channel.channel_id} {...vault} />}
      </div>

      {dna}

      {/* -- configuration ----------------------------------------------- */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Field label={t.channels.voice} value={agent.tts_provider === "elevenlabs" ? agent.elevenlabs_voice_id : agent.edge_tts_voice} />
        <Field label={t.channels.language} value={agent.language} />
        <Field
          label={t.channels.targetDuration}
          value={agent.target_duration_seconds ? `${Math.round(agent.target_duration_seconds / 60)} min` : undefined}
        />
        <Field
          label={t.channels.schedule}
          value={
            schedule.enabled === false
              ? "—"
              : schedule.publish_hour_utc != null
                ? `${String(schedule.publish_hour_utc).padStart(2, "0")}:00 UTC`
                : undefined
          }
        />
        <Field label={t.channels.videos} value={String(videos)} />
        <Field label={t.channels.queued} value={String(queued)} />
        <Field
          label={t.channels.competitors}
          // undefined means the channel inherits the server-side default, which
          // this dashboard cannot see — so say "—", never a confident 0.
          value={
            agent.competitor_channel_ids ? String(agent.competitor_channel_ids.length) : undefined
          }
        />
      </dl>

      {agent.visual_style_prompt && (
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">
          <span className="text-xs">{t.channels.visualStyle}: </span>
          {agent.visual_style_prompt}
        </p>
      )}

      <Link
        // This channel's videos, on this channel's own URL — the link carries
        // the lens, so the page opens already scoped.
        href={`/${encodeURIComponent(slug)}/videos`}
        className="tap-link text-xs text-[var(--color-primary)] hover:underline"
      >
        {t.channels.videos} →
      </Link>
    </section>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="truncate text-xs text-[var(--color-fg)]">{value || "—"}</dd>
    </div>
  );
}

function toneColor(tone: HealthTone): string {
  return tone === "ok"
    ? "var(--color-ok)"
    : tone === "warn"
      ? "var(--color-warn)"
      : tone === "fail"
        ? "var(--color-fail)"
        : "var(--color-idle)";
}

type Dict = ReturnType<typeof useI18n>["t"];

function subsystemLabel(key: string, t: Dict): string {
  switch (key) {
    case "youtube":
      return t.channels.subYoutube;
    case "scheduler":
      return t.channels.subScheduler;
    case "generator":
      return t.channels.subGenerator;
    default:
      return t.channels.subAnalytics;
  }
}

function credentialTone(status: string): "ok" | "warn" | "fail" | "idle" {
  if (status === "connected") return "ok";
  if (status === "expired" || status === "error") return "fail";
  return "idle";
}

function credentialLabel(status: string, t: Dict): string {
  if (status === "connected") return t.channels.connected;
  if (status === "expired") return t.channels.expired;
  if (status === "error") return t.channels.credentialError;
  return t.channels.notConnected;
}

/** The GitHub secret this channel's token belongs in — mirrors
 *  modules/channel_credentials.env_var_name. A name, not a value. */
function secretName(channel: ChannelRow): string {
  const key = channel.credential_ref?.ref || channel.channel_id;
  return "CHRONOS_YT_TOKEN_" + key.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
