"use client";

/**
 * The canvas's timeline lane: under the dock, a reading of the wired chains above as a video track and a voice track
 * (lib/studio/lane.ts decides what is on it and in what order). Wire a clip card into a chain and its segment lands here; take the
 * wire away and it goes. A press on a segment finds its card on the canvas.
 *
 * What it never does: play, render, assemble, export or spend (CLAUDE.md rule 3); there is no key here that could. It never draws
 * a guess as a reading (rule 5): a length is the file's measured one, or the job's requested one marked "~", or "?" on a hatched
 * segment drawn at a default width; the ruler stops labelling times past the first unknown length; a segment's picture is the
 * node's real result or none.
 */
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, ChevronDown, Film } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { KIND_SPEC, type CanvasNode, type CanvasState } from "@/lib/studio/canvas";
import { laneOf, laneTotal, placeTrack, segmentLength, type LaneLength, type LaneTrack } from "@/lib/studio/lane";
import { timecode } from "@/lib/studio/timeline";
import { formatTimecode } from "@/components/ui/Timecode";
import { KIND_ICONS, statusLine } from "./parts";
import { LAMP, nodeAsset, resultView, type JobReading, type NodeStatus } from "./nodeState";

/** Open or closed, per browser (not per canvas: it is how a person likes the page, not part of the work). */
export const LANE_OPEN_KEY = "ns.studio.canvas.lane";
const PX_PER_S = 28;
const PX_PER_S_PHONE = 18;
/** A label on the ruler every this many seconds; a tick every second. */
const LABEL_EVERY = 5;
const THUMB_MIN_W = 104;

type Previews = ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;

function readOpen(fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(LANE_OPEN_KEY);
    return v === "open" ? true : v === "closed" ? false : fallback;
  } catch {
    return fallback;
  }
}
function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(LANE_OPEN_KEY, open ? "open" : "closed");
  } catch {
    /* a private window: the lane still opens and closes, it is just not remembered */
  }
}
/** Scroll the lane sideways; an element without scrollTo (an old engine, a test DOM) just jumps. */
function scrollLane(box: HTMLElement, left: number) {
  const to = Math.max(0, left - 48);
  if (typeof box.scrollTo === "function") box.scrollTo({ left: to, behavior: reducedMotion() ? "auto" : "smooth" });
  else box.scrollLeft = to;
}
const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Seg = {
  node: CanvasNode;
  track: LaneTrack;
  index: number;
  name: string;
  status: NodeStatus;
  statusWords: string;
  length: LaneLength;
  thumb: string | null;
  made: boolean;
};

type Flight = { id: string; name: string; track: LaneTrack; fx: number; fy: number; tx: number; ty: number };

export function CanvasLane({
  canvas,
  statusOf,
  nodeName,
  jobs,
  previews,
  measured,
  selected,
  onPick,
  resultPending,
  phone = false,
}: {
  canvas: CanvasState;
  statusOf: (n: CanvasNode) => NodeStatus;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: Previews;
  /** The media worker's measured length of each library file it has read (seconds), by asset id. */
  measured: ReadonlyMap<string, number | null>;
  selected: string | null;
  onPick: (id: string) => void;
  resultPending: (assetId: string) => boolean;
  /** The phone's compact strip: closed until opened (the flow above is the work there). */
  phone?: boolean;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const l = c.lane;
  const [open, setOpen] = useState(!phone);
  useEffect(() => setOpen(readOpen(!phone)), [phone]);
  const toggle = () =>
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });

  const lane = useMemo(() => laneOf(canvas), [canvas]);
  const segs = useMemo(() => {
    const read = (track: LaneTrack, list: readonly CanvasNode[]): Seg[] =>
      list.map((node, i) => {
        const status = statusOf(node);
        const reading = node.jobId ? jobs.get(node.jobId) : undefined;
        const job = reading?.state === "ok" ? reading.job : null;
        const asset = nodeAsset(node, jobs);
        const rv = resultView(node, status, jobs, previews, resultPending);
        const thumb = track === "video" && asset && (rv === "shown" || node.kind === "asset") ? previews.get(asset)?.thumbUrl ?? null : null;
        const accepts = KIND_SPEC[node.kind].accepts.map((k) => c.ports[k]).join(" / ");
        const statusWords = rv === "missing" ? c.node.resultMissing : rv === "loading" ? c.node.resultLoading : statusLine(t, status, job, accepts);
        return {
          node,
          track,
          index: i + 1,
          name: nodeName(node),
          status,
          statusWords,
          length: segmentLength({ measured: asset ? measured.get(asset) : null, requested: job?.params?.duration_s, failed: status === "failed", track }),
          thumb,
          // Solid only for what exists: a finished job's file or a library file. Everything else is a plan (dashed).
          made: status === "done" || status === "asset",
        };
      });
    return { video: read("video", lane.video), audio: read("audio", lane.audio) };
  }, [lane, statusOf, jobs, previews, resultPending, measured, nodeName, c, t]);

  const pxPerS = phone ? PX_PER_S_PHONE : PX_PER_S;
  const vPlace = placeTrack(segs.video.map((s) => s.length), pxPerS);
  const aPlace = placeTrack(segs.audio.map((s) => s.length), pxPerS);
  const end = Math.max(vPlace.end, aPlace.end);
  const timedUntil = Math.min(vPlace.timedUntil, aPlace.timedUntil);
  const vTotal = laneTotal(segs.video.map((s) => s.length));
  const aTotal = laneTotal(segs.audio.map((s) => s.length));
  // The two tracks run side by side from 0: the known length is the longer one; unknowns are counted, never summed in.
  const total = { seconds: Math.max(vTotal.seconds, aTotal.seconds), requested: vTotal.requested || aTotal.requested, unknown: vTotal.unknown + aTotal.unknown };
  const empty = segs.video.length === 0 && segs.audio.length === 0;
  const innerW = Math.ceil(end) + 160;
  const rulerSpan = Math.max(innerW, 2400);

  // ── a segment just added: it grows in, and a tag with the card's name flies from the card to it ──
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [flights, setFlights] = useState<Flight[]>([]);
  const laneIds = [...segs.video, ...segs.audio].map((s) => s.node.id).join(",");
  const segsRef = useRef(segs);
  segsRef.current = segs;
  useLayoutEffect(() => {
    const now = new Set(laneIds ? laneIds.split(",") : []);
    // The first reading is what was already there: nothing animates on opening the page.
    if (seen.current === null) {
      seen.current = now;
      return;
    }
    const added = [...now].filter((id) => !seen.current!.has(id));
    seen.current = now;
    if (added.length === 0) return;
    setFresh(new Set(added));
    const clear = window.setTimeout(() => setFresh(new Set()), 1400);
    const box = scroller.current;
    const pill = box ? Array.from(box.querySelectorAll<HTMLElement>("[data-lane-seg]")).find((el) => el.dataset.laneSeg === added[added.length - 1]) : undefined;
    // A segment landing past the visible end is brought into view, so the person sees where it went.
    if (box && pill) {
      const left = pill.offsetLeft;
      if (left < box.scrollLeft || left + pill.offsetWidth > box.scrollLeft + box.clientWidth) {
        scrollLane(box, left);
      }
    }
    let frame = 0;
    if (!reducedMotion() && box) {
      frame = requestAnimationFrame(() => {
        const all = [...segsRef.current.video, ...segsRef.current.audio];
        const next: Flight[] = [];
        for (const id of added.slice(0, 3)) {
          const seg = all.find((s) => s.node.id === id);
          const to = Array.from(box.querySelectorAll<HTMLElement>("[data-lane-seg]")).find((el) => el.dataset.laneSeg === id)?.getBoundingClientRect();
          if (!seg || !to || to.width === 0) continue;
          const card = Array.from(document.querySelectorAll<HTMLElement>("[data-node-id]")).find((el) => el.dataset.nodeId === id)?.getBoundingClientRect();
          const visible = card && card.bottom > 0 && card.top < window.innerHeight && card.right > 0 && card.left < window.innerWidth;
          const from = visible ? { x: card.right - 24, y: card.top + 12 } : { x: to.left + 8, y: to.top - 56 };
          next.push({ id, name: seg.name, track: seg.track, fx: from.x, fy: from.y, tx: to.left + 6, ty: to.top - 22 });
        }
        if (next.length) setFlights((f) => [...f, ...next]);
      });
    }
    return () => {
      window.clearTimeout(clear);
      cancelAnimationFrame(frame);
    };
  }, [laneIds]);

  // The card selected on the canvas is kept in view on the lane.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !selected || !open) return;
    const pill = Array.from(box.querySelectorAll<HTMLElement>("[data-lane-seg]")).find((el) => el.dataset.laneSeg === selected);
    if (!pill) return;
    if (pill.offsetLeft < box.scrollLeft || pill.offsetLeft + pill.offsetWidth > box.scrollLeft + box.clientWidth) {
      scrollLane(box, pill.offsetLeft);
    }
  }, [selected, open]);

  const [portal, setPortal] = useState(false);
  useEffect(() => setPortal(true), []);

  const lengthText = (len: LaneLength) => (!len ? "?" : `${len.basis === "requested" ? "~" : ""}${formatTimecode(len.seconds, "duration")}`);
  const lengthWords = (len: LaneLength) =>
    !len ? l.lengthUnknown : len.basis === "requested" ? fmt(l.lengthRequested, { t: formatTimecode(len.seconds, "duration") }) : formatTimecode(len.seconds, "duration");

  const pill = (s: Seg, x: number, w: number) => {
    const Icon = KIND_ICONS[s.node.kind];
    const working = s.status === "working" || s.status === "queued";
    const cls = [
      "cv-pill",
      `t-${s.track}`,
      `s-${s.status}`,
      s.made ? "is-made" : "is-plan",
      !s.length && "is-unk",
      working && "is-working",
      selected === s.node.id && "is-sel",
      fresh.has(s.node.id) && "is-new",
    ]
      .filter(Boolean)
      .join(" ");
    const label = fmt(l.seg, { n: s.index, name: s.name, status: s.statusWords, length: lengthWords(s.length) });
    const art = s.thumb && w >= THUMB_MIN_W;
    return (
      <li key={s.node.id} className="cv-pill-li" style={{ left: x, width: w }}>
        <button
          type="button"
          className={cls}
          aria-label={label}
          title={`${label}\n${fmt(l.find, { name: s.name })}`}
          aria-current={selected === s.node.id ? "true" : undefined}
          onClick={() => onPick(s.node.id)}
          data-lane-seg={s.node.id}
          data-testid={`lane-seg-${s.node.id}`}
          data-length={s.length ? s.length.basis : "unknown"}
        >
          {art ? (
            <span className="cv-pill-art" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.thumb!} alt="" draggable={false} />
            </span>
          ) : (
            <Icon aria-hidden className="cv-pill-ic" strokeWidth={2} />
          )}
          <span className="cv-pill-txt" aria-hidden>
            <span className="cv-pill-nm">{s.name}</span>
            <span className="cv-pill-meta">
              <span className={`cv-lamp is-${LAMP[s.status]}${s.status === "working" ? " is-live" : ""}`} />
              <span className="cv-pill-len">{lengthText(s.length)}</span>
              {!s.made && <span className="cv-pill-st">{s.statusWords}</span>}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const ticks: number[] = [];
  for (let s = 0; s * pxPerS <= rulerSpan; s += LABEL_EVERY) ticks.push(s);
  const looseN = lane.loose.length;
  const known = total.seconds > 0 || total.unknown === 0;

  return (
    <section
      className={`cv-lane${phone ? " is-phone" : ""}${open ? "" : " is-closed"}`}
      aria-label={l.label}
      data-testid="canvas-lane"
      data-open={open ? "true" : "false"}
      style={{ "--pxs": `${pxPerS}px` } as CSSProperties}
    >
      <div className="cv-lane-bar">
        <button type="button" className="cv-lane-tog" aria-expanded={open} aria-controls="cv-lane-body" onClick={toggle} title={open ? l.hide : l.show} data-testid="lane-toggle">
          <ChevronDown aria-hidden className="cv-lane-chev size-4" />
          <span>{l.title}</span>
        </button>
        <span className="cv-lane-tc" title={fmt(l.total, { t: formatTimecode(total.seconds, "duration") })} data-testid="lane-total">
          <span aria-hidden>
            {total.requested ? "~" : ""}
            {known ? timecode(total.seconds) : "--:--:--:--"}
          </span>
          <span className="sr-only">{fmt(l.total, { t: total.requested ? fmt(l.lengthRequested, { t: formatTimecode(total.seconds, "duration") }) : formatTimecode(total.seconds, "duration") })}</span>
        </span>
        {total.unknown > 0 && <span className="cv-lane-unk">{fmt(l.totalUnknown, { n: total.unknown })}</span>}
        <span className="cv-lane-counts">
          <span className="cv-lane-chip t-video" title={fmt(l.count, { track: l.video, n: segs.video.length })}>
            <b aria-hidden>{c.ports.letters.video}</b>
            <span aria-hidden>{segs.video.length}</span>
            <span className="sr-only">{fmt(l.count, { track: l.video, n: segs.video.length })}</span>
          </span>
          <span className="cv-lane-chip t-audio" title={fmt(l.count, { track: l.audio, n: segs.audio.length })}>
            <b aria-hidden>{c.ports.letters.audio}</b>
            <span aria-hidden>{segs.audio.length}</span>
            <span className="sr-only">{fmt(l.count, { track: l.audio, n: segs.audio.length })}</span>
          </span>
        </span>
        <span className="cv-grow" />
        {looseN > 0 && (
          <span className="cv-lane-meta is-loose" data-testid="lane-loose">
            {fmt(l.loose, { n: looseN })}
          </span>
        )}
        {open && !empty && (
          <span className="cv-lane-meta is-legend">
            {l.legendRequested} · {l.legendUnknown}
          </span>
        )}
        <span className="cv-lane-meta is-note">{l.nothingRenders}</span>
      </div>
      {open && (
        <div className="cv-lane-body" id="cv-lane-body">
          <div className="cv-lane-heads">
            <span className="cv-lane-hgap" aria-hidden />
            <TrackHead track="video" name={l.video} sub={l.videoSub} letter={c.ports.letters.video} />
            <TrackHead track="audio" name={l.audio} sub={l.audioSub} letter={c.ports.letters.audio} />
          </div>
          <div className="cv-lane-scroll" ref={scroller}>
            <div className="cv-lane-in" style={{ width: innerW }}>
              <div className="cv-ruler" aria-hidden>
                {ticks
                  .filter((s) => s * pxPerS < timedUntil)
                  .map((s) => (
                    <i key={s} style={{ left: s * pxPerS }}>
                      {formatTimecode(s, "duration")}
                    </i>
                  ))}
                {Number.isFinite(timedUntil) && <span className="cv-ruler-unk" style={{ left: timedUntil }} title={l.untimed} />}
              </div>
              {/* Where the lane starts. Nothing plays here, so it never moves. */}
              <span className="cv-lane-head" aria-hidden />
              <ol className="cv-track t-video" aria-label={l.video}>
                {segs.video.map((s, i) => pill(s, vPlace.places[i].x, vPlace.places[i].w))}
              </ol>
              <ol className="cv-track t-audio" aria-label={l.audio}>
                {segs.audio.map((s, i) => pill(s, aPlace.places[i].x, aPlace.places[i].w))}
              </ol>
              {empty && (
                <p className="cv-lane-empty" data-testid="lane-empty">
                  {l.empty}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      {portal &&
        flights.length > 0 &&
        createPortal(
          <div className="cv-tok">
            {flights.map((f) => (
              <span
                key={f.id}
                className={`cv-fly t-${f.track}`}
                aria-hidden
                style={{ "--fx": `${f.fx}px`, "--fy": `${f.fy}px`, "--tx": `${f.tx}px`, "--ty": `${f.ty}px` } as CSSProperties}
                onAnimationEnd={() => setFlights((all) => all.filter((x) => x !== f))}
              >
                {f.name}
              </span>
            ))}
          </div>,
          document.body,
        )}
    </section>
  );
}

function TrackHead({ track, name, sub, letter }: { track: LaneTrack; name: string; sub: string; letter: string }) {
  const Icon = track === "video" ? Film : AudioLines;
  return (
    <div className={`cv-th t-${track}`}>
      <span className="cv-th-badge" aria-hidden>
        <Icon className="size-3.5" strokeWidth={2.2} />
        <b>{letter}</b>
      </span>
      <span className="cv-th-txt">
        <span className="cv-th-nm">{name}</span>
        <span className="cv-th-sub">{sub}</span>
      </span>
    </div>
  );
}
