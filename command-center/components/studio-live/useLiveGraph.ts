"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling, type PollVerdict } from "@/lib/studio/timeline";
import { coerceFilmLive, coerceRunLive, filmGraph, runGraph, type FilmReading, type LiveGraph } from "@/lib/studio/liveGraph";

/** A project, a queue-backend run (render_jobs id), or an Actions-backend run: its channel and the moment it was dispatched. */
export type LiveTarget = { kind: "film"; id: string } | { kind: "run"; id: string } | { kind: "window"; channel: string; since: string; hold?: string | null };

export type LiveLoad =
  | { state: "loading" }
  | { state: "ready"; graph: LiveGraph; film: FilmReading | null }
  /** The read failed (network, 5xx, an answer that is not one): retried with backoff; the last good graph stays on screen. */
  | { state: "error" }
  | { state: "notFound" }
  | { state: "expired" }
  /** The feature is not there (0166 not applied, Supabase not configured). */
  | { state: "unavailable" };

const POLL_MS = 6000;
const TERMINAL: LiveLoad["state"][] = ["notFound", "expired", "unavailable"];

function urlOf(t: LiveTarget): string {
  if (t.kind === "film") return `/api/films/${encodeURIComponent(t.id)}/live`;
  if (t.kind === "run") return `/api/agent/runs/${encodeURIComponent(t.id)}`;
  const hold = t.hold ? `&hold=${encodeURIComponent(t.hold)}` : "";
  return `/api/agent/runs/window?channel=${encodeURIComponent(t.channel)}&since=${encodeURIComponent(t.since)}${hold}`;
}

async function readLive(t: LiveTarget): Promise<LiveLoad> {
  let res: Response;
  try {
    res = await fetch(urlOf(t), { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { state: "error" };
  }
  if (res.status === 401) return { state: "expired" };
  if (res.status === 404) return { state: "notFound" };
  if (res.status === 503) return { state: "unavailable" };
  if (!res.ok) return { state: "error" };
  const json: unknown = await res.json().catch(() => null);
  if (t.kind === "film") {
    const film = coerceFilmLive(json);
    return film ? { state: "ready", graph: filmGraph(film), film } : { state: "error" };
  }
  const run = coerceRunLive(json);
  return run.job || run.window ? { state: "ready", graph: runGraph(run), film: null } : { state: "error" };
}

/**
 * One plan's live graph, read every few seconds through the read-only live routes. It only ever GETs: nothing here starts, retries or
 * prices a step (CLAUDE.md rule 3). It survives a refresh because nothing lives in the browser: the URL names the plan and every read
 * is the database's answer. It pauses while the tab is hidden, backs off on a failed read (keeping the last good graph, marked stale),
 * and stops once every step has settled or the plan is gone.
 */
export function useLiveGraph(target: LiveTarget | null) {
  const [load, setLoad] = useState<LiveLoad>({ state: "loading" });
  const [stale, setStale] = useState(false);
  const shown = useRef<LiveLoad>(load);
  shown.current = load;
  // Which plan, and which effect run, a read belongs to: an answer for the previous plan must never show for the new one.
  const gen = useRef(0);
  const key = target ? (target.kind === "window" ? `window:${target.channel}:${target.since}` : `${target.kind}:${target.id}`) : null;

  const accept = useCallback((next: LiveLoad, from: number) => {
    if (from !== gen.current) return;
    if (next.state === "ready") {
      setLoad(next);
      setStale(false);
    } else if (shown.current.state !== "ready" || TERMINAL.includes(next.state)) {
      setLoad(next);
    } else {
      setStale(true);
    }
  }, []);

  const read = useCallback(async (): Promise<PollVerdict> => {
    if (!target) return "stop";
    const from = gen.current;
    const next = await readLive(target);
    accept(next, from);
    if (from !== gen.current || TERMINAL.includes(next.state)) return "stop";
    if (next.state === "ready") return next.graph.settled ? "stop" : "ok";
    return "error";
    // The target object is rebuilt each render; its key is what names the plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accept]);

  const pollRef = useRef<ReturnType<typeof startPolling> | null>(null);

  useEffect(() => {
    if (!key) return;
    gen.current += 1;
    setLoad({ state: "loading" });
    setStale(false);
    let ended = false;
    const poll = startPolling(read, POLL_MS);
    pollRef.current = poll;
    void read().then((v) => {
      if (v === "stop") {
        ended = true;
        poll.stop();
      }
    });
    const onVisible = () => {
      if (ended || poll.stopped) return;
      if (document.hidden) poll.pause();
      else poll.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (document.hidden) poll.pause();
    return () => {
      gen.current += 1;
      poll.stop();
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, read]);

  /** The person's "Try again" after a failed first read: one more read now. Reads only. */
  const retry = useCallback(() => {
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    void read();
  }, [read]);

  return { load, stale, retry };
}
