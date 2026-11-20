"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowDownUp, Flag, Link2, Lock, Magnet, MousePointer2, Pause, Play, Repeat, Scissors, Search, SkipBack, SkipForward, ZoomIn } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { BAR_SLOT_ID, ProjectBar } from "@/components/studio-canvas/StudioCanvas";
import { clock, scenesPatch, sceneToDraft, filmErrorFromResponse, type FilmScene } from "@/lib/films";
import {
  FPS,
  TRACKS,
  TRACK_BACKEND,
  chosenClip,
  chosenKeyframe,
  keyAction,
  layoutTimeline,
  narrationTake,
  reorder,
  sceneAt,
  shortcutAllowed,
  timecode,
  type TimelineActor,
  type TimelineClip,
  type TimelineFilm,
  type TrackId,
} from "@/lib/studio/timeline";
import { useFilmList, useMediaUrls, usePeaks, useTimelineFilm, type MediaUrls } from "./useTimelineData";
import { AssemblePanel } from "./AssemblePanel";
import "@/components/studio-canvas/studio-canvas.css";
import "./studio-timeline.css";

const ZOOMS = [8, 14, 22, 36, 60] as const;
const TRACK_TONE: Record<TrackId, string> = {
  V1: "var(--t-video)",
  A1: "var(--t-narr)",
  A2: "var(--t-music)",
  A3: "var(--t-sfx)",
  A4: "var(--t-amb)",
  C1: "var(--t-cap)",
};
/** Tracks whose sound the preview can play; A3/A4 have no backend, so their meters stay at rest. */
const METERED: readonly (TrackId | "main")[] = ["V1", "A1", "A2", "A3", "A4", "main"];

/**
 * Nightshift Studio's Timeline (prototype docs/studio/prototype/studio-timeline-prototype.html): one project as an edit page.
 * Everything drawn is read: the scenes in their saved order (film_json), each as long as its chosen clip measured or, when it has none,
 * a dashed draft at its planned length; narration and music only when a file exists; effects and ambience empty because nothing stores
 * them. The browser edits only what a database function guards (scene order and the project's music levels through save_film), and
 * assembling is the server's quote → the person's confirmation → start_film. No demo cursors, no sample clips, no client price.
 */
export function StudioTimeline({ filmStudio, filmId, actors }: { filmStudio: boolean; filmId: string | null; actors?: ReadonlyMap<string, TimelineActor[]> }) {
  const { t } = useI18n();
  const c = t.studioTimeline;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(BAR_SLOT_ID)), []);

  const { load, stale, reload, replace } = useTimelineFilm(filmStudio ? filmId : null);
  const list = useFilmList(filmStudio && !filmId);

  const film = load.state === "ready" ? load.film : null;
  const title = film?.view.film.title ?? c.timeline;
  const n = film?.view.scenes.length ?? 0;
  const sub = film ? `${n === 1 ? c.sceneCountOne : c.sceneCount.replace("{n}", String(n))} · ${film.view.film.aspect}` : c.label;
  const bar = <ProjectBar filmStudio={filmStudio} inline={!slot} view="timeline" title={title} sub={sub} />;
  const barEl = slot ? createPortal(bar, slot) : bar;

  let body: ReactNode;
  if (!filmStudio) body = <Empty title={c.closed} body={c.closedBody} testid="timeline-closed" />;
  else if (!filmId) body = <Picker load={list.load} onRetry={() => void list.reload()} />;
  else if (load.state === "loading") body = <p className="cv-loading" role="status">{c.loading}</p>;
  else if (load.state === "missing") body = <Empty title={c.missing} body={c.missingBody} testid="timeline-missing" />;
  else if (load.state === "expired") body = <Empty title={c.sessionExpired} testid="timeline-expired" />;
  else if (load.state === "error") body = <Empty title={c.readFailed} testid="timeline-error" action={<button type="button" className="cv-kbtn" onClick={() => void reload()}>{c.retry}</button>} />;
  else body = <Editor film={load.film} stale={stale} onSaved={replace} onReload={() => void reload()} actors={actors} />;

  return (
    <div className="cv-root tl-root" data-studio-canvas="" data-studio-timeline="">
      {barEl}
      {body}
    </div>
  );
}

function Empty({ title, body, action, testid }: { title: string; body?: string; action?: ReactNode; testid: string }) {
  return (
    <div className="tl-empty" role="status" data-testid={testid}>
      <h1>{title}</h1>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

function Picker({ load, onRetry }: { load: ReturnType<typeof useFilmList>["load"]; onRetry: () => void }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  const path = useChannelPath();
  if (load.state === "loading") return <p className="cv-loading" role="status">{c.loading}</p>;
  if (load.state === "missing") return <Empty title={c.missing} body={c.missingBody} testid="timeline-missing" />;
  if (load.state === "expired") return <Empty title={c.sessionExpired} testid="timeline-expired" />;
  if (load.state === "error") return <Empty title={c.readFailed} testid="timeline-error" action={<button type="button" className="cv-kbtn" onClick={onRetry}>{c.retry}</button>} />;
  if (load.films.length === 0)
    return <Empty title={c.pickTitle} body={c.pickEmpty} testid="timeline-pick-empty" action={<Link className="cv-kbtn" href={path("/create/projects")}>{c.pickOpen}</Link>} />;
  return (
    <div className="tl-empty" data-testid="timeline-pick">
      <h1>{c.pickTitle}</h1>
      <ul className="tl-pick">
        {load.films.map((f) => (
          <li key={f.id}>
            <Link href={path(`/studio?view=timeline&film=${f.id}`)} className="tl-pick-row">
              <b>{f.title}</b>
              <span>{fmt("{a} · {t}", { a: f.aspect, t: clock(f.targetSeconds) })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the edit page ─────────────────────────────────────────────────────────────

type Mix = Record<TrackId, { m: boolean; s: boolean; lock: boolean }>;
const MIX0: Mix = { V1: { m: false, s: false, lock: false }, A1: { m: false, s: false, lock: false }, A2: { m: false, s: false, lock: false }, A3: { m: false, s: false, lock: false }, A4: { m: false, s: false, lock: false }, C1: { m: false, s: false, lock: false } };

function Editor({ film, stale, onSaved, onReload, actors }: { film: TimelineFilm; stale: boolean; onSaved: (raw: unknown) => void; onReload: () => void; actors?: ReadonlyMap<string, TimelineActor[]> }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  const view = film.view;
  const layout = useMemo(() => layoutTimeline(film), [film]);
  const { clips, duration } = layout;

  // Every asset the page may show: chosen clips and key frames, the narration and the music.
  const assetIds = useMemo(() => {
    const ids: string[] = [];
    for (const s of view.scenes) {
      const takes = film.sceneTakes.get(s.id) ?? [];
      const clip = chosenClip(s, takes);
      const key = chosenKeyframe(s, takes);
      if (clip?.resultAssetId) ids.push(clip.resultAssetId);
      if (key?.resultAssetId) ids.push(key.resultAssetId);
    }
    const narr = narrationTake(film);
    if (narr?.resultAssetId) ids.push(narr.resultAssetId);
    if (film.musicAssetId && !film.musicMissing) ids.push(film.musicAssetId);
    return ids;
  }, [film, view.scenes]);
  const media = useMediaUrls(assetIds);

  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [mix, setMix] = useState<Mix>(MIX0);
  const [notice, setNotice] = useState<string | null>(null);
  const say = useCallback((s: string) => {
    setNotice(s);
    window.setTimeout(() => setNotice((n) => (n === s ? null : n)), 3200);
  }, []);
  const [marks, setMarks] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const pps = ZOOMS[zoom];

  const p = usePlayback({ clips, duration, film, media: media.urls, mix, onMediaError: media.refresh });

  const sel = clips.find((x) => x.id === selected) ?? null;
  const cur = sceneAt(clips, p.t);
  const vClips = clips.filter((x) => x.track === "V1");
  const curIndex = cur ? vClips.indexOf(cur) : -1;

  // Keyboard: never while typing, never with focus in the inspector (rule learned from the canvas).
  const inspectorRef = useRef<HTMLElement>(null);
  const pRef = useRef(p);
  pRef.current = p;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e.target, inspectorRef.current)) return;
      const a = keyAction(e);
      if (!a) return;
      e.preventDefault();
      const p = pRef.current;
      if (a === "toggle") p.toggle();
      else if (a === "pause") p.pause();
      else if (a === "forward") p.play();
      else if (a === "back") p.seek(p.tRef.current - 1);
      else if (a === "prevFrame") p.seek(p.tRef.current - 1 / FPS);
      else if (a === "nextFrame") p.seek(p.tRef.current + 1 / FPS);
      else if (a === "markIn") setMarks((m) => ({ ...m, in: p.tRef.current }));
      else if (a === "markOut") setMarks((m) => ({ ...m, out: p.tRef.current }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reorder: save_film with the whole ordered list (0166 checks the editor role and the version; a stale version is refused).
  const [saving, setSaving] = useState(false);
  const moveScene = useCallback(
    async (from: number, to: number) => {
      if (!view.editable || saving || from === to) return;
      const order = reorder(view.scenes, from, to);
      const saved = new Map<string, FilmScene>(view.scenes.map((s) => [s.id, s]));
      setSaving(true);
      try {
        const res = await fetch(`/api/films/${encodeURIComponent(view.film.id)}`, {
          method: "PATCH",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: view.film.version, patch: { scenes: scenesPatch(order.map(sceneToDraft), saved) } }),
        });
        const json: unknown = await res.json().catch(() => null);
        if (res.ok) {
          onSaved((json as { film?: unknown } | null)?.film);
          say(c.moved);
        } else {
          const e = filmErrorFromResponse(res.status, json);
          if (e.error === "film_changed") {
            say(c.changedElsewhere);
            onReload();
          } else say(e.detail ? `${c.moveFailed}: ${e.detail}` : c.moveFailed);
        }
      } catch {
        say(c.moveFailed);
      } finally {
        setSaving(false);
      }
    },
    [view, saving, onSaved, onReload, say, c],
  );

  // The project's two real levels (films.music_gain_db, films.duck_db, −40…0 dB), saved through save_film.
  const saveGain = useCallback(
    async (key: "music_gain_db" | "duck_db", db: number) => {
      if (!view.editable) return;
      const res = await fetch(`/api/films/${encodeURIComponent(view.film.id)}`, {
        method: "PATCH",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: view.film.version, patch: { [key]: db } }),
      }).catch(() => null);
      const json: unknown = res ? await res.json().catch(() => null) : null;
      if (res?.ok) onSaved((json as { film?: unknown } | null)?.film);
      else {
        if (res && filmErrorFromResponse(res.status, json).error === "film_changed") onReload();
        say(c.moveFailed);
      }
    },
    [view, onSaved, onReload, say, c],
  );

  const curUrls = cur?.assetId ? media.urls.get(cur.assetId) : undefined;
  const curScene = cur?.sceneId ? view.scenes.find((s) => s.id === cur.sceneId) : undefined;
  const curThumb = curScene ? thumbOf(curScene, film, media.urls) : null;
  const caption = clips.find((x) => x.track === "C1" && cur && x.sceneId === cur.sceneId)?.label ?? null;

  const transport = (
    <div className="tl-trans" role="group" aria-label={c.viewer}>
      <button type="button" className="tl-tkey" onClick={() => p.seek(0)} aria-label={c.start} title={c.start}>
        <SkipBack aria-hidden className="size-4" />
      </button>
      <button type="button" className="tl-tkey is-play" onClick={p.toggle} aria-label={p.playing ? c.pause : c.play} aria-pressed={p.playing} data-testid="play" disabled={duration <= 0}>
        {p.playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
      </button>
      <button type="button" className="tl-tkey" onClick={() => p.setLoop(!p.loop)} aria-pressed={p.loop} aria-label={c.loop} title={c.loop}>
        <Repeat aria-hidden className="size-4" />
      </button>
      <button type="button" className="tl-tkey" onClick={() => p.seek(duration)} aria-label={c.end} title={c.end}>
        <SkipForward aria-hidden className="size-4" />
      </button>
    </div>
  );

  const soon = () => say(c.notAvailable);

  return (
    <div className="tl-page">
      <p className="sr-only" role="status" aria-live="polite">
        {notice}
      </p>
      {notice && <p className="cv-toast">{notice}</p>}
      <div className="tl-upper">
        <LibraryPanel film={film} clips={clips} media={media.urls} selected={selected} onPick={(clip) => { setSelected(clip.id); p.seek(clip.start); }} />
        <section className="tl-viewer" aria-label={c.viewer}>
          <div className="tl-screen" style={{ aspectRatio: view.film.aspect.replace(":", " / ") } as CSSProperties} data-testid="viewer">
            <video ref={p.videoRef} className="tl-video" playsInline preload="auto" hidden={!curUrls?.play} onError={() => cur?.assetId && media.refresh(cur.assetId)} />
            {/* A signed, short-lived link to the project's own file: nothing for next/image to optimise or cache. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {!curUrls?.play && curThumb && <img className="tl-still" src={curThumb} alt="" />}
            {/* A shot scene whose file cannot be shown here is said so; it is never called a draft. */}
            {!curUrls?.play && !curThumb && cur && !cur.draft && (
              <div className="tl-draftscreen is-shot" data-testid="viewer-unavailable">
                <b>{curUrls?.failed ? c.previewFailed : c.previewLoading}</b>
              </div>
            )}
            {!curUrls?.play && !curThumb && (!cur || cur.draft) && (
              <div className="tl-draftscreen" data-testid="viewer-draft">
                <b>{n0(vClips.length) ? c.noScenes : c.draftScreen}</b>
                {!n0(vClips.length) && <span>{c.draftScreenBody}</span>}
              </div>
            )}
            {cur && <span className="tl-sc">{cur.label}</span>}
            {caption && <span className="tl-cap">{caption}</span>}
          </div>
          <p className="tl-vmeta" data-testid="viewer-meta">
            <span>{timecode(p.t)}</span>
            <span>{view.film.aspect}</span>
            <span>{curIndex >= 0 ? fmt(c.sceneOf, { n: pad(curIndex + 1), m: pad(vClips.length) }) : c.noScenes}</span>
          </p>
          {transport}
        </section>
        <Inspector
          refEl={inspectorRef}
          film={film}
          clip={sel}
          onGain={saveGain}
          footer={<AssemblePanel filmId={view.film.id} orgId={view.film.orgId} version={view.film.version} editable={view.editable} status={view.film.status} onStarted={onReload} />}
        />
      </div>

      <div className="tl-trow">
        <span className="tl-tc" data-testid="timecode">{timecode(p.t)}</span>
        <div className="tl-tools" role="toolbar" aria-label={c.tools}>
          <ToolKey label={c.toolSelect} pressed onClick={() => undefined}>
            <MousePointer2 aria-hidden className="size-4" />
          </ToolKey>
          <ToolKey label={`${c.toolBlade} · ${c.notAvailable}`} soon onClick={soon}>
            <Scissors aria-hidden className="size-4" />
          </ToolKey>
          <ToolKey label={`${c.toolSnap} · ${c.notAvailable}`} soon onClick={soon}>
            <Magnet aria-hidden className="size-4" />
          </ToolKey>
          <ToolKey label={`${c.toolLink} · ${c.notAvailable}`} soon onClick={soon}>
            <Link2 aria-hidden className="size-4" />
          </ToolKey>
          <ToolKey label={`${c.toolMarker} · ${c.notAvailable}`} soon onClick={soon}>
            <Flag aria-hidden className="size-4" />
          </ToolKey>
          <ToolKey label={c.toolZoom} onClick={() => setZoom((z) => (z + 1) % ZOOMS.length)}>
            <ZoomIn aria-hidden className="size-4" />
          </ToolKey>
        </div>
        <span className="tl-chip" data-testid="planned-chip">{fmt(c.plannedChip, { t: clock(layout.planned) })}</span>
      </div>

      <div className="tl-lower">
        <div className="tl-hdrs" role="rowgroup" aria-label={c.tracks}>
          <div className="tl-hgap">{c.tracks}</div>
          {TRACKS.map((id) => (
            <div key={id} className="tl-th" style={{ "--c": TRACK_TONE[id] } as CSSProperties}>
              <span className="tl-id">{id}</span>
              <span className="tl-tn">{c.track[id]}</span>
              <span className="tl-ms" data-no-shortcuts>
                <button type="button" className={mix[id].m ? "on-m" : ""} aria-pressed={mix[id].m} aria-label={fmt(c.muteTrack, { t: c.track[id] })} title={fmt(c.muteTrack, { t: c.track[id] })} onClick={() => setMix((m) => ({ ...m, [id]: { ...m[id], m: !m[id].m } }))}>M</button>
                <button type="button" className={mix[id].s ? "on-s" : ""} aria-pressed={mix[id].s} aria-label={fmt(c.soloTrack, { t: c.track[id] })} title={fmt(c.soloTrack, { t: c.track[id] })} onClick={() => setMix((m) => ({ ...m, [id]: { ...m[id], s: !m[id].s } }))}>S</button>
                <button type="button" className={mix[id].lock ? "on-l" : ""} aria-pressed={mix[id].lock} aria-label={fmt(c.lockTrack, { t: c.track[id] })} onClick={() => setMix((m) => ({ ...m, [id]: { ...m[id], lock: !m[id].lock } }))}>
                  <Lock aria-hidden className="size-3" />
                </button>
              </span>
            </div>
          ))}
        </div>
        <Lanes
          clips={clips}
          duration={duration}
          pps={pps}
          t={p.t}
          marks={marks}
          selected={selected}
          media={media.urls}
          film={film}
          reorderable={view.editable && !mix.V1.lock && !saving}
          onSelect={setSelected}
          onSeek={p.seek}
          onMove={(from, to) => void moveScene(from, to)}
          onLocked={() => say(fmt(c.reorderLocked, { status: view.film.status }))}
          actors={actors}
        />
        <Mixer levels={p.levels} film={film} />
      </div>

      <div className="tl-phonebar">
        <span />
        {transport}
        <AssemblePanel compact filmId={view.film.id} orgId={view.film.orgId} version={view.film.version} editable={view.editable} status={view.film.status} onStarted={onReload} />
      </div>
      {stale && <span className="tl-stale" role="status">{c.readFailed}</span>}
    </div>
  );
}

/** play() is a promise in browsers and undefined in some test DOMs; a refused autoplay is not an error to show. */
function safePlay(el: HTMLMediaElement) {
  try {
    const p = el.play() as Promise<void> | undefined;
    p?.catch(() => undefined);
  } catch {
    // Not playable here.
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const n0 = (n: number) => n === 0;

function thumbOf(scene: FilmScene, film: TimelineFilm, urls: ReadonlyMap<string, MediaUrls>): string | null {
  const takes = film.sceneTakes.get(scene.id) ?? [];
  const clip = chosenClip(scene, takes);
  const key = chosenKeyframe(scene, takes);
  return (clip?.resultAssetId && urls.get(clip.resultAssetId)?.thumb) || (key?.resultAssetId && urls.get(key.resultAssetId)?.thumb) || null;
}

function ToolKey({ label, pressed, soon, onClick, children }: { label: string; pressed?: boolean; soon?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={soon ? "tl-tool is-soon" : "tl-tool"} aria-pressed={pressed} aria-disabled={soon || undefined} title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

// ── playback ─────────────────────────────────────────────────────────────────

/**
 * The preview clock. While a scene's clip plays, the clip's own currentTime drives the playhead; over a draft block (no picture) real
 * time does. Narration and music play from their own files, kept at the playhead. Meters read the real signal through an AnalyserNode
 * once the person pressed play (an AudioContext needs that gesture), and rest at zero when nothing plays.
 */
function usePlayback({ clips, duration, film, media, mix, onMediaError }: { clips: TimelineClip[]; duration: number; film: TimelineFilm; media: ReadonlyMap<string, MediaUrls>; mix: Mix; onMediaError: (id: string) => void }) {
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(false);
  loopRef.current = loop;
  const videoRef = useRef<HTMLVideoElement>(null);
  const narrEl = useRef<HTMLAudioElement | null>(null);
  const musicEl = useRef<HTMLAudioElement | null>(null);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const graph = useRef<{ ctx: AudioContext; an: Record<string, AnalyserNode> } | null>(null);

  const narr = clips.find((x) => x.track === "A1");
  const music = clips.find((x) => x.track === "A2");
  const narrUrl = narr?.assetId ? (media.get(narr.assetId)?.play ?? null) : null;
  const musicUrl = music?.assetId ? (media.get(music.assetId)?.play ?? null) : null;

  // The audio elements live outside React's tree (no markup to lay out); one each, so a MediaElementSource is made once.
  useEffect(() => {
    narrEl.current ??= new Audio();
    musicEl.current ??= new Audio();
    const a = narrEl.current;
    const m = musicEl.current;
    if (narrUrl && a.src !== new URL(narrUrl, location.href).href) a.src = narrUrl;
    if (!narrUrl) a.removeAttribute("src");
    if (musicUrl && m.src !== new URL(musicUrl, location.href).href) m.src = musicUrl;
    if (!musicUrl) m.removeAttribute("src");
    const errN = () => narr?.assetId && onMediaError(narr.assetId);
    const errM = () => music?.assetId && onMediaError(music.assetId);
    a.addEventListener("error", errN);
    m.addEventListener("error", errM);
    return () => {
      a.removeEventListener("error", errN);
      m.removeEventListener("error", errM);
    };
  }, [narrUrl, musicUrl, narr?.assetId, music?.assetId, onMediaError]);

  // What a person hears: solo wins over mute; the project's music level (films.music_gain_db) is applied to the music.
  const anySolo = TRACKS.some((id) => mix[id].s);
  const audible = (id: TrackId) => (anySolo ? mix[id].s : !mix[id].m);
  const musicVol = film.musicGainDb === null ? 1 : Math.pow(10, film.musicGainDb / 20);
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audible("V1");
    if (narrEl.current) narrEl.current.muted = !audible("A1");
    if (musicEl.current) {
      musicEl.current.muted = !audible("A2");
      musicEl.current.volume = Math.min(1, Math.max(0, musicVol));
    }
  });

  const cur = sceneAt(clips, t);
  const curUrl = cur?.assetId ? (media.get(cur.assetId)?.play ?? null) : null;

  const syncMedia = useCallback(
    (at: number, play: boolean) => {
      const v = videoRef.current;
      const scene = sceneAt(clips, at);
      const url = scene?.assetId ? (media.get(scene.assetId)?.play ?? null) : null;
      if (v) {
        if (url) {
          const abs = new URL(url, location.href).href;
          if (v.src !== abs) v.src = url;
          const local = Math.max(0, at - (scene?.start ?? 0));
          if (Math.abs(v.currentTime - local) > 0.25) {
            try {
              v.currentTime = local;
            } catch {
              // Not seekable yet; the clock goes on by real time until it is.
            }
          }
          if (play) safePlay(v);
          else v.pause();
        } else {
          v.pause();
        }
      }
      for (const [el, clip] of [
        [narrEl.current, narr],
        [musicEl.current, music],
      ] as const) {
        if (!el || !el.src || !clip) continue;
        const local = at - clip.start;
        if (local < 0 || local >= clip.length) {
          el.pause();
          continue;
        }
        if (Math.abs(el.currentTime - local) > 0.3) {
          try {
            el.currentTime = local;
          } catch {
            /* not seekable yet */
          }
        }
        if (play) safePlay(el);
        else el.pause();
      }
    },
    [clips, media, narr, music],
  );

  const ensureGraph = useCallback(() => {
    if (graph.current || typeof window === "undefined") return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      const main = ctx.createAnalyser();
      main.fftSize = 512;
      main.connect(ctx.destination);
      const an: Record<string, AnalyserNode> = { main };
      const wire = (el: HTMLMediaElement | null, id: TrackId) => {
        if (!el) return;
        const node = ctx.createAnalyser();
        node.fftSize = 512;
        ctx.createMediaElementSource(el).connect(node);
        node.connect(main);
        an[id] = node;
      };
      wire(videoRef.current, "V1");
      wire(narrEl.current, "A1");
      wire(musicEl.current, "A2");
      graph.current = { ctx, an };
    } catch {
      // No metering in this browser: the meters stay at rest, the preview still plays.
    }
  }, []);

  const seek = useCallback(
    (to: number) => {
      const at = Math.min(Math.max(0, to), Math.max(0, duration));
      tRef.current = at;
      setT(at);
      syncMedia(at, playingRef.current);
    },
    [duration, syncMedia],
  );

  const play = useCallback(() => {
    if (duration <= 0) return;
    ensureGraph();
    void graph.current?.ctx.resume().catch(() => undefined);
    if (tRef.current >= duration) tRef.current = 0;
    playingRef.current = true;
    setPlaying(true);
    syncMedia(tRef.current, true);
  }, [duration, ensureGraph, syncMedia]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    syncMedia(tRef.current, false);
  }, [syncMedia]);

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [play, pause]);

  // The clock.
  const sceneKey = useRef<string | null>(null);
  useEffect(() => {
    if (!playing) {
      setLevels({});
      return;
    }
    let raf = 0;
    let last = performance.now();
    const buf = new Uint8Array(512);
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const scene = sceneAt(clips, tRef.current);
      const v = videoRef.current;
      let next = tRef.current + dt;
      if (scene?.assetId && v && !v.paused && v.readyState >= 2 && v.src) {
        next = Math.min(scene.start + v.currentTime, scene.start + scene.length);
        if (v.ended || v.currentTime >= scene.length - 0.02) next = scene.start + scene.length;
      }
      if (next >= duration) {
        if (loopRef.current) next = 0;
        else {
          tRef.current = duration;
          setT(duration);
          pause();
          return;
        }
      }
      tRef.current = next;
      setT(next);
      const nowScene = sceneAt(clips, next);
      if ((nowScene?.id ?? null) !== sceneKey.current) {
        sceneKey.current = nowScene?.id ?? null;
        syncMedia(next, true);
      }
      const g = graph.current;
      if (g) {
        const out: Record<string, number> = {};
        for (const [k, node] of Object.entries(g.an)) {
          node.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const x = (buf[i] - 128) / 128;
            sum += x * x;
          }
          out[k] = Math.min(1, Math.sqrt(sum / buf.length) * 2.2);
        }
        setLevels(out);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, clips, duration, pause, syncMedia]);

  // A newly signed link for the scene under the playhead: load it at the playhead.
  useEffect(() => {
    syncMedia(tRef.current, playingRef.current);
  }, [curUrl, narrUrl, musicUrl, syncMedia]);

  useEffect(
    () => () => {
      narrEl.current?.pause();
      musicEl.current?.pause();
      void graph.current?.ctx.close().catch(() => undefined);
    },
    [],
  );

  return { t, tRef, playing, loop, setLoop, play, pause, toggle, seek, videoRef, levels };
}

// ── library ──────────────────────────────────────────────────────────────────

function LibraryPanel({ film, clips, media, selected, onPick }: { film: TimelineFilm; clips: TimelineClip[]; media: ReadonlyMap<string, MediaUrls>; selected: string | null; onPick: (c: TimelineClip) => void }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  const [tab, setTab] = useState<"library" | "effects" | "sound">("library");
  const [q, setQ] = useState("");
  const [byName, setByName] = useState(false);
  const words = q.trim().toLowerCase();
  const match = (s: string) => !words || s.toLowerCase().includes(words);
  const v1 = clips.filter((x) => x.track === "V1" && match(x.label));
  if (byName) v1.sort((a, b) => a.label.localeCompare(b.label));
  const narr = clips.find((x) => x.track === "A1");
  const music = clips.find((x) => x.track === "A2");
  const scenes = new Map(film.view.scenes.map((s) => [s.id, s]));

  return (
    <aside className="tl-lib" aria-label={c.tabLibrary}>
      <div className="tl-tabs" role="tablist">
        {(["library", "effects", "sound"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === "library" ? c.tabLibrary : k === "effects" ? c.tabEffects : c.tabSound}
          </button>
        ))}
      </div>
      {tab === "library" ? (
        <>
          <div className="tl-libtools">
            <label className="tl-search">
              <Search aria-hidden className="size-4" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={c.search} aria-label={c.search} />
            </label>
            <button type="button" className="cv-kbtn tl-sq" aria-pressed={byName} onClick={() => setByName((b) => !b)} aria-label={`${c.sort}: ${byName ? c.sortName : c.sortOrder}`} title={byName ? c.sortName : c.sortOrder}>
              <ArrowDownUp aria-hidden className="size-4" />
            </button>
          </div>
          <ul className="tl-liblist">
            <li className="tl-gh">{c.groupClips}</li>
            {v1.length === 0 && <li className="tl-libnone">{c.noMatches}</li>}
            {v1.map((x) => {
              const s = x.sceneId ? scenes.get(x.sceneId) : undefined;
              const thumb = s ? thumbOf(s, film, media) : null;
              const take = s ? chosenClip(s, film.sceneTakes.get(s.id) ?? []) : null;
              return (
                <li key={x.id}>
                  <button type="button" className="tl-libitem" aria-current={selected === x.id || undefined} onClick={() => onPick(x)} style={{ "--c": "var(--t-video)" } as CSSProperties}>
                    <span className={x.draft ? "tl-lth is-draft" : "tl-lth"}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {thumb && <img src={thumb} alt="" />}
                    </span>
                    <span className="tl-lnm">
                      <b>{x.label}</b>
                      <small>{x.draft ? fmt(c.draftKind, { s: clock(x.length) }) : fmt(c.clipKind, { v: take?.version ?? "" })}</small>
                    </span>
                    <span className="tl-ldu">{clock(x.length)}</span>
                  </button>
                </li>
              );
            })}
            <li className="tl-gh">{c.groupVoice}</li>
            {narr ? (
              <li>
                <button type="button" className="tl-libitem" onClick={() => onPick(narr)} style={{ "--c": "var(--t-narr)" } as CSSProperties}>
                  <span className="tl-lth" />
                  <span className="tl-lnm"><b>{c.track.A1}</b><small>{c.narrationKind}</small></span>
                  <span className="tl-ldu">{narr.measured ? clock(narr.length) : ""}</span>
                </button>
              </li>
            ) : (
              <li className="tl-libnone" data-testid="lib-no-voice">{c.noVoice}</li>
            )}
            <li className="tl-gh">{c.groupMusic}</li>
            {music ? (
              <li>
                <button type="button" className="tl-libitem" onClick={() => onPick(music)} style={{ "--c": "var(--t-music)" } as CSSProperties}>
                  <span className="tl-lth" />
                  <span className="tl-lnm"><b>{c.track.A2}</b><small>{c.musicKind}</small></span>
                  <span className="tl-ldu" />
                </button>
              </li>
            ) : (
              <li className="tl-libnone">{film.musicMissing ? c.musicMissing : c.noMusic}</li>
            )}
            <li className="tl-gh">{c.groupEffects}</li>
            <li className="tl-libnone">{c.effectsSoon}</li>
          </ul>
        </>
      ) : (
        <div className="tl-libsoon" data-testid="lib-effects-soon">
          <b>{c.effectsSoon}</b>
          <p>{c.effectsSoonBody}</p>
        </div>
      )}
    </aside>
  );
}

// ── inspector ────────────────────────────────────────────────────────────────

function Inspector({ refEl, film, clip, onGain, footer }: { refEl: React.RefObject<HTMLElement | null>; film: TimelineFilm; clip: TimelineClip | null; onGain: (k: "music_gain_db" | "duck_db", db: number) => void; footer: ReactNode }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  const [tab, setTab] = useState<"video" | "audio" | "effects">("audio");
  const scene = clip?.sceneId ? film.view.scenes.find((s) => s.id === clip.sceneId) : undefined;
  const take = scene ? chosenClip(scene, film.sceneTakes.get(scene.id) ?? []) : null;
  const music = clip?.track === "A2";
  const editable = film.view.editable;
  const db = (v: number | null) => (v === null ? c.notSet : fmt(c.db, { n: v.toFixed(1) }));

  return (
    <section className="tl-insp" aria-label={c.inspector} ref={refEl} data-testid="inspector">
      <div className="tl-ih">
        <span className="tl-ik">{clip ? (clip.track === "V1" ? c.sceneClip : `${c.track[clip.track]} · ${clip.track}`) : c.inspector}</span>
        <h2>{clip ? clip.label || c.track[clip.track] : c.nothingSelected}</h2>
        <div className="tl-tabs" role="tablist">
          {(["video", "audio", "effects"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {k === "video" ? c.tabVideo : k === "audio" ? c.tabAudio : c.tabEffectsInsp}
            </button>
          ))}
        </div>
      </div>
      <div className="tl-ib">
        {tab === "video" && (
          <dl className="tl-facts">
            <dt>{c.planned}</dt>
            <dd>{scene ? clock(scene.plannedSeconds) : "—"}</dd>
            <dt>{c.measured}</dt>
            <dd>{clip?.measured ? clock(clip.length) : c.unknown}</dd>
            <dt>{c.take}</dt>
            <dd>{take ? `v${take.version}` : c.noTake}</dd>
            <dt>{c.status}</dt>
            <dd>{scene?.status ?? c.unknown}</dd>
          </dl>
        )}
        {tab === "audio" && (
          <>
            {music ? (
              <Slider label={c.level} value={film.musicGainDb} shown={db(film.musicGainDb)} disabled={!editable} onCommit={(v) => onGain("music_gain_db", v)} testid="music-level" />
            ) : (
              <Slider label={c.level} value={null} shown={c.notAvailable} disabled testid="clip-level" />
            )}
            <Slider label={c.fadeIn} value={null} shown={c.notAvailable} disabled />
            <Slider label={c.fadeOut} value={null} shown={c.notAvailable} disabled />
            <Toggle label={c.mute} note={c.notAvailable} />
            {music ? (
              <Slider label={c.duck} value={film.duckDb} shown={db(film.duckDb)} disabled={!editable} onCommit={(v) => onGain("duck_db", v)} testid="duck-level" />
            ) : (
              <Toggle label={c.duck} note={c.notAvailable} />
            )}
            {!music && <p className="tl-insp-note">{c.perClipNote}</p>}
          </>
        )}
        {tab === "effects" && <p className="tl-insp-note">{c.effectsNote}</p>}
      </div>
      <div className="tl-if">{footer}</div>
    </section>
  );
}

function Slider({ label, value, shown, disabled, onCommit, testid }: { label: string; value: number | null; shown: string; disabled?: boolean; onCommit?: (v: number) => void; testid?: string }) {
  const [v, setV] = useState<number | null>(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className={disabled ? "tl-row is-off" : "tl-row"} data-testid={testid}>
      <span>{label}</span>
      <output>{shown}</output>
      <input
        type="range"
        min={-40}
        max={0}
        step={0.5}
        value={v ?? -40}
        disabled={disabled}
        aria-valuetext={shown}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== null && v !== value && onCommit?.(v)}
        onKeyUp={() => v !== null && v !== value && onCommit?.(v)}
      />
    </label>
  );
}

function Toggle({ label, note }: { label: string; note: string }) {
  return (
    <div className="tl-tog is-off" aria-disabled="true">
      <span>
        {label}
        <small>{note}</small>
      </span>
      <span className="tl-sw" aria-hidden />
    </div>
  );
}

// ── lanes ────────────────────────────────────────────────────────────────────

function Lanes({
  clips,
  duration,
  pps,
  t,
  marks,
  selected,
  media,
  film,
  reorderable,
  onSelect,
  onSeek,
  onMove,
  onLocked,
  actors,
}: {
  clips: TimelineClip[];
  duration: number;
  pps: number;
  t: number;
  marks: { in: number | null; out: number | null };
  selected: string | null;
  media: ReadonlyMap<string, MediaUrls>;
  film: TimelineFilm;
  reorderable: boolean;
  onSelect: (id: string) => void;
  onSeek: (t: number) => void;
  onMove: (from: number, to: number) => void;
  onLocked: () => void;
  actors?: ReadonlyMap<string, TimelineActor[]>;
}) {
  const { t: tr, fmt } = useI18n();
  const c = tr.studioTimeline;
  const width = Math.max(duration * pps + 120, 600);
  // Keep both ARIA values on the same displayed frame, so sub-frame pointer
  // changes cannot repeat an unchanged timecode to assistive technology.
  const [h, m, s, f] = timecode(t).split(":").map(Number);
  const spokenPosition = fmt(c.scrubPosition, { h, m, s, f });
  const framePosition = h * 3600 + m * 60 + s + f / FPS;
  const scroller = useRef<HTMLDivElement>(null);
  const tickEvery = pps >= 36 ? 1 : pps >= 14 ? 5 : 10;
  const ticks: number[] = [];
  for (let s = 0; s <= duration + tickEvery; s += tickEvery) ticks.push(s);

  const timeAt = (clientX: number) => {
    const el = scroller.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return (clientX - r.left + el.scrollLeft - 8) / pps;
  };
  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(timeAt(e.clientX));
  };

  // V1 drag to reorder: a press that moves more than 4 px is a drag; on release the block lands before the block whose middle it passed.
  const [drag, setDrag] = useState<{ id: string; from: number; x0: number; dx: number } | null>(null);
  const v1 = clips.filter((x) => x.track === "V1");
  const dropIndex = (d: { from: number; dx: number }) => {
    const moved = v1[d.from];
    const centre = moved.start * pps + (moved.length * pps) / 2 + d.dx;
    let to = 0;
    v1.forEach((x, i) => {
      if (i !== d.from && centre > x.start * pps + (x.length * pps) / 2) to = i < d.from ? i + 1 : i;
    });
    return Math.min(Math.max(0, to), v1.length - 1);
  };

  const narrUrl = (() => {
    const a = clips.find((x) => x.track === "A1");
    return a?.assetId ? (media.get(a.assetId)?.play ?? null) : null;
  })();
  const musicUrl = (() => {
    const a = clips.find((x) => x.track === "A2");
    return a?.assetId ? (media.get(a.assetId)?.play ?? null) : null;
  })();
  const narrPeaks = usePeaks(narrUrl);
  const musicPeaks = usePeaks(musicUrl);
  const scenes = new Map(film.view.scenes.map((s) => [s.id, s]));

  return (
    <div className="tl-lanes" ref={scroller} data-testid="lanes">
      <div className="tl-lanes-in" style={{ width }}>
        <div className="tl-ruler" onPointerDown={scrub} onPointerMove={(e) => e.buttons === 1 && onSeek(timeAt(e.clientX))} role="slider" aria-label={c.ruler} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={framePosition} aria-valuetext={spokenPosition} tabIndex={-1}>
          {ticks.map((s) => (
            <span key={s} className="tl-tick" style={{ left: 8 + s * pps }}>
              <i>{clock(s)}</i>
            </span>
          ))}
          {marks.in !== null && <span className="tl-marker is-in" style={{ left: 8 + marks.in * pps }} title={c.markIn} />}
          {marks.out !== null && <span className="tl-marker is-out" style={{ left: 8 + marks.out * pps }} title={c.markOut} />}
        </div>
        {TRACKS.map((id) => {
          const lane = clips.filter((x) => x.track === id);
          const empty = lane.length === 0 && id !== "V1" ? c.laneEmpty[id as Exclude<TrackId, "V1">] : null;
          return (
            <div key={id} className="tl-lane" data-track={id} data-testid={`lane-${id}`} data-backend={TRACK_BACKEND[id]} style={{ "--c": TRACK_TONE[id] } as CSSProperties}>
              {empty && (
                <span className="tl-lane-empty" data-testid={`lane-empty-${id}`}>
                  {empty}
                </span>
              )}
              {lane.map((x, i) => {
                const dragging = drag?.id === x.id;
                const s = x.sceneId ? scenes.get(x.sceneId) : undefined;
                const thumb = id === "V1" && s ? thumbOf(s, film, media) : null;
                const who = actors?.get(x.id) ?? [];
                const cls = ["tl-clip", `is-${id.toLowerCase()}`, x.draft ? "is-draft" : "", selected === x.id ? "is-sel" : "", dragging ? "is-drag" : "", who.length ? "has-actor" : ""].filter(Boolean).join(" ");
                const style = {
                  left: 8 + x.start * pps,
                  width: Math.max(id === "A3" || id === "A4" ? 56 : 6, x.length * pps - 2),
                  transform: dragging ? `translateX(${drag.dx}px)` : undefined,
                  "--actor": who[0]?.color,
                } as CSSProperties;
                return (
                  <div
                    key={x.id}
                    className={cls}
                    style={style}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === x.id}
                    aria-label={x.draft ? `${x.label} · ${c.draftBlock}` : x.label || c.track[id]}
                    data-testid={`clip-${x.id}`}
                    data-draft={x.draft ? "" : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSelect(x.id);
                    }}
                    onPointerDown={(e) => {
                      onSelect(x.id);
                      if (id === "V1") {
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                        setDrag({ id: x.id, from: i, x0: e.clientX, dx: 0 });
                      }
                    }}
                    onPointerMove={(e) => {
                      if (drag?.id === x.id) setDrag({ ...drag, dx: e.clientX - drag.x0 });
                    }}
                    onPointerUp={() => {
                      if (drag?.id !== x.id) return;
                      const d = drag;
                      setDrag(null);
                      if (Math.abs(d.dx) <= 4) return;
                      if (!reorderable) {
                        onLocked();
                        return;
                      }
                      const to = dropIndex(d);
                      if (to !== d.from) onMove(d.from, to);
                    }}
                    onPointerCancel={() => setDrag(null)}
                  >
                    {id === "V1" && !x.draft && <span className="tl-thumbs" style={thumb ? ({ backgroundImage: `url("${thumb}")` } as CSSProperties) : undefined} />}
                    {(id === "A1" || id === "A2") && <Wave peaks={id === "A1" ? narrPeaks : musicPeaks} />}
                    <span className="tl-lb">{x.label || c.track[id]}</span>
                    {x.draft && <span className="tl-dur">{clock(x.length)}</span>}
                    {who.map((a) => (
                      <span key={a.id} className="tl-actor" style={{ background: a.color }}>
                        {a.doing ? `${a.name} · ${a.doing}` : a.name}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
        <div className="tl-playhead" style={{ left: 8 + t * pps }} aria-label={c.playhead} />
      </div>
    </div>
  );
}

/** The decoded file's own peaks, mirrored; nothing at all until they are known. */
function Wave({ peaks }: { peaks: number[] | null }) {
  if (!peaks || peaks.length === 0) return null;
  const n = peaks.length;
  const top = peaks.map((p, i) => `${(i / (n - 1)) * 100},${50 - p * 48}`).join(" L");
  const bottom = [...peaks].reverse().map((p, i) => `${((n - 1 - i) / (n - 1)) * 100},${50 + p * 48}`).join(" L");
  return (
    <svg className="tl-wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <path d={`M${top} L${bottom} Z`} />
    </svg>
  );
}

// ── mixer ────────────────────────────────────────────────────────────────────

function Mixer({ levels, film }: { levels: Record<string, number>; film: TimelineFilm }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  const db = (v: number | null) => (v === null ? c.notSet : fmt(c.db, { n: v.toFixed(1) }));
  return (
    <aside className="tl-mix" aria-label={c.mixer}>
      <div className="tl-mh">{c.mixer}</div>
      <div className="tl-strips">
        {METERED.map((k) => (
          <div key={k} className={k === "main" ? "tl-strip is-main" : "tl-strip"} data-testid={`meter-${k}`}>
            <span className="tl-meter">
              <i style={{ height: `${Math.round((levels[k] ?? 0) * 100)}%` }} data-level={levels[k] ?? 0} />
            </span>
            <span className="tl-sl">{k === "main" ? c.main : k}</span>
          </div>
        ))}
      </div>
      <dl className="tl-gains">
        <dt>{c.musicGain}</dt>
        <dd data-testid="mix-music-gain">{db(film.musicGainDb)}</dd>
        <dt>{c.duckGain}</dt>
        <dd>{db(film.duckDb)}</dd>
      </dl>
    </aside>
  );
}
