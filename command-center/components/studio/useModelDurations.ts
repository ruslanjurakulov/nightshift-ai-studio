"use client";

import { useEffect, useState } from "react";
import { DURATION_MODELS_MAX } from "@/lib/creative/durations";

/** `{ durations: { model: number[] } }` → a map; anything else in the body is ignored, never guessed into a number. */
export function coerceDurations(body: unknown): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const d = body && typeof body === "object" ? (body as { durations?: unknown }).durations : null;
  if (!d || typeof d !== "object" || Array.isArray(d)) return out;
  for (const [model, xs] of Object.entries(d as Record<string, unknown>)) {
    if (Array.isArray(xs)) out.set(model, xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0));
  }
  return out;
}

/**
 * How long each of these models' recent jobs took in this organization (GET /api/creative/durations, read as the
 * member). Asked once per set of models that are running — not on every poll of the feed — so a long job does not
 * re-read history every few seconds. A model whose history could not be read is simply absent: its placeholder then
 * shows seconds, never a percentage it cannot back (CLAUDE.md #5).
 */
export function useModelDurations(orgId: string, models: readonly string[]): ReadonlyMap<string, number[]> {
  const key = [...new Set(models.filter(Boolean))].sort().slice(0, DURATION_MODELS_MAX).join(",");
  const [durations, setDurations] = useState<Map<string, number[]>>(() => new Map());
  useEffect(() => {
    if (!key) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/creative/durations?org_id=${encodeURIComponent(orgId)}&models=${encodeURIComponent(key)}`, {
          cache: "no-store",
        });
        if (!res.ok || !live) return;
        const read = coerceDurations(await res.json().catch(() => null));
        if (live) setDurations((prev) => new Map([...prev, ...read]));
      } catch {
        // Unread: the placeholders keep showing seconds.
      }
    })();
    return () => {
      live = false;
    };
  }, [orgId, key]);
  return durations;
}
