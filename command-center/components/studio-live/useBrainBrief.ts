"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { coerceBrief, type Brief, type BriefHandoff } from "@/lib/studio/liveGraph";
import type { LiveTarget } from "./useLiveGraph";

export type BriefLoad =
  | { state: "loading" }
  | { state: "ready"; brief: Brief }
  | { state: "error" }
  /** Not this person's conversation, or none with that id: a conversation is visible to its author only. */
  | { state: "notFound" }
  | { state: "expired" }
  /** Nightshift AI is off for this workspace, or the server has no Brain yet. */
  | { state: "unavailable" };

/** The browser event the Nightshift AI panel dispatches whenever the brief changes (docs/studio/NIGHTSHIFT_AI.md). */
export const BRAIN_BRIEF_EVENT = "nightshift:brain-brief";

export function handoffTarget(h: BriefHandoff): LiveTarget {
  if (h.kind === "film") return { kind: "film", id: h.filmId };
  if ("jobId" in h) return { kind: "run", id: h.jobId };
  return { kind: "window", channel: h.channelId, since: h.dispatchedAt };
}

async function readBrief(session: string): Promise<BriefLoad> {
  let res: Response;
  try {
    res = await fetch(`/api/brain/session/${encodeURIComponent(session)}`, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { state: "error" };
  }
  if (res.status === 401) return { state: "expired" };
  if (res.status === 404) return { state: "notFound" };
  if (res.status === 403 || res.status === 503) return { state: "unavailable" };
  if (!res.ok) return { state: "error" };
  const json = (await res.json().catch(() => null)) as { brief?: unknown } | null;
  const brief = coerceBrief(json?.brief);
  return brief ? { state: "ready", brief } : { state: "error" };
}

/**
 * The brief of one Nightshift AI conversation, as the canvas draws it before Create. It reads with the person's own session, once on
 * open, again whenever the panel says the brief changed (its browser event, for this conversation only) and when the tab comes back.
 * There is no timer: the brief changes only on a person's turn. Read-only: it never answers a card, prices or creates anything.
 */
export function useBrainBrief(session: string | null) {
  const [load, setLoad] = useState<BriefLoad>({ state: "loading" });
  const gen = useRef(0);
  const last = useRef<BriefLoad>(load);
  last.current = load;

  const read = useCallback(async () => {
    if (!session) return;
    const from = gen.current;
    const next = await readBrief(session);
    if (from !== gen.current) return;
    // A failed re-read keeps the brief on screen: the panel's next change reads again.
    if (next.state === "error" && last.current.state === "ready") return;
    setLoad(next);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    gen.current += 1;
    setLoad({ state: "loading" });
    void read();
    const onBrief = (e: Event) => {
      const d = (e as CustomEvent<{ session_id?: unknown }>).detail;
      if (d && d.session_id === session) void read();
    };
    const onVisible = () => {
      if (!document.hidden) void read();
    };
    window.addEventListener(BRAIN_BRIEF_EVENT, onBrief);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gen.current += 1;
      window.removeEventListener(BRAIN_BRIEF_EVENT, onBrief);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, read]);

  const retry = useCallback(() => {
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    void read();
  }, [read]);

  return { load, retry };
}
