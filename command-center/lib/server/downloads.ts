import "server-only";
import { existsSync } from "node:fs";
import { createClient } from "@/lib/supabase/server";
import { isCreditExempt, type PriceMap } from "@/lib/credits";
import { readCreditAccount, readCreditPrices } from "@/lib/server/credits";
import {
  DOWNLOAD_REQUEST_COLUMNS,
  coerceDownloadRequests,
  coerceMaster,
  type DownloadMaster,
  type DownloadRequestRow,
} from "@/lib/downloads";

/**
 * Where prepared downloads live on THIS host (deploy/docker-compose.yml mounts
 * the worker's downloads volume read-only at NIGHTSHIFT_DOWNLOADS_DIR). Null on
 * a host without it — Vercel has no shared volume — and then nothing is sold:
 * the route refuses before charging, and the panel offers 480p only.
 */
export function downloadsDir(): string | null {
  const dir = (process.env.NIGHTSHIFT_DOWNLOADS_DIR ?? "").trim();
  if (!dir.startsWith("/")) return null;
  try {
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

export interface DownloadPanelData {
  /** 0030 applied and readable. */
  available: boolean;
  /** This host can serve HD files (the shared volume is mounted). */
  host: boolean;
  master: DownloadMaster | null;
  prices: PriceMap;
  requests: DownloadRequestRow[];
  /** Credits available to the video's organization (null = unknown). */
  balance: number | null;
  exempt: boolean;
}

/**
 * What the Download menu starts from, read as the signed-in user (RLS): the
 * worker-probed master of this video, the download prices, the organization's
 * available credits, and this video's download requests, newest first.
 */
export async function loadDownloads(videoId: string, channelId: string): Promise<DownloadPanelData> {
  const empty: DownloadPanelData = {
    available: false,
    host: downloadsDir() !== null,
    master: null,
    prices: {},
    requests: [],
    balance: null,
    exempt: false,
  };
  const supabase = await createClient();
  if (!supabase) return empty;
  try {
    const [masterRes, reqRes, chRes, prices] = await Promise.all([
      supabase.from("download_masters").select("width,height,duration_seconds,bytes").eq("video_id", videoId).maybeSingle(),
      supabase
        .from("download_requests")
        .select(DOWNLOAD_REQUEST_COLUMNS)
        .eq("video_id", videoId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase.from("channels").select("org_id").eq("channel_id", channelId).maybeSingle(),
      readCreditPrices(supabase),
    ]);
    if (masterRes.error || reqRes.error) return empty;
    const orgId = (chRes.data as { org_id?: string | null } | null)?.org_id ?? null;
    const exempt = isCreditExempt(orgId);
    let balance: number | null = null;
    if (orgId && !exempt) {
      const acc = await readCreditAccount(supabase, orgId);
      // A failed read is an unknown balance (null), never 0.
      balance = acc.failed ? null : acc.account ? acc.account.available : acc.supported ? 0 : null;
    }
    return {
      ...empty,
      available: true,
      master: coerceMaster(masterRes.data),
      prices: prices.prices,
      requests: coerceDownloadRequests(reqRes.data),
      balance,
      exempt,
    };
  } catch {
    return empty;
  }
}
