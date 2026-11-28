"use client";

/**
 * Seconds since a job started, as the server recorded it. One shared one-second clock drives every timer on the board, so
 * 20 working cards are 20 tiny text updates on the same tick, not 20 full-card renders spread through the second. The
 * server snapshot is null: no timer is server-rendered, so the server's clock and the browser's can never disagree in the
 * markup (a hydration mismatch). With no start time the answer is null and no timer is shown: an elapsed time is a
 * measurement, never a default (CLAUDE.md rule 5).
 */
import { useSyncExternalStore } from "react";
import { formatElapsed } from "./model";

export { formatElapsed };

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noSubscribe = () => () => {};
const clientNow = () => now || Date.now();
const serverNow = () => null;

export function useElapsed(startedAt: number | null | undefined, running: boolean): number | null {
  const valid = running && typeof startedAt === "number" && Number.isFinite(startedAt);
  const t = useSyncExternalStore(valid ? subscribe : noSubscribe, valid ? clientNow : serverNow, serverNow);
  if (!valid || t === null) return null;
  return Math.max(0, Math.floor((t - (startedAt as number)) / 1000));
}
