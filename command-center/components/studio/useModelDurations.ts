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

/** What the feed knows of a model's history here: its durations, or why there are none (the pill says which). */
export interface ModelDurations {
  /** The model's durations (s) when they were read; null otherwise. */
  samples(model: string): number[] | null;
  /** Why `samples` is null: asked and not (yet) read — or never asked, past DURATION_MODELS_MAX models at once. */
  missing(model: string): "unread" | "not_asked";
}

/**
 * How long each of these models' recent jobs took in this organization (GET /api/creative/durations, read as the
 * member). Asked once per set of models that are running — not on every poll of the feed — so a long job does not
 * re-read history every few seconds. A model whose history could not be read is simply absent: its placeholder then
 * shows seconds, never a percentage it cannot back (CLAUDE.md #5).
 *
 * What was read belongs to the organization it was read for: on a switch to another one the map starts empty (and
 * reads as empty at once, before the new answer arrives), so one workspace's history never times another's jobs.
 */
export function useModelDurations(orgId: string, models: readonly string[]): ModelDurations {
  const key = [...new Set(models.filter(Boolean))].sort().slice(0, DURATION_MODELS_MAX).join(",");
  const [read, setRead] = useState<{ org: string; map: Map<string, number[]> }>(() => ({ org: orgId, map: new Map() }));
  useEffect(() => {
    if (!key) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/creative/durations?org_id=${encodeURIComponent(orgId)}&models=${encodeURIComponent(key)}`, {
          cache: "no-store",
        });
        if (!res.ok || !live) return;
        const got = coerceDurations(await res.json().catch(() => null));
        if (live) setRead((prev) => ({ org: orgId, map: new Map([...(prev.org === orgId ? prev.map : []), ...got]) }));
      } catch {
        // Unread: the placeholders keep showing seconds.
      }
    })();
    return () => {
      live = false;
    };
  }, [orgId, key]);
  const map = read.org === orgId ? read.map : EMPTY;
  const asked = new Set(key ? key.split(",") : []);
  return {
    samples: (model) => map.get(model) ?? null,
    missing: (model) => (asked.has(model) ? "unread" : "not_asked"),
  };
}

const EMPTY: ReadonlyMap<string, number[]> = new Map();
