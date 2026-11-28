"use client";

/**
 * The timeline strip: a video track and a voice track drawn from rows (lib/studio/lane.ts LaneRow), whoever read them. The
 * canvas feeds it from its wired cards (CanvasLane); a live film view can feed it from its takes. It owns the look and nothing
 * else: the transport bar with the known length, the ruler, the time scale (placeTrack), the pills, the open/closed state and
 * the landing animation. It reads no table and knows no card.
 *
 * What it never does: play, render, assemble, export or spend (CLAUDE.md rule 3); its only keys are open/close and the segments.
 * It never draws a guess as a reading (rule 5): a length is measured, or requested and marked "~", or planned (a dotted edge and
 * the word "plan"), or "?" on a hatched pill at a default width; the ruler stops naming times past the first unknown length; a
 * picture is only ever the row's own `thumb`.
 *
 * `master` is one more row drawn after the tracks, at the end of the lane: the video the tracks are assembled into. It is not a
 * track (nothing is placed on a time scale), and `masterAction` is what the caller puts under it (a download once a file exists).
 * It stays on screen with the strip closed: on a phone it is the one thing a person came to see.
 *
 * A live caller can also: name the strip (`label`), hide its own total when it shows a truer one (`showTotal`), hide the 0:00
 * flag and the canvas's "nothing renders here" note (`startFlag`, `showNote`), and label pills by their tag (`pillLabel`).
 */
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AudioLines, ChevronDown, Film, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { laneTotal, placeTrack, type LaneLength, type LaneRow, type LaneTrack } from "@/lib/studio/lane";
import { timecode } from "@/lib/studio/timeline";
import { formatTimecode } from "@/components/ui/Timecode";

export type { LaneRow } from "@/lib/studio/lane";

/** Open or closed, per browser (not per canvas: it is how a person likes the page, not part of the work). */
export const LANE_OPEN_KEY = "ns.studio.canvas.lane";
const PX_PER_S = 28;
const PX_PER_S_PHONE = 18;
/** A label on the ruler every this many seconds; a tick every second. */
const LABEL_EVERY = 5;
/** A pill narrower than this shows its icon, not its picture: the name needs the room. */
const THUMB_MIN_W = 128;
/** A tagged pill narrower than this has no room for its status words beside the tag. */
const NARROW_PILL_W = 150;
/** Narrower than this a tag loses its kind (`clip-02.1` → `02.1`): the track already says it, and the number is what matters. */
const FULL_TAG_W = 100;
const TRACK_ICON: Record<LaneTrack, LucideIcon> = { video: Film, audio: AudioLines };

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === "open" ? true : v === "closed" ? false : fallback;
  } catch {
    return fallback;
  }
}
function writeOpen(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    /* a private window: the lane still opens and closes, it is just not remembered */
  }
}
const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Scroll the lane sideways; an element without scrollTo (an old engine, a test DOM) just jumps. */
function scrollLane(box: HTMLElement, left: number) {
  const to = Math.max(0, left - 48);
  if (typeof box.scrollTo === "function") box.scrollTo({ left: to, behavior: reducedMotion() ? "auto" : "smooth" });
  else box.scrollLeft = to;
}
/** The bottom of whatever is fixed or sticky at the top of the page: a card under it is not on screen for a flight to start from. */
function headerBottom(): number {
  let bottom = 0;
  for (const h of document.querySelectorAll<HTMLElement>("header")) {
    const pos = getComputedStyle(h).position;
    if (pos === "fixed" || pos === "sticky") bottom = Math.max(bottom, h.getBoundingClientRect().bottom);
  }
  return bottom;
}
/** A length on a pill: whole seconds, rounded (6.6 s is 0:07, not 0:06). */
const dur = (seconds: number) => formatTimecode(Math.round(seconds), "duration");
const pillOf = (box: HTMLElement, id: string) => Array.from(box.querySelectorAll<HTMLElement>("[data-lane-seg]")).find((el) => el.dataset.laneSeg === id);

type Flight = { key: number; tag: string; track: LaneTrack; fx: number; fy: number; tx: number; ty: number };

export function LaneStrip({
  rows,
  selected,
  onPick,
  phone = false,
  loose = 0,
  flights: fly = true,
  landedIds,
  flightFrom,
  iconFor,
  storageKey = LANE_OPEN_KEY,
  testId = "canvas-lane",
  master,
  masterAction,
  label,
  showTotal = true,
  startFlag = true,
  showNote = true,
  pillLabel = "name",
  defaultOpen,
}: {
  /** Each track's rows in the order they play. */
  rows: readonly LaneRow[];
  selected: string | null;
  onPick: (id: string) => void;
  /** The phone's compact strip: closed until opened. */
  phone?: boolean;
  /** Things that could be on the lane but are not (a card with no wire), counted in the bar so none goes missing silently. */
  loose?: number;
  /** Fly a tag to a segment that just landed (never under reduced motion). */
  flights?: boolean;
  /** The ids that just landed, when the caller knows (a live feed). Without it the strip tells a new row from an old one itself. */
  landedIds?: readonly string[];
  /** Where a landed segment's tag starts (a canvas card's box), or null to drop it in from above. */
  flightFrom?: (id: string) => DOMRect | null;
  /** A row's icon when it has no picture (default: its track's). */
  iconFor?: (row: LaneRow) => LucideIcon;
  storageKey?: string;
  testId?: string;
  /** The assembled result, drawn after the tracks (a live film's master). Its `length` is shown as the others are. */
  master?: LaneRow;
  /** Under the master: the caller's own control for an existing file (it must not start, render or spend anything). */
  masterAction?: ReactNode;
  /** The strip's accessible name (default: the canvas's). */
  label?: string;
  /** The bar's own total; a caller that shows a truer one elsewhere turns it off, so the page never shows two. */
  showTotal?: boolean;
  /** The fixed 0:00 flag where the lane starts (on a live view it could read as a playhead). */
  startFlag?: boolean;
  /** The canvas's "order only, nothing renders" note. */
  showNote?: boolean;
  /** What a pill says on its face: its name (the canvas's cards) or its tag (a live film's `clip-02.1`). The name is always in its
   *  accessible name and title. */
  pillLabel?: "name" | "tag";
  /** Open or closed until the person chooses (their stored choice wins); default: open, closed on a phone. */
  defaultOpen?: boolean;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const l = c.lane;
  const [open, setOpen] = useState(defaultOpen ?? !phone);
  useEffect(() => setOpen(readOpen(storageKey, defaultOpen ?? !phone)), [phone, storageKey, defaultOpen]);
  const toggle = () =>
    setOpen((o) => {
      writeOpen(storageKey, !o);
      return !o;
    });

  const video = rows.filter((r) => r.track === "video");
  const audio = rows.filter((r) => r.track === "audio");
  const pxPerS = phone ? PX_PER_S_PHONE : PX_PER_S;
  const vPlace = placeTrack(video.map((s) => s.length), pxPerS);
  const aPlace = placeTrack(audio.map((s) => s.length), pxPerS);
  const end = Math.max(vPlace.end, aPlace.end);
  const timedUntil = Math.min(vPlace.timedUntil, aPlace.timedUntil);
  const vTotal = laneTotal(video.map((s) => s.length));
  const aTotal = laneTotal(audio.map((s) => s.length));
  // The two tracks run side by side from 0: the known length is the longer one; unknowns are counted, never summed in.
  // "~" (requested) only when the longer track's own sum leans on a requested length.
  const longer = vTotal.seconds >= aTotal.seconds ? vTotal : aTotal;
  // A planned length is summed like a known one, so a total that leans on one says "planned", never "known".
  const longerRows = longer === vTotal ? video : audio;
  const total = {
    seconds: longer.seconds,
    requested: longer.requested,
    planned: longerRows.some((r) => r.length?.basis === "planned"),
    unknown: vTotal.unknown + aTotal.unknown,
  };
  const anyPlanned = rows.some((r) => r.length?.basis === "planned");
  const empty = rows.length === 0;
  const innerW = Math.ceil(end) + 160;
  const rulerSpan = Math.max(innerW, 2400);

  // ── a segment just landed: it grows in, and a tag with its name flies to it ──
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const flown = useRef<Set<string>>(new Set());
  const flightKey = useRef(0);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [flights, setFlights] = useState<Flight[]>([]);
  // The master lands too (it pulses: it has no place on the time scale to fly to).
  const ids = [...rows.map((r) => r.id), ...(master ? [master.id] : [])].join(",");
  const landedKey = landedIds ? landedIds.join(",") : null;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const fromRef = useRef(flightFrom);
  fromRef.current = flightFrom;
  // A frame asked for is never cancelled by a re-run (that swallowed a flight whose id was already marked flown); only unmounting
  // cancels them. The "new" mark clears on its own timer, keyed on the mark, so a re-run cannot leave it stuck.
  const frames = useRef<Set<number>>(new Set());
  useEffect(() => {
    const all = frames.current;
    return () => {
      for (const f of all) cancelAnimationFrame(f);
    };
  }, []);
  useEffect(() => {
    if (fresh.size === 0) return;
    const clear = window.setTimeout(() => setFresh(new Set()), 1400);
    return () => window.clearTimeout(clear);
  }, [fresh]);
  useLayoutEffect(() => {
    const now = new Set(ids ? ids.split(",") : []);
    let added: string[];
    if (landedKey !== null) {
      // The caller says what landed: each id is animated once while it stays in that list.
      const list = landedKey ? landedKey.split(",") : [];
      added = list.filter((id) => now.has(id) && !flown.current.has(id));
      flown.current = new Set(list);
    } else {
      // The first reading is what was already there: nothing animates on opening the page.
      if (seen.current === null) {
        seen.current = now;
        return;
      }
      const before = seen.current;
      added = [...now].filter((id) => !before.has(id));
      seen.current = now;
    }
    if (added.length === 0) return;
    setFresh(new Set(added));
    const box = scroller.current;
    const last = box ? pillOf(box, added[added.length - 1]) : undefined;
    // A segment landing past the visible end is brought into view, so the person sees where it went.
    if (box && last && (last.offsetLeft < box.scrollLeft || last.offsetLeft + last.offsetWidth > box.scrollLeft + box.clientWidth)) scrollLane(box, last.offsetLeft);
    if (fly && !reducedMotion() && box) {
      const frame = requestAnimationFrame(() => {
        frames.current.delete(frame);
        const next: Flight[] = [];
        for (const id of added.slice(0, 3)) {
          const row = rowsRef.current.find((r) => r.id === id);
          const to = pillOf(box, id)?.getBoundingClientRect();
          if (!row || !to || to.width === 0) continue;
          const card = fromRef.current?.(id) ?? null;
          // On screen means below the page's fixed header, not just inside the window.
          const visible = !!card && card.top >= headerBottom() && card.top < window.innerHeight && card.right > 0 && card.left < window.innerWidth;
          const from = visible ? { x: card!.right - 24, y: card!.top + 12 } : { x: to.left + 8, y: to.top - 56 };
          next.push({ key: ++flightKey.current, tag: row.tag, track: row.track, fx: from.x, fy: from.y, tx: to.left + 6, ty: to.top - 22 });
        }
        if (next.length) setFlights((f) => [...f, ...next]);
      });
      frames.current.add(frame);
    }
  }, [ids, landedKey, fly]);

  // The selected row is kept in view.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !selected || !open) return;
    const pill = pillOf(box, selected);
    if (pill && (pill.offsetLeft < box.scrollLeft || pill.offsetLeft + pill.offsetWidth > box.scrollLeft + box.clientWidth)) scrollLane(box, pill.offsetLeft);
  }, [selected, open]);

  const [portal, setPortal] = useState(false);
  useEffect(() => setPortal(true), []);

  const lengthText = (len: LaneLength) =>
    !len ? "?" : len.basis === "planned" ? fmt(l.lengthPlannedShort, { t: dur(len.seconds) }) : `${len.basis === "requested" ? "~" : ""}${dur(len.seconds)}`;
  const lengthWords = (len: LaneLength) =>
    !len
      ? l.lengthUnknown
      : len.basis === "requested"
        ? fmt(l.lengthRequested, { t: dur(len.seconds) })
        : len.basis === "planned"
          ? fmt(l.lengthPlanned, { t: dur(len.seconds) })
          : dur(len.seconds);

  const pill = (s: LaneRow, index: number, x: number, w: number) => {
    const Icon = iconFor?.(s) ?? TRACK_ICON[s.track];
    const cls = [
      "cv-pill",
      `t-${s.track}`,
      `s-${s.status}`,
      s.made ? "is-made" : "is-plan",
      !s.length && "is-unk",
      s.length?.basis === "planned" && "is-planned",
      s.status === "run" && "is-working",
      selected === s.id && "is-sel",
      fresh.has(s.id) && "is-new",
    ]
      .filter(Boolean)
      .join(" ");
    const label = fmt(l.seg, { n: index, name: s.name, status: s.statusWords, length: lengthWords(s.length) });
    const art = s.thumb && w >= THUMB_MIN_W;
    // A narrow tagged pill keeps the whole tag (its ".2" is what tells two shots apart) and the lamp: its icon goes, and its status
    // words move to its title and accessible name.
    const roomy = pillLabel === "name" || w >= NARROW_PILL_W;
    return (
      <li key={s.id} className="cv-pill-li" style={{ left: x, width: w }}>
        <button
          type="button"
          className={cls}
          aria-label={label}
          title={`${label}\n${fmt(l.find, { name: s.name })}`}
          aria-current={selected === s.id ? "true" : undefined}
          onClick={() => onPick(s.id)}
          data-lane-seg={s.id}
          data-testid={`lane-seg-${s.id}`}
          data-length={s.length ? s.length.basis : "unknown"}
        >
          {art ? (
            <span className="cv-pill-art" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.thumb!} alt="" draggable={false} />
            </span>
          ) : roomy ? (
            <Icon aria-hidden className="cv-pill-ic" strokeWidth={2} />
          ) : null}
          <span className="cv-pill-txt" aria-hidden>
            <span className={pillLabel === "tag" ? "cv-pill-nm is-tag" : "cv-pill-nm"}>{pillLabel === "tag" ? (w >= FULL_TAG_W ? s.tag : s.tag.slice(s.tag.indexOf("-") + 1)) : s.name}</span>
            <span className="cv-pill-meta">
              <span className={`cv-lamp is-${s.status}${s.status === "run" ? " is-live" : ""}`} />
              <span className="cv-pill-len">{lengthText(s.length)}</span>
              {!s.made && roomy && <span className="cv-pill-st">{s.statusWords}</span>}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const ticks: number[] = [];
  for (let s = 0; s * pxPerS <= rulerSpan; s += LABEL_EVERY) ticks.push(s);
  const known = total.seconds > 0 || total.unknown === 0;
  const totalWords = total.planned
    ? fmt(l.totalPlanned, { t: dur(total.seconds) })
    : total.requested
      ? fmt(l.total, { t: fmt(l.lengthRequested, { t: dur(total.seconds) }) })
      : fmt(l.total, { t: dur(total.seconds) });

  const body = (
    <div className="cv-lane-body" id={`${testId}-body`}>
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
          {startFlag ? <span className="cv-lane-head" aria-hidden /> : null}
          <ol className="cv-track t-video" aria-label={l.video}>
            {video.map((s, i) => pill(s, i + 1, vPlace.places[i].x, vPlace.places[i].w))}
          </ol>
          <ol className="cv-track t-audio" aria-label={l.audio}>
            {audio.map((s, i) => pill(s, i + 1, aPlace.places[i].x, aPlace.places[i].w))}
          </ol>
          {empty && (
            <p className="cv-lane-empty" data-testid="lane-empty">
              {l.empty}
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <section
      className={`cv-lane${phone ? " is-phone" : ""}${open ? "" : " is-closed"}`}
      aria-label={label ?? l.label}
      data-testid={testId}
      data-open={open ? "true" : "false"}
      style={{ "--pxs": `${pxPerS}px` } as CSSProperties}
    >
      <div className="cv-lane-bar">
        <button type="button" className="cv-lane-tog" aria-expanded={open} aria-controls={`${testId}-body`} onClick={toggle} title={open ? l.hide : l.show} data-testid="lane-toggle">
          <ChevronDown aria-hidden className="cv-lane-chev size-4" />
          <span>{l.title}</span>
        </button>
        {/* Nothing known at all: the words, never a 00:00 that would read as a measurement. */}
        {showTotal ? (
          <span className={!known ? "cv-lane-tc is-unknown" : empty ? "cv-lane-tc is-empty" : "cv-lane-tc"} title={known ? totalWords : undefined} data-testid="lane-total" data-planned={total.planned ? "true" : undefined}>
            {known ? (
              <>
                <span aria-hidden>
                  {total.requested ? "~" : ""}
                  {timecode(total.seconds)}
                  {total.planned ? <span className="cv-lane-plan">{l.planTag}</span> : null}
                </span>
                <span className="sr-only">{totalWords}</span>
              </>
            ) : (
              l.lengthUnknown
            )}
          </span>
        ) : null}
        {showTotal && total.unknown > 0 && <span className="cv-lane-unk">{fmt(l.totalUnknown, { n: total.unknown })}</span>}
        <span className="cv-lane-counts">
          <CountChip track="video" letter={c.ports.letters.video} words={fmt(l.count, { track: l.video, n: video.length })} n={video.length} />
          <CountChip track="audio" letter={c.ports.letters.audio} words={fmt(l.count, { track: l.audio, n: audio.length })} n={audio.length} />
        </span>
        <span className="cv-grow" />
        {loose > 0 && (
          // The count first, so a narrow bar that cuts the words never cuts the number.
          <span className="cv-lane-meta is-loose" data-testid="lane-loose">
            <b>{loose}</b> {l.loose}
          </span>
        )}
        {open && !empty && (
          <span className="cv-lane-meta is-legend">
            {l.legendRequested} · {anyPlanned ? `${l.legendPlanned} · ` : ""}
            {l.legendUnknown}
          </span>
        )}
        {showNote ? <span className="cv-lane-meta is-note">{l.nothingRenders}</span> : null}
      </div>
      {master ? (
        // The master sits beside the tracks, outside the part that opens and closes: closed, it is still on screen.
        <div className="cv-lane-row has-master">
          {open && body}
          <MasterCell
            row={master}
            selected={selected === master.id}
            fresh={fresh.has(master.id)}
            onPick={onPick}
            action={masterAction}
            label={l.master}
            length={lengthText(master.length)}
            // No position number: the master is not one of the track's segments.
            words={fmt(l.masterSeg, { name: master.name, status: master.statusWords, length: lengthWords(master.length) })}
          />
        </div>
      ) : (
        open && body
      )}
      {portal &&
        flights.length > 0 &&
        createPortal(
          <div className="cv-tok">
            {flights.map((f) => (
              <span
                key={f.key}
                className={`cv-fly t-${f.track}`}
                aria-hidden
                style={{ "--fx": `${f.fx}px`, "--fy": `${f.fy}px`, "--tx": `${f.tx}px`, "--ty": `${f.ty}px` } as CSSProperties}
                onAnimationEnd={() => setFlights((all) => all.filter((x) => x.key !== f.key))}
              >
                {f.tag}
              </span>
            ))}
          </div>,
          document.body,
        )}
    </section>
  );
}

function CountChip({ track, letter, words, n }: { track: LaneTrack; letter: string; words: string; n: number }) {
  return (
    <span className={`cv-lane-chip t-${track}`} title={words}>
      <b aria-hidden>{letter}</b>
      <span aria-hidden>{n}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}

function TrackHead({ track, name, sub, letter }: { track: LaneTrack; name: string; sub: string; letter: string }) {
  const Icon = TRACK_ICON[track];
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

/** The film the tracks become, at the end of the lane: its state in words beside the lamp, and the caller's control under it. */
function MasterCell({
  row,
  selected,
  fresh,
  onPick,
  action,
  label,
  length,
  words,
}: {
  row: LaneRow;
  selected: boolean;
  fresh: boolean;
  onPick: (id: string) => void;
  action?: ReactNode;
  label: string;
  length: string;
  words: string;
}) {
  return (
    <div className={`cv-master s-${row.status}${row.made ? " is-made" : " is-plan"}${selected ? " is-sel" : ""}${fresh ? " is-new" : ""}`} role="group" aria-label={label} data-testid="lane-master" data-status={row.status}>
      <button type="button" className="cv-master-btn" aria-label={words} aria-current={selected ? "true" : undefined} onClick={() => onPick(row.id)} data-testid={`lane-seg-${row.id}`} data-lane-master={row.id}>
        {row.thumb && row.made ? (
          <span className="cv-master-art" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={row.thumb} alt="" draggable={false} />
          </span>
        ) : (
          <Film aria-hidden className="cv-pill-ic" strokeWidth={2} />
        )}
        <span className="cv-master-txt" aria-hidden>
          <span className="cv-master-nm">{row.name}</span>
          <span className="cv-master-meta">
            <span className={`cv-lamp is-${row.status}${row.status === "run" ? " is-live" : ""}`} />
            <span className="cv-master-st">{row.statusWords}</span>
            {row.made && row.length ? <span className="cv-pill-len">{length}</span> : null}
          </span>
        </span>
      </button>
      {action ? <div className="cv-master-act">{action}</div> : null}
    </div>
  );
}
