"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { useToast } from "@/components/feedback/ToastProvider";
import { Avatar } from "@/components/account/Avatar";
import {
  AVATAR_ENDPOINT,
  AVATAR_INPUT_ACCEPT,
  AVATAR_META_KEY,
  AVATAR_MIME,
  isAvatarErrorCode,
  type AvatarErrorCode,
} from "@/lib/avatar";
import { AvatarInputError, inspectAvatarFile, prepareAvatar, type AvatarCrop } from "@/lib/avatar-image";

/**
 * Add, change or remove the profile photo. Self-contained: the Settings
 * account section mounts `<AvatarUploader email={email} version={avatarV} />`
 * and nothing else.
 *
 *   idle      the current picture, "Add/Change photo", "Remove photo"
 *   cropping  the picked photo under a circular mask: drag (mouse, touch, pen)
 *             or arrow keys to move, slider or + / - to zoom
 *   saving    the crop is re-encoded in the browser as a 256x256 JPEG
 *             (lib/avatar-image.ts), POSTed to /api/avatar, and only then is the version recorded in
 *             the person's metadata (avatar_v); controls are disabled and the
 *             section is aria-busy
 *   error     one fixed message from the code (never server or storage text)
 *
 * The picked file is checked by its header before anything decodes it, so a
 * file that declares an enormous size is refused without being drawn.
 */

const MAX_ZOOM = 4;
const KEY_STEP = 0.05; // of the viewport, per arrow press
const ZOOM_STEP = 0.1;

/**
 * The zoom slider with a track that is visible against the page (the browser's own is pale grey: under 3:1 in the
 * light theme) and a thumb in the action colour. Centres the 20px thumb on the 6px track in both engines.
 */
const ZOOM_SLIDER = [
  "h-11 w-full cursor-pointer appearance-none bg-transparent",
  "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--color-muted)]",
  "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--color-muted)]",
  "[&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-[var(--ns-act)]",
  "[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--ns-act)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

type Phase = "idle" | "cropping" | "saving";

const STATUS_CODE: Record<number, AvatarErrorCode> = {
  401: "unauthorized",
  403: "forbidden",
  413: "too_large",
  415: "not_jpeg",
  429: "rate_limited",
};

/** The fixed code for a failed response: its own `error` when it is one we know, else by status. */
async function codeFromResponse(res: Response): Promise<AvatarErrorCode> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (isAvatarErrorCode(body?.error)) return body.error;
  } catch {
    /* no body: fall through to the status */
  }
  return STATUS_CODE[res.status] ?? "failed";
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

interface Frame {
  /** Centre of the square, as a fraction of the picture's width and height. */
  cx: number;
  cy: number;
  /** 1 = the shorter side fills the viewport. */
  zoom: number;
}

/** The square, in the picture's own pixels, that a frame selects. */
export function cropFor(frame: Frame, w: number, h: number): AvatarCrop {
  const size = Math.min(w, h) / frame.zoom;
  return {
    size,
    x: clamp(frame.cx * w - size / 2, 0, w - size),
    y: clamp(frame.cy * h - size / 2, 0, h - size),
  };
}

/** Keep the square inside the picture. */
function settle(frame: Frame, w: number, h: number): Frame {
  const zoom = clamp(frame.zoom, 1, MAX_ZOOM);
  const side = Math.min(w, h) / zoom;
  const hx = side / 2 / w;
  const hy = side / 2 / h;
  return { zoom, cx: clamp(frame.cx, hx, 1 - hx), cy: clamp(frame.cy, hy, 1 - hy) };
}

export function AvatarUploader({ email, version }: { email: string | null; version: number | null }) {
  const { t } = useI18n();
  const a = t.avatar;
  const router = useRouter();
  const toast = useToast();
  const helpId = useId();
  const zoomId = useId();

  const [current, setCurrent] = useState<number | null>(version);
  useEffect(() => setCurrent(version), [version]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [busyKind, setBusyKind] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<AvatarErrorCode | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState<Frame>({ cx: 0.5, cy: 0.5, zoom: 1 });

  const inputRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  // The preview is an object URL for the picked file; it is released as soon as it is not shown.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [file]);

  // Focus follows the step: into the crop when it opens, back to the button that opened it when it closes.
  const refocus = useRef(false);
  useEffect(() => {
    if (phase === "cropping") viewportRef.current?.focus();
    else if (phase === "idle" && refocus.current) {
      refocus.current = false;
      pickRef.current?.focus();
    }
  }, [phase]);

  const leaveCrop = useCallback(() => {
    setFile(null);
    setDims(null);
    setFrame({ cx: 0.5, cy: 0.5, zoom: 1 });
    refocus.current = true;
    setPhase("idle");
  }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    // Allow picking the same file again after a cancel.
    e.target.value = "";
    if (!picked) return;
    setError(null);
    try {
      const info = await inspectAvatarFile(picked);
      setDims({ w: info.width, h: info.height });
      setFrame({ cx: 0.5, cy: 0.5, zoom: 1 });
      setFile(picked);
      setPhase("cropping");
    } catch (err) {
      setError(err instanceof AvatarInputError ? err.code : "unreadable");
    }
  }

  // ── move and zoom ─────────────────────────────────────────────────────────

  const move = useCallback(
    (dxView: number, dyView: number) => {
      // dxView / dyView are fractions of the viewport; the square is `side` of the picture wide.
      setFrame((f) => {
        if (!dims) return f;
        const side = Math.min(dims.w, dims.h) / f.zoom;
        return settle({ ...f, cx: f.cx + (dxView * side) / dims.w, cy: f.cy + (dyView * side) / dims.h }, dims.w, dims.h);
      });
    },
    [dims],
  );

  const zoomTo = useCallback(
    (z: number) => {
      setFrame((f) => (dims ? settle({ ...f, zoom: z }, dims.w, dims.h) : f));
    },
    [dims],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (phase !== "cropping") return;
    const big = e.shiftKey ? 4 : 1;
    switch (e.key) {
      case "ArrowLeft":
        move(KEY_STEP * big, 0);
        break;
      case "ArrowRight":
        move(-KEY_STEP * big, 0);
        break;
      case "ArrowUp":
        move(0, KEY_STEP * big);
        break;
      case "ArrowDown":
        move(0, -KEY_STEP * big);
        break;
      case "+":
      case "=":
        zoomTo(frame.zoom + ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomTo(frame.zoom - ZOOM_STEP);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (phase !== "cropping" || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const width = e.currentTarget.getBoundingClientRect().width;
    if (!width) return;
    // The picture follows the finger: dragging right shows more of its left side.
    move(-(e.clientX - d.x) / width, -(e.clientY - d.y) / width);
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }

  // ── save and remove ───────────────────────────────────────────────────────

  async function recordVersion(v: number | null): Promise<boolean> {
    const supabase = createClient();
    if (!supabase) return false;
    const { error: e } = await supabase.auth.updateUser({ data: { [AVATAR_META_KEY]: v } });
    return !e;
  }

  async function save() {
    if (!file || !dims || phase === "saving") return;
    setError(null);
    setPhase("saving");
    setBusyKind("save");
    try {
      const blob = await prepareAvatar(file, cropFor(frame, dims.w, dims.h), previewRef.current);
      const res = await fetch(AVATAR_ENDPOINT, { method: "POST", headers: { "content-type": AVATAR_MIME }, body: blob });
      if (!res.ok) throw new AvatarInputError(await codeFromResponse(res));
      const body = (await res.json()) as { version?: unknown };
      const v = typeof body.version === "number" && Number.isSafeInteger(body.version) && body.version > 0 ? body.version : Date.now();
      if (!(await recordVersion(v))) throw new AvatarInputError("failed");
      setCurrent(v);
      toast.success(a.saved);
      leaveCrop();
      router.refresh();
    } catch (err) {
      setError(err instanceof AvatarInputError ? err.code : "failed");
      setPhase("cropping");
    } finally {
      setBusyKind(null);
    }
  }

  async function removePhoto() {
    if (phase === "saving") return;
    setError(null);
    setPhase("saving");
    setBusyKind("remove");
    try {
      const res = await fetch(AVATAR_ENDPOINT, { method: "DELETE" });
      if (!res.ok) throw new AvatarInputError(await codeFromResponse(res));
      if (!(await recordVersion(null))) throw new AvatarInputError("failed");
      setCurrent(null);
      toast.success(a.removed);
      router.refresh();
    } catch (err) {
      const code = err instanceof AvatarInputError ? err.code : "failed";
      // A generic failure while removing says "removed", not "saved".
      setError(code === "failed" ? "remove_failed" : code);
    } finally {
      setPhase("idle");
      setBusyKind(null);
    }
  }

  const saving = phase === "saving";
  const cropping = phase === "cropping" || (saving && busyKind === "save");
  const side = dims ? Math.min(dims.w, dims.h) / frame.zoom : 1;
  const imgStyle: React.CSSProperties | undefined = dims
    ? {
        width: `${(dims.w / side) * 100}%`,
        height: `${(dims.h / side) * 100}%`,
        left: `${50 - ((frame.cx * dims.w) / side) * 100}%`,
        top: `${50 - ((frame.cy * dims.h) / side) * 100}%`,
      }
    : undefined;

  return (
    <div className="flex flex-col gap-3" data-testid="avatar-uploader" aria-busy={saving}>
      <h3 className="g5-h">{a.title}</h3>
      <p className="g5-note">{a.privacy}</p>

      {!cropping && (
        <div className="flex flex-wrap items-center gap-4">
          <Avatar email={email} version={current} size={96} ring />
          <div className="flex flex-wrap items-center gap-3">
            <button
              ref={pickRef}
              type="button"
              className="btn-quiet px-5 text-sm"
              disabled={saving}
              onClick={() => inputRef.current?.click()}
            >
              {current ? a.change : a.add}
            </button>
            {current && (
              <button type="button" className="btn-quiet px-5 text-sm" disabled={saving} onClick={removePhoto}>
                {busyKind === "remove" ? a.removing : a.remove}
              </button>
            )}
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_INPUT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        data-testid="avatar-file"
        onChange={onPick}
      />
      {!cropping && <p className="g5-note">{a.hint}</p>}

      {cropping && (
        <div className="flex max-w-[20rem] flex-col gap-3" role="group" aria-label={a.cropTitle}>
          {/* Arrow keys and +/- mean nothing on a phone: a coarse pointer gets the touch wording. */}
          <p id={helpId} className="g5-note">
            <span className="[@media(pointer:coarse)]:hidden">{a.cropHelp}</span>
            <span className="hidden [@media(pointer:coarse)]:inline">{a.cropHelpTouch}</span>
          </p>
          <div
            ref={viewportRef}
            role="group"
            tabIndex={0}
            aria-label={a.cropArea}
            aria-describedby={helpId}
            data-testid="avatar-crop"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="scroll-focus relative aspect-square w-full cursor-grab touch-none select-none overflow-hidden rounded-xl bg-[var(--color-panel-2)] active:cursor-grabbing"
          >
            {previewUrl && (
              // A local blob URL of the picked file; next/image cannot take it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={previewRef}
                src={previewUrl}
                alt=""
                draggable={false}
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                  // The browser's own size (rotation applied) beats the header's.
                  if (w > 0 && h > 0) setDims((d) => (d && d.w === w && d.h === h ? d : { w, h }));
                }}
                onError={() => {
                  setError("unreadable");
                  leaveCrop();
                }}
                className="pointer-events-none absolute max-w-none"
                style={imgStyle}
              />
            )}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_999px_rgba(0,0,0,0.55)] ring-1 ring-white/70"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={zoomId} className="g5-k">
              {a.zoom}
            </label>
            <input
              id={zoomId}
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={frame.zoom}
              disabled={saving}
              onChange={(e) => zoomTo(Number(e.target.value))}
              className={ZOOM_SLIDER}
            />
          </div>
          <div className="g5-actions">
            <button type="button" className="btn-primary px-5 text-sm" disabled={saving} onClick={save}>
              {saving ? a.saving : a.save}
            </button>
            <button type="button" className="btn-quiet px-5 text-sm" disabled={saving} onClick={leaveCrop}>
              {a.cancel}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="g5-note g5-fail-text" data-testid="avatar-error">
          {a.errors[error]}
        </p>
      )}
    </div>
  );
}
