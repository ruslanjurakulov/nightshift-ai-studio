"use client";

/**
 * The lane under a live film's board (docs/studio/S3_GAPS.md G1, G3, G5, G6): the film's clips and narration as they land, a
 * transport row above them, and the final film at the end. An adapter: liveLane (lib/studio/liveLane.ts) reads the film,
 * laneRows (lib/studio/liveLaneRows.ts) turns it into rows, and the canvas's LaneStrip draws them.
 *
 * Read-only (CLAUDE.md rule 3): a press on a piece opens its step in the view's details, and the only control is the existing
 * download of a master that exists. Nothing here starts, retries, renders or spends. There is no player: nothing plays until there
 * is a file, and the file plays through its own download/preview.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { AssetDownloads } from "@/components/media/AssetDownloads";
import { LaneStrip } from "@/components/studio-canvas/LaneStrip";
import { useMediaUrls } from "@/components/studio-timeline/useTimelineData";
import { liveLane, type LiveLane as Lane } from "@/lib/studio/liveLane";
import { assemblyReasonText, flightIds, landedSeconds, laneRows, masterCell, masterRow, type LaneRowWords, type MasterWords } from "@/lib/studio/liveLaneRows";
import { timecode } from "@/lib/studio/timeline";
import type { LiveLoad } from "./useLiveGraph";
import "./live-lane.css";

const PHONE = "(max-width: 767px)";
const NO_DURATIONS: ReadonlyMap<string, number> = new Map();
const LANE_OPEN_KEY = "ns.studio.live.lane";

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

/** The board's card a piece belongs to (liveGraph's filmGraph names them): a scene's clip, the voice, the final video. */
export function nodeOfPiece(id: string): string | null {
  const v = /^v:(.+):\d+$/.exec(id);
  if (v) return `scene:${v[1]}:clip`;
  if (id === "a:narration") return "voice";
  if (id === "m:master") return "final";
  return null;
}

/** A card's box on the BOARD only: at list width there is no board, and a tag dropping in from above is the honest start. */
function boardCard(nodeId: string): DOMRect | null {
  const want = `live-node-${nodeId}`;
  const el = Array.from(document.querySelectorAll<HTMLElement>(".lv-board .lv-card")).find((e) => e.dataset.testid === want);
  return el ? el.getBoundingClientRect() : null;
}

export function LiveLane({
  load,
  planKey,
  stale,
  selected,
  onOpen,
}: {
  load: LiveLoad;
  /** The plan on screen: a reading of another plan (one render after a switch) is not drawn. */
  planKey: string | null;
  stale: boolean;
  /** The board's selected step, and how to select one: a press on a piece opens its step. */
  selected: string | null;
  onOpen: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  const c = t.studioLive;
  const w = c.lane;
  const phone = usePhone();
  const reading = load.state === "ready" && load.key === planKey ? load.film : null;

  // States and assets do not depend on lengths: one pass without them names the files to ask the library about.
  const base = useMemo(() => (reading ? liveLane(reading, NO_DURATIONS) : null), [reading]);
  const assetIds = useMemo(
    () => (base ? [...base.video, ...base.audio, ...(base.master ? [base.master] : [])].flatMap((p) => (p.assetId ? [p.assetId] : [])) : []),
    [base],
  );
  const { urls, durations } = useMediaUrls(assetIds);
  const lane = useMemo(() => (reading ? liveLane(reading, durations) : null), [reading, durations]);

  // What landed since the previous reading of this film. The first reading, a refresh and a film switch fly nothing: landedSince
  // has no previous lane, or one of another film.
  const [fly, setFly] = useState<{ of: Lane | null; ids: string[] }>({ of: null, ids: [] });
  useEffect(() => {
    if (!base) return;
    setFly((f) => (f.of === base ? f : { of: base, ids: flightIds(f.of, base) }));
  }, [base]);

  const failure = useCallback(
    // The live view's own failure words (LiveView's failureText, for a film step): a known word's sentence, else the code as stored.
    (code: string | null) => (code && c.errors[code] ? c.errors[code] : code ? fmt(c.failedGeneric, { code }) : c.failedNoCode),
    [c],
  );
  const rowWords = useMemo<LaneRowWords>(
    () => ({ clip: c.kinds.clip, shot: w.shot, voice: c.kinds.voice, master: w.master.name, state: w.state, failedWith: w.failedWith, failure, fmt }),
    [c, w, failure],
  );
  const masterWords = useMemo<MasterWords>(() => ({ ...w.master, assembly: w.assembly }), [w]);
  const thumbs = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const [id, u] of urls) m.set(id, u.failed || u.unavailable ? null : u.thumb);
    return m;
  }, [urls]);
  const rows = useMemo(() => (lane ? laneRows(lane, rowWords, thumbs) : []), [lane, rowWords, thumbs]);
  const master = lane ? masterRow(lane.master, masterWords, lane.master?.assetId ? (thumbs.get(lane.master.assetId) ?? null) : null) : null;
  const cell = lane ? masterCell(lane.master) : null;

  const pick = useCallback((id: string) => {
    const node = nodeOfPiece(id);
    if (node) onOpen(node);
  }, [onOpen]);
  const flightFrom = useCallback((id: string) => {
    const node = nodeOfPiece(id);
    return node ? boardCard(node) : null;
  }, []);
  const selectedRow = selected ? ([...rows, ...(master ? [master] : [])].find((r) => nodeOfPiece(r.id) === selected)?.id ?? null) : null;

  if (!reading || !lane) {
    if (load.state === "loading" || (load.state === "ready" && !reading)) {
      return (
        <section className="ll-root" aria-label={w.label} aria-busy="true" data-testid="live-lane">
          <div className="ll-skeleton" data-testid="live-lane-loading">
            <span className="sr-only" role="status">{w.loading}</span>
            <i aria-hidden />
            <i aria-hidden />
          </div>
        </section>
      );
    }
    if (load.state === "error") {
      return (
        <section className="ll-root" aria-label={w.label} data-testid="live-lane">
          <p className="ll-note" role="status" data-testid="live-lane-error">{w.error}</p>
        </section>
      );
    }
    // Not found, signed out, switched off: the view above says so, with its way on.
    return null;
  }

  const film = reading.film.view.film;
  const landed = landedSeconds(lane);
  const total = lane.planned;
  const status = w.film[film.status] ?? w.filmUnknown;
  const empty = reading.film.view.scenes.length === 0;
  const landedText = landed ? timecode(landed.seconds) : "?";
  const totalText = total !== null ? timecode(total) : "?";
  const clockWords = landed ? fmt(w.clock, { t: `${landedText}${landed.measured ? "" : ` (${w.planTag})`}`, total: total !== null ? `${totalText} (${w.planTag})` : w.totalUnknown }) : w.clockUnknown;

  return (
    <section className={`ll-root${phone ? " is-phone" : ""}`} aria-label={w.label} data-testid="live-lane" data-stale={stale ? "true" : undefined}>
      <div className="ll-transport" role="group" aria-label={w.transport} data-testid="live-lane-transport">
        <span className="ds-timecode ll-tc" data-testid="live-lane-clock" data-landed={landed ? (landed.measured ? "measured" : "planned") : "unknown"}>
          <span aria-hidden>
            {landedText}
            {landed && !landed.measured ? <span className="ll-plan">{w.planTag}</span> : null}
            <span data-part="total" className="ll-tc-total" data-testid="live-lane-total">
              {" / "}
              {totalText}
            </span>
          </span>
          <span className="sr-only">{clockWords}</span>
        </span>
        <span className="ll-status" data-testid="live-lane-status" data-status={film.status}>
          {status}
        </span>
        <span className="ll-made" data-testid="live-lane-made">
          {fmt(w.made, { n: lane.landed, m: lane.total })}
        </span>
        {stale ? (
          <span className="ll-stale" data-testid="live-lane-stale">
            {w.stale}
          </span>
        ) : null}
        <span className="ll-grow" />
        {!phone ? <span className="ll-note">{w.noPlayhead}</span> : null}
      </div>
      {empty ? (
        <p className="ll-note ll-empty" data-testid="live-lane-empty">
          {w.empty}
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
          master={master ?? undefined}
          masterAction={
            cell?.state === "ready" ? (
              <div data-testid="live-lane-download">
                <AssetDownloads assetId={cell.assetId} preview="ready" compact />
              </div>
            ) : cell?.state === "failed" ? (
              // The remedy is words, never a key: nothing in a browser re-runs an assembly (rule 3).
              <p className="ll-note" data-testid="live-lane-remedy">{assemblyReasonText(cell.reason, w.assembly).remedy}</p>
            ) : cell && cell.state !== "skipped" ? (
              <p className="ll-note" data-testid="live-lane-nofile">{w.master.noFile}</p>
            ) : null
          }
        />
      )}
    </section>
  );
}
