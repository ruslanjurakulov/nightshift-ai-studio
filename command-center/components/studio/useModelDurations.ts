"use client";

import { useEffect, useState } from "react";
import { DURATION_MODELS_MAX } from "@/lib/creative/durations";
import { coerceProbeSeeds, pickSeed, type ProbeSeed } from "@/lib/creative/progress";

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

/** `{ seeds: { model: ProbeSeed[] } }` → a map of the seeds that read whole; a missing or malformed `seeds` is none. */
export function coerceSeeds(body: unknown): Map<string, ProbeSeed[]> {
  const out = new Map<string, ProbeSeed[]>();
  const s = body && typeof body === "object" ? (body as { seeds?: unknown }).seeds : null;
  if (!s || typeof s !== "object" || Array.isArray(s)) return out;
  for (const [model, x] of Object.entries(s as Record<string, unknown>)) {
    const seeds = coerceProbeSeeds(x);
    if (seeds.length > 0) out.set(model, seeds);
  }
  return out;
}

/** What the feed knows of a model's history here: its durations, or why there are none (the pill says which). */
export interface ModelDurations {
  /** The model's durations (s) when they were read; null otherwise. */
  samples(model: string): number[] | null;
  /**
   * The platform's test run of the model for this capability (0151), when the history here is short and the seed was read;
   * null otherwise — and for a capability the model was never probed for.
   */
  seed(model: string, capability: string): ProbeSeed | null;
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
  const [read, setRead] = useState<{ org: string; map: Map<string, number[]>; seeds: Map<string, ProbeSeed[]> }>(() => ({
    org: orgId,
    map: new Map(),
    seeds: new Map(),
  }));
  useEffect(() => {
    if (!key) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/creative/durations?org_id=${encodeURIComponent(orgId)}&models=${encodeURIComponent(key)}`, {
          cache: "no-store",
        });
        if (!res.ok || !live) return;
        const body: unknown = await res.json().catch(() => null);
        const got = coerceDurations(body);
        const seeds = coerceSeeds(body);
        if (live)
          setRead((prev) => {
            const same = prev.org === orgId;
            // A model read again replaces its seed too: one whose history here has since grown long enough is sent none.
            const kept = same ? [...prev.seeds].filter(([m]) => !got.has(m)) : [];
            return { org: orgId, map: new Map([...(same ? prev.map : []), ...got]), seeds: new Map([...kept, ...seeds]) };
          });
      } catch {
        // Unread: the placeholders keep showing seconds.
      }
    })();
    return () => {
      live = false;
    };
  }, [orgId, key]);
  const map = read.org === orgId ? read.map : EMPTY;
  const seeds = read.org === orgId ? read.seeds : NO_SEEDS;
  const asked = new Set(key ? key.split(",") : []);
  return {
    samples: (model) => map.get(model) ?? null,
    seed: (model, capability) => pickSeed(seeds.get(model), capability),
    missing: (model) => (asked.has(model) ? "unread" : "not_asked"),
  };
}

const EMPTY: ReadonlyMap<string, number[]> = new Map();
const NO_SEEDS: ReadonlyMap<string, ProbeSeed[]> = new Map();
