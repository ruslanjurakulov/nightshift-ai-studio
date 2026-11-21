/**
 * Scene-level retention — which scene the audience left in (roadmap Q8, PR 5.1).
 *
 * The TypeScript twin of `modules/scene_retention.py`; both run the same cases
 * in `samples/scene_retention_cases.json`, so a divergence fails on both sides.
 *
 * The Video IR (migration 0013) gives each scene its REAL start/end on the
 * narration audio, and the rendered video is exactly as long as that audio, so
 * a YouTube retention point at `elapsed_ratio` sits at `elapsed_ratio *
 * duration` seconds. Per scene: retention at its start and end (linearly
 * interpolated between measured points), the drop (start − end, in
 * share-of-audience points), the drop per minute, and a rank — ranked on the
 * RATE, because a long scene loses more viewers simply by being long.
 *
 * Unknown stays unknown: a scene without real times, a video without a known
 * duration, or a curve with fewer than MIN_POINTS measured points gives null,
 * never 0. The curve is never extrapolated — YouTube reports it from 1% of the
 * video onwards, so the first scene's start retention is unknown.
 *
 * Pure (no network, no DB); never throws on malformed rows.
 */

import { sceneIdFor, type VideoScene } from "@/lib/storyboard";

/** Mirrors retention_analyzer.MIN_POINTS: fewer measured points describe nothing. */
export const MIN_POINTS = 5;
/** How many of the fastest-losing scenes the Storyboard highlights. */
export const HIGHLIGHT_WORST = 3;

const EPS = 1e-6;

/** One stored retention row (migration 0002); loose on purpose. */
export interface RetentionPointInput {
  elapsed_ratio?: number | null;
  watch_ratio?: number | null;
  measured_date?: string | null;
}

/** A scene window as the mapping needs it. */
export interface SceneWindow {
  id?: string | null;
  start_s?: number | null;
  end_s?: number | null;
}

export interface SceneRetention {
  sceneId: string;
  startS: number | null;
  endS: number | null;
  /** Share of viewers still watching at the scene's start / end. */
  retentionStart: number | null;
  retentionEnd: number | null;
  /** retentionStart − retentionEnd (share-of-audience points; negative when the curve rises). */
  drop: number | null;
  /** drop per minute of scene. */
  dropPerMin: number | null;
  /** 1 = fastest loss per minute; null when the rate is unknown. */
  rank: number | null;
}

export type SceneRetentionStatus =
  /** At least one scene has a measured drop. */
  | "ok"
  /** No usable retention curve for this video (none yet, or too few points). */
  | "no_curve"
  /** A curve exists, but no scene has real times or the video's length is unknown. */
  | "no_timing";

export interface SceneRetentionSummary {
  status: SceneRetentionStatus;
  scenes: SceneRetention[];
  /** Scene id → its row, for the Storyboard. */
  byId: Map<string, SceneRetention>;
}

function num(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function round4(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1e4) / 1e4;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The newest measured curve as sorted [elapsed_ratio, watch_ratio] pairs, or []
 * when fewer than MIN_POINTS are usable. A null watch ratio is dropped, not read
 * as 0; only the newest measured_date counts; a repeated ratio keeps its last row.
 */
export function cleanCurve(points: readonly RetentionPointInput[] | null | undefined): Array<[number, number]> {
  let rows = (Array.isArray(points) ? points : []).filter(isObject) as RetentionPointInput[];
  const dates = rows.map((p) => p.measured_date).filter((d): d is string => typeof d === "string" && d !== "");
  if (dates.length) {
    const newest = dates.reduce((a, b) => (b > a ? b : a));
    rows = rows.filter((p) => !p.measured_date || p.measured_date === newest);
  }
  const byRatio = new Map<number, number>();
  for (const p of rows) {
    const r = num(p.elapsed_ratio);
    const w = num(p.watch_ratio);
    if (r === null || w === null || r < 0) continue;
    byRatio.set(r, w);
  }
  const curve = [...byRatio.entries()].sort((a, b) => a[0] - b[0]);
  return curve.length >= MIN_POINTS ? curve : [];
}

/** Retention at `ratio`, interpolated between measured points; null outside them. */
export function interpolate(curve: ReadonlyArray<[number, number]>, ratio: number | null): number | null {
  if (!curve.length || ratio === null) return null;
  const lo = curve[0][0];
  const hi = curve[curve.length - 1][0];
  if (ratio < lo - EPS || ratio > hi + EPS) return null;
  if (ratio <= lo) return curve[0][1];
  if (ratio >= hi) return curve[curve.length - 1][1];
  for (let i = 0; i + 1 < curve.length; i++) {
    const [r0, w0] = curve[i];
    const [r1, w1] = curve[i + 1];
    if (r0 <= ratio && ratio <= r1) {
      return r1 === r0 ? w1 : w0 + ((w1 - w0) * (ratio - r0)) / (r1 - r0);
    }
  }
  return null;
}

/**
 * The rendered video's length in seconds: the IR's measured audio duration,
 * else the last real scene end (the timeline the IR derives it from). Null when
 * neither exists — never a word-count estimate.
 */
export function videoDuration(manifest: unknown, scenes: readonly SceneWindow[] | null | undefined): number | null {
  const audio = isObject(manifest) ? manifest.audio : null;
  const d = isObject(audio) ? num(audio.duration_s) : null;
  if (d !== null && d > 0) return d;
  const ends = (Array.isArray(scenes) ? scenes : [])
    .map((s) => (isObject(s) ? num(s.end_s) : null))
    .filter((e): e is number => e !== null && e > 0);
  return ends.length ? Math.max(...ends) : null;
}

/** Rank by fastest loss per minute, then larger raw drop, then scene order. */
function rank(rows: SceneRetention[]): SceneRetention[] {
  const order = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.dropPerMin !== null)
    .sort((a, b) => b.r.dropPerMin! - a.r.dropPerMin! || (b.r.drop ?? 0) - (a.r.drop ?? 0) || a.i - b.i);
  const rankOf = new Map<number, number>();
  order.forEach(({ i }, k) => rankOf.set(i, k + 1));
  return rows.map((r, i) => ({ ...r, rank: rankOf.get(i) ?? null }));
}

/** Map a curve onto scene windows: one row per scene, null where unmeasurable. */
export function mapScenes(
  scenes: readonly SceneWindow[] | null | undefined,
  points: readonly RetentionPointInput[] | null | undefined,
  durationS: number | null,
): SceneRetention[] {
  const curve = cleanCurve(points);
  const duration = num(durationS) !== null && durationS! > 0 ? durationS! : null;
  const out: SceneRetention[] = [];
  (Array.isArray(scenes) ? scenes : []).forEach((s, position) => {
    if (!isObject(s)) return;
    const start = num(s.start_s);
    const end = num(s.end_s);
    let rStart: number | null = null;
    let rEnd: number | null = null;
    let drop: number | null = null;
    let rate: number | null = null;
    if (curve.length && duration !== null && start !== null && end !== null && end > start) {
      rStart = interpolate(curve, start / duration);
      rEnd = interpolate(curve, end / duration);
      if (rStart !== null && rEnd !== null) {
        drop = rStart - rEnd;
        rate = drop / ((end - start) / 60);
      }
    }
    out.push({
      sceneId: sceneIdFor(s as VideoScene, position),
      startS: start,
      endS: end,
      retentionStart: round4(rStart),
      retentionEnd: round4(rEnd),
      drop: round4(drop),
      dropPerMin: round4(rate),
      rank: null,
    });
  });
  return rank(out);
}

/**
 * Everything the video page needs: the per-scene rows keyed by the same scene
 * id the Storyboard uses, and why there is nothing to show when there isn't.
 */
export function summarizeSceneRetention(
  scenes: readonly VideoScene[] | null | undefined,
  manifest: unknown,
  points: readonly RetentionPointInput[] | null | undefined,
): SceneRetentionSummary {
  const list = Array.isArray(scenes) ? scenes : [];
  const rows = mapScenes(list, points, videoDuration(manifest, list));
  const status: SceneRetentionStatus = rows.some((r) => r.dropPerMin !== null)
    ? "ok"
    : cleanCurve(points).length === 0
      ? "no_curve"
      : "no_timing";
  return { status, scenes: rows, byId: new Map(rows.map((r) => [r.sceneId, r])) };
}

/** True when this scene is among the worst HIGHLIGHT_WORST AND actually loses viewers. */
export function isWorstScene(r: SceneRetention | null | undefined): boolean {
  return !!r && r.rank !== null && r.rank <= HIGHLIGHT_WORST && (r.drop ?? 0) > 0;
}

/** Bar width (0–100) of a scene's loss rate against the steepest scene's; null when unknown or not a loss. */
export function dropBarPercent(r: SceneRetention | null | undefined, all: readonly SceneRetention[]): number | null {
  if (!r || r.dropPerMin === null || r.dropPerMin <= 0) return null;
  const max = Math.max(...all.map((x) => x.dropPerMin ?? 0));
  return max > 0 ? Math.max(2, Math.round((r.dropPerMin / max) * 100)) : null;
}

/** A share (0.87) as a whole percent ("87%"); "—" when unknown. */
export function pctText(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** A share-of-audience change in points with a sign ("−7.0", "+1.2"); "—" when unknown. */
export function pointsText(v: number | null): string {
  if (v === null) return "—";
  const p = v * 100;
  const sign = p > 0 ? "−" : p < 0 ? "+" : "";
  return `${sign}${Math.abs(p).toFixed(1)}`;
}
