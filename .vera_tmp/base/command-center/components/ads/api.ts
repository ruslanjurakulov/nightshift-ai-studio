import { fmt } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import { ADS_LIMITS, type AdCampaign, type AdsError, type BrandKit } from "@/lib/adsFactory/model";

/** What a call to /api/ads/* came back with: the body, or the route's closed error word (and the cap the database named, if any). */
export type AdsResult<T> = { ok: true; data: T } | { ok: false; error: AdsError; max?: number };

export interface AdsPayload {
  org: string;
  kits: BrandKit[];
  campaigns: AdCampaign[];
}

/**
 * One request to the Ads routes. Same-origin, the session cookie only; a body that is not our JSON, a network failure and a status
 * with no error word are all `failed`, never a made-up success.
 */
export async function adsRequest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<AdsResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: unknown; max?: unknown }) | null;
    if (!res.ok || !json) {
      const error = typeof json?.error === "string" ? (json.error as AdsError) : "failed";
      return typeof json?.max === "number" && Number.isFinite(json.max) ? { ok: false, error, max: json.max } : { ok: false, error };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** The length a "too long" sentence names, where the sentence names one. */
const MAX_FOR: Partial<Record<AdsError, number>> = {
  invalid_name: ADS_LIMITS.kitName,
  invalid_title: ADS_LIMITS.productTitle,
  invalid_headline: ADS_LIMITS.headline,
};

/**
 * A refusal in the reader's language. A limit is stated with a number only when the database gave one (rule 5: a default is never
 * shown as a measurement); an error word this version has no sentence for reads as the plain "that did not work".
 */
export function adsErrorText(t: Dictionary["adsFactory"], failure: { error: AdsError; max?: number }): string {
  if (failure.error === "limit_reached" && typeof failure.max === "number") return fmt(t.errors.limit_reached_max, { max: failure.max });
  const text = (t.errors as Record<string, string>)[failure.error] ?? t.errors.failed;
  return fmt(text, { max: MAX_FOR[failure.error] ?? "" });
}

/** A fresh id for one press of "add drafts": a retry of the SAME press reuses it, so the database answers the first one. */
export function newBatchKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `ads-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
