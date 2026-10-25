/**
 * What /api/results answers and the page draws: client-safe types only (no server import), so the route, the loader, the
 * component and the tests all name the same shape.
 */
import type { Freshness, HistoryEntry, Kpis, RangeDays, VideoResult } from "@/lib/resultsDashboard/aggregate";
import type { PlatformCard } from "@/lib/resultsDashboard/platforms";

export interface ChannelSummary {
  id: string;
  name: string;
  /** A usable YouTube token is on record right now (lib/connectedAccounts.ts's rule). Results already stored stay readable either way. */
  connected: boolean;
}

/** Each secondary source says whether it could be read; the page words a gap instead of showing an empty list. */
export type SourceState = "ok" | "unavailable" | "failed";

export interface ResultsPayload {
  /** ISO time the server built this answer: every number below is as of the readings, this is when it was assembled. */
  generatedAt: string;
  rangeDays: RangeDays;
  /** "all" or one of `channels[].id`. */
  selected: string;
  channels: ChannelSummary[];
  platforms: PlatformCard[];
  kpis: Kpis;
  videos: VideoResult[];
  history: HistoryEntry[];
  freshness: Freshness;
  /** Subscribers gained / lost are not stored by the daily poll, so there is nothing to show. Always "not_collected" in this phase. */
  subscribers: "not_collected";
  truncated: { videos: boolean; history: boolean };
  sources: { requests: SourceState; accounts: SourceState };
}

export type ResultsError = "not_found" | "invalid_params" | "unauthorized" | "not_configured" | "not_available" | "org_required" | "failed";
