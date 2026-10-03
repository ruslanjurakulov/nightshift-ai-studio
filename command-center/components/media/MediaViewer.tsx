"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject, type TouchEvent } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink, Trash2, X } from "lucide-react";
import { useOverlay } from "@/components/a11y/useOverlay";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { SOURCE_CAPABILITIES } from "@/lib/creative/operations";
import { formatDuration, formatMediaBytes, type LibraryAsset } from "@/lib/media";
import { stepIndex } from "./libraryView";
import { KIND_ICON } from "./kindIcon";
import { SendToEditor, isSendKind } from "@/components/editor/SendToEditor";

/** Keys inside these keep their own meaning (a video's arrows seek, a field's arrows move the caret). */
function ownsArrows(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"].includes(target.tagName);
}

function formatLabel(mime: string): string {
  const sub = mime.split("/")[1] ?? mime;
  return sub.replace(/^x-/, "").toUpperCase();
}

const SWIPE_PX = 48;

/**
 * One file, large: a full-screen sheet on a phone, a dialog on a wider screen.
 * The preview (picture, video or audio player), the file's facts, and the
 * actions the library already has — open the served copy, delete — nothing new.
 *
 * Keyboard: Escape closes (useOverlay), Tab stays inside, ←/→ move between the
 * files the grid is showing (not inside a player, whose arrows seek). Swipe
 * does the same on a phone. When it closes, the page puts focus back on the
 * tile of the file that was showing (MediaLibrary's onClose).
 */
export function MediaViewer({
  items,
  index,
  onNavigate,
  onClose,
  onDelete,
  deleting,
  opener,
  folderName,
  orgId,
}: {
  items: readonly LibraryAsset[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  onDelete?: (asset: LibraryAsset) => void;
  deleting: boolean;
  opener?: RefObject<HTMLElement | null>;
  /** The name of the folder a file is in (migration 0049); absent before folders exist. */
  folderName?: (id: string | null | undefined) => string | null;
  /** The organization the files belong to: when given, a video, picture or sound can be sent to the editor. */
  orgId?: string;
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const tm = t.media;
  const tv = tm.viewer;
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [confirm, setConfirm] = useState(false);
  // While the "open in editor" dialog is up it owns Escape and Tab.
  const [sending, setSending] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const asset = items[index];

  useOverlay(!sending, { onClose, container: box, opener });

  // A new file never inherits the last one's "delete?" question. And if the
  // arrow button that brought us here just disabled itself (first or last
  // file), keep focus in the dialog so ←/→ and Tab still work.
  useEffect(() => {
    setConfirm(false);
    const el = box.current;
    const active = document.activeElement;
    if (el && (!el.contains(active) || (active instanceof HTMLButtonElement && active.disabled))) el.focus();
  }, [asset?.id]);

  // The page behind a full-screen sheet must not scroll under a finger.
  useEffect(() => {
    const body = document.body;
    const before = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = before;
    };
  }, []);

  if (!asset) return null;

  const name = asset.name ?? tm.kinds[asset.kind];
  const Icon = KIND_ICON[asset.kind];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;
  const go = (delta: number) => {
    const next = stepIndex(index, delta, items.length);
    if (next !== index && next >= 0) onNavigate(next);
  };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (ownsArrows(e.target) || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    go(e.key === "ArrowRight" ? 1 : -1);
  }

  function onTouchStart(e: TouchEvent) {
    const p = e.touches[0];
    touch.current = p ? { x: p.clientX, y: p.clientY } : null;
  }
  function onTouchEnd(e: TouchEvent) {
    const start = touch.current;
    touch.current = null;
    const p = e.changedTouches[0];
    if (!start || !p) return;
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const facts: [string, string][] = [
    [tv.type, tm.kinds[asset.kind]],
    [tv.format, formatLabel(asset.mime)],
    [tv.size, formatMediaBytes(asset.bytes)],
    [tv.dimensions, asset.width && asset.height ? `${asset.width} × ${asset.height}` : ""],
    [tv.duration, formatDuration(asset.durationS)],
    [tv.source, tm.sources[asset.source]],
    [tv.added, asset.createdAt ? dateFmt.format(new Date(asset.createdAt)) : ""],
    [tv.folder, folderName ? (folderName(asset.folderId) ?? "") : ""],
  ];
  const picture = asset.kind === "image" ? (asset.viewUrl ?? asset.thumbUrl) : null;

  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-media-viewer
      className="fixed inset-0 z-50 flex items-stretch justify-center outline-none sm:items-center sm:p-6"
    >
      <div aria-hidden className="scrim-enter absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="sheet-enter relative flex h-full w-full flex-col overflow-hidden bg-[var(--color-panel)] sm:h-[min(88vh,880px)] sm:max-w-6xl sm:rounded-[var(--ns-r-sheet)] sm:border sm:border-[var(--color-border)] sm:shadow-[var(--shadow-elevated)]">
        <header className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-3">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[var(--ns-r-key)] bg-[var(--color-panel-2)] text-[var(--color-muted)]">
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id={titleId} className="m-0 truncate text-[15px] font-semibold text-[var(--color-fg)]" title={name}>
              {name}
            </h2>
            <span className="tnum text-xs text-[var(--color-muted)]" aria-live="polite">
              {fmt(tv.position, { n: index + 1, total: items.length })}
            </span>
          </div>
          <button type="button" className="sheet-close shrink-0" aria-label={tv.close} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div
            className="relative min-h-[42vh] flex-1 bg-[var(--color-panel-2)] lg:min-h-0"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            <div className="absolute inset-0 flex items-center justify-center p-3 sm:p-6">
              {asset.kind === "video" && asset.viewUrl ? (
                <video
                  key={asset.id}
                  src={asset.viewUrl}
                  poster={asset.thumbUrl ?? undefined}
                  controls
                  playsInline
                  preload="metadata"
                  className="max-h-full max-w-full rounded-[var(--ns-r-key)] bg-black"
                />
              ) : picture ? (
                // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived same-origin link; next/image would re-host it
                <img key={asset.id} src={picture} alt={name} className="max-h-full max-w-full rounded-[var(--ns-r-key)] object-contain" />
              ) : asset.kind === "audio" && asset.viewUrl ? (
                <div className="flex w-full max-w-md flex-col items-center gap-5">
                  {asset.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- see above
                    <img src={asset.thumbUrl} alt="" className="size-40 rounded-[var(--ns-r-key)] object-cover" />
                  ) : (
                    <span aria-hidden className="grid size-28 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-primary)]">
                      <Icon className="size-10" strokeWidth={1.25} />
                    </span>
                  )}
                  <audio key={asset.id} src={asset.viewUrl} controls preload="metadata" className="w-full" />
                </div>
              ) : (
                <div className="flex max-w-xs flex-col items-center gap-3 text-center text-[var(--color-muted)]">
                  <span aria-hidden className="grid size-20 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)]">
                    <Icon className="size-8" strokeWidth={1.25} />
                  </span>
                  <p className="m-0 text-sm">{tv.noPreview}</p>
                </div>
              )}
            </div>
            {items.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={!hasPrev}
                  aria-label={tv.prev}
                  className="press absolute left-2 top-1/2 grid size-10 -translate-y-1/2 max-sm:size-11 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-fg)] shadow-[var(--shadow-panel)] hover:border-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-0 sm:left-4"
                >
                  <ChevronLeft className="size-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={!hasNext}
                  aria-label={tv.next}
                  className="press absolute right-2 top-1/2 grid size-10 -translate-y-1/2 max-sm:size-11 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-fg)] shadow-[var(--shadow-panel)] hover:border-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-0 sm:right-4"
                >
                  <ChevronRight className="size-5" aria-hidden />
                </button>
              </>
            )}
          </div>

          <aside className="flex max-h-[46vh] shrink-0 flex-col gap-5 overflow-y-auto border-t border-[var(--color-border)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0 lg:p-5">
            <div className="flex flex-col gap-2">
              <span className="t-label">{tv.details}</span>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {facts
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-[var(--color-muted)]">{k}</dt>
                      <dd className="m-0 min-w-0 break-words text-[var(--color-fg)]">{v}</dd>
                    </div>
                  ))}
              </dl>
            </div>

            {/* A picture opens a Studio tool with it chosen. A link only: nothing is priced or spent here. */}
            {asset.kind === "image" && picture && (
              <div className="flex flex-col gap-2">
                <span className="t-label">{t.gen.useInStudio}</span>
                <div className="flex flex-wrap gap-2">
                  {SOURCE_CAPABILITIES.map((tool) => (
                    <Link
                      key={tool}
                      href={path(`/create?tool=${tool}&source=${encodeURIComponent(asset.id)}`)}
                      className="btn-quiet text-xs"
                    >
                      {t.gen.kinds[tool]}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {orgId && isSendKind(asset.kind) && (
                <SendToEditor key={asset.id} orgId={orgId} assetId={asset.id} kind={asset.kind} name={asset.name} onOpenChange={setSending} />
              )}
              {asset.viewUrl && (
                <a
                  href={asset.viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-quiet text-sm"
                >
                  <ExternalLink size={14} aria-hidden />
                  {tv.openTab}
                </a>
              )}
              {onDelete &&
                (confirm ? (
                  <div className="flex flex-col gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3">
                    <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tm.deleteConfirm, { name })}</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={deleting}
                        onClick={() => onDelete(asset)}
                        className="btn-primary flex-1 text-sm disabled:opacity-40"
                      >
                        {deleting ? tm.deleting : tm.delete}
                      </button>
                      <button type="button" onClick={() => setConfirm(false)} className="btn-quiet text-sm">
                        {tm.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirm(true)}
                    className="btn-quiet text-sm hover:text-[var(--color-fail)]!"
                  >
                    <Trash2 size={14} aria-hidden />
                    {tm.delete}
                  </button>
                ))}
            </div>

            {items.length > 1 && <p className="m-0 hidden text-xs text-[var(--color-muted)] sm:block">{tv.swipeHint}</p>}
          </aside>
        </div>
      </div>
    </div>
  );
}
