"use client";

/**
 * The canvas's timeline lane: the adapter from the canvas to the strip (LaneStrip). lib/studio/lane.ts decides which cards are
 * on it and in what order (wired ones, in chain order); this file reads each one into a LaneRow from its job and its library
 * file, and hands the strip a way to find the card a landed segment's tag flies from. Wire a clip card into a chain and its
 * segment lands; take the wire away and it goes. A press on a segment finds its card on the canvas.
 *
 * Every row is a reading (CLAUDE.md rule 5): a picture only from the card's real result, "made" only for a finished job's file
 * or a library file, a length from the file's measurement or the job's request (marked), or none.
 */
import { useCallback, useMemo } from "react";
import { useI18n } from "@/lib/i18n/context";
import { KIND_SPEC, type CanvasNode, type CanvasState } from "@/lib/studio/canvas";
import { laneOf, segmentLength, type LaneRow, type LaneTrack } from "@/lib/studio/lane";
import { KIND_ICONS, statusLine } from "./parts";
import { LAMP, nodeAsset, resultView, type JobReading, type NodeStatus } from "./nodeState";
import { LaneStrip } from "./LaneStrip";

export { LANE_OPEN_KEY } from "./LaneStrip";

type Previews = ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;

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
  const { t } = useI18n();
  const c = t.studioCanvas;
  const lane = useMemo(() => laneOf(canvas), [canvas]);
  const rows = useMemo(() => {
    const read = (track: LaneTrack, list: readonly CanvasNode[]): LaneRow[] =>
      list.map((node) => {
        const status = statusOf(node);
        const reading = node.jobId ? jobs.get(node.jobId) : undefined;
        const job = reading?.state === "ok" ? reading.job : null;
        const asset = nodeAsset(node, jobs);
        const rv = resultView(node, status, jobs, previews, resultPending);
        const thumb = track === "video" && asset && (rv === "shown" || node.kind === "asset") ? previews.get(asset)?.thumbUrl ?? null : null;
        const accepts = KIND_SPEC[node.kind].accepts.map((k) => c.ports[k]).join(" / ");
        const statusWords = rv === "missing" ? c.node.resultMissing : rv === "loading" ? c.node.resultLoading : statusLine(t, status, job, accepts);
        const name = nodeName(node);
        return {
          id: node.id,
          track,
          name,
          tag: name,
          status: rv === "missing" ? "warn" : LAMP[status],
          statusWords,
          length: segmentLength({ measured: asset ? measured.get(asset) : null, requested: job?.params?.duration_s, failed: status === "failed", track }),
          thumb,
          // Solid only for what exists: a finished job's file or a library file. Everything else is a plan (dashed).
          made: status === "done" || status === "asset",
        };
      });
    return [...read("video", lane.video), ...read("audio", lane.audio)];
  }, [lane, statusOf, jobs, previews, resultPending, measured, nodeName, c, t]);
  const kindOf = useMemo(() => new Map(canvas.nodes.map((n) => [n.id, n.kind])), [canvas.nodes]);
  const iconFor = useCallback((row: LaneRow) => KIND_ICONS[kindOf.get(row.id) ?? (row.track === "video" ? "video" : "voice")], [kindOf]);
  // A landed segment's tag flies from its card on the board (found by its data attribute: no selector string to escape).
  const flightFrom = useCallback(
    (id: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-node-id]"))
        .find((el) => el.dataset.nodeId === id)
        ?.getBoundingClientRect() ?? null,
    [],
  );
  return <LaneStrip rows={rows} selected={selected} onPick={onPick} phone={phone} loose={lane.loose.length} flightFrom={flightFrom} iconFor={iconFor} />;
}
