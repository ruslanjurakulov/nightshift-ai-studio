"use client";

import { useEffect, useState } from "react";

/**
 * Seconds since a job started, as the server recorded it, ticking once a second only while the job runs. With no start time
 * the answer is null and the card shows no timer: an elapsed time is a measurement, never a default (CLAUDE.md rule 5).
 */
export function useElapsed(startedAt: number | null | undefined, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);
  if (startedAt == null || !Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 65 → "1:05", 3725 → "1:02:05". Tabular, so the card does not jitter as it ticks. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
