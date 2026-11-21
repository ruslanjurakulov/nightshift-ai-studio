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
  /** null for all channels, else one of `channels[].id`. A channel whose id is literally "all" is an ordinary channel: the two cannot collide. */
  selected: string | null;
  channels: ChannelSummary[];
  platforms: PlatformCard[];
  kpis: Kpis;
  videos: VideoResult[];
  history: HistoryEntry[];
  freshness: Freshness;
  /** Subscribers gained / lost are not stored by the daily poll, so there is nothing to show. Always "not_collected" in this phase. */
  subscribers: "not_collected";
  /**
   * videos: more than MAX_VIDEOS in the period, only the newest are used (the figures cover those only).
   * history: more entries than shown.
   * snapshots: a reading query came back at its row cap even for one video, so some readings may be missing.
   */
  truncated: { videos: boolean; history: boolean; snapshots: boolean };
  sources: { requests: SourceState; accounts: SourceState };
}

export type ResultsError = "not_found" | "invalid_params" | "unauthorized" | "not_configured" | "not_available" | "org_required" | "failed";
