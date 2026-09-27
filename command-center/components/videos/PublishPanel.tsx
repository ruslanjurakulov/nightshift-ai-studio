"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Download, ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { StatusPill } from "@/components/ui";
import { PlatformLogo } from "@/components/social/PlatformLogo";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { accountLabel, type SocialAccount } from "@/lib/social-accounts";
import {
  PUBLISH_REQUEST_COLUMNS,
  coercePublishRequests,
  downloadName,
  isLive,
  knownReason,
  latestByAccount,
  publishBlocker,
  type PublishRequestRow,
  type PublishStatus,
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
  requests: PublishRequestRow[];
  /** False when 0028 / 0029 are not applied. */
  available: boolean;
  role: Role;
}

/**
 * A finished video's "Download" and "Publish to platforms".
 *
 * Download mints a short-lived signed URL for the stored copy with the anon key
 * against the previews bucket's RLS read policy — the same mechanism the
 * review player uses; nothing durable is handed out.
 *
 * Send writes publish_requests rows through /api/publish-requests and stops.
 * The queue worker uploads, after checking the publish gate and approvals
 * again; this panel only shows each request's status as the worker records it.
 */
export function PublishPanel({ video, channelName, accounts, requests, available, role }: PublishPanelProps) {
  const { t } = useI18n();
  const tp = t.publish;
  const path = useChannelPath();
  const [rows, setRows] = useState<PublishRequestRow[]>(requests);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  const latest = useMemo(() => latestByAccount(rows), [rows]);
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

  async function download() {
    if (!video.preview_path) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      const supabase = createClient();
      if (!supabase) throw new Error("no client");
      const { data, error } = await supabase.storage
        .from("previews")
        .createSignedUrl(video.preview_path, 600, { download: downloadName(video.title, video.video_id) });
      if (error || !data?.signedUrl) throw new Error("sign");
      window.location.assign(data.signedUrl);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }

  async function send() {
    if (picked.size === 0) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/publish-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: video.video_id, account_ids: [...picked] }),
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
      <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-[var(--color-muted)]">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={TONE[r.status]} label={tp.status[r.status]} live={isLive(r.status)} />
          {r.status === "published" && r.privacy === "SELF_ONLY" && <span>{tp.privateOnTiktok}</span>}
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

  return (
    <section className="section-card flex flex-col gap-4" aria-labelledby="publish-title">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="publish-title" className="t-panel">
          {tp.title}
        </h2>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={download}
            disabled={!video.preview_path || downloading}
            className="btn-sky ghost pill inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] disabled:opacity-50"
          >
            <Download size={14} aria-hidden />
            {downloading ? tp.downloading : tp.download}
          </button>
          <span className="text-[10px] text-[var(--color-muted)]">
            {video.preview_path ? tp.downloadNote : tp.downloadNone}
          </span>
          {downloadError && <span className="text-[11px] text-[var(--color-fail)]">{tp.downloadFailed}</span>}
        </div>
      </header>

      <div>
        <h3 className="text-[12px] font-semibold">{tp.publishTitle}</h3>
        {blocker && (
          <p className="mt-1 text-[12px] text-[var(--color-warn)]" role="status">
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
            <div className="flex items-center gap-1.5 text-[13px]">
              <span className="truncate">{channelName}</span>
              {!held && <CheckCircle2 size={14} style={{ color: "var(--color-ok)" }} aria-hidden />}
            </div>
            <div className="text-[11px] text-[var(--color-muted)]">
              {held ? tp.youtubeHeld : fmt(tp.youtubeHere, { privacy: video.privacy ?? "private" })}
            </div>
          </div>
        </li>

        {!available ? (
          <li className="text-[12px] text-[var(--color-muted)]">{tp.notAvailable}</li>
        ) : accounts.length === 0 ? (
          <li className="text-[12px] text-[var(--color-muted)]">
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
                  <div className="flex items-center gap-1.5 text-[13px]">
                    {a.avatar_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.avatar_url}
                        alt=""
                        width={18}
                        height={18}
                        referrerPolicy="no-referrer"
                        className="h-[18px] w-[18px] rounded-full object-cover"
                      />
                    )}
                    <span className="truncate">{accountLabel(a)}</span>
                    {a.status === "connected" && (
                      <CheckCircle2 size={14} style={{ color: "var(--color-ok)" }} aria-hidden />
                    )}
                  </div>
                  {a.status !== "connected" && (
                    <div className="text-[11px] text-[var(--color-warn)]">{tp.reconnect}</div>
                  )}
                  {a.platform === "tiktok" && !last && (
                    <div className="text-[11px] text-[var(--color-muted)]">{tp.tiktokPrivate}</div>
                  )}
                  {last && statusLine(last)}
                </div>
              </li>
            );
          })
        )}
      </ul>

      {available && accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={send}
            disabled={!editor || Boolean(blocker) || picked.size === 0 || sending}
            className="btn-sky pill px-5 py-2 text-[13px] disabled:opacity-50"
          >
            {sending ? tp.sending : picked.size ? fmt(tp.sendN, { n: picked.size }) : tp.send}
          </button>
          {!editor && <span className="text-[11px] text-[var(--color-muted)]">{tp.editorOnly}</span>}
          <span className="text-[11px] text-[var(--color-muted)]">{tp.sendNote}</span>
        </div>
      )}
      {sendError && <p className="mono text-[11px] text-[var(--color-fail)]">{fmt(tp.sendFailed, { error: sendError })}</p>}
    </section>
  );
}
