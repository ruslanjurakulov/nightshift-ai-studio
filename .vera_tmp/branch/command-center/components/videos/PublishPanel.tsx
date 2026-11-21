"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { StatusPill } from "@/components/ui";
import { PlatformLogo } from "@/components/social/PlatformLogo";
import { DownloadMenu, type DownloadMenuProps } from "@/components/videos/DownloadMenu";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { accountLabel, type SocialAccount } from "@/lib/social-accounts";
import {
  PUBLISH_REQUEST_COLUMNS,
  coercePublishRequests,
  isLive,
  knownReason,
  latestByTarget,
  publishBlocker,
  targetKey,
  youtubeWatchUrl,
  type PublishRequestRow,
  type PublishStatus,
  type YoutubeTarget,
} from "@/lib/publish";

const TONE: Record<PublishStatus, "ok" | "run" | "fail" | "warn" | "idle"> = {
  queued: "idle",
  uploading: "run",
  processing: "run",
  published: "ok",
  failed: "fail",
  refused: "warn",
};

export interface PublishPanelProps {
  video: {
    video_id: string;
    channel_id: string;
    title: string | null;
    privacy: string | null;
    published_at: string | null;
    publish_state?: string | null;
    review_state: string;
    preview_path: string | null;
  };
  /** The channel the video was made on, for the YouTube row. */
  channelName: string;
  accounts: SocialAccount[];
  /** The organization's YouTube channels (the video's own included). */
  youtube: YoutubeTarget[];
  requests: PublishRequestRow[];
  /** False when 0028 / 0029 are not applied. */
  available: boolean;
  role: Role;
  /** Paid 720p / 1080p downloads (migration 0030). */
  downloads: Omit<DownloadMenuProps, "video" | "role">;
}

/**
 * A finished video's "Download" and "Publish to platforms".
 *
 * Download (components/videos/DownloadMenu.tsx): 480p is the stored review
 * copy via a short-lived signed URL; 720p / 1080p are bought with credits
 * (migration 0030) and served from the Nightshift server.
 *
 * Send writes publish_requests rows through /api/publish-requests and stops.
 * The queue worker uploads, after checking the publish gate and approvals
 * again; this panel only shows each request's status as the worker records it.
 *
 * YouTube: the video's own channel already has it (the pipeline uploaded it
 * there) and is never tickable. Another of the organization's channels gets a
 * NEW private upload of the master — never public from here.
 */
export function PublishPanel({ video, channelName, accounts, youtube, requests, available, role, downloads }: PublishPanelProps) {
  const { t } = useI18n();
  const tp = t.publish;
  const path = useChannelPath();
  const [rows, setRows] = useState<PublishRequestRow[]>(requests);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const latest = useMemo(() => latestByTarget(rows), [rows]);
  const blocker = publishBlocker(video);
  const editor = atLeast(role, "editor");
  const anyLive = rows.some((r) => isLive(r.status));

  const refresh = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error } = await supabase
      .from("publish_requests")
      .select(PUBLISH_REQUEST_COLUMNS)
      .eq("video_id", video.video_id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error) setRows(coercePublishRequests(data));
  }, [video.video_id]);

  // Follow the worker while anything is in flight.
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [anyLive, refresh]);

  async function send() {
    if (picked.size === 0) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/publish-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          video_id: video.video_id,
          account_ids: [...picked].filter((k) => !k.startsWith("youtube:")),
          channel_ids: [...picked].filter((k) => k.startsWith("youtube:")).map((k) => k.slice("youtube:".length)),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { errors?: { error: string }[]; error?: string };
      if (!res.ok && !body.errors?.length) setSendError(body.error ?? `HTTP ${res.status}`);
      else if (body.errors?.length) setSendError(body.errors.map((e) => e.error).join(", "));
      setPicked(new Set());
      await refresh();
    } catch {
      setSendError("network");
    } finally {
      setSending(false);
    }
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function statusLine(r: PublishRequestRow) {
    const reason = knownReason(r.reason);
    return (
      <div className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--color-muted)]">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={TONE[r.status]} label={tp.status[r.status]} live={isLive(r.status)} />
          {r.status === "published" && r.privacy === "SELF_ONLY" && <span>{tp.privateOnTiktok}</span>}
          {r.status === "published" && r.platform === "youtube" && <span>{tp.privateOnYoutube}</span>}
          {r.result_url && (
            <a
              href={r.result_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[var(--color-primary)] underline"
            >
              {tp.openPost} <ExternalLink size={11} aria-hidden />
            </a>
          )}
        </div>
        {(r.status === "failed" || r.status === "refused") && (
          <span>
            {reason ? tp.reasons[reason] : tp.reasons.worker_error}
            {r.error ? ` — ${r.error}` : ""}
          </span>
        )}
      </div>
    );
  }

  const held = blocker === "not_uploaded";
  const ownChannel = youtube.find((c) => c.channel_id === video.channel_id);
  const otherChannels = youtube.filter((c) => c.channel_id !== video.channel_id);
  const watchUrl = held ? null : youtubeWatchUrl(video.video_id);

  return (
    <section className="section-card flex flex-col gap-4" aria-labelledby="publish-title">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="publish-title" className="t-panel">
          {tp.title}
        </h2>
        <DownloadMenu video={video} role={role} {...downloads} />
      </header>

      <div>
        <h3 className="text-xs font-semibold">{tp.publishTitle}</h3>
        {blocker && (
          <p className="mt-1 text-xs text-[var(--color-warn)]" role="status">
            {tp.blocker[blocker]}
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-3">
        {/* YouTube: the video's own channel. Nothing is sent there from here —
            the video is already on it, with the privacy its rules gave it. */}
        <li className="flex items-start gap-3">
          <input type="checkbox" checked={!held} disabled readOnly aria-label="YouTube" className="mt-1" />
          <PlatformLogo platform="youtube" size={20} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm">
              <ChannelAvatar url={ownChannel?.avatarUrl ?? null} />
              <span className="truncate">{ownChannel?.name ?? channelName}</span>
              {!held && <CheckCircle2 size={14} style={{ color: "var(--color-ok)" }} aria-hidden />}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
              {held ? (
                tp.youtubeHeld
              ) : (
                <>
                  <span>{fmt(tp.youtubeHere, { privacy: video.privacy ?? "private" })}</span>
                  {watchUrl && (
                    <a
                      href={watchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--color-primary)] underline"
                    >
                      {tp.openOnYoutube} <ExternalLink size={11} aria-hidden />
                    </a>
                  )}
                </>
              )}
            </div>
          </div>
        </li>

        {/* The organization's OTHER YouTube channels: a new private upload. */}
        {available &&
          otherChannels.map((c) => {
            const key = targetKey({ account_id: null, target_channel_id: c.channel_id });
            const last = latest.get(key);
            const live = last ? isLive(last.status) : false;
            const disabled = !editor || Boolean(blocker) || !c.connected || !c.active || live || sending;
            return (
              <li key={key} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.has(key)}
                  disabled={disabled}
                  onChange={() => toggle(key)}
                  aria-label={c.name}
                />
                <PlatformLogo platform="youtube" size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm">
                    <ChannelAvatar url={c.avatarUrl} />
                    <span className="truncate">{c.name}</span>
                    {c.connected && <CheckCircle2 size={14} style={{ color: "var(--color-ok)" }} aria-hidden />}
                  </div>
                  {!c.connected ? (
                    <div className="text-xs text-[var(--color-warn)]">{tp.youtubeReconnect}</div>
                  ) : !c.active ? (
                    <div className="text-xs text-[var(--color-warn)]">{tp.channelPaused}</div>
                  ) : (
                    !last && <div className="text-xs text-[var(--color-muted)]">{tp.youtubePrivate}</div>
                  )}
                  {last && statusLine(last)}
                </div>
              </li>
            );
          })}

        {!available ? (
          <li className="text-xs text-[var(--color-muted)]">{tp.notAvailable}</li>
        ) : accounts.length === 0 ? (
          <li className="text-xs text-[var(--color-muted)]">
            {tp.noAccounts}{" "}
            <Link href={path("/channels")} className="text-[var(--color-primary)] underline">
              {tp.connectAccounts}
            </Link>
          </li>
        ) : (
          accounts.map((a) => {
            const last = latest.get(a.id);
            const live = last ? isLive(last.status) : false;
            const disabled = !editor || Boolean(blocker) || a.status !== "connected" || live || sending;
            return (
              <li key={a.id} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.has(a.id)}
                  disabled={disabled}
                  onChange={() => toggle(a.id)}
                  aria-label={accountLabel(a)}
                />
                <PlatformLogo platform={a.platform} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm">
                    <ChannelAvatar url={a.avatar_url} />
                    <span className="truncate">{accountLabel(a)}</span>
                    {a.status === "connected" && (
                      <CheckCircle2 size={14} style={{ color: "var(--color-ok)" }} aria-hidden />
                    )}
                  </div>
                  {a.status !== "connected" && (
                    <div className="text-xs text-[var(--color-warn)]">{tp.reconnect}</div>
                  )}
                  {a.platform === "tiktok" && !last && (
                    <div className="text-xs text-[var(--color-muted)]">{tp.tiktokPrivate}</div>
                  )}
                  {last && statusLine(last)}
                </div>
              </li>
            );
          })
        )}
      </ul>

      {available && (accounts.length > 0 || otherChannels.length > 0) && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={send}
            disabled={!editor || Boolean(blocker) || picked.size === 0 || sending}
            className="btn-sky pill px-5 py-2 text-sm disabled:opacity-50"
          >
            {sending ? tp.sending : picked.size ? fmt(tp.sendN, { n: picked.size }) : tp.send}
          </button>
          {!editor && <span className="text-xs text-[var(--color-muted)]">{tp.editorOnly}</span>}
          <span className="text-xs text-[var(--color-muted)]">{tp.sendNote}</span>
        </div>
      )}
      {sendError && <p className="tnum text-xs text-[var(--color-fail)]">{fmt(tp.sendFailed, { error: sendError })}</p>}
    </section>
  );
}

/** A small round avatar; only an https URL from the platform is rendered. */
function ChannelAvatar({ url }: { url: string | null }) {
  if (!url || !url.startsWith("https://")) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={18}
      height={18}
      referrerPolicy="no-referrer"
      className="h-[18px] w-[18px] rounded-full object-cover"
    />
  );
}
