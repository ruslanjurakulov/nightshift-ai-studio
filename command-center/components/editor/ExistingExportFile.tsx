"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { coerceAssets, formatMediaBytes, type MediaAsset } from "@/lib/media";

/** Reads an already stored original. Never requests a render or claims the browser saved its bytes. */
export function ExistingExportFile({ assetId }: { assetId: string }) {
  const { t } = useI18n();
  const ep = t.editor.exportPanel;
  const locked = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "missing" | "failed" | "unavailable" | "handed">("idle");
  const [asset, setAsset] = useState<MediaAsset | null>(null);

  async function download() {
    if (locked.current) return;
    locked.current = true;
    setState("loading");
    setAsset(null);
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(assetId)}`, { cache: "no-store" });
      if (res.status === 404) { setState("missing"); return; }
      if (!res.ok) { setState("failed"); return; }
      const body = await res.json() as { asset?: unknown; urls?: Record<string, unknown>; served?: boolean };
      const raw = body.asset as Partial<MediaAsset> | null | undefined;
      // The existing metadata endpoint has already shaped its row to camelCase.
      const found = raw && typeof raw === "object" && !Array.isArray(raw)
        ? coerceAssets([{ ...raw, original_name: raw.name, duration_s: raw.durationS, created_at: raw.createdAt }])[0]
        : undefined;
      if (!found || found.id !== assetId) { setState("failed"); return; }
      setAsset(found);
      const original = body.urls?.original;
      // Same signed same-origin path used by the existing Studio download key; no URL fallback or re-signing here.
      if (!body.served || typeof original !== "string" || !original.startsWith("/api/media/file/")) {
        setState("unavailable"); return;
      }
      const link = document.createElement("a");
      link.href = original;
      link.download = found.name ?? "";
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      setState("handed");
    } catch {
      setState("failed");
    } finally {
      locked.current = false;
    }
  }

  const message = state === "missing" ? ep.fileMissing : state === "failed" ? ep.fileReadFailed
    : state === "unavailable" ? ep.fileUnavailable : state === "handed" ? ep.fileHanded : null;
  return <div className="flex basis-full flex-col items-start gap-2" data-existing-export-file>
    <button type="button" className="btn-quiet min-h-11 text-sm" disabled={state === "loading"} onClick={() => void download()}>
      {state === "loading" ? ep.fileDownloading : ep.fileDownload}
    </button>
    <div role="status" aria-live="polite" className="text-xs text-[var(--color-muted)]">
      {asset ? <p className="m-0">{fmt(ep.fileFacts, { format: asset.mime, size: formatMediaBytes(asset.bytes) })}</p> : null}
      {message ? <p className="m-0">{message}</p> : null}
    </div>
  </div>;
}
