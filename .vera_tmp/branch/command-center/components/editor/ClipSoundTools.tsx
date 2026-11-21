"use client";

import { useId, useState } from "react";
import { Copy, CopyPlus, ClipboardPaste, Unlink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  CLIP_VOLUME_MAX_PCT,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_SOUNDS,
  canInsertClip,
  clipVolumePct,
  detachClipAudio,
  detachProblem,
  duplicateClip,
  insertClipCopy,
  setClipVolume,
  type EditorAsset,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";

const quietBtn = "btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs";
const note = "m-0 text-xs text-[var(--color-muted)]";

/**
 * A video clip's own sound: its volume (0-200 %, `gain_db` in the document; muting is the
 * clip's sound switch above it) and "Detach audio", which moves the sound to a sound of its
 * own (lib/editor.ts `detachClipAudio`). Shown only for a clip that plays its own sound.
 */
export function ClipVolumeDetach({
  model,
  clip,
  assetKind,
  apply,
  onDetached,
}: {
  model: EditorModel;
  clip: VideoClip;
  assetKind: EditorAsset["kind"] | undefined;
  apply: (next: EditorModel, group?: string) => void;
  onDetached: (soundId: string) => void;
}) {
  const { t } = useI18n();
  const ct = t.editor.clipTools;
  const id = useId();
  if (!clip.audio || assetKind === "image") return null;
  const pct = clipVolumePct(clip);
  const why = detachProblem(model, clip.id, assetKind);
  return (
    <div className="flex flex-col gap-1.5" data-testid="clip-volume">
      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        <span>
          {ct.volume.label} · {fmt(ct.volume.value, { pct })}
        </span>
        <input
          type="range"
          min={0}
          max={CLIP_VOLUME_MAX_PCT}
          step={5}
          value={pct}
          aria-valuetext={fmt(ct.volume.value, { pct })}
          aria-describedby={`${id}-vol`}
          onChange={(e) =>
            apply(setClipVolume(model, clip.id, Number(e.target.value)), `vol-${clip.id}`)
          }
          className="accent-[var(--color-primary)]"
        />
      </label>
      <p id={`${id}-vol`} className={note}>
        {ct.volume.hint}
      </p>
      <button
        type="button"
        className={`${quietBtn} self-start`}
        aria-disabled={why !== null || undefined}
        aria-describedby={why ? `${id}-detach` : undefined}
        onClick={() => {
          const out = detachClipAudio(model, clip.id, assetKind);
          if (!out) return;
          apply(out.model);
          onDetached(out.soundId);
        }}
      >
        <Unlink className="size-3.5" aria-hidden />
        {ct.detach.button}
      </button>
      {why ? (
        <p id={`${id}-detach`} className={note}>
          {why === "sounds_full"
            ? fmt(ct.detach.sounds_full, { max: MAX_EDITOR_SOUNDS })
            : ct.detach[why]}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Duplicate, copy and paste of a picture clip. The copy is a whole clip (every setting) with a
 * fresh id, put right after a clip (lib/editor.ts `insertClipCopy`); the clipboard is the
 * editor's own (one clip of this project), not the system's.
 */
export function ClipCopyTools({
  model,
  clip,
  clipboard,
  onCopy,
  apply,
  onInserted,
}: {
  model: EditorModel;
  clip: VideoClip;
  clipboard: VideoClip | null;
  onCopy: (c: VideoClip) => void;
  apply: (next: EditorModel) => void;
  onInserted: (newId: string) => void;
}) {
  const { t } = useI18n();
  const cb = t.editor.clipTools.clipboard;
  const [said, setSaid] = useState<string | null>(null);
  const room = canInsertClip(model);
  const insert = (out: { model: EditorModel; id: string } | null) => {
    if (!out) return;
    // The copy becomes the selection, so its own inspector (its heading) is what the person meets next.
    apply(out.model);
    onInserted(out.id);
  };
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={cb.group}>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={quietBtn}
          aria-disabled={!room || undefined}
          onClick={() => {
            if (room) insert(duplicateClip(model, clip.id));
          }}
        >
          <CopyPlus className="size-3.5" aria-hidden />
          {cb.duplicate}
        </button>
        <button
          type="button"
          className={quietBtn}
          onClick={() => {
            onCopy(clip);
            setSaid(cb.copied);
          }}
        >
          <Copy className="size-3.5" aria-hidden />
          {cb.copy}
        </button>
        <button
          type="button"
          className={quietBtn}
          aria-disabled={!clipboard || !room || undefined}
          onClick={() => {
            if (clipboard && room) insert(insertClipCopy(model, clipboard, clip.id));
          }}
        >
          <ClipboardPaste className="size-3.5" aria-hidden />
          {cb.paste}
        </button>
      </div>
      <p className={note}>
        {room ? cb.hint : fmt(cb.full, { max: MAX_EDITOR_CLIPS })}
      </p>
      <p aria-live="polite" className={note}>
        {said}
      </p>
    </div>
  );
}
