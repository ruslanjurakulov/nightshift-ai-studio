"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filmErrorFromResponse, filmsApi, type FilmListItem } from "@/lib/films";
import { coerceTimelineFilm, startPolling, type PollVerdict, type TimelineFilm } from "@/lib/studio/timeline";

export const FILM_POLL_MS = 6000;

export type FilmLoad =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "expired" }
  | { state: "notFound" }
  | { state: "error" }
  | { state: "ready"; film: TimelineFilm; raw: unknown };

async function readFilm(id: string): Promise<FilmLoad> {
  let res: Response;
  try {
    res = await fetch(`/api/films/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { state: "error" };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = filmErrorFromResponse(res.status, json);
    if (e.error === "not_available") return { state: "missing" };
    if (e.error === "session_expired") return { state: "expired" };
    if (e.error === "not_found") return { state: "notFound" };
    return { state: "error" };
  }
  const raw = (json as { film?: unknown } | null)?.film;
  const film = coerceTimelineFilm(raw);
  return film ? { state: "ready", film, raw } : { state: "error" };
}

/** States a re-read cannot fix: the poll stops and the page says which one it is. */
const TERMINAL: readonly FilmLoad["state"][] = ["missing", "expired", "notFound"];

/**
 * One project, read through /api/films/{id} (RLS + film_json), and read again every few seconds while the page is visible so a take
 * the worker finishes appears without a reload.
 * - A failed re-read keeps what was last read and marks it `stale`; the poll backs off, it never stops on a failure.
 * - A read that answers an OLDER version than the one shown is dropped: a poll already in flight when a reorder saved must not put the
 *   old order back (Lens M1).
 * - The project gone, the session ended or the tables missing stop the poll: reading again cannot change them.
 * - A hidden tab is not read; it reads at once when it is shown again.
 */
export function useTimelineFilm(filmId: string | null) {
  const [load, setLoad] = useState<FilmLoad>({ state: "loading" });
  const [stale, setStale] = useState(false);
  const current = useRef<FilmLoad>(load);
  current.current = load;
  const shownVersion = useRef(0);
  // Which project this hook is showing, and which effect run a read belongs to: an answer for the PREVIOUS project, still in flight
  // when ?film= changed, must neither show nor set the version guard for the new one (Lens N1), or every read of the new project
  // would be dropped as "older" and a save would PATCH the old one.
  const filmRef = useRef(filmId);
  const gen = useRef(0);

  const accept = useCallback((next: FilmLoad, from: number) => {
    if (from !== gen.current) return;
    if (next.state === "ready") {
      if (next.film.view.film.id !== filmRef.current) return;
      if (next.film.view.film.version < shownVersion.current) return;
      shownVersion.current = next.film.view.film.version;
      setLoad(next);
      setStale(false);
    } else if (current.current.state !== "ready" || TERMINAL.includes(next.state)) {
      setLoad(next);
    } else {
      setStale(true);
    }
  }, []);

  const reload = useCallback(async (): Promise<PollVerdict> => {
    if (!filmId) return "stop";
    const from = gen.current;
    const next = await readFilm(filmId);
    accept(next, from);
    if (from !== gen.current) return "stop";
    if (TERMINAL.includes(next.state)) return "stop";
    return next.state === "ready" ? "ok" : "error";
  }, [filmId, accept]);

  useEffect(() => {
    if (!filmId) return;
    gen.current += 1;
    filmRef.current = filmId;
    shownVersion.current = 0;
    setLoad({ state: "loading" });
    setStale(false);
    let stopped = false;
    void reload().then((v) => {
      if (v === "stop") {
        stopped = true;
        poll.stop();
      }
    });
    const poll = startPolling(reload, FILM_POLL_MS);
    const onVisible = () => {
      if (stopped || poll.stopped) return;
      if (document.hidden) poll.pause();
      else poll.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (document.hidden) poll.pause();
    return () => {
      gen.current += 1;
      poll.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [filmId, reload]);

  /** A save's answer: the film as the database now holds it, accepted only if it is still the project on screen. */
  const replace = useCallback(
    (raw: unknown) => {
      const film = coerceTimelineFilm(raw);
      if (film) accept({ state: "ready", film, raw }, gen.current);
    },
    [accept],
  );

  return { load, stale, reload, replace };
}

export type ListLoad = { state: "loading" } | { state: "missing" } | { state: "expired" } | { state: "error" } | { state: "ready"; films: FilmListItem[] };

/** The workspace's open projects, for the picker shown when the Timeline is opened without one. */
export function useFilmList(enabled: boolean) {
  const [load, setLoad] = useState<ListLoad>({ state: "loading" });
  const read = useCallback(async () => {
    setLoad({ state: "loading" });
    const r = await filmsApi().list(false);
    if (r.ok) setLoad({ state: "ready", films: r.data });
    else setLoad({ state: r.error === "not_available" ? "missing" : r.error === "session_expired" ? "expired" : "error" });
  }, []);
  useEffect(() => {
    if (enabled) void read();
  }, [enabled, read]);
  return { load, reload: read };
}

export interface MediaUrls {
  /** The read was refused or failed, or the links stopped working after the retries: it cannot be shown here. */
  failed?: boolean;
  /** The server read the asset but serves no files (no media volume or signing secret): "preview unavailable", never "loading". */
  unavailable?: boolean;
  /** What a <video>/<audio> plays: the review copy (proxy) when there is one, else the original. */
  play: string | null;
  thumb: string | null;
  kind: string | null;
  /** The library's recorded length in seconds (media_assets.duration_s), the only length the timeline calls measured. */
  durationS: number | null;
}

/**
 * How many errors in a row (within MEDIA_RETRY_WINDOW_MS of each other) one asset may report before it is shown as failed. A signed
 * link expires every ten minutes, so an error long after the last one is an ordinary expiry and starts the count again (Lens N2).
 */
export const MEDIA_RETRIES = 2;
export const MEDIA_RETRY_WINDOW_MS = 60_000;

/**
 * Signed links for the assets the timeline shows (GET /api/media/{id}: RLS read, then 10-minute signed links). Fetched once per id;
 * fetched again when a player reports an error (an expired link), at most MEDIA_RETRIES times, then the asset reads as failed, so a
 * file that is really gone cannot set off an endless loop of requests (Lens M3).
 */
export function useMediaUrls(ids: readonly string[]) {
  const [urls, setUrls] = useState<ReadonlyMap<string, MediaUrls>>(new Map());
  const asked = useRef(new Set<string>());
  const retries = useRef(new Map<string, { n: number; at: number }>());
  const key = [...new Set(ids)].sort().join(",");

  const fetchOne = useCallback(async (id: string) => {
    const fail = () => setUrls((prev) => new Map(prev).set(id, { play: null, thumb: null, kind: null, durationS: null, failed: true }));
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return fail();
      const j = (await res.json()) as { asset?: { kind?: string; durationS?: unknown }; urls?: Record<string, string>; served?: boolean };
      const u = j.urls ?? {};
      const kind = j.asset?.kind ?? null;
      const d = j.asset?.durationS;
      const entry: MediaUrls = {
        play: kind === "video" || kind === "audio" ? (u.proxy ?? u.original ?? null) : null,
        thumb: u.thumb ?? (kind === "image" ? (u.display ?? u.original ?? null) : null),
        kind,
        durationS: typeof d === "number" && Number.isFinite(d) && d > 0 ? d : null,
        unavailable: j.served === false || Object.keys(u).length === 0,
      };
      setUrls((prev) => new Map(prev).set(id, entry));
    } catch {
      fail();
    }
  }, []);

  useEffect(() => {
    for (const id of key ? key.split(",") : []) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void fetchOne(id);
    }
  }, [key, fetchOne]);

  const refresh = useCallback(
    (id: string) => {
      const now = Date.now();
      const was = retries.current.get(id);
      const n = was && now - was.at < MEDIA_RETRY_WINDOW_MS ? was.n : 0;
      if (n >= MEDIA_RETRIES) {
        setUrls((prev) => {
          const was = prev.get(id);
          return was?.failed ? prev : new Map(prev).set(id, { ...(was ?? { play: null, thumb: null, kind: null, durationS: null }), play: null, thumb: null, failed: true });
        });
        return;
      }
      retries.current.set(id, { n: n + 1, at: now });
      void fetchOne(id);
    },
    [fetchOne],
  );

  const durations = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, u] of urls) if (u.durationS !== null) m.set(id, u.durationS);
    return m;
  }, [urls]);

  return { urls, refresh, durations };
}

/** Longest audio decoded for a waveform: a 20-minute file decodes to about 460 MB of samples in the browser (Lens M6). */
export const PEAKS_MAX_SECONDS = 600;

export type Peaks = { state: "none" } | { state: "skipped" } | { state: "ready"; peaks: number[] };

const coarse = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/**
 * The real waveform of one audio file: decoded in the browser and reduced to `buckets` peaks. Keyed by the asset, not its signed link,
 * so a refreshed link does not decode the file again. Not decoded on a phone, or when the library has no length for the file or it is
 * longer than PEAKS_MAX_SECONDS: then `skipped`, and the lane says the waveform is not shown, never a drawn-on wave.
 */
export function usePeaks(assetId: string | null, url: string | null, durationS: number | null, buckets = 400): Peaks {
  const [peaks, setPeaks] = useState<Peaks>({ state: "none" });
  const urlRef = useRef(url);
  urlRef.current = url;
  const hasUrl = Boolean(url);
  useEffect(() => {
    setPeaks({ state: "none" });
    if (!assetId || !hasUrl || typeof window === "undefined") return;
    if (durationS === null || durationS > PEAKS_MAX_SECONDS || coarse()) {
      setPeaks({ state: "skipped" });
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    let cancelled = false;
    (async () => {
      let ctx: AudioContext | null = null;
      try {
        const res = await fetch(urlRef.current as string, { credentials: "same-origin" });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / buckets));
        const out: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(data[j]));
          out.push(m);
        }
        if (!cancelled) setPeaks({ state: "ready", peaks: out });
      } catch {
        // Not decodable here: no wave is drawn.
      } finally {
        void ctx?.close().catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, hasUrl, durationS, buckets]);
  return peaks;
}
