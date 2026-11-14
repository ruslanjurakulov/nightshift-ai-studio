"use client";

import Link from "next/link";
import { AudioLines, Film, Plus, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { PickerImage, PickerRecording, LibraryLoadState } from "@/components/studio/useLibraryImages";
import type { PortType } from "@/lib/studio/canvas";

/** The drag payload a library file carries onto the canvas: an id and a kind, nothing else. */
export const ASSET_MIME = "application/x-nightshift-asset";

export interface DroppedAsset {
  id: string;
  kind: PortType;
  name: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read a drop, refusing anything that is not exactly the shape this drawer wrote (a drop can come from any page). */
export function readDrop(raw: string): DroppedAsset | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.id !== "string" || !UUID.test(v.id)) return null;
    if (v.kind !== "image" && v.kind !== "video" && v.kind !== "audio") return null;
    return { id: v.id, kind: v.kind, name: typeof v.name === "string" ? v.name.slice(0, 120) : null };
  } catch {
    return null;
  }
}

/**
 * The organization's media library (migration 0038), read as the member through RLS by the shared hook, as a
 * drawer beside the canvas. A file drags onto the canvas (an asset node) or onto a node's input (wired at
 * once); "+" adds it without dragging, which is how the phone does it. Reading the library spends nothing.
 */
export function LibraryDrawer({
  state,
  images,
  recordings,
  onReload,
  onAdd,
  onClose,
  sheet = false,
}: {
  state: LibraryLoadState;
  images: readonly PickerImage[];
  recordings: readonly PickerRecording[];
  onReload: () => void;
  onAdd: (a: DroppedAsset) => void;
  onClose: () => void;
  sheet?: boolean;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas.drawer;
  const path = useChannelPath();
  const item = (a: DroppedAsset, thumb: string | null) => {
    const name = a.name || c.untitled;
    return (
      <li key={a.id} className="sc-asset">
        <div
          className="sc-asset-tile"
          draggable={!sheet}
          onDragStart={(e) => {
            e.dataTransfer.setData(ASSET_MIME, JSON.stringify(a));
            e.dataTransfer.effectAllowed = "copy";
          }}
          data-testid={`library-asset-${a.id}`}
        >
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" draggable={false} />
          ) : a.kind === "audio" ? (
            <AudioLines aria-hidden className="size-6" />
          ) : (
            <Film aria-hidden className="size-6" />
          )}
          <span className="sc-asset-name">{name}</span>
        </div>
        <button type="button" className="sc-asset-add" onClick={() => onAdd(a)} aria-label={fmt(c.add, { name })} title={fmt(c.add, { name })}>
          <Plus aria-hidden className="size-4" />
        </button>
      </li>
    );
  };
  return (
    <aside className={sheet ? "sc-drawer is-sheet" : "sc-drawer"} aria-label={c.title} data-testid="canvas-library">
      <header className="sc-inspector-head">
        <div className="min-w-0">
          <h2 className="sc-inspector-title">{c.title}</h2>
          <p className="sc-note">{c.hint}</p>
        </div>
        <button type="button" className="sc-icon-btn" onClick={onClose} aria-label={c.close} title={c.close}>
          <X aria-hidden className="size-4" />
        </button>
      </header>
      {state === "loading" ? (
        <p className="sc-note" role="status">
          {c.loading}
        </p>
      ) : state === "failed" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="sc-note is-fail">{c.failed}</p>
          <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={onReload}>
            {c.retry}
          </button>
        </div>
      ) : state === "unavailable" ? (
        <p className="sc-note">{c.unavailable}</p>
      ) : images.length === 0 && recordings.length === 0 ? (
        <p className="sc-note" data-testid="library-empty">
          {c.empty}
        </p>
      ) : (
        <>
          {images.length > 0 && (
            <>
              <h3 className="sc-block-title">{c.pictures}</h3>
              <ul className="sc-assets">{images.map((i) => item({ id: i.id, kind: "image", name: i.name }, i.thumbUrl))}</ul>
            </>
          )}
          {recordings.length > 0 && (
            <>
              <h3 className="sc-block-title">{c.recordings}</h3>
              <ul className="sc-assets">{recordings.map((r) => item({ id: r.id, kind: r.kind, name: r.name }, r.thumbUrl))}</ul>
            </>
          )}
        </>
      )}
      <Link href={path("/library")} className="sc-text-btn mt-auto">
        {c.openFull}
      </Link>
    </aside>
  );
}
