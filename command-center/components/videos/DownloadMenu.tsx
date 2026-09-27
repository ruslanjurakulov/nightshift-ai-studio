"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { StatusPill } from "@/components/ui";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { downloadName } from "@/lib/publish";
import type { PriceMap } from "@/lib/credits";
import {
  DOWNLOAD_REQUEST_COLUMNS,
  availableQualities,
  coerceDownloadRequests,
  formatBytes,
  freeRedownload,
  isPreparing,
  knownDownloadReason,
  latestByQuality,
  nextCharge,
  readyRow,
  type DownloadMaster,
  type DownloadQuality,
  type DownloadRequestRow,
  type DownloadStatus,
  type HdQuality,
} from "@/lib/downloads";

const TONE: Record<DownloadStatus, "ok" | "run" | "fail" | "warn" | "idle"> = {
  queued: "idle",
  processing: "run",
  ready: "ok",
  failed: "fail",
  expired: "warn",
};

export interface DownloadMenuProps {
  video: { video_id: string; title: string | null; preview_path: string | null };
  available: boolean;
  host: boolean;
  master: DownloadMaster | null;
  prices: PriceMap;
  requests: DownloadRequestRow[];
  balance: number | null;
  exempt: boolean;
  role: Role;
}

/**
 * "Download" with a quality choice (migration 0030).
 *
 * 480p is the stored review copy, free, via a short-lived signed URL (as
 * before). 720p / 1080p are offered only up to the master's own resolution
 * (the worker records it) and only on a host that serves them; each shows its
 * exact credit price. Buying goes through /api/downloads, which calls the
 * database's request_download() as the signed-in user — the database decides
 * the price, the charge and whether it is free (re-download within 7 days,
 * operator organization). The file is then streamed by /api/downloads/<id>.
 */
export function DownloadMenu(props: DownloadMenuProps) {
  const { video, available, host, master, prices, balance, exempt, role } = props;
  const { t, locale } = useI18n();
  const tp = t.publish;
  const td = tp.dl;
  const path = useChannelPath();
  const [rows, setRows] = useState<DownloadRequestRow[]>(props.requests);
  const [quality, setQuality] = useState<DownloadQuality>("480p");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(balance);

  const hd = useMemo(() => (available && host ? availableQualities(master) : []), [available, host, master]);
  const latest = latestByQuality(rows);
  const editor = atLeast(role, "editor");
  const anyPreparing = rows.some((r) => isPreparing(r));

  const refresh = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error: e } = await supabase
      .from("download_requests")
      .select(DOWNLOAD_REQUEST_COLUMNS)
      .eq("video_id", video.video_id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!e) setRows(coerceDownloadRequests(data));
  }, [video.video_id]);

  useEffect(() => {
    if (!anyPreparing) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [anyPreparing, refresh]);

  function priceOf(q: HdQuality): number | null {
    return nextCharge({ quality: q, master, prices, rows, exempt });
  }

  function priceLabel(q: DownloadQuality): string {
    if (q === "480p") return td.free;
    const p = priceOf(q);
    if (p === null) return td.unpriced;
    if (p === 0) return freeRedownload(rows, q) ? td.freeRedownload : td.free;
    return fmt(td.credits, { n: p });
  }

  async function download480() {
    if (!video.preview_path) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      if (!supabase) throw new Error("no client");
      const { data, error: e } = await supabase.storage
        .from("previews")
        .createSignedUrl(video.preview_path, 600, { download: downloadName(video.title, video.video_id) });
      if (e || !data?.signedUrl) throw new Error("sign");
      window.location.assign(data.signedUrl);
    } catch {
      setError(tp.downloadFailed);
    } finally {
      setBusy(false);
    }
  }

  async function buy(q: HdQuality) {
    const price = priceOf(q);
    if (price === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/downloads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: video.video_id, quality: q, max_credits: price }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; available?: number | null };
      if (!res.ok) {
        const word = (body.error ?? "failed") as keyof typeof td.errors;
        setError(td.errors[word] ?? td.errors.failed);
        if (typeof body.available === "number") setCredits(body.available);
      } else if (credits !== null && price > 0) {
        setCredits(Math.max(0, credits - price));
      }
      setConfirming(false);
      await refresh();
    } catch {
      setError(td.errors.network);
    } finally {
      setBusy(false);
    }
  }

  const selectedHd = quality === "480p" ? null : quality;
  const last = selectedHd ? latest[selectedHd] : undefined;
  const lastReady = selectedHd ? readyRow(last) : false;
  const lastPreparing = isPreparing(last);
  const price = selectedHd ? priceOf(selectedHd) : 0;
  const short = selectedHd !== null && price !== null && price > 0 && credits !== null && credits < price;
  const whyFree = selectedHd && price === 0 ? (exempt ? td.whyExempt : td.whyRedownload) : "";

  const options: DownloadQuality[] = ["480p", ...hd];
  const note = !available ? td.notAvailable : !host ? td.noHost : !master ? td.noMaster : null;

  return (
    <div className="flex max-w-[360px] flex-col items-end gap-1.5 text-right">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="text-[11px] text-[var(--color-muted)]" htmlFor="dl-quality">
          {td.quality}
        </label>
        <select
          id="dl-quality"
          value={quality}
          onChange={(e) => {
            setQuality(e.target.value as DownloadQuality);
            setConfirming(false);
            setError(null);
          }}
          className="rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-[12px]"
        >
          {options.map((q) => (
            <option key={q} value={q}>
              {q} — {priceLabel(q)}
            </option>
          ))}
        </select>

        {selectedHd === null ? (
          <button
            type="button"
            onClick={download480}
            disabled={!video.preview_path || busy}
            className="btn-sky ghost pill inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] disabled:opacity-50"
          >
            <Download size={14} aria-hidden />
            {busy ? tp.downloading : tp.download}
          </button>
        ) : lastReady && last ? (
          <a
            href={`/api/downloads/${last.id}`}
            className="btn-sky pill inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px]"
            download
          >
            <Download size={14} aria-hidden />
            {fmt(td.downloadFile, { q: selectedHd })}
          </a>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!editor || busy || lastPreparing || price === null || short || confirming}
            className="btn-sky ghost pill inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] disabled:opacity-50"
          >
            <Download size={14} aria-hidden />
            {fmt(td.get, { q: selectedHd })}
          </button>
        )}
      </div>

      {selectedHd === null && (
        <span className="text-[10px] text-[var(--color-muted)]">
          {video.preview_path ? tp.downloadNote : tp.downloadNone}
        </span>
      )}
      {note && <span className="text-[10px] text-[var(--color-muted)]">{note}</span>}

      {selectedHd && !exempt && credits !== null && (
        <span className="text-[11px] text-[var(--color-muted)]">
          {fmt(td.balance, { n: credits })}
          {short && (
            <>
              {" · "}
              <Link href={path("/credits")} className="text-[var(--color-primary)] underline">
                {td.buyCredits}
              </Link>
            </>
          )}
        </span>
      )}
      {short && price !== null && selectedHd && (
        <span className="text-[11px] text-[var(--color-warn)]">{fmt(td.insufficient, { q: selectedHd, n: price })}</span>
      )}
      {selectedHd && !editor && !lastReady && <span className="text-[11px] text-[var(--color-muted)]">{td.editorOnly}</span>}

      {confirming && selectedHd && price !== null && (
        <div role="dialog" aria-modal="false" className="section-card mt-1 flex flex-col gap-2 p-3 text-left text-[12px]">
          <strong>
            {price > 0 ? fmt(td.confirmTitle, { q: selectedHd, n: price }) : fmt(td.confirmFree, { q: selectedHd, why: whyFree })}
          </strong>
          {price > 0 && credits !== null && (
            <span>{fmt(td.confirmBody, { b: credits, a: Math.max(0, credits - price) })}</span>
          )}
          <span className="text-[11px] text-[var(--color-muted)]">{fmt(td.confirmTerms, { q: selectedHd })}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => buy(selectedHd)}
              disabled={busy}
              className="btn-sky pill px-4 py-1.5 text-[12px] disabled:opacity-50"
            >
              {busy ? td.buying : td.confirm}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="btn-sky ghost pill px-4 py-1.5 text-[12px]"
            >
              {td.cancel}
            </button>
          </div>
        </div>
      )}

      {selectedHd && last && (
        <div className="flex flex-col items-end gap-0.5 text-[11px] text-[var(--color-muted)]">
          <StatusPill
            tone={TONE[last.status === "ready" && !lastReady ? "expired" : last.status]}
            label={td.status[last.status === "ready" && !lastReady ? "expired" : last.status]}
            live={isPreparing(last)}
          />
          {lastReady && last.expires_at && (
            <span>
              {fmt(td.readyLine, {
                size: formatBytes(last.bytes),
                t: new Date(last.expires_at).toLocaleString(locale),
              })}
            </span>
          )}
          {last.status === "failed" && (
            <span>
              {td.reasons[knownDownloadReason(last.reason) ?? "worker_error"]}
              {last.refunded && last.charged > 0 ? ` — ${fmt(td.refunded, { n: last.charged })}` : ""}
            </span>
          )}
        </div>
      )}
      {error && <span className="text-[11px] text-[var(--color-fail)]">{error}</span>}
    </div>
  );
}
