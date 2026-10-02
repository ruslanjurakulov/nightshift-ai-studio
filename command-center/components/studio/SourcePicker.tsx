"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Film, ImageOff, Music } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useLibraryImages, type PickerRecording } from "@/components/studio/useLibraryImages";

/** 61.2 -> "1:02" (whole seconds rounded up, as the price counts them). */
export function clipLength(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Pick the ONE library picture an edit, animation, upscale or background
 * removal starts from (or an animation ends on) — or, with
 * `media="recording"`, the ONE audio or video file a voice change or a dub
 * starts from (migration 0050), or with `media="video"` the ONE video a video
 * upscale starts from (0052). Once picked it
 * shows large with "Change"; the list comes back only when asked. The pick is
 * only an id: the database refuses (source_unavailable) one that is not a
 * live file of the right kind of this organization when it prices the job,
 * and it alone measures a recording's length for the price.
 */
export function SourcePicker({
  orgId,
  value,
  onChange,
  libraryHref,
  compact = false,
  media = "picture",
  maxSeconds = null,
  label,
  well = false,
}: {
  /** On the Image and Enhance desks: the chosen picture lies large on the light table, not as a thumbnail. */
  well?: boolean;
  orgId: string;
  value: string | null;
  onChange: (id: string) => void;
  libraryHref: string;
  /** In the Studio's narrow composer column: four across at every width. */
  compact?: boolean;
  /** What the tool starts from: a picture (0046), a recording (0050) or a video (0052). */
  media?: "picture" | "recording" | "video";
  /** A recording or video tool's longest clip, to grey out longer ones (the database still decides). */
  maxSeconds?: number | null;
  /** The list's accessible name when a form has two pickers (an animation's end frame). */
  label?: string;
}) {
  const { t } = useI18n();
  const g = t.gen;
  const { state, images, recordings, reload } = useLibraryImages(orgId);
  const [browsing, setBrowsing] = useState(false);
  const chosen = value && media === "picture" ? images.find((i) => i.id === value) : undefined;
  const files = media === "video" ? recordings.filter((r) => r.kind === "video") : recordings;
  const chosenRec = value && media !== "picture" ? files.find((r) => r.id === value) : undefined;
  // A picture handed in from a result that finished after the library was
  // read ("Use as picture"): read the library once more to show it.
  const reread = useRef<string | null>(null);
  const found = Boolean(chosen || chosenRec);
  useEffect(() => {
    if (!value || state !== "ready" || found || reread.current === value) return;
    reread.current = value;
    void reload();
  }, [value, state, found, reload]);

  if (media !== "picture") {
    return (
      <RecordingPicker
        state={state}
        recordings={files}
        video={media === "video"}
        value={value}
        chosen={chosenRec}
        browsing={browsing}
        setBrowsing={setBrowsing}
        onChange={onChange}
        reload={reload}
        libraryHref={libraryHref}
        maxSeconds={maxSeconds}
      />
    );
  }

  if (value && !browsing && well) {
    return (
      <figure className="desk-well" data-testid="source-well">
        {chosen?.thumbUrl || chosen?.viewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived library links
          <img src={(chosen.viewUrl ?? chosen.thumbUrl) as string} alt={chosen.name ?? g.sourceChosen} className="desk-well-img" />
        ) : (
          <span className="grid min-h-[160px] w-full place-items-center text-[var(--color-muted)]">
            <ImageOff aria-hidden className="size-6" />
          </span>
        )}
        <figcaption className="desk-well-cap">
          <span className="min-w-0 truncate">{chosen?.name ?? g.sourceChosen}</span>
          <button type="button" onClick={() => setBrowsing(true)} className="ns-chip shrink-0">
            {g.sourceChange}
          </button>
        </figcaption>
      </figure>
    );
  }

  if (value && !browsing) {
    return (
      <div className={compact ? "studio-field flex items-center gap-3 p-2" : "flex items-center gap-3"}>
        <div className="relative size-20 shrink-0 overflow-hidden rounded-[var(--ns-r-key)] border-2 border-[var(--color-primary)] bg-[var(--color-panel-2)]">
          {chosen?.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={chosen.thumbUrl} alt={chosen.name ?? g.sourceChosen} className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center text-[var(--color-muted)]">
              <ImageOff aria-hidden className="size-5" />
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate text-[13px]">{chosen?.name ?? g.sourceChosen}</span>
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            className="btn-quiet w-fit text-[12px]"
          >
            {g.sourceChange}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-[var(--color-muted)]">{g.sourcePick}</span>

      {state === "loading" && (
        <div className={`grid grid-cols-4 gap-2${compact ? "" : " sm:grid-cols-6"}`} aria-busy="true" aria-label={g.sourceLoading}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-[var(--ns-r-key)] bg-[var(--color-panel-2)]" />
          ))}
        </div>
      )}

      {state === "failed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{g.sourceFailed}</span>
          <button type="button" onClick={() => void reload()} className="btn-quiet text-[12px]">
            {g.sourceRetry}
          </button>
        </div>
      )}

      {state === "unavailable" && (
        <p className="rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">{g.sourceUnavailable}</p>
      )}

      {state === "ready" && images.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--ns-r-key)] border border-dashed border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{g.sourceEmpty}</span>
          <Link href={libraryHref} className="btn-quiet text-[12px]">
            {g.sourceOpenLibrary}
          </Link>
        </div>
      )}

      {state === "ready" && images.length > 0 && (
        <ul
          className={`grid max-h-[260px] grid-cols-4 gap-2 overflow-y-auto${compact ? "" : " sm:grid-cols-6"}`}
          role="radiogroup" aria-label={label ?? g.sourceLabel}>
          {images.map((img) => {
            const on = img.id === value;
            return (
              <li key={img.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={img.name ?? g.sourceLabel}
                  onClick={() => {
                    onChange(img.id);
                    setBrowsing(false);
                  }}
                  className="relative block aspect-square w-full overflow-hidden rounded-[var(--ns-r-key)] border bg-[var(--color-panel-2)]"
                  style={{ borderColor: on ? "var(--color-primary)" : "var(--color-border)", borderWidth: on ? 2 : 1 }}
                >
                  {img.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-full w-full place-items-center gap-1 text-[10px] text-[var(--color-muted)]">
                      <ImageOff aria-hidden className="size-4" />
                      {g.noPreview}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RecordingIcon({ r, size = "size-10" }: { r: PickerRecording | undefined; size?: string }) {
  const Icon = r?.kind === "video" ? Film : Music;
  return (
    <span
      aria-hidden
      className={`relative grid ${size} shrink-0 place-items-center overflow-hidden rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]`}
    >
      {r?.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Icon className="size-4" />
      )}
    </span>
  );
}

/** The audio and video files of the library, as rows: a name and a length read better than a waveform tile. */
function RecordingPicker({
  state,
  recordings,
  video,
  value,
  chosen,
  browsing,
  setBrowsing,
  onChange,
  reload,
  libraryHref,
  maxSeconds,
}: {
  state: "loading" | "ready" | "failed" | "unavailable";
  recordings: PickerRecording[];
  /** Videos only (0052's upscale): its own words, and limits in seconds. */
  video: boolean;
  value: string | null;
  chosen: PickerRecording | undefined;
  browsing: boolean;
  setBrowsing: (v: boolean) => void;
  onChange: (id: string) => void;
  reload: () => Promise<void>;
  libraryHref: string;
  maxSeconds: number | null;
}) {
  const { t, fmt } = useI18n();
  const g = t.gen;
  const kindName = (r: PickerRecording | undefined) => (r?.kind === "video" ? g.recordingVideo : g.recordingAudio);
  const copy = video
    ? { label: g.videoLabel, pick: g.videoPick, empty: g.videoEmpty, chosen: g.videoChosen, change: g.videoChange }
    : { label: g.recordingLabel, pick: g.recordingPick, empty: g.recordingEmpty, chosen: g.recordingChosen, change: g.recordingChange };
  // A video tool's limit is seconds long (0052); a voice tool's is minutes.
  const tooLongText = (max: number) =>
    video ? fmt(g.videoTooLong, { n: max }) : fmt(g.recordingTooLong, { n: Math.round(max / 60) });

  if (value && !browsing) {
    const len = clipLength(chosen?.durationS ?? null);
    return (
      <div className="studio-field flex items-center gap-3 p-2">
        <RecordingIcon r={chosen} size="size-14" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate text-[13px]">{chosen?.name ?? copy.chosen}</span>
          {chosen && (
            <span className="text-[12px] text-[var(--color-muted)]">
              {kindName(chosen)}
              {len ? ` · ${len}` : ""}
            </span>
          )}
          <button type="button" onClick={() => setBrowsing(true)} className="btn-quiet w-fit text-[12px]">
            {copy.change}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-[var(--color-muted)]">{copy.pick}</span>

      {state === "loading" && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={g.sourceLoading}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-[var(--ns-r-key)] bg-[var(--color-panel-2)]" />
          ))}
        </div>
      )}

      {state === "failed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{g.sourceFailed}</span>
          <button type="button" onClick={() => void reload()} className="btn-quiet text-[12px]">
            {g.sourceRetry}
          </button>
        </div>
      )}

      {state === "unavailable" && (
        <p className="rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">{g.sourceUnavailable}</p>
      )}

      {state === "ready" && recordings.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--ns-r-key)] border border-dashed border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{copy.empty}</span>
          <Link href={libraryHref} className="btn-quiet text-[12px]">
            {g.sourceOpenLibrary}
          </Link>
        </div>
      )}

      {state === "ready" && recordings.length > 0 && (
        <ul className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto" role="radiogroup" aria-label={copy.label}>
          {recordings.map((r) => {
            const on = r.id === value;
            const len = clipLength(r.durationS);
            const tooLong = maxSeconds !== null && r.durationS !== null && r.durationS > maxSeconds;
            const unknown = r.durationS === null;
            const note = tooLong ? tooLongText(maxSeconds ?? 0) : unknown ? g.recordingNoLength : null;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-disabled={tooLong || unknown}
                  disabled={tooLong || unknown}
                  onClick={() => {
                    onChange(r.id);
                    setBrowsing(false);
                  }}
                  className="flex w-full items-center gap-3 rounded-[var(--ns-r-key)] border bg-[var(--color-panel)] p-2 text-left disabled:cursor-not-allowed disabled:opacity-55"
                  style={{ borderColor: on ? "var(--color-primary)" : "var(--color-border)", borderWidth: on ? 2 : 1 }}
                >
                  <RecordingIcon r={r} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-[var(--color-fg)]">{r.name ?? kindName(r)}</span>
                    <span className="text-[12px] text-[var(--color-muted)]">
                      {kindName(r)}
                      {len ? ` · ${len}` : ""}
                      {note ? ` · ${note}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
