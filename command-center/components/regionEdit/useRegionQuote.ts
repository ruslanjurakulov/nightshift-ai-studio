"use client";

import { useEffect, useState } from "react";
import { toWire, type EditorRegion } from "@/lib/regionEdit/geometry";
import type { RegionQuote } from "@/lib/regionEdit/quote";

export type RegionQuoteState =
  | { status: "idle" }
  | { status: "quoting" }
  | { status: "ready"; quote: RegionQuote }
  | { status: "error"; code: string; region: number | null };

const DELAY_MS = 400;

/**
 * The price of the regions as drawn, asked of /api/region-edit/quote (nothing held, nothing spent) a moment after the
 * person stops changing them. `idle` when there is nothing honest to ask: no picture, no model, no region with words.
 * A total is only ever a number the database priced region by region; a failure shows its reason, never a guessed sum.
 */
export function useRegionQuote({
  orgId,
  sourceId,
  model,
  feather,
  regions,
}: {
  orgId: string;
  sourceId: string | null;
  model: string;
  feather: number;
  regions: readonly EditorRegion[];
}): RegionQuoteState {
  const [state, setState] = useState<RegionQuoteState>({ status: "idle" });
  const wire = toWire(regions);
  const key = JSON.stringify({ orgId, sourceId, model, feather, wire });
  const askable = Boolean(sourceId && model && wire.some((r) => r.prompt !== ""));

  useEffect(() => {
    if (!askable) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "quoting" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/region-edit/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ org_id: orgId, source_asset_id: sourceId, model, feather, regions: wire }),
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { quote?: RegionQuote; error?: unknown; region?: unknown };
        if (ctrl.signal.aborted) return;
        if (res.ok && body.quote && typeof body.quote.total === "number") setState({ status: "ready", quote: body.quote });
        else
          setState({
            status: "error",
            code: typeof body.error === "string" ? body.error : "failed",
            region: typeof body.region === "number" ? body.region : null,
          });
      } catch {
        if (!ctrl.signal.aborted) setState({ status: "error", code: "failed", region: null });
      }
    }, DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `key` carries every input; `wire` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, askable]);

  return state;
}
