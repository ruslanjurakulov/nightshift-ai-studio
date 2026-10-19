"use client";

import Link from "next/link";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { isChannelVerified } from "@/lib/channels";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ChannelMark } from "@/components/channels/ChannelMark";
import { relativeTime } from "@/lib/format";
import type { ChannelHealth } from "@/lib/channels";
import type { ChannelCredentialRow, ChannelRow } from "@/lib/types";
import { ChannelTokenPanel, type ChannelTokenPanelProps } from "@/components/channels/ChannelTokenPanel";
import { useConfirm } from "@/components/feedback/ConfirmDialog";

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
  publishReleased = false,
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
  /**
   * Is "Publish when approved" released to customers (the server flag, lib/server/release-flags.ts)? Not released: the switch is
   * drawn only while it is ON, so an administrator can still turn it OFF, and nothing offers to turn it ON. Default false: a
   * caller that forgets the prop does not expose the feature.
   */
  publishReleased?: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [auto, setAuto] = useState(Boolean(channel.auto_publish));
  const [review, setReview] = useState(channel.agent_config?.storyboard_review === true);
  const [reviewBusy, setReviewBusy] = useState(false);
  // "Publish when approved" (migration 0113). Absent before that migration is applied: then there is no switch to show.
  const [publishOn, setPublishOn] = useState(channel.publish_on_approve === true);
  // Released: shown whenever the column exists. Not released: shown only while it is on (the way to turn it off), and it is gone
  // again the moment it is off, so there is never a control to turn it on.
  const showPublishSwitch = typeof channel.publish_on_approve === "boolean" && (publishReleased || publishOn);
  const [publishBusy, setPublishBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const cs = t.confirmSheets;
  // One question or write at a time, locked synchronously: state alone lags a render, and a second tap during the
  // sheet or the write must not open a second sheet or send a second write.
  const asking = useRef(false);

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
   * agent_config so no other setting is overwritten; an unreadable
   * config is not merged into.
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

  /**
   * Publish when approved, per channel (migration 0113). Off (the default): approving a video records the decision and nothing
   * else, and the video is made public on YouTube by a person. On: approving also queues the video, and a worker asks YouTube
   * to make it public after checking everything again; YouTube may still keep it private, and the video page says what YouTube
   * reports. Written only through the database function, which checks that the caller administers this workspace, and audits it;
   * the column itself is closed to every API role.
   */
  async function togglePublishOn() {
    const supabase = createClient();
    if (!supabase) return;
    if (!publishOn && !publishReleased) return;      // not released: this can only turn it off
    setPublishBusy(true);
    setError(null);
    const next = !publishOn;
    const { data, error: err } = await supabase.rpc("set_channel_publish_on_approve", {
      p_channel_id: channel.channel_id,
      p_on: next,
    });
    setPublishBusy(false);
    const out = (data ?? null) as { ok?: unknown; error?: unknown } | null;
    if (err || !out || out.ok !== true) {
      setError(
        err?.code === "42501"
          ? t.channels.publishOnForbidden
          : out?.error === "rate_limited"
            ? t.channels.publishOnRateLimited
            : t.channels.publishOnFailed,
      );
      return;
    }
    setPublishOn(next);
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

  /** Runs `go` after the person has agreed, once at a time. No sheet (`ask` null) is the safe direction: one tap. */
  async function guarded(ask: Parameters<typeof confirm>[0] | null, go: () => Promise<void>) {
    if (asking.current) return;
    asking.current = true;
    try {
      if (ask && !(await confirm(ask))) return;
      await go();
    } finally {
      asking.current = false;
    }
  }

  // Auto publish ON removes the human step before a video goes public, so it asks and needs a word typed. OFF is the
  // safe direction and stays one tap.
  const askAuto = () =>
    guarded(
      auto
        ? null
        : {
            title: fmt(cs.autoOnTitle, { name: channel.name }),
            message: cs.autoOnBody,
            confirmLabel: cs.autoOnConfirm,
            typeToConfirm: cs.autoOnWord,
            details: [
              { label: cs.dChannel, value: channel.name },
              { label: cs.dNow, value: cs.autoModeAsk },
              { label: cs.dAfter, value: cs.autoModeSelf },
            ],
          },
      toggleAuto,
    );

  // Publish when approved ON lets an approval make a video public with no further step, so it asks and needs a word typed.
  // OFF is the safe direction and stays one tap.
  const askPublishOn = () =>
    guarded(
      publishOn
        ? null
        : {
            title: fmt(cs.publishOnTitle, { name: channel.name }),
            message: cs.publishOnBody,
            confirmLabel: cs.publishOnConfirm,
            typeToConfirm: cs.publishOnWord,
            details: [
              { label: cs.dChannel, value: channel.name },
              { label: cs.dNow, value: cs.publishOnModeRecord },
              { label: cs.dAfter, value: cs.publishOnModePublish },
            ],
          },
      togglePublishOn,
    );

  // Pausing stops new videos; resuming starts runs that spend. Both say so, neither needs a word: both are undone by
  // the opposite press.
  const askStatus = () =>
    guarded(
      active
        ? {
            title: fmt(cs.pauseTitle, { name: channel.name }),
            message: cs.pauseBody,
            confirmLabel: cs.pauseConfirm,
            tone: "primary",
          }
        : {
            title: fmt(cs.resumeTitle, { name: channel.name }),
            message: auto ? `${cs.resumeBody} ${cs.resumeAutoOn}` : cs.resumeBody,
            confirmLabel: cs.resumeConfirm,
            tone: "primary",
            details: [{ label: cs.dAutoPublish, value: auto ? t.channels.autoOn : t.channels.autoOff }],
          },
      toggleStatus,
    );

  // Storyboard review ON adds a checkpoint (one tap). OFF removes the checkpoint before the render is paid for.
  const askReview = () =>
    guarded(
      review
        ? {
            title: fmt(cs.reviewOffTitle, { name: channel.name }),
            message: cs.reviewOffBody,
            confirmLabel: cs.reviewOffConfirm,
            tone: "primary",
          }
        : null,
      toggleReview,
    );

  const credentialLamp = credential
    ? { tone: credentialTone(credential.status), label: credentialLabel(credential.status, t) }
    : { tone: "idle" as const, label: t.channels.notConnected };
  const healthLamp = {
    tone: health.tone,
    label: health.actionRequired
      ? t.channels.actionRequired
      : health.tone === "ok"
        ? t.channels.healthy
        : health.tone === "warn"
          ? t.status.warn
          : health.tone === "fail"
            ? t.status.failed
            : t.status.idle,
  };
  const titleId = `channel-title-${channel.channel_id}`;

  return (
    <section id={`channel-${channel.channel_id}`} aria-labelledby={titleId} className="g2-channel">
      <header className="g2-channel-head">
        <div className="g2-channel-id">
          {/* The channel's own avatar, pulled from YouTube when the channel was
              confirmed. Public, and the fastest way to see at a glance that the
              right channel is wired up. */}
          <ChannelMark name={channel.name} thumbnail={channel.credential_ref?.youtube_thumbnail ?? null} />
          <div className="min-w-0">
            <h2 id={titleId} className="g2-h2">{channel.name}</h2>
            <p className="g2-sub tnum">
              {channel.credential_ref?.youtube_custom_url || channel.channel_id}
              {channel.niche ? ` · ${channel.niche}` : ""}
            </p>
          </div>
        </div>
        <div className="g2-actions">
          <StatusLamp
            tone={!verified ? "warn" : active ? "ok" : "idle"}
            label={!verified ? t.channels.verifyGate : active ? t.channels.active : t.channels.paused}
          />
          <button
            type="button"
            onClick={askStatus}
            disabled={busy || pending || (!active && !verified)}
            title={!active && !verified ? t.channels.verifyRequired : undefined}
            className="btn-quiet disabled:opacity-50"
          >
            {busy ? t.channels.saving : active ? t.channels.pause : t.channels.activate}
          </button>
        </div>
      </header>

      {!verified && <p className="g2-warn">{t.channels.verifyRequired}</p>}

      <div className="g2-cols">
        <div className="flex flex-col">
          {/* Auto publish. Off is the default and the safe direction; the switch
              says which way it is currently pointing, in words, not just colour. */}
          <SwitchRow
            id={`${titleId}-auto`}
            label={t.channels.autoLabel}
            hint={auto ? t.channels.autoOnHint : publishOn ? t.channels.autoOffHintPublish : t.channels.autoOffHint}
            on={auto}
            word={autoBusy ? t.channels.saving : auto ? t.channels.autoOn : t.channels.autoOff}
            onClick={askAuto}
            disabled={autoBusy || pending || !canControl}
            title={canControl ? undefined : t.channels.adminOnly}
          />
          {/* Storyboard review. Off is the default; on adds a checkpoint before
              the render is paid for — it never replaces the publish gate. */}
          <SwitchRow
            id={`${titleId}-review`}
            label={t.storyboardReview.toggleLabel}
            hint={review ? t.storyboardReview.toggleOnHint : t.storyboardReview.toggleOffHint}
            on={review}
            word={reviewBusy ? t.channels.saving : review ? t.storyboardReview.toggleOn : t.storyboardReview.toggleOff}
            onClick={askReview}
            disabled={reviewBusy || pending || !canControl}
            title={canControl ? undefined : t.channels.adminOnly}
          />
          {/* Publish when approved (migration 0113). Off is the default; on queues an approved video to be made public by a
              worker, which YouTube may still refuse. Only shown once the migration is applied. */}
          {showPublishSwitch && (
            <SwitchRow
              id={`${titleId}-publish-on-approve`}
              label={t.channels.publishOnLabel}
              hint={publishOn ? t.channels.publishOnHintOn : t.channels.publishOnHintOff}
              on={publishOn}
              word={publishBusy ? t.channels.saving : publishOn ? t.channels.publishOnOn : t.channels.publishOnOff}
              onClick={askPublishOn}
              disabled={publishBusy || pending || !canControl}
              title={canControl ? undefined : t.channels.adminOnly}
            />
          )}
          {error && (
            <p className="g2-fail tnum pt-2" role="alert">
              {t.channels.saveFailed}: {error}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {/* -- health ------------------------------------------------------ */}
          <div className="g2-sub-block">
            <div className="g2-sub-head">
              <h3 className="g2-label">{t.channels.health}</h3>
              <StatusLamp tone={healthLamp.tone} label={healthLamp.label} />
            </div>
            <ul className="g2-subsystems">
              {health.subsystems.map((s) => (
                <li key={s.key}>
                  <span aria-hidden className="g2-dot" data-tone={s.tone} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-[var(--color-fg)]">{subsystemLabel(s.key, t)}</span>
                    {s.detail && <small className="tnum">{s.detail}</small>}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* -- youtube ----------------------------------------------------- */}
          <div className="g2-sub-block">
            <div className="g2-sub-head">
              <h3 className="g2-label">{t.channels.youtube}</h3>
              <StatusLamp tone={credentialLamp.tone} label={credentialLamp.label} />
            </div>
            {credential ? (
              <dl className="g2-inline-dl">
                {credential.youtube_channel_id && (
                  <div>
                    <dt>{t.channels.youtube}: </dt>
                    <dd>{credential.youtube_channel_id}</dd>
                  </div>
                )}
                {credential.last_verified_at && (
                  <div>
                    <dt>{t.channels.lastVerified}: </dt>
                    <dd>{relativeTime(credential.last_verified_at, locale)}</dd>
                  </div>
                )}
                {credential.expires_at && (
                  <div>
                    <dt>{t.channels.expiresAt}: </dt>
                    <dd>{relativeTime(credential.expires_at, locale)}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="g2-note">{t.channels.noCredential}</p>
            )}
            {credential?.detail && <p className="g2-note">{credential.detail}</p>}
            {/* The GitHub-secret hint is the operator's path; a customer channel
                connects in the panel below instead. */}
            {credential?.status !== "connected" && !vault && (
              <p className="g2-note">
                {fmt(t.channels.connectHint, {
                  id: channel.channel_id,
                  secret: secretName(channel),
                })}
              </p>
            )}
            {vault && <ChannelTokenPanel channelId={channel.channel_id} {...vault} />}
          </div>
        </div>
      </div>

      {dna}

      {/* -- configuration ----------------------------------------------- */}
      <dl className="g2-facts">
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
        <p className="g2-note">
          <span className="g2-label">{t.channels.visualStyle}: </span>
          {agent.visual_style_prompt}
        </p>
      )}

      <Link
        // This channel's videos, on this channel's own URL — the link carries
        // the lens, so the page opens already scoped.
        href={`/${encodeURIComponent(slug)}/videos`}
        className="tap-link g2-link g2-chan-link text-sm"
      >
        {t.channels.videos} →
      </Link>
      {dialog}
    </section>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  on,
  word,
  onClick,
  disabled,
  title,
}: {
  id: string;
  label: string;
  hint: string;
  on: boolean;
  word: string;
  onClick: () => void;
  disabled: boolean;
  title?: string;
}) {
  return (
    <div className="g2-switchrow">
      <div className="min-w-0 flex-1" style={{ flexBasis: "16rem" }}>
        <div id={`${id}-label`} className="g2-strong">{label}</div>
        <p className="g2-note mt-1">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-word`}
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="g2-switch"
      >
        <span aria-hidden className="g2-switch-track">
          <span className="g2-switch-thumb" />
        </span>
        <span id={`${id}-word`} className="g2-switch-word">{word}</span>
      </button>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
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
