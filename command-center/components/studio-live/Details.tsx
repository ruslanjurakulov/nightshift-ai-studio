"use client";

/**
 * One step's details beside the board, read-only (CLAUDE.md rule 3): its status, its failure and remedy, its credits, its output.
 * Its own file so the Studio's Plan column can open it without bundling LiveView.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { AssetDownloads } from "@/components/media/AssetDownloads";
import { Lamp } from "@/components/studio-canvas/parts";
import { useMediaUrls } from "@/components/studio-timeline/useTimelineData";
import { JOB_ERROR_CODES } from "@/lib/job-errors";
import { utc } from "@/lib/studio/utc";
import type { LiveNode, RunVideoRef } from "@/lib/studio/liveGraph";
import type { MasterSound } from "@/lib/studio/masterSound";
import { nodeName, TONE } from "./StoryBoard";

type T = ReturnType<typeof useI18n>["t"];

/** A failed step's reason and remedy, never a guess: a known word gets its sentence, any other is named as it was stored. */
export function failureText(t: T, n: LiveNode, run: boolean): { reason: string; remedy: string | null } {
  const c = t.studioLive;
  if (run) {
    const code = n.error && (JOB_ERROR_CODES as readonly string[]).includes(n.error) ? (n.error as keyof T["create"]["jobError"]) : null;
    return { reason: code ? t.create.jobError[code] : c.failedNoCode, remedy: null };
  }
  if (n.error && c.errors[n.error]) return { reason: c.errors[n.error], remedy: null };
  return { reason: n.error ? fmt(c.failedGeneric, { code: n.error }) : c.failedNoCode, remedy: c.remedyGeneric };
}


function Output({ node }: { node: LiveNode }) {
  const { t } = useI18n();
  const ids = useMemo(() => (node.assetId ? [node.assetId] : []), [node.assetId]);
  const { urls } = useMediaUrls(ids);
  // A failed step has nothing coming: "nothing to show yet" would promise otherwise.
  if (!node.assetId) return node.text ? <p className="lv-text">{node.text}</p> : node.status === "failed" ? null : <p className="lv-muted">{t.studioLive.noOutput}</p>;
  const m = urls.get(node.assetId);
  if (!m) return <p className="lv-muted">{t.studioLive.loading}</p>;
  // A picture has a thumbnail and no play link (useMediaUrls gives play to video and audio only): Pixel H2.
  const src = m.kind === "image" ? (m.thumb ?? m.play) : m.play;
  if (m.failed || m.unavailable || !src) return <p className="lv-muted">{t.studioLive.outputUnavailable}</p>;
  // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
  if (m.kind === "image") return <img className="lv-media" src={src} alt="" />;
  if (m.kind === "audio") return <audio className="lv-audio" src={src} controls preload="none" />;
  return <video className="lv-media" src={src} poster={m.thumb ?? undefined} controls preload="metadata" playsInline />;
}

/**
 * The finished video's sound, as its file records it (S2): how the loudness was set and what it measured, and the clips whose sound
 * was paid for or left out. A file without the record reads "unknown", with its cause, never as if all were well (rule 5).
 */
function FinalSound({ sound }: { sound: MasterSound }) {
  const { t, locale } = useI18n();
  const c = t.studioLive.sound;
  const loc = locale === "uz" ? "uz-Latn-UZ" : locale;
  // A number keeps its unit (Pixel L4); a value not recorded is the phrase alone, never "not recorded LU" (Pixel M1).
  const value = (v: number | null, unit: "lufs" | "dbtp" | "lu") =>
    v === null ? (
      <span>{c.notRecorded}</span>
    ) : (
      <span className="lv-num">
        {v.toLocaleString(loc, { maximumFractionDigits: 1 })}
        {"\u00a0"}
        <abbr title={c.unitTitles[unit]}>{c.units[unit]}</abbr>
      </span>
    );
  const count = (v: number | null) => (v === null ? c.notRecorded : v.toLocaleString(loc));
  const measured = (m: { i: number | null; tp: number | null; lra: number | null }) => {
    const parts = { i: value(m.i, "lufs"), tp: value(m.tp, "dbtp"), lra: value(m.lra, "lu") };
    return c.measured.split(/(\{i\}|\{tp\}|\{lra\})/).map((piece, k) => {
      const key = piece.slice(1, -1) as keyof typeof parts;
      return piece.startsWith("{") && key in parts ? <span key={k}>{parts[key]}</span> : piece;
    });
  };
  const unknown = sound.state === "unknown" ? { read_failed: c.unknownReadFailed, made_before: c.unknownMadeBefore, no_record: c.unknownNoRecord }[sound.cause] : null;
  return (
    <div className="lv-final-sound" data-testid="live-final-sound" data-state={sound.state} data-cause={sound.state === "unknown" ? sound.cause : undefined}>
      <h3>{c.title}</h3>
      {unknown ? <p className="lv-muted">{unknown}</p> : null}
      {sound.state === "none" ? <p className="lv-muted">{c.none}</p> : null}
      {sound.state === "ready" ? (
        <>
          <p data-testid="live-final-loudness" data-mode={sound.mode}>
            {sound.mode === "linear" ? c.linear : sound.mode === "dynamic" ? c.dynamic : sound.mode === "silent" ? c.silent : c.modeUnknown}
          </p>
          {sound.mode !== "silent" ? (
            <p className="lv-muted" data-testid="live-final-measured">
              {measured(sound.measured)}
            </p>
          ) : null}
          {sound.paidUnused === null || sound.paidUnused > 0 ? (
            <p data-testid="live-final-paid">{fmt(c.paidUnused, { n: count(sound.paidUnused) })}</p>
          ) : null}
          {sound.defaultUnused === null || sound.defaultUnused > 0 ? (
            <p className="lv-muted" data-testid="live-final-default">
              {fmt(c.defaultUnused, { n: count(sound.defaultUnused) })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function Details({
  node,
  run,
  filmId,
  video,
  onClose,
}: {
  node: LiveNode;
  run: boolean;
  filmId: string | null;
  /** undefined: the route did not say (an older answer); null: no video row readable for this run yet. */
  video?: RunVideoRef | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const c = t.studioLive;
  const path = useChannelPath();
  const closeRef = useRef<HTMLButtonElement>(null);
  // preventScroll: focusing the close key must not scroll the page and hide the plan's title (S4 MEDIUM 4).
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), [node.id]);
  return (
    <aside
      className="lv-details"
      aria-label={c.details}
      data-testid="live-details"
    >
      <div className="lv-details-head">
        <h2>{nodeName(t, node)}</h2>
        <button type="button" ref={closeRef} className="cv-kbtn" onClick={onClose} aria-label={c.close}>
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <Lamp tone={TONE[node.status]} live={node.status === "working"} label={c.status[node.status]} />
      {node.status === "failed" ? (
        (() => {
          const f = failureText(t, node, run);
          return (
            <div className="lv-fail" role="status" data-testid="live-failure">
              <p>{f.reason}</p>
              {f.remedy ? <p>{f.remedy}</p> : null}
            </div>
          );
        })()
      ) : null}
      {node.kind === "upload" ? (
        <p data-testid="live-privacy">{node.privacy === "private" ? c.privacyPrivate : node.privacy ? fmt(c.privacyOther, { privacy: c.privacyWords[node.privacy] ?? node.privacy }) : c.privacyUnknown}</p>
      ) : null}
      {run && node.kind === "upload" && video !== undefined ? (
        // The run's video page holds the existing "Publish to platforms" panel: the person sends from there, after its checks.
        video ? (
          <Link className="cv-kbtn" href={path(`/videos/${encodeURIComponent(video.id)}`)} data-testid="live-open-video">
            {c.openVideo}
          </Link>
        ) : (
          <p className="lv-muted" data-testid="live-video-after-sync">
            {c.videoAfterSync}
          </p>
        )
      ) : null}
      {node.cast?.length ? (
        <p className="lv-muted" data-testid="live-cast">
          {fmt(c.plan.castLine, { names: node.cast.map((n) => n || c.plan.card.unnamed).join(", ") })}
        </p>
      ) : null}
      {!run && node.status === "draft" ? (
        // A planned step has no money on it yet: the backend prices the whole plan when Create is pressed (Pixel L3).
        <p className="lv-muted" data-testid="live-credits">
          {c.plan.pricedAtCreate}
        </p>
      ) : !run ? (
        <p className="lv-muted" data-testid="live-credits">
          {node.credits
            ? [
                node.credits.held === null ? c.creditsHeldUnrecorded : fmt(c.creditsHeld, { n: node.credits.held }),
                node.credits.charged === null ? c.creditsChargedUnrecorded : fmt(c.creditsCharged, { n: node.credits.charged }),
              ].join(" · ")
            : c.creditsNone}
        </p>
      ) : node.at ? (
        <p className="lv-muted">{fmt(c.recordedAt, { time: utc(node.at).toLocaleString(locale === "uz" ? "uz-Latn-UZ" : locale) })}</p>
      ) : null}
      {!run ? <Output node={node} /> : null}
      {node.kind === "final" && node.assetId ? (
        <div className="lv-final" data-testid="live-final">
          <AssetDownloads assetId={node.assetId} preview="ready" />
          <FinalSound sound={node.sound ?? { state: "unknown", cause: "read_failed" }} />
          {filmId ? (
            <Link className="cv-kbtn" href={path(`/studio?view=timeline&film=${filmId}`)} data-testid="live-open-timeline">
              {c.openTimeline}
            </Link>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
