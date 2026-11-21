"use client";

import { useCallback, useEffect, useState } from "react";
import { parseStyleId, type StyleKit } from "@/lib/style-kits";

export type StyleKitsState = "loading" | "ready" | "failed" | "unavailable";

/** What the Style chips need of a kit: its id and its name. */
export interface StyleChoice {
  id: string;
  name: string;
}

/** GET /api/style-kits' body -> the kits that can be picked (anything malformed is left out). */
export function coerceStyleChoices(body: unknown): StyleChoice[] {
  const kits = body && typeof body === "object" ? (body as { kits?: unknown }).kits : undefined;
  if (!Array.isArray(kits)) return [];
  const out: StyleChoice[] = [];
  for (const k of kits as Array<Partial<StyleKit>>) {
    const id = parseStyleId(k?.id);
    if (!id || typeof k.name !== "string" || !k.name.trim()) continue;
    out.push({ id, name: k.name });
  }
  return out;
}

/**
 * The organization's style kits, for the generate panel's Style chips.
 *
 * Reads GET /api/style-kits (the Studio page's own route, under the member's
 * session — RLS returns this organization's kits and nothing else). A 503 is
 * "0047 is not applied here": the chips are then not offered at all, never an
 * empty row that reads as "you have none". What is picked is only an id: the
 * database checks it again when the generation is priced (0048).
 */
export function useStyleKits(orgId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const [state, setState] = useState<StyleKitsState>("loading");
  const [kits, setKits] = useState<StyleChoice[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/style-kits?org=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      if (res.status === 503) {
        setState("unavailable");
        return;
      }
      if (!res.ok) {
        setState("failed");
        return;
      }
      setKits(coerceStyleChoices(await res.json()));
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [orgId]);

  useEffect(() => {
    if (enabled) void load();
  }, [load, enabled]);

  return { state, kits, reload: load };
}
