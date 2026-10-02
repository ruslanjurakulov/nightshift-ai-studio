"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, FolderInput, Images, Search, Upload } from "lucide-react";
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
import { SEARCH_MAX, cleanSearch, type FolderError } from "@/lib/media-folders";
import { KIND_ICON } from "./kindIcon";
import { LibrarySkeleton } from "./LibrarySkeleton";
import { MediaViewer } from "./MediaViewer";
import { FolderRail } from "./FolderRail";
import { FolderMenu } from "./FolderMenu";
import { DeleteFolderDialog, FolderNameDialog } from "./FolderDialogs";
import { MoveSheet } from "./MoveSheet";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { createFolder, deleteFolder, moveAssets, renameFolder } from "./folderApi";
import {
  DEFAULT_VIEW,
  LIBRARY_FILTERS,
  commonFolder,
  countByFilter,
  fileCount,
  guessUploadKind,
  inFolder,
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
/** How long the search box waits for typing to stop before asking the server. */
const SEARCH_DEBOUNCE_MS = 350;

type ErrorWord = keyof ReturnType<typeof useI18n>["t"]["media"]["errors"];

/** Which folder dialog is open, if any. */
type Dialog = { kind: "create" } | { kind: "rename" } | { kind: "delete" } | { kind: "move" } | null;

/**
 * The library's interactive half: upload (ticket -> streamed PUT with
 * progress), the uploads still being checked, folders (migration 0049), the
 * assets as a grid with chips / search / sort, a viewer, delete and move (one,
 * or several in a row).
 *
 * Nothing here decides anything: /api/media/uploads asks the database for a
 * ticket (membership, type, size, quota), the PUT route streams the body to
 * the server, and the media worker checks the content. Folders are created,
 * renamed, deleted and filled by the database's own functions, which check
 * that the member edits the organization and that every file and folder is
 * its own. The list is what GET /api/media returns under the member's
 * session — for the open folder, refreshed while an upload is on its way, and
 * every few minutes so the signed links stay fresh. Deleting several files is
 * the same DELETE /api/media/{id}, once per file; moving several is one call.
 *
 * Search narrows what is loaded at once; when the library is larger than one
 * page, it also asks the server, so older files are found too.
 *
 * Without `initial` the list is fetched on mount, and until it arrives the
 * page shows a skeleton — never "nothing here yet". Before 0049 is applied
 * the page has no folders at all, and works exactly as it did.
 *
 * A file uploaded while a folder is open goes into that folder (0051): the
 * ticket names it, and the database checks it and re-checks it when the file
 * is registered. Its card waits in that folder meanwhile. `canEditFolders`
 * (editor or more, the database's own answer for this organization) decides
 * whether folder controls are offered at all — a viewer reads folders, opens
 * them and uploads to All files; the database refuses them the rest anyway.
 */
export function MediaLibrary({
  orgId,
  initial,
  canEditFolders = true,
}: {
  orgId: string;
  initial?: MediaLibraryData | null;
  /** Editor or more in this organization: may create, rename, delete, move and upload into folders. */
  canEditFolders?: boolean;
}) {
  const { t, locale } = useI18n();
  const tm = t.media;
  const tf = tm.folders;
  const [data, setData] = useState<MediaLibraryData | null>(initial ?? null);
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(Boolean(initial?.error));
  const [view, setView] = useState<LibraryView>(DEFAULT_VIEW);
  const [folder, setFolder] = useState<string | null>(initial?.folder ?? null);
  const [serverQuery, setServerQuery] = useState(initial?.query ?? "");
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const allButton = useRef<HTMLButtonElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const selectButton = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the next render is on screen (after a dialog whose opener is gone). */
  const focusNext = useRef<(() => HTMLElement | null) | null>(null);
  /** Only the latest read may land: a slow answer for the last folder must not replace this one's. */
  const readSeq = useRef(0);
  const inputId = useId();

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    const q = new URLSearchParams({ org: orgId });
    if (folder) q.set("folder", folder);
    if (serverQuery) q.set("q", serverQuery);
    try {
      const res = await fetch(`/api/media?${q.toString()}`, { cache: "no-store" });
      if (seq !== readSeq.current) return;
      if (!res.ok) {
        setReadFailed(true);
        return;
      }
      const next = (await res.json()) as MediaLibraryData;
      if (seq !== readSeq.current) return;
      setData(next);
      setReadFailed(Boolean(next.error));
    } catch {
      if (seq === readSeq.current) setReadFailed(true);
    }
  }, [orgId, folder, serverQuery]);

  // No list from the server render: read it now (the skeleton shows meanwhile).
  useEffect(() => {
    if (!initial) void refresh();
    // Only on mount: `initial` is the server's first answer, not a live input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another folder or another server search: read that list.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void refresh();
    // `refresh` changes exactly when the folder or the server search does.
  }, [refresh]);

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

  // The server is asked to search only when one page does not hold the whole
  // library (or a server search is already showing): otherwise everything is
  // here and the box narrows it at once.
  const searchOnServer = Boolean(data?.truncated) || serverQuery !== "";
  useEffect(() => {
    const q = cleanSearch(view.query).slice(0, SEARCH_MAX);
    if (!searchOnServer || q === serverQuery) return;
    const timer = setTimeout(() => setServerQuery(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [view.query, searchOnServer, serverQuery]);

  // After a dialog whose opener has gone (a moved selection, a deleted folder):
  // focus lands somewhere that still exists rather than on <body>.
  // One try, on the render right after: a target that is not there then
  // (the list emptied) must not steal focus later.
  useEffect(() => {
    const find = focusNext.current;
    if (!find) return;
    focusNext.current = null;
    const target = find();
    if (target && target.isConnected) target.focus();
  });

  const foldersState = data?.folders;
  const foldersOn = Boolean(foldersState?.available);
  const folderList = useMemo(() => foldersState?.folders ?? [], [foldersState]);
  const openFolder = foldersOn && folder ? (folderList.find((f) => f.id === folder) ?? null) : null;
  // The answer on screen may still be the last folder's for a moment: narrow
  // it here too, so a folder never shows a file that is not in it.
  const assets = useMemo(() => inFolder(data?.assets ?? [], foldersOn ? folder : null), [data, foldersOn, folder]);
  const switching = Boolean(data) && foldersOn && ((data?.folder ?? null) !== folder || (data?.query ?? "") !== serverQuery);
  const counts = useMemo(() => countByFilter(assets), [assets]);
  const shown = useMemo(() => visibleAssets(assets, view, (k) => tm.kinds[k]), [assets, view, tm]);
  // An upload waits where it will land: in All files every one, in a folder
  // the ones asked into it (0051; before it, none name a folder).
  const pending = useMemo(
    () => visibleUploads((data?.uploads ?? []).filter((u) => folder === null || u.folderId === folder), view),
    [data, view, folder],
  );
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

  // A folder that is gone (deleted in another tab): back to All files.
  useEffect(() => {
    if (foldersOn && folder && !foldersState?.error && !folderList.some((f) => f.id === folder)) setFolder(null);
  }, [foldersOn, folder, folderList, foldersState]);

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
  const libraryEmpty =
    folder === null && serverQuery === "" && !switching && assets.length === 0 && data.uploads.length === 0 && progress === null;
  // Nothing at all, and no folder to show either: the first-run empty state.
  const nothingAtAll = libraryEmpty && (!foldersOn || folderList.length === 0);
  const folderEmpty =
    openFolder !== null && !switching && assets.length === 0 && serverQuery === "" && pending.length === 0 && progress === null;
  // Only an editor files an upload; a viewer's upload goes to All files, and the folder says so.
  const uploadFolder = foldersOn && canEditFolders && openFolder ? openFolder : null;
  const nothingShown = shown.length === 0 && pending.length === 0 && progress === null;
  const viewCount = openFolder ? openFolder.count : foldersOn ? (foldersState?.total ?? null) : assets.length;

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
    setNotice(null);
    setProgress({ name: file.name, pct: 0 });
    // The folder open when the file was chosen, fixed now: switching folders
    // during the upload does not move where it goes.
    const target = uploadFolder;
    try {
      const res = await fetch("/api/media/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: orgId,
          filename: file.name,
          mime: file.type,
          bytes: file.size,
          ...(target ? { folder_id: target.id } : {}),
        }),
      });
      const ticket = (await res.json().catch(() => ({}))) as {
        upload_url?: string;
        error?: string;
        max_bytes?: number;
        folder_applied?: boolean | null;
      };
      if (!res.ok || !ticket.upload_url) {
        setError(errorText(ticket.error, ticket.max_bytes));
        return;
      }
      // The deployment cannot file uploads yet (0051 missing): it goes to All files, said plainly.
      if (target && ticket.folder_applied === false) setNotice(tf.uploadedToAll);
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
    setNotice(null);
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

  // ── folders ──────────────────────────────────────────────────────────────

  function chooseFolder(id: string | null) {
    if (id === folder) return;
    setFolder(id);
    setNotice(null);
    setError(null);
    setSelected(new Set());
    setBulkConfirm(false);
  }

  async function submitNewFolder(name: string): Promise<FolderError | null> {
    const r = await createFolder(orgId, name);
    if (!r.ok) return r.error;
    setDialog(null);
    setNotice(fmt(tf.created, { name: r.value.name }));
    setFolder(r.value.id);
    setSelected(new Set());
    return null;
  }

  async function submitRename(name: string): Promise<FolderError | null> {
    if (!openFolder) return "not_found";
    const r = await renameFolder(openFolder.id, name);
    if (!r.ok) return r.error;
    setDialog(null);
    setNotice(fmt(tf.renamed, { name: r.value.name }));
    await refresh();
    return null;
  }

  async function confirmDeleteFolder(): Promise<FolderError | null> {
    if (!openFolder) return "not_found";
    const r = await deleteFolder(openFolder.id);
    if (!r.ok) return r.error;
    setDialog(null);
    setNotice(tf.deleted);
    focusNext.current = () => allButton.current;
    if (folder === null) await refresh();
    else setFolder(null);
    return null;
  }

  async function moveSelected(target: string | null, targetName: string | null): Promise<FolderError | null> {
    const ids = [...selected];
    const r = await moveAssets(orgId, target, ids);
    if (!r.ok) return r.error;
    setDialog(null);
    setSelected(new Set());
    setSelecting(false);
    setBulkConfirm(false);
    setNotice(
      r.value.moved === 0
        ? tf.movedNone
        : target === null
          ? fmt(tf.movedOut, { n: r.value.moved, files: fileCount(tf, r.value.moved) })
          : fmt(tf.moved, { n: r.value.moved, files: fileCount(tf, r.value.moved), folder: targetName ?? "" }),
    );
    focusNext.current = () => selectButton.current;
    await refresh();
    return null;
  }

  async function createAndMove(name: string): Promise<FolderError | null> {
    const made = await createFolder(orgId, name);
    if (!made.ok) return made.error;
    // The folder exists now whatever happens next; the list shows it.
    return moveSelected(made.value.id, made.value.name);
  }

  // ── selection, viewer ────────────────────────────────────────────────────

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
    focusNext.current = () => selectButton.current;
  }

  const allShownSelected = shown.length > 0 && shown.every((a) => selected.has(a.id));
  const setFilter = (filter: LibraryView["filter"]) => setView((v) => ({ ...v, filter }));
  const q = data.quota;
  const storageLine =
    q.limitBytes === null
      ? fmt(tm.storageUnknown, { used: formatMediaBytes(q.usedBytes) || "0 KB" })
      : fmt(tm.storageUsed, { used: formatMediaBytes(q.usedBytes) || "0 KB", limit: formatMediaBytes(q.limitBytes) || "0 KB" });
  const usedPct = q.limitBytes ? Math.min(100, Math.round((q.usedBytes / q.limitBytes) * 100)) : null;
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const folderName = (id: string | null | undefined) => (id ? (folderList.find((f) => f.id === id)?.name ?? null) : null);
  const truncatedLine =
    data.truncated && serverQuery === ""
      ? viewCount !== null && viewCount > data.assets.length
        ? fmt(tf.truncatedOf, { shown: data.assets.length, total: viewCount })
        : fmt(tf.truncated, { shown: data.assets.length })
      : null;

  const uploadButton = (large = false) => (
    <label
      htmlFor={inputId}
      aria-disabled={busy}
      className={`btn-primary ${large ? "min-h-12 px-6" : "px-5"} ${
        busy ? "pointer-events-none opacity-40" : "cursor-pointer"
      }`}
    >
      <Upload size={large ? 16 : 14} aria-hidden />
      {progress ? fmt(tm.uploading, { name: progress.name, pct: progress.pct }) : tm.upload}
    </label>
  );

  const headingId = `${inputId}-assets`;

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
                className="h-1.5 w-56 max-w-full overflow-hidden rounded-[var(--ns-r-frame)] bg-[var(--color-panel-2)]"
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
            className="grid size-14 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
          >
            <Images className="size-6" strokeWidth={1.5} />
          </span>
          <p className="m-0 max-w-[46ch] text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{tm.empty}</p>
          {canUpload && uploadButton(true)}
        </section>
      ) : (
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
          {foldersOn && foldersState && (
            <FolderRail
              state={foldersState}
              current={folder}
              onSelect={chooseFolder}
              onNew={() => setDialog({ kind: "create" })}
              allRef={allButton}
              newRef={newButton}
              canCreate={canEditFolders}
            />
          )}

          <section className="flex min-w-0 flex-1 flex-col gap-3" aria-labelledby={headingId} aria-busy={switching || undefined}>
            {foldersOn ? (
              <div className="flex min-w-0 items-start justify-between gap-3" data-folder-header>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h2 id={headingId} className="m-0 truncate text-[18px] font-semibold leading-tight text-[var(--color-fg)]" title={openFolder?.name}>
                    {openFolder ? openFolder.name : tf.allFiles}
                  </h2>
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {[
                      viewCount === null ? null : fileCount(tf, viewCount),
                      openFolder ? (uploadFolder ? tf.uploadsLandHere : tf.uploadsLand) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {openFolder && canEditFolders && (
                  <FolderMenu
                    ref={menuButton}
                    label={tf.actions}
                    renameLabel={tf.rename}
                    deleteLabel={tf.delete}
                    onRename={() => setDialog({ kind: "rename" })}
                    onDelete={() => setDialog({ kind: "delete" })}
                  />
                )}
              </div>
            ) : (
              <h2 id={headingId} className="sr-only">
                {fmt(tm.assets, { n: assets.length })}
              </h2>
            )}

            <p role="status" aria-live="polite" className={notice ? "m-0 text-[13px] text-[var(--color-ok)]" : "sr-only"} data-library-notice>
              {notice ?? ""}
            </p>

            {selecting ? (
              <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-library-selection>
                <div className="flex items-center gap-3">
                  <span className="text-[13px] font-semibold" aria-live="polite">
                    {fmt(tm.selectedCount, { n: selected.size })}
                  </span>
                  {!bulkConfirm && shown.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((a) => a.id)))}
                      className="text-[13px] text-[var(--color-primary)] underline-offset-4 hover:underline"
                    >
                      {allShownSelected ? tf.clearSelection : tf.selectAll}
                    </button>
                  )}
                </div>
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
                        className="btn-primary disabled:opacity-40"
                      >
                        {bulkBusy ? tm.deleting : fmt(tm.deleteSelected, { n: selected.size })}
                      </button>
                      <button type="button" disabled={bulkBusy} onClick={() => setBulkConfirm(false)} className="btn-quiet">
                        {tm.cancel}
                      </button>
                    </>
                  ) : (
                    <>
                      {foldersOn && canEditFolders && (
                        <button
                          ref={moveButton}
                          type="button"
                          disabled={selected.size === 0}
                          onClick={() => {
                            setNotice(null);
                            setDialog({ kind: "move" });
                          }}
                          className="btn-primary disabled:opacity-40"
                        >
                          <FolderInput className="size-4" aria-hidden />
                          {tf.moveTo}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={selected.size === 0}
                        onClick={() => setBulkConfirm(true)}
                        className="btn-quiet hover:text-[var(--color-fail)]! disabled:opacity-40"
                      >
                        {fmt(tm.deleteSelected, { n: selected.size })}
                      </button>
                    </>
                  )}
                  {!bulkConfirm && (
                    <button type="button" onClick={stopSelecting} className="btn-quiet">
                      {tm.selectDone}
                    </button>
                  )}
                </div>
              </div>
            ) : null}

            <ChipRow label={tm.filterLabel}>
              {LIBRARY_FILTERS.map((f) => (
                <Chip key={f} pressed={view.filter === f} count={counts[f]} onClick={() => setFilter(f)}>
                  {tm.filters[f]}
                </Chip>
              ))}
            </ChipRow>

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
                  maxLength={SEARCH_MAX * 2}
                  className="min-h-9 w-full rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] py-2 pl-9 pr-3 text-[16px] max-sm:min-h-11 pointer-coarse:min-h-11 text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] sm:text-[13px]"
                />
              </label>
              <label className="shrink-0">
                <span className="sr-only">{tm.sort}</span>
                <select
                  value={view.sort}
                  onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as LibrarySort }))}
                  className="min-h-9 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] px-3 py-2 text-[16px] max-sm:min-h-11 pointer-coarse:min-h-11 text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
                >
                  <option value="newest">{tm.sortNewest}</option>
                  <option value="oldest">{tm.sortOldest}</option>
                </select>
              </label>
              {!selecting && assets.length > 0 && (
                <button
                  ref={selectButton}
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setSelecting(true);
                  }}
                  className="btn-quiet shrink-0"
                >
                  {tm.select}
                </button>
              )}
            </div>

            {checkingDown && (!folder || pending.some(isWaitingForCheck)) && (
              <p role="status" data-pipeline-down className="m-0 text-[13px] text-[var(--color-warn)]">
                {tm.pipelineDown}
              </p>
            )}
            {truncatedLine && <p className="m-0 text-[12px] text-[var(--color-muted)]" data-library-truncated>{truncatedLine}</p>}
            {switching && serverQuery !== "" && (
              <p className="m-0 text-[12px] text-[var(--color-muted)]">{tf.searching}</p>
            )}

            {folderEmpty ? (
              <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center" data-folder-empty>
                <p className="m-0 max-w-[46ch] text-[13px] leading-relaxed text-[var(--color-muted)]">
                  {canEditFolders ? tf.emptyFolder : tf.emptyFolderReadOnly}
                </p>
                <button type="button" onClick={() => chooseFolder(null)} className="btn-quiet">
                  {tf.allFiles}
                </button>
              </div>
            ) : libraryEmpty ? (
              <div className="panel flex flex-col items-center gap-4 px-6 py-10 text-center" data-library-empty-all>
                <p className="m-0 max-w-[46ch] text-[13px] leading-relaxed text-[var(--color-muted)]">{tf.emptyAll}</p>
                {canUpload && uploadButton()}
              </div>
            ) : nothingShown ? (
              <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center" data-library-no-match>
                <p className="m-0 text-[13px] text-[var(--color-muted)]">{switching ? tm.loading : tm.noMatches}</p>
                {isNarrowed(view) && !switching && (
                  <button type="button" onClick={() => setView(DEFAULT_VIEW)} className="btn-quiet">
                    {tm.showAll}
                  </button>
                )}
              </div>
            ) : (
              <div className={`transition-opacity ${switching ? "opacity-60" : ""}`}>
                <ContactSheet label={tm.title} min={150}>
                  {progress && (
                    <Frame aspect="1 / 1" data-upload-local body={<span className="block truncate text-[13px]" title={progress.name}>{progress.name}</span>}>
                      <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-dashed border-[var(--ns-amber)] p-4 text-center text-[var(--ns-on-film)]">
                        <Upload className="size-6 text-[var(--ns-amber)]" strokeWidth={1.5} aria-hidden />
                        <span className="text-[12px]">{fmt(tm.uploadingCard, { pct: progress.pct })}</span>
                        <div
                          className="h-1 w-full max-w-[8rem] overflow-hidden rounded-[1px] bg-[color-mix(in_srgb,var(--ns-on-film)_25%,transparent)]"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={progress.pct}
                          aria-label={progress.name}
                        >
                          <div className="h-full bg-[var(--ns-amber)] transition-[width]" style={{ width: `${progress.pct}%` }} />
                        </div>
                      </div>
                    </Frame>
                  )}
                  {pending.map((u) => (
                    <UploadCard key={u.id} upload={u} checkingDown={checkingDown} />
                  ))}
                  {shown.map((a) => {
                    const Icon = KIND_ICON[a.kind];
                    const name = a.name ?? tm.kinds[a.kind];
                    const isSelected = selected.has(a.id);
                    const duration = a.kind === "video" || a.kind === "audio" ? formatDuration(a.durationS) : "";
                    // In All files a tile says which folder it is in.
                    const where = folder === null ? folderName(a.folderId) : null;
                    const date = a.createdAt ? dateFmt.format(new Date(a.createdAt)) : "";
                    return (
                      <Frame
                        key={a.id}
                        data-asset-kind={a.kind}
                        aspect="1 / 1"
                        selected={isSelected}
                        edge={[tm.kinds[a.kind], duration, formatMediaBytes(a.bytes)]}
                        body={
                          <>
                            <span className="block truncate text-[13px] text-[var(--color-fg)]" title={name}>
                              {name}
                            </span>
                            <span className="block truncate text-[12px] text-[var(--color-muted)]">
                              {[where, date].filter(Boolean).join(" · ")}
                            </span>
                          </>
                        }
                      >
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) tiles.current.set(a.id, el);
                            else tiles.current.delete(a.id);
                          }}
                          onClick={(e) => (selecting ? toggleSelected(a.id) : openViewer(a, e.currentTarget))}
                          aria-pressed={selecting ? isSelected : undefined}
                          aria-label={fmt(selecting ? tm.selectItem : tm.openItem, { name })}
                          className="press absolute inset-0 block h-full w-full text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ns-cue)]"
                        >
                          {a.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived same-origin link; next/image would re-host it
                            <img src={a.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                          ) : (
                            <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--ns-on-film)] opacity-70">
                              <Icon className="size-7" strokeWidth={1.25} aria-hidden />
                              <span className="text-[11px]">{tm.noPreview}</span>
                            </span>
                          )}
                          {selecting && (
                            <span
                              aria-hidden
                              className={`absolute right-2 top-2 grid size-6 place-items-center rounded-[var(--ns-r-chip)] border-2 ${
                                isSelected
                                  ? "border-[var(--ns-amber)] bg-[var(--ns-amber)] text-[var(--ns-film)]"
                                  : "border-[var(--ns-on-film)] bg-[color-mix(in_srgb,var(--ns-film)_60%,transparent)]"
                              }`}
                            >
                              {isSelected && <Check className="size-3.5" strokeWidth={3} />}
                            </span>
                          )}
                        </button>
                      </Frame>
                    );
                  })}
                </ContactSheet>
              </div>
            )}
          </section>
        </div>
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
          folderName={foldersOn ? folderName : undefined}
          orgId={orgId}
        />
      )}

      {canEditFolders && dialog?.kind === "create" && (
        <FolderNameDialog mode="create" onSubmit={submitNewFolder} onClose={() => setDialog(null)} opener={newButton} />
      )}
      {canEditFolders && dialog?.kind === "rename" && openFolder && (
        <FolderNameDialog
          mode="rename"
          initialName={openFolder.name}
          onSubmit={submitRename}
          onClose={() => setDialog(null)}
          opener={menuButton}
        />
      )}
      {canEditFolders && dialog?.kind === "delete" && openFolder && (
        <DeleteFolderDialog
          name={openFolder.name}
          count={openFolder.count}
          onConfirm={confirmDeleteFolder}
          onClose={() => setDialog(null)}
          opener={menuButton}
        />
      )}
      {canEditFolders && dialog?.kind === "move" && (
        <MoveSheet
          count={selected.size}
          folders={folderList}
          here={commonFolder(assets, selected)}
          onMove={moveSelected}
          onCreateAndMove={createAndMove}
          onClose={() => setDialog(null)}
          opener={moveButton}
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
    <Frame
      aspect="1 / 1"
      data-upload-status={paused ? "paused" : u.status}
      edge={[formatMediaBytes(u.bytes)]}
      body={
        <span className="block truncate text-[13px]" title={u.name}>
          {u.name}
        </span>
      }
    >
      <div
        className={`flex h-full w-full flex-col items-center justify-center gap-2.5 border border-dashed p-3 text-center ${
          failed ? "border-[var(--ns-tally)]" : "border-[color-mix(in_srgb,var(--ns-on-film)_40%,transparent)]"
        }`}
      >
        <Icon className={`size-6 ${failed ? "text-[var(--ns-tally)]" : "text-[var(--ns-on-film)]"}`} strokeWidth={1.5} aria-hidden />
        {paused ? (
          <StatusPill tone="warn" label={tm.status.paused} />
        ) : (
          <StatusPill tone={STATUS_TONE[u.status]} label={tm.status[u.status]} live={isUploadInFlight(u)} />
        )}
        {failed && (
          <span className="line-clamp-4 text-[11px] leading-snug text-[var(--ns-on-film)] opacity-80">
            {reason ? tm.reasons[reason] : tm.reasons.other}
          </span>
        )}
      </div>
    </Frame>
  );
}
