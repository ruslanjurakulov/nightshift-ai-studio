"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { filmErrorFromResponse, parseFilmId, type FilmListItem } from "@/lib/films";
import { coerceTimelineFilm, startPolling, type TimelineFilm } from "@/lib/studio/timeline";

export const FILM_POLL_MS = 6000;

export type FilmLoad =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "expired" }
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
    return { state: "error" };
  }
  const raw = (json as { film?: unknown } | null)?.film;
  const film = coerceTimelineFilm(raw);
  return film ? { state: "ready", film, raw } : { state: "error" };
}

/**
 * One project, read through /api/films/{id} (RLS + film_json), and read again every few seconds while the page is open so a take the
 * worker finishes appears without a reload. A failed re-read keeps what was last read and marks it `stale`; it never blanks the
 * timeline and never stops the loop (startPolling schedules the next read whatever this one did).
 */
export function useTimelineFilm(filmId: string | null) {
  const [load, setLoad] = useState<FilmLoad>({ state: "loading" });
  const [stale, setStale] = useState(false);
  const current = useRef<FilmLoad>(load);
  current.current = load;

  const reload = useCallback(async () => {
    if (!filmId) return;
    const next = await readFilm(filmId);
    if (next.state === "ready" || current.current.state !== "ready") {
      setLoad(next);
      setStale(false);
    } else {
      setStale(true);
      if (next.state === "expired") setLoad(next);
    }
  }, [filmId]);

  useEffect(() => {
    if (!filmId) return;
    setLoad({ state: "loading" });
    void reload();
    const poll = startPolling(reload, FILM_POLL_MS);
    return () => poll.stop();
  }, [filmId, reload]);

  const replace = useCallback((raw: unknown) => {
    const film = coerceTimelineFilm(raw);
    if (film) setLoad({ state: "ready", film, raw });
  }, []);

  return { load, stale, reload, replace };
}

export type ListLoad = { state: "loading" } | { state: "missing" } | { state: "expired" } | { state: "error" } | { state: "ready"; films: FilmListItem[] };

/** The workspace's open projects, for the picker shown when the Timeline is opened without one. */
export function useFilmList(enabled: boolean) {
  const [load, setLoad] = useState<ListLoad>({ state: "loading" });
  const read = useCallback(async () => {
    setLoad({ state: "loading" });
    // GET /api/films answers rows the server already read into FilmListItem (camelCase); filmsApi().list re-reads them as database
    // rows and drops every one, so the picker reads the route's answer itself and keeps only rows with a real id and title.
    let res: Response;
    try {
      res = await fetch("/api/films", { cache: "no-store", credentials: "same-origin" });
    } catch {
      setLoad({ state: "error" });
      return;
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = filmErrorFromResponse(res.status, json).error;
      setLoad({ state: e === "not_available" ? "missing" : e === "session_expired" ? "expired" : "error" });
      return;
    }
    const rows = (json as { films?: unknown } | null)?.films;
    if (!Array.isArray(rows)) {
      setLoad({ state: "error" });
      return;
    }
    const films = rows.filter((r): r is FilmListItem => {
      const x = r as Partial<FilmListItem> | null;
      return Boolean(x && parseFilmId(x.id) && typeof x.title === "string" && typeof x.targetSeconds === "number" && typeof x.aspect === "string");
    });
    setLoad({ state: "ready", films });
  }, []);
  useEffect(() => {
    if (enabled) void read();
  }, [enabled, read]);
  return { load, reload: read };
}

export interface MediaUrls {
  /** The read was refused or failed: the asset exists in the project but cannot be shown here. */
  failed?: boolean;
  /** What a <video>/<audio> plays: the review copy (proxy) when there is one, else the original. */
  play: string | null;
  thumb: string | null;
  kind: string | null;
}

/**
 * Signed links for the assets the timeline shows (GET /api/media/{id}: RLS read, then 10-minute signed links). Fetched once per id and
 * again when a player reports an error (an expired link). An asset that cannot be read has no entry, so it is drawn as missing.
 */
export function useMediaUrls(ids: readonly string[]) {
  const [urls, setUrls] = useState<ReadonlyMap<string, MediaUrls>>(new Map());
  const asked = useRef(new Set<string>());
  const key = [...new Set(ids)].sort().join(",");

  const fetchOne = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        setUrls((prev) => new Map(prev).set(id, { play: null, thumb: null, kind: null, failed: true }));
        return;
      }
      const j = (await res.json()) as { asset?: { kind?: string }; urls?: Record<string, string> };
      const u = j.urls ?? {};
      const kind = j.asset?.kind ?? null;
      const entry: MediaUrls = {
        play: kind === "video" || kind === "audio" ? (u.proxy ?? u.original ?? null) : null,
        thumb: u.thumb ?? (kind === "image" ? (u.display ?? u.original ?? null) : null),
        kind,
      };
      setUrls((prev) => new Map(prev).set(id, entry));
    } catch {
      setUrls((prev) => new Map(prev).set(id, { play: null, thumb: null, kind: null, failed: true }));
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
      void fetchOne(id);
    },
    [fetchOne],
  );
  return { urls, refresh };
}

/**
 * The real waveform of one audio file: decoded in the browser and reduced to `buckets` peaks. Null until decoded (or when it cannot
 * be): the lane then shows a plain clip, never a drawn-on wave.
 */
export function usePeaks(url: string | null, buckets = 400): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!url || typeof window === "undefined") return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf);
        void ctx.close();
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / buckets));
        const out: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(data[j]));
          out.push(m);
        }
        if (!cancelled) setPeaks(out);
      } catch {
        // Not decodable here: no wave is drawn.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, buckets]);
  return peaks;
}
