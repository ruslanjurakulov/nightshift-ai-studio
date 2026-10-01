"use client";

import { useEffect, useState } from "react";
import type { CreativeError } from "@/lib/creative/operations";
import { asCreativeError, SHEET_PRICE_MAX, type StudioCapability } from "@/lib/creative/studio";

export type ModelPrice =
  | { status: "quoting" }
  | { status: "ready"; credits: number }
  | { status: "error"; code: CreativeError };

const SHEET_QUOTE_DELAY_MS = 250;

/**
 * Each model's price for the current settings, asked of the database
 * (/api/creative/quote — a price, nothing held, nothing spent) only while the
 * model sheet is open, after a short pause, for at most SHEET_PRICE_MAX
 * models (the picked one always among them). A model past that limit, or a
 * form that cannot be priced yet (`params` null), has no entry: the sheet
 * says why instead of showing a number nobody computed.
 */
export function useModelPrices({
  open,
  orgId,
  capability,
  modelIds,
  selectedId,
  params,
}: {
  open: boolean;
  orgId: string;
  capability: StudioCapability;
  modelIds: string[];
  selectedId: string;
  params: Record<string, unknown> | null;
}): Record<string, ModelPrice> {
  const [prices, setPrices] = useState<Record<string, ModelPrice>>({});
  const paramsKey = params ? JSON.stringify(params) : "";
  const ids = pricedIds(modelIds, selectedId);
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!open || !paramsKey || !idsKey) {
      setPrices({});
      return;
    }
    const list = idsKey.split(",");
    setPrices(Object.fromEntries(list.map((id) => [id, { status: "quoting" } as ModelPrice])));
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      for (const id of list) {
        void (async () => {
          let next: ModelPrice;
          try {
            const res = await fetch("/api/creative/quote", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ org_id: orgId, capability, model: id, params: JSON.parse(paramsKey) }),
              signal: ctrl.signal,
            });
            const body = (await res.json().catch(() => ({}))) as { quote?: { credits?: unknown }; error?: unknown };
            const credits = body.quote?.credits;
            next =
              res.ok && typeof credits === "number" && Number.isFinite(credits)
                ? { status: "ready", credits }
                : { status: "error", code: asCreativeError(body.error) };
          } catch {
            if (ctrl.signal.aborted) return;
            next = { status: "error", code: "failed" };
          }
          if (!ctrl.signal.aborted) setPrices((p) => ({ ...p, [id]: next }));
        })();
      }
    }, SHEET_QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, orgId, capability, idsKey, paramsKey]);

  return prices;
}

/** The models priced: the picked one first, then the list's order, at most SHEET_PRICE_MAX. */
export function pricedIds(modelIds: string[], selectedId: string): string[] {
  const rest = modelIds.filter((id) => id !== selectedId);
  const head = modelIds.includes(selectedId) ? [selectedId] : [];
  return [...head, ...rest].slice(0, SHEET_PRICE_MAX);
}
