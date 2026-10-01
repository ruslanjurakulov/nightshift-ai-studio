"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Images, Search, Upload } from "lucide-react";
import { StatusPill } from "@/components/ui";
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
  type MediaLibraryData,
  type MediaUpload,
  type UploadStatus,
} from "@/lib/media";
import { KIND_ICON } from "./kindIcon";
import { LibrarySkeleton } from "./LibrarySkeleton";
import { MediaViewer } from "./MediaViewer";
import {
  DEFAULT_VIEW,
  LIBRARY_FILTERS,
  countByFilter,
  guessUploadKind,
  isNarrowed,
  visibleAssets,
  visibleUploads,
  type LibrarySort,
  type LibraryView,
} from "./libraryView";

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

/** The small chip laid over a thumbnail (kind, duration): legible on any picture, in both themes. */
const BADGE =
  "inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-panel)_86%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)] backdrop-blur-sm";

/**
 * The library's interactive half: upload (ticket -> streamed PUT with
 * progress), the uploads still being checked, the assets as a grid with
 * chips / search / sort, a viewer, delete (one, or several in a row).
 *
 * Nothing here decides anything: /api/media/uploads asks the database for a
 * ticket (membership, type, size, quota), the PUT route streams the body to
 * the server, and the media worker checks the content. The list is what
 * GET /api/media returns under the member's session — refreshed while an
 * upload is on its way, and every few minutes so the signed links stay fresh.
 * Deleting several files is the same DELETE /api/media/{id}, once per file.
 *
 * Without `initial` the list is fetched on mount, and until it arrives the
 * page shows a skeleton — never "nothing here yet".
 */
export function MediaLibrary({ orgId, initial }: { orgId: string; initial?: MediaLibraryData | null }) {
  const { t, locale } = useI18n();
  const tm = t.media;
  const [data, setData] = useState<MediaLibraryData | null>(initial ?? null);
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(Boolean(initial?.error));
  const [view, setView] = useState<LibraryView>(DEFAULT_VIEW);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const inputId = useId();

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

  // No list from the server render: read it now (the skeleton shows meanwhile).
  useEffect(() => {
    if (!initial) void refresh();
    // Only on mount: `initial` is the server's first answer, not a live input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inFlight = Boolean(data?.uploads.some(isUploadInFlight));
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, refresh]);

  useEffect(() => {
    const timer = setInterval(refresh, RESIGN_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const assets = useMemo(() => data?.assets ?? [], [data]);
  const counts = useMemo(() => countByFilter(assets), [assets]);
  const shown = useMemo(() => visibleAssets(assets, view, (k) => tm.kinds[k]), [assets, view, tm]);
  const pending = useMemo(() => visibleUploads(data?.uploads ?? [], view), [data, view]);
  const viewerIndex = viewerId ? shown.findIndex((a) => a.id === viewerId) : -1;

  // The open file left the grid (deleted elsewhere, filtered away): the viewer closes.
  useEffect(() => {
    if (viewerId && viewerIndex < 0) setViewerId(null);
  }, [viewerId, viewerIndex]);

  // Selection only ever holds files that are still there.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(assets.map((a) => a.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [assets]);

  if (!data) {
    return readFailed ? (
      <div role="alert" className="panel p-4 text-[13px] text-[var(--color-fail)]">
        {tm.readFailed}
      </div>
    ) : (
      <LibrarySkeleton label={tm.loading} />
    );
  }

  const canUpload = data.host.media && data.host.staging;
  const busy = !canUpload || progress !== null;
  const maxLabel = formatMediaBytes(data.quota.maxUploadBytes);
  // File checking is down (not reporting, or failed) AND something is waiting
  // on it: say so instead of "waiting for the server" for good. "unknown"
  // (0045 missing, or the read failed) says nothing.
  const checkingDown = pipelineIsDown(data.pipeline) && data.uploads.some(isWaitingForCheck);
  const nothingAtAll = assets.length === 0 && data.uploads.length === 0 && progress === null;
  const nothingShown = shown.length === 0 && pending.length === 0 && progress === null;

  function errorText(word: unknown, max?: number | null): string {
    const key = (typeof word === "string" && word in tm.errors ? word : "failed") as ErrorWord;
    return fmt(tm.errors[key], { max: formatMediaBytes(max ?? data?.quota.maxUploadBytes ?? null) || "—" });
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

  /** One DELETE; true when the server took it. Never throws. */
  async function deleteOne(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`/api/media/${id}`, { method: "DELETE" });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error };
    } catch {
      return { ok: false, error: "network" };
    }
  }

  async function removeFromViewer(asset: LibraryAsset) {
    const at = shown.findIndex((a) => a.id === asset.id);
    const neighbour = shown[at + 1] ?? shown[at - 1] ?? null;
    setDeleting(asset.id);
    setError(null);
    const r = await deleteOne(asset.id);
    setDeleting(null);
    if (r.ok) {
      if (neighbour) setViewerId(neighbour.id);
      else closeViewer();
    } else {
      setError(r.error === "network" ? tm.errors.network : errorText(r.error));
    }
    await refresh();
  }

  async function removeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError(null);
    let failed = 0;
    // One at a time: each is the same checked DELETE a single delete makes.
    for (const id of ids) {
      const r = await deleteOne(id);
      if (!r.ok) failed += 1;
    }
    setBulkBusy(false);
    setBulkConfirm(false);
    if (failed > 0) setError(fmt(tm.bulkPartial, { failed, n: ids.length }));
    else {
      setSelected(new Set());
      setSelecting(false);
    }
    await refresh();
  }

  function openViewer(asset: LibraryAsset, from: HTMLElement) {
    opener.current = from;
    setViewerId(asset.id);
  }

  function closeViewer() {
    // Back to the tile of the file that was showing — after arrowing through
    // five files, that is where the reader is, not where they started.
    const id = viewerId;
    setViewerId(null);
    const tile = id ? tiles.current.get(id) : null;
    if (tile && tile.isConnected) tile.focus();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setBulkConfirm(false);
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
    setBulkConfirm(false);
  }

  const setFilter = (filter: LibraryView["filter"]) => setView((v) => ({ ...v, filter }));
  const q = data.quota;
  const storageLine =
    q.limitBytes === null
      ? fmt(tm.storageUnknown, { used: formatMediaBytes(q.usedBytes) || "0 KB" })
      : fmt(tm.storageUsed, { used: formatMediaBytes(q.usedBytes) || "0 KB", limit: formatMediaBytes(q.limitBytes) || "0 KB" });
  const usedPct = q.limitBytes ? Math.min(100, Math.round((q.usedBytes / q.limitBytes) * 100)) : null;
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  const uploadButton = (large = false) => (
    <label
      htmlFor={inputId}
      aria-disabled={busy}
      className={`btn-sky is-solid pill inline-flex items-center gap-2 ${large ? "px-6 py-3 text-[14px]" : "px-5 py-2.5 text-[13px]"} ${
        busy ? "pointer-events-none opacity-40" : "cursor-pointer"
      }`}
    >
      <Upload size={large ? 16 : 14} aria-hidden />
      {progress ? fmt(tm.uploading, { name: progress.name, pct: progress.pct }) : tm.upload}
    </label>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!canUpload && <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{tm.noHost}</div>}
      {canUpload && !data.host.signing && (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{tm.noSigning}</div>
      )}
      {readFailed && (
        <div role="alert" className="panel p-4 text-[13px] text-[var(--color-fail)]">
          {tm.readFailed}
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        id={inputId}
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />

      <section className="panel flex flex-col gap-3 p-4" aria-label={tm.storage}>
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
          {uploadButton()}
        </div>
        <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">
          {tm.accepted}
          {maxLabel ? ` · ${fmt(tm.maxSize, { max: maxLabel })}` : ""}
        </p>
        <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">{tm.checkNote}</p>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[var(--color-fail)]">
            {error}
          </p>
        )}
      </section>

      {nothingAtAll ? (
        <section className="panel flex flex-col items-center gap-5 px-6 py-14 text-center" data-library-empty>
          <span
            aria-hidden
            className="grid size-14 place-items-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
          >
            <Images className="size-6" strokeWidth={1.5} />
          </span>
          <p className="m-0 max-w-[46ch] text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{tm.empty}</p>
          {canUpload && uploadButton(true)}
        </section>
      ) : (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby={`${inputId}-assets`}>
          <h2 id={`${inputId}-assets`} className="sr-only">
            {fmt(tm.assets, { n: assets.length })}
          </h2>

          {selecting ? (
            <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-library-selection>
              <span className="text-[13px] font-semibold" aria-live="polite">
                {fmt(tm.selectedCount, { n: selected.size })}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {bulkConfirm ? (
                  <>
                    <span className="w-full text-[12px] text-[var(--color-muted)] sm:w-auto sm:max-w-[42ch]">
                      {fmt(tm.deleteSelectedConfirm, { n: selected.size })}
                    </span>
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={() => void removeSelected()}
                      className="btn-sky is-solid pill px-4 py-2 text-[13px] disabled:opacity-40"
                    >
                      {bulkBusy ? tm.deleting : fmt(tm.deleteSelected, { n: selected.size })}
                    </button>
                    <button type="button" disabled={bulkBusy} onClick={() => setBulkConfirm(false)} className="btn-sky is-quiet pill px-4 py-2 text-[13px]">
                      {tm.cancel}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={selected.size === 0}
                    onClick={() => setBulkConfirm(true)}
                    className="btn-sky is-quiet pill px-4 py-2 text-[13px] hover:text-[var(--color-fail)]! disabled:opacity-40"
                  >
                    {fmt(tm.deleteSelected, { n: selected.size })}
                  </button>
                )}
                {!bulkConfirm && (
                  <button type="button" onClick={stopSelecting} className="btn-sky ghost pill px-4 py-2 text-[13px]">
                    {tm.selectDone}
                  </button>
                )}
              </div>
            </div>
          ) : null}

          <div role="group" aria-label={tm.filterLabel} className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
            {LIBRARY_FILTERS.map((f) => {
              const on = view.filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f)}
                  className={`press pill inline-flex shrink-0 items-center gap-2 border px-4 py-2 text-[13px] font-medium ${
                    on
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-accent)]"
                      : "border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-fg)] hover:border-[var(--color-primary)]"
                  }`}
                >
                  {tm.filters[f]}
                  <span className={`mono text-[11px] ${on ? "opacity-80" : "text-[var(--color-muted)]"}`}>{counts[f]}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-[1_1_12rem]">
              <span className="sr-only">{tm.search}</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-muted)]"
              />
              <input
                type="search"
                value={view.query}
                onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))}
                placeholder={tm.search}
                enterKeyHint="search"
                className="pill w-full border border-[var(--color-border)] bg-[var(--color-panel)] py-2 pl-9 pr-3 text-[16px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] sm:text-[13px]"
              />
            </label>
            <label className="shrink-0">
              <span className="sr-only">{tm.sort}</span>
              <select
                value={view.sort}
                onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as LibrarySort }))}
                className="pill border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
              >
                <option value="newest">{tm.sortNewest}</option>
                <option value="oldest">{tm.sortOldest}</option>
              </select>
            </label>
            {!selecting && assets.length > 0 && (
              <button type="button" onClick={() => setSelecting(true)} className="btn-sky is-quiet pill shrink-0 px-4 py-2 text-[13px]">
                {tm.select}
              </button>
            )}
          </div>

          {checkingDown && (
            <p role="status" data-pipeline-down className="m-0 text-[13px] text-[var(--color-warn)]">
              {tm.pipelineDown}
            </p>
          )}

          {nothingShown ? (
            <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center" data-library-no-match>
              <p className="m-0 text-[13px] text-[var(--color-muted)]">{tm.noMatches}</p>
              {isNarrowed(view) && (
                <button type="button" onClick={() => setView(DEFAULT_VIEW)} className="btn-sky ghost pill px-4 py-2 text-[13px]">
                  {tm.showAll}
                </button>
              )}
            </div>
          ) : (
            <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-4 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {progress && (
                <li className="flex min-w-0 flex-col gap-1.5" data-upload-local>
                  <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--color-primary)] bg-[var(--color-panel-2)] p-4 text-center">
                    <Upload className="size-6 text-[var(--color-primary)]" strokeWidth={1.5} aria-hidden />
                    <span className="text-[12px] text-[var(--color-fg)]">{fmt(tm.uploadingCard, { pct: progress.pct })}</span>
                    <div
                      className="h-1 w-full max-w-[8rem] overflow-hidden rounded-full bg-[var(--color-border)]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress.pct}
                      aria-label={progress.name}
                    >
                      <div className="h-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${progress.pct}%` }} />
                    </div>
                  </div>
                  <span className="truncate text-[13px]" title={progress.name}>
                    {progress.name}
                  </span>
                </li>
              )}
              {pending.map((u) => (
                <UploadCard key={u.id} upload={u} checkingDown={checkingDown} />
              ))}
              {shown.map((a) => {
                const Icon = KIND_ICON[a.kind];
                const name = a.name ?? tm.kinds[a.kind];
                const isSelected = selected.has(a.id);
                const duration = a.kind === "video" || a.kind === "audio" ? formatDuration(a.durationS) : "";
                const meta = [formatMediaBytes(a.bytes), a.createdAt ? dateFmt.format(new Date(a.createdAt)) : ""].filter(Boolean);
                return (
                  <li key={a.id} className="min-w-0" data-asset-kind={a.kind}>
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) tiles.current.set(a.id, el);
                        else tiles.current.delete(a.id);
                      }}
                      onClick={(e) => (selecting ? toggleSelected(a.id) : openViewer(a, e.currentTarget))}
                      aria-pressed={selecting ? isSelected : undefined}
                      aria-label={fmt(selecting ? tm.selectItem : tm.openItem, { name })}
                      className="press group flex w-full min-w-0 flex-col gap-1.5 rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
                    >
                      <span
                        className={`relative block aspect-square w-full overflow-hidden rounded-2xl border bg-[var(--color-panel-2)] transition-colors ${
                          isSelected ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]" : "border-[var(--color-border)] group-hover:border-[var(--color-primary)]"
                        }`}
                      >
                        {a.thumbUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived same-origin link; next/image would re-host it
                          <img src={a.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                        ) : (
                          <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--color-muted)]">
                            <Icon className="size-7" strokeWidth={1.25} aria-hidden />
                            <span className="text-[11px]">{tm.noPreview}</span>
                          </span>
                        )}
                        <span className={`absolute left-2 top-2 ${BADGE}`}>
                          <Icon className="size-3" aria-hidden />
                          {tm.kinds[a.kind]}
                        </span>
                        {duration && <span className={`mono absolute bottom-2 right-2 ${BADGE}`}>{duration}</span>}
                        {selecting && (
                          <span
                            aria-hidden
                            className={`absolute right-2 top-2 grid size-6 place-items-center rounded-full border-2 ${
                              isSelected
                                ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-accent)]"
                                : "border-[var(--color-panel)] bg-[color-mix(in_srgb,var(--color-panel)_60%,transparent)]"
                            }`}
                          >
                            {isSelected && <Check className="size-3.5" strokeWidth={3} />}
                          </span>
                        )}
                      </span>
                      <span className="block truncate px-0.5 text-[13px] text-[var(--color-fg)]" title={name}>
                        {name}
                      </span>
                      <span className="block truncate px-0.5 text-[12px] text-[var(--color-muted)]">{meta.join(" · ")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {viewerId && viewerIndex >= 0 && (
        <MediaViewer
          items={shown}
          index={viewerIndex}
          onNavigate={(i) => setViewerId(shown[i]?.id ?? null)}
          onClose={closeViewer}
          onDelete={(a) => void removeFromViewer(a)}
          deleting={deleting !== null}
          opener={opener}
        />
      )}
    </div>
  );
}

/**
 * An upload that is not in the library yet: on its way, waiting for the
 * server's check, being checked, refused or expired — said plainly on a card
 * the shape of the tiles it will become.
 */
function UploadCard({ upload: u, checkingDown }: { upload: MediaUpload; checkingDown: boolean }) {
  const { t } = useI18n();
  const tm = t.media;
  const kind = guessUploadKind(u.name);
  const Icon = kind ? KIND_ICON[kind] : Upload;
  const reason = knownUploadReason(u.reason);
  const failed = u.status === "rejected" || u.status === "expired";
  const paused = checkingDown && isWaitingForCheck(u);
  return (
    <li className="flex min-w-0 flex-col gap-1.5" data-upload-status={paused ? "paused" : u.status}>
      <div
        className={`flex aspect-square flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed p-3 text-center ${
          failed ? "border-[color-mix(in_srgb,var(--color-fail)_45%,var(--color-border))]" : "border-[var(--color-border)]"
        } bg-[var(--color-panel-2)]`}
      >
        <Icon className={`size-6 ${failed ? "text-[var(--color-fail)]" : "text-[var(--color-muted)]"}`} strokeWidth={1.5} aria-hidden />
        {paused ? (
          <StatusPill tone="warn" label={tm.status.paused} />
        ) : (
          <StatusPill tone={STATUS_TONE[u.status]} label={tm.status[u.status]} live={isUploadInFlight(u)} />
        )}
        {failed && (
          <span className="line-clamp-4 text-[11px] leading-snug text-[var(--color-muted)]">
            {reason ? tm.reasons[reason] : tm.reasons.other}
          </span>
        )}
      </div>
      <span className="block truncate px-0.5 text-[13px]" title={u.name}>
        {u.name}
      </span>
      <span className="block px-0.5 text-[12px] text-[var(--color-muted)]">{formatMediaBytes(u.bytes)}</span>
    </li>
  );
}
