"use client";

/**
 * The lane under a live film's board (docs/studio/S3_GAPS.md G1, G3, G5, G6): the film's clips and narration as they land, a
 * progress row above them, and the final video at the end. An adapter: liveLane (lib/studio/liveLane.ts) reads the film,
 * laneRows (lib/studio/liveLaneRows.ts) turns it into rows, and the canvas's LaneStrip draws them.
 *
 * Read-only (CLAUDE.md rule 3): a press on a piece opens its step in the view's details, "Try now" is one more GET of the same
 * read-only route, and the only other control is the existing download of a master that exists. Nothing here starts, retries,
 * renders or spends. There is no player and no playhead: nothing plays until there is a file.
 *
 * LiveView owns the page's status announcements (loading, stale, error); this lane adds only one polite line per reading that
 * made something, and none on the first reading.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { AssetDownloads } from "@/components/media/AssetDownloads";
import { LaneStrip } from "@/components/studio-canvas/LaneStrip";
import { useMediaUrls } from "@/components/studio-timeline/useTimelineData";
import { liveLane, type LiveLane as Lane } from "@/lib/studio/liveLane";
import {
  assemblyReasonText,
  filmLength,
  flightIds,
  landedSeconds,
  laneRows,
  masterCell,
  masterRow,
  type LaneRowWords,
  type MasterCell,
  type MasterWords,
} from "@/lib/studio/liveLaneRows";
import { timecode } from "@/lib/studio/timeline";
import type { LiveLoad } from "./useLiveGraph";
import { sceneNodeId } from "@/lib/studio/liveGraph";

const NO_SCENES: ReadonlyMap<string, number> = new Map();
import "./live-lane.css";

const PHONE = "(max-width: 767px)";
const NO_DURATIONS: ReadonlyMap<string, number> = new Map();
const LANE_OPEN_KEY = "ns.studio.live.lane";
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const reduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(PHONE);
    setPhone(m.matches);
    const on = () => setPhone(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return phone;
}

/**
 * The board's card a piece belongs to (liveGraph's filmGraph names them): a scene's clip, the voice, and for the master the final
 * video, or the assembly step when the assembly failed (that is where its reason and credits are). A scene's cards are keyed by
 * the scene's position (sceneNodeId), so a clip piece (`v:<film_scenes id>:<shot>`) is found through `sceneNo`, the lane's own
 * scene id to position; a scene the lane does not place has no card to name.
 */
export function nodeOfPiece(id: string, master: MasterCell | null = null, sceneNo: ReadonlyMap<string, number> = NO_SCENES): string | null {
  const v = /^v:(.+):\d+$/.exec(id);
  if (v) {
    const n = sceneNo.get(v[1]);
    return n ? sceneNodeId(n, "clip") : null;
  }
  if (id === "a:narration") return "voice";
  if (id === "m:master") return master?.state === "failed" ? "assembly" : "final";
  return null;
}

/** A card's box on the BOARD only: at list width there is no board, and a tag dropping in from above is the honest start. */
function boardCard(nodeId: string): DOMRect | null {
  const el = Array.from(document.querySelectorAll<HTMLElement>(".lv-board [data-node-id]")).find((e) => e.dataset.nodeId === nodeId);
  return el ? el.getBoundingClientRect() : null;
}

/** A pill (or the master) by its piece id, compared as data: no selector string to escape. */
function pillEl(id: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-lane-seg], [data-lane-master]")).find((e) => e.dataset.laneSeg === id || e.dataset.laneMaster === id);
}

export function LiveLane({
  load,
  planKey,
  stale,
  selected,
  onOpen,
  retry,
}: {
  load: LiveLoad;
  /** The plan on screen: a reading of another plan (one render after a switch) is not drawn. */
  planKey: string | null;
  stale: boolean;
  /** The board's selected step, and how to select one: a press on a piece opens its step. */
  selected: string | null;
  onOpen: (nodeId: string | null) => void;
  /** useLiveGraph's own "read again now" (a GET of the read-only route). */
  retry: () => void;
}) {
  const { t, locale } = useI18n();
  const c = t.studioLive;
  const w = c.lane;
  const phone = usePhone();
  const path = useChannelPath();
  const reading = load.state === "ready" && load.key === planKey ? load.film : null;

  // States and assets do not depend on lengths: one pass without them names the files to ask the library about.
  const base = useMemo(() => (reading ? liveLane(reading, NO_DURATIONS) : null), [reading]);
  const assetIds = useMemo(
    () => (base ? [...base.video, ...base.audio, ...(base.master ? [base.master] : [])].flatMap((p) => (p.assetId ? [p.assetId] : [])) : []),
    [base],
  );
  const { urls, durations } = useMediaUrls(assetIds);
  const lane = useMemo(() => (reading ? liveLane(reading, durations) : null), [reading, durations]);

  // What landed since the previous reading of this film, worked out while rendering the new reading (one commit per poll, not a
  // second one from an effect). The first reading, a refresh and a film switch fly nothing: landedSince has no previous lane, or
  // one of another film. `at` is when this reading arrived, for "last reading HH:MM".
  const [fly, setFly] = useState<{ of: Lane | null; ids: string[]; at: number | null }>({ of: null, ids: [], at: null });
  if (base && fly.of !== base) setFly({ of: base, ids: flightIds(fly.of, base), at: Date.now() });

  const failure = useCallback(
    // The live view's own failure words (LiveView's failureText, for a film step): a known word's sentence, else the code as stored.
    (code: string | null) => (code && has(c.errors, code) ? c.errors[code] : code ? fmt(c.failedGeneric, { code }) : c.failedNoCode),
    [c],
  );
  const rowWords = useMemo<LaneRowWords>(
    () => ({ clip: c.kinds.clip, shot: w.shot, voice: c.kinds.voice, master: w.master.name, state: w.state, failedWith: w.failedWith, failure, fmt }),
    [c, w, failure],
  );
  const masterWords = useMemo<MasterWords>(() => ({ ...w.master, failed: w.state.failed, failedWith: w.failedWith, fmt, assembly: w.assembly }), [w]);
  const thumbs = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const [id, u] of urls) m.set(id, u.failed || u.unavailable ? null : u.thumb);
    return m;
  }, [urls]);
  const rows = useMemo(() => (lane ? laneRows(lane, rowWords, thumbs) : []), [lane, rowWords, thumbs]);
  const master = lane ? masterRow(lane.master, masterWords, lane.master?.assetId ? (thumbs.get(lane.master.assetId) ?? null) : null) : null;
  const cell = lane ? masterCell(lane.master) : null;
  const sceneNo = useMemo(() => new Map((lane?.video ?? []).map((p) => [p.sceneId, p.scene] as const)), [lane]);

  // Opening a piece scrolls its details into view; closing them gives focus back to the pill that opened them (LiveView's own
  // close focuses the board's card first; this runs after it).
  const opened = useRef<{ pill: string; node: string } | null>(null);
  const pick = useCallback(
    (id: string) => {
      const node = nodeOfPiece(id, cell, sceneNo);
      if (!node) return;
      opened.current = { pill: id, node };
      onOpen(node);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-testid=live-details]")?.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }));
    },
    [onOpen, cell, sceneNo],
  );
  const lastSelected = useRef(selected);
  useEffect(() => {
    const was = lastSelected.current;
    lastSelected.current = selected;
    const from = opened.current;
    if (!from) return;
    if (selected === null && was === from.node) {
      opened.current = null;
      pillEl(from.pill)?.focus({ preventScroll: true });
    } else if (selected !== from.node) opened.current = null;
  }, [selected]);
  const flightFrom = useCallback(
    (id: string) => {
      const node = nodeOfPiece(id, null, sceneNo);
      return node ? boardCard(node) : null;
    },
    [sceneNo],
  );
  const selectedRow = selected ? ([...rows, ...(master ? [master] : [])].find((r) => nodeOfPiece(r.id, cell, sceneNo) === selected)?.id ?? null) : null;

  if (!reading || !lane) {
    if (load.state === "loading" || (load.state === "ready" && !reading)) {
      // LiveView announces the loading; this is only its shape, marked busy.
      return (
        <section className="ll-root" aria-label={w.heading} aria-busy="true" data-testid="live-lane">
          <div className="ll-skeleton" data-testid="live-lane-loading" aria-hidden>
            <i />
            <i />
          </div>
        </section>
      );
    }
    if (load.state === "error") {
      // LiveView says it as an alert; here only the line and a way on.
      return (
        <section className="ll-root" aria-label={w.heading} data-testid="live-lane">
          <div className="ll-error">
            <p className="ll-note" data-testid="live-lane-error">{w.error}</p>
            <button type="button" className="cv-kbtn" onClick={retry} data-testid="live-lane-retry">
              {w.tryNow}
            </button>
          </div>
        </section>
      );
    }
    // Not found, signed out, switched off: the view above says so, with its way on.
    return null;
  }

  const film = reading.film.view.film;
  const empty = reading.film.view.scenes.length === 0;
  const landed = landedSeconds(lane);
  const length = filmLength(lane);
  const status = has(w.film, film.status) ? w.film[film.status] : w.filmUnknown;
  const landedText = landed ? `${landed.basis === "requested" ? "~" : ""}${timecode(landed.seconds)}` : "?";
  const lengthText = length ? timecode(length.seconds) : "?";
  const clockWords = landed
    ? fmt(w.clock, {
        t: `${landedText}${landed.basis === "planned" ? ` (${w.planTag})` : ""}`,
        total: length ? `${lengthText}${length.basis === "planned" ? ` (${w.planTag})` : ""}` : w.totalUnknown,
      })
    : w.clockUnknown;
  const names = new Map([...rows, ...(master ? [master] : [])].map((r) => [r.id, r.name]));
  const announce = fly.of === base && fly.ids.length ? fmt(w.landedSr, { names: fly.ids.map((id) => names.get(id) ?? id).join(", ") }) : "";
  const staleAt = fly.at !== null ? new Date(fly.at).toLocaleTimeString(locale === "uz" ? "uz-Latn-UZ" : locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

  return (
    <section className={`ll-root${phone ? " is-phone" : ""}`} aria-labelledby={`live-lane-h-${film.id}`} data-testid="live-lane" data-stale={stale ? "true" : undefined}>
      <h2 className="sr-only" id={`live-lane-h-${film.id}`}>
        {w.heading}
      </h2>
      <p className="sr-only" aria-live="polite" data-testid="live-lane-announce">
        {announce}
      </p>
      <div className="ll-transport" aria-label={w.progress} data-testid="live-lane-transport">
        {empty ? null : (
          <>
            <span className="ds-t-label ll-tag">{w.madeTag}</span>
            <span className="ds-timecode ll-tc" data-testid="live-lane-clock" data-landed={landed ? landed.basis : "unknown"}>
              <span aria-hidden>
                {landedText}
                {landed?.basis === "planned" ? <span className="ll-plan">{w.planTag}</span> : null}
                <span data-part="total" className="ll-tc-total" data-testid="live-lane-total" data-basis={length ? length.basis : "unknown"}>
                  {" / "}
                  {lengthText}
                  {length?.basis === "planned" ? <span className="ll-plan">{w.planTag}</span> : null}
                </span>
              </span>
              <span className="sr-only">{clockWords}</span>
            </span>
          </>
        )}
        <span className="ll-status" data-testid="live-lane-status" data-status={film.status}>
          {status}
        </span>
        {empty ? null : (
          <span className="ll-made" data-testid="live-lane-made">
            {fmt(w.made, { n: lane.landed, m: lane.total })}
          </span>
        )}
        {stale ? (
          <span className="ll-stale" data-testid="live-lane-stale">
            {fmt(w.stale, { time: staleAt })}
          </span>
        ) : null}
        <span className="ll-grow" />
        {!phone && !empty ? <span className="ll-note">{w.noPlayhead}</span> : null}
      </div>
      {empty ? (
        <p className="ll-note ll-empty" data-testid="live-lane-empty">
          {w.empty}{" "}
          <Link href={path(`/studio?view=timeline&film=${encodeURIComponent(film.id)}`)} data-testid="live-lane-editor">
            {w.emptyLink}
          </Link>
        </p>
      ) : (
        <LaneStrip
          rows={rows}
          selected={selectedRow}
          onPick={pick}
          phone={phone}
          landedIds={fly.of === base ? fly.ids : []}
          flightFrom={flightFrom}
          storageKey={LANE_OPEN_KEY}
          testId="live-lane-strip"
          label={w.label}
          showTotal={false}
          startFlag={false}
          showNote={false}
          pillLabel="tag"
          master={master ?? undefined}
          masterAction={
            cell?.state === "ready" ? (
              <div data-testid="live-lane-download">
                <AssetDownloads assetId={cell.assetId} preview="ready" compact />
              </div>
            ) : cell?.state === "failed" ? (
              // The remedy is words, never a key: nothing in a browser re-runs an assembly (rule 3).
              <p className="ll-note" data-testid="live-lane-remedy">{assemblyReasonText(cell.reason, w.assembly).remedy}</p>
            ) : cell?.state === "unknown" ? (
              <p className="ll-note" data-testid="live-lane-unknown">{w.master.unknownNote}</p>
            ) : cell?.state === "pending" || cell?.state === "assembling" ? (
              <p className="ll-note" data-testid="live-lane-nofile">{w.master.noFile}</p>
            ) : null
          }
        />
      )}
    </section>
  );
}
