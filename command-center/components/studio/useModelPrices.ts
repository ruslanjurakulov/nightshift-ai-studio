"use client";

import { useEffect, useState } from "react";
import type { CreativeError } from "@/lib/creative/operations";
import { asCreativeError, SHEET_PRICE_MAX, type ImageQuality, type StudioCapability } from "@/lib/creative/studio";

export type ModelPrice =
  | { status: "quoting" }
  | { status: "ready"; credits: number }
  | { status: "error"; code: CreativeError };

const SHEET_QUOTE_DELAY_MS = 250;

/**
 * One price, asked of the database (/api/creative/quote: nothing held, nothing
 * spent). null = the request was aborted: nobody is waiting for the answer.
 */
async function askPrice(
  orgId: string,
  capability: StudioCapability,
  model: string,
  params: unknown,
  signal: AbortSignal,
): Promise<ModelPrice | null> {
  try {
    const res = await fetch("/api/creative/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: orgId, capability, model, params }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { quote?: { credits?: unknown }; error?: unknown };
    const credits = body.quote?.credits;
    return res.ok && typeof credits === "number" && Number.isFinite(credits)
      ? { status: "ready", credits }
      : { status: "error", code: asCreativeError(body.error) };
  } catch {
    return signal.aborted ? null : { status: "error", code: "failed" };
  }
}

/** The same settings with the model's own tier: a model without tiers is asked without one (the database refuses a tier it does not list). */
function withTier(paramsKey: string, tier: ImageQuality | null | undefined): Record<string, unknown> {
  const params = JSON.parse(paramsKey) as Record<string, unknown>;
  delete params.quality;
  if (tier) params.quality = tier;
  return params;
}

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
  tierFor,
}: {
  open: boolean;
  orgId: string;
  capability: StudioCapability;
  modelIds: string[];
  selectedId: string;
  params: Record<string, unknown> | null;
  /** Each model's own tier (0060) for a picture tool; absent or null = ask without one. */
  tierFor?: Record<string, ImageQuality | null>;
}): Record<string, ModelPrice> {
  const [prices, setPrices] = useState<Record<string, ModelPrice>>({});
  const tiersKey = JSON.stringify(tierFor ?? {});
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
          const tiers = JSON.parse(tiersKey) as Record<string, ImageQuality | null>;
          const next = await askPrice(orgId, capability, id, withTier(paramsKey, tiers[id]), ctrl.signal);
          if (next && !ctrl.signal.aborted) setPrices((p) => ({ ...p, [id]: next }));
        })();
      }
    }, SHEET_QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, orgId, capability, idsKey, paramsKey, tiersKey]);

  return prices;
}

/**
 * The price of each quality tier (0060) of the picked model, for the same
 * settings — the selector shows what each tier would cost before the person
 * picks one. Each is a real quote from the database (a price, nothing held,
 * nothing spent); a tier that cannot be priced says so (`unpriced`) rather
 * than showing a number nobody computed. `params` null (no picture yet, or no
 * honest price can be asked for) = no entries.
 */
export function useTierPrices({
  orgId,
  capability,
  modelId,
  tiers,
  params,
}: {
  orgId: string;
  capability: StudioCapability;
  modelId: string;
  tiers: readonly ImageQuality[];
  params: Record<string, unknown> | null;
}): Partial<Record<ImageQuality, ModelPrice>> {
  const [prices, setPrices] = useState<Partial<Record<ImageQuality, ModelPrice>>>({});
  const paramsKey = params ? JSON.stringify(params) : "";
  const tiersKey = tiers.join(",");

  useEffect(() => {
    if (!paramsKey || !tiersKey || !modelId) {
      setPrices({});
      return;
    }
    const list = tiersKey.split(",") as ImageQuality[];
    setPrices(Object.fromEntries(list.map((q) => [q, { status: "quoting" } as ModelPrice])));
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      for (const q of list) {
        void (async () => {
          const next = await askPrice(orgId, capability, modelId, withTier(paramsKey, q), ctrl.signal);
          if (next && !ctrl.signal.aborted) setPrices((p) => ({ ...p, [q]: next }));
        })();
      }
    }, SHEET_QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [orgId, capability, modelId, tiersKey, paramsKey]);

  return prices;
}

/** The models priced: the picked one first, then the list's order, at most SHEET_PRICE_MAX. */
export function pricedIds(modelIds: string[], selectedId: string): string[] {
  const rest = modelIds.filter((id) => id !== selectedId);
  const head = modelIds.includes(selectedId) ? [selectedId] : [];
  return [...head, ...rest].slice(0, SHEET_PRICE_MAX);
}
