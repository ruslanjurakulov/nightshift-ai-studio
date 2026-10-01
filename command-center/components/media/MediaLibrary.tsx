"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Captions, FileAudio, FileVideo, Image as ImageIcon, Images, Trash2, Upload, type LucideIcon } from "lucide-react";
import { EmptyState, StatusPill } from "@/components/ui";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  UPLOAD_ACCEPT,
  formatDuration,
  formatMediaBytes,
  isUploadInFlight,
  isWaitingForCheck,
  knownUploadReason,
  pipelineIsDown,
  type LibraryAsset,
  type MediaKind,
  type MediaLibraryData,
  type UploadStatus,
} from "@/lib/media";

const KIND_ICON: Record<MediaKind, LucideIcon> = {
  image: ImageIcon,
  video: FileVideo,
  audio: FileAudio,
  caption: Captions,
};

const STATUS_TONE: Record<UploadStatus, "ok" | "run" | "fail" | "warn" | "idle"> = {
  requested: "idle",
  receiving: "run",
  uploaded: "idle",
  ingesting: "run",
  ingested: "ok",
  rejected: "fail",
  expired: "warn",
};

/** A signed link lives 10 minutes; fetch fresh ones well before that. */
const RESIGN_MS = 5 * 60_000;
const POLL_MS = 3000;

type ErrorWord = keyof ReturnType<typeof useI18n>["t"]["media"]["errors"];

/**
 * The library's interactive half: upload (ticket -> streamed PUT with
 * progress), the uploads still being checked, the assets, delete.
 *
 * Nothing here decides anything: /api/media/uploads asks the database for a
 * ticket (membership, type, size, quota), the PUT route streams the body to
 * the server, and the media worker checks the content. The list is what
 * GET /api/media returns under the member's session — refreshed while an
 * upload is on its way, and every few minutes so the signed links stay fresh.
 */
export function MediaLibrary({ orgId, initial }: { orgId: string; initial: MediaLibraryData }) {
  const { t, locale } = useI18n();
  const tm = t.media;
  const [data, setData] = useState<MediaLibraryData>(initial);
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<LibraryAsset | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(Boolean(initial.error));
  const input = useRef<HTMLInputElement>(null);

  const canUpload = data.host.media && data.host.staging;
  const inFlight = data.uploads.some(isUploadInFlight);
  const maxLabel = formatMediaBytes(data.quota.maxUploadBytes);
  // File checking is down (not reporting, or failed) AND something is waiting
  // on it: say so instead of "waiting for the server" for good. "unknown"
  // (0045 missing, or the read failed) says nothing.
  const checkingDown = pipelineIsDown(data.pipeline) && data.uploads.some(isWaitingForCheck);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/media?org=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      if (!res.ok) {
        setReadFailed(true);
        return;
      }
      const next = (await res.json()) as MediaLibraryData;
      setData(next);
      setReadFailed(Boolean(next.error));
    } catch {
      setReadFailed(true);
    }
  }, [orgId]);

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, refresh]);

  useEffect(() => {
    const timer = setInterval(refresh, RESIGN_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  function errorText(word: unknown, max?: number | null): string {
    const key = (typeof word === "string" && word in tm.errors ? word : "failed") as ErrorWord;
    return fmt(tm.errors[key], { max: formatMediaBytes(max ?? data.quota.maxUploadBytes) || "—" });
  }

  function send(url: string, file: File): Promise<{ status: number; body: { error?: string; max_bytes?: number } }> {
    // XMLHttpRequest, not fetch: only it reports upload progress.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress({ name: file.name, pct: Math.floor((e.loaded / e.total) * 100) });
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText || "{}");
        } catch {
          body = {};
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new Error("network"));
      xhr.onabort = () => reject(new Error("network"));
      xhr.send(file);
    });
  }

  async function upload(file: File) {
    setError(null);
    setProgress({ name: file.name, pct: 0 });
    try {
      const res = await fetch("/api/media/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: orgId, filename: file.name, mime: file.type, bytes: file.size }),
      });
      const ticket = (await res.json().catch(() => ({}))) as { upload_url?: string; error?: string; max_bytes?: number };
      if (!res.ok || !ticket.upload_url) {
        setError(errorText(ticket.error, ticket.max_bytes));
        return;
      }
      await refresh();
      const put = await send(ticket.upload_url, file);
      if (put.status < 200 || put.status >= 300) {
        setError(put.status === 408 ? tm.errors.network : errorText(put.body.error, put.body.max_bytes));
      }
    } catch {
      setError(tm.errors.network);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
      await refresh();
    }
  }

  async function remove(asset: LibraryAsset) {
    setDeleting(asset.id);
    setError(null);
    try {
      const res = await fetch(`/api/media/${asset.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errorText(body.error));
      }
    } catch {
      setError(tm.errors.network);
    } finally {
      setDeleting(null);
      setConfirm(null);
      await refresh();
    }
  }

  const q = data.quota;
  const storageLine =
    q.limitBytes === null
      ? fmt(tm.storageUnknown, { used: formatMediaBytes(q.usedBytes) || "0 KB" })
      : fmt(tm.storageUsed, { used: formatMediaBytes(q.usedBytes) || "0 KB", limit: formatMediaBytes(q.limitBytes) || "0 KB" });
  const usedPct = q.limitBytes ? Math.min(100, Math.round((q.usedBytes / q.limitBytes) * 100)) : null;
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <div className="flex flex-col gap-4">
      {!canUpload && <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{tm.noHost}</div>}
      {canUpload && !data.host.signing && (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{tm.noSigning}</div>
      )}
      {readFailed && (
        <div role="alert" className="panel p-4 text-[13px] text-[var(--color-fail)]">
          {tm.readFailed}
        </div>
      )}

      <div className="panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="t-label">{tm.storage}</span>
            <span className="text-[13px]">{storageLine}</span>
            {usedPct !== null && (
              <div
                className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usedPct}
                aria-label={tm.storage}
              >
                <div className="h-full bg-[var(--color-primary)]" style={{ width: `${usedPct}%` }} />
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <input
              ref={input}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="sr-only"
              id="media-upload"
              disabled={!canUpload || progress !== null}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <label
              htmlFor="media-upload"
              aria-disabled={!canUpload || progress !== null}
              className={`btn-sky is-solid pill inline-flex items-center gap-2 px-5 py-2 text-[13px] ${
                !canUpload || progress !== null ? "pointer-events-none opacity-40" : "cursor-pointer"
              }`}
            >
              <Upload size={14} aria-hidden />
              {progress ? fmt(tm.uploading, { name: progress.name, pct: progress.pct }) : tm.upload}
            </label>
          </div>
        </div>
        <p className="m-0 text-[12px] text-[var(--color-muted)]">
          {tm.accepted}
          {maxLabel ? ` · ${fmt(tm.maxSize, { max: maxLabel })}` : ""}
        </p>
        <p className="m-0 text-[12px] text-[var(--color-muted)]">{tm.checkNote}</p>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[var(--color-fail)]">
            {error}
          </p>
        )}
      </div>

      {data.uploads.length > 0 && (
        <div className="panel flex flex-col gap-2 p-4">
          <h2 className="t-section">{tm.uploads}</h2>
          {checkingDown && (
            <p role="status" data-pipeline-down className="m-0 text-[13px] text-[var(--color-warn)]">
              {tm.pipelineDown}
            </p>
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {data.uploads.map((u) => {
              const reason = knownUploadReason(u.reason);
              return (
                <li key={u.id} className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate">{u.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[12px] text-[var(--color-muted)]">{formatMediaBytes(u.bytes)}</span>
                    {checkingDown && isWaitingForCheck(u) ? (
                      <StatusPill tone="warn" label={tm.status.paused} />
                    ) : (
                      <StatusPill tone={STATUS_TONE[u.status]} label={tm.status[u.status]} live={isUploadInFlight(u)} />
                    )}
                  </span>
                  {(u.status === "rejected" || u.status === "expired") && (
                    <span className="w-full text-[12px] text-[var(--color-muted)]">
                      {reason ? tm.reasons[reason] : tm.reasons.other}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="panel flex flex-col gap-3 p-4">
        <h2 className="t-section">{fmt(tm.assets, { n: data.assets.length })}</h2>
        {data.assets.length === 0 ? (
          <EmptyState icon={Images}>{tm.empty}</EmptyState>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.assets.map((a) => {
              const Icon = KIND_ICON[a.kind];
              const meta = [
                tm.kinds[a.kind],
                a.width && a.height ? `${a.width}×${a.height}` : "",
                formatDuration(a.durationS),
                formatMediaBytes(a.bytes),
                tm.sources[a.source],
              ].filter(Boolean);
              return (
                <li key={a.id} className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
                  <div className="grid aspect-video place-items-center overflow-hidden rounded-lg bg-[var(--color-panel-2)]">
                    {a.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived same-origin link; next/image would re-host it
                      <img src={a.thumbUrl} alt={a.name ?? tm.kinds[a.kind]} className="h-full w-full object-contain" loading="lazy" />
                    ) : (
                      <span className="flex flex-col items-center gap-1 text-[var(--color-muted)]">
                        <Icon className="size-6" strokeWidth={1.5} aria-hidden />
                        <span className="text-[11px]">{tm.noPreview}</span>
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 truncate text-[13px]" title={a.name ?? undefined}>
                    {a.name ?? tm.kinds[a.kind]}
                  </div>
                  <div className="text-[12px] text-[var(--color-muted)]">{meta.join(" · ")}</div>
                  {a.createdAt && <div className="text-[11px] text-[var(--color-muted)]">{dateFmt.format(new Date(a.createdAt))}</div>}
                  {a.kind === "audio" && a.viewUrl && <audio controls preload="none" src={a.viewUrl} className="w-full" />}
                  <div className="flex items-center justify-between gap-2">
                    {a.viewUrl && a.kind !== "audio" ? (
                      <a href={a.viewUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] text-[var(--color-primary)]">
                        {tm.open}
                      </a>
                    ) : (
                      <span />
                    )}
                    {confirm?.id === a.id ? (
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={deleting === a.id}
                          onClick={() => remove(a)}
                          className="btn-sky is-solid pill px-3 py-1 text-[12px] disabled:opacity-40"
                        >
                          {deleting === a.id ? tm.deleting : tm.delete}
                        </button>
                        <button type="button" onClick={() => setConfirm(null)} className="text-[12px] text-[var(--color-muted)]">
                          {tm.cancel}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirm(a)}
                        className="inline-flex items-center gap-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-fail)]"
                        aria-label={`${tm.delete}: ${a.name ?? tm.kinds[a.kind]}`}
                      >
                        <Trash2 size={13} aria-hidden />
                        {tm.delete}
                      </button>
                    )}
                  </div>
                  {confirm?.id === a.id && (
                    <p className="m-0 text-[12px] text-[var(--color-muted)]">
                      {fmt(tm.deleteConfirm, { name: a.name ?? tm.kinds[a.kind] })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
