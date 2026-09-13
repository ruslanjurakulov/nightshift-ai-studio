/**
 * Row shapes mirroring the Supabase tables (supabase/schema.sql at the repo
 * root), which in turn mirror the bot's SQLite state_store. Keep these in sync
 * with that schema.
 */

export interface VideoRow {
  video_id: string;
  /** Which Nightshift channel published it. Backfilled to "default" by migration 0001. */
  channel_id: string;
  topic: string | null;
  title: string | null;
  slug: string | null;
  published_at: string | null;
  privacy: string | null;
  category_id: string | null;
  local_path: string | null;
  /**
   * Which A/B arm this video shipped on ("A" | "B"), or null for anything
   * published before migration 0002. Null is "not part of the experiment",
   * which is why the experiment excludes it rather than assuming A.
   */
  thumbnail_variant: string | null;
  title_variant: string | null;
  /** Which first-30s opening this video shipped (roadmap #60). Null when it
   *  predates the hook experiment — excluded from the readback, never A. */
  hook_variant: string | null;
  /**
   * "long" or "short". A Short is its own YouTube video with its own id and
   * its own metrics, so it is its own row; this is what keeps it from reading
   * as a second long video. Everything published before migration 0003 is
   * "long", which is a fact about the history rather than an assumption.
   */
  video_format: string;
  /** For a Short, the long video it was cut from. Null for a long video. */
  parent_video_id: string | null;
  /**
   * Object path in the private "previews" bucket, or null when the render was
   * not kept (too large, storage unavailable, or pruned to make room). Never a
   * URL — the page mints a short-lived signed one when it needs to play.
   */
  preview_path: string | null;
  /** The narration this video was built from. What a reviewer approves. */
  script_text: string | null;
  /** pending | approved | rejected. "pending" means nobody has looked yet. */
  review_state: string;
}

/** A reviewer's request, waiting for the next run to pick it up. */
export interface ReviewIntentRow {
  id: number;
  channel_id: string;
  video_id: string | null;
  action: "approve" | "regenerate" | "regenerate_script";
  note: string | null;
  created_at: string;
  consumed_at: string | null;
  outcome: string | null;
}

export interface MetricsSnapshotRow {
  video_id: string;
  snapshot_date: string;
  views: number | null;
  likes: number | null;
  comment_count: number | null;
  watch_time_minutes: number | null;
  average_view_duration_seconds: number | null;
  /**
   * Click-through as YouTube reports it. Null means UNKNOWN — the video has
   * not been polled, or the Analytics API did not return the metric. It never
   * means "nobody clicked", so no aggregate here may read it as zero.
   */
  impressions: number | null;
  impression_ctr: number | null;
}

export interface TopicPerformanceRow {
  topic: string;
  score: number;
  videos_analyzed: number;
  avg_views_per_day: number | null;
  reason: string | null;
  updated_at: string;
}

export interface FeedbackSignalRow {
  video_id: string;
  channel_id: string;
  topic: string | null;
  signal: string;
  metric_value: number | null;
  channel_baseline: number | null;
  detail: string | null;
  analyzed_date: string;
}

export interface SystemEventRow {
  event_key: string;
  /**
   * The channel this event belongs to, or null for genuinely global events
   * (system heartbeats, infrastructure). Null is meaningful here — it is not
   * "unknown", it is "not any one channel's doing".
   */
  channel_id: string | null;
  event: string;
  ts: string;
  video_id: string | null;
  job_id: string | null;
  agent: string | null;
  status: string | null;
  duration_ms: number | null;
  metadata: Record<string, unknown> | null;
}

export interface CompetitorSnapshotRow {
  video_id: string;
  channel_id: string;
  title: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  published_at: string | null;
  polled_date: string;
  view_velocity: number | null;
  /**
   * NOTE the two ids: `channel_id` above is the COMPETITOR's YouTube channel
   * (it always has been); this is which of our channels is watching them.
   */
  chronos_channel_id: string;
}

export interface DemandSignalRow {
  id: number;
  channel_id: string;
  topic_phrase: string;
  mention_count: number;
  example_comment_ids: string | null;
  polled_date: string;
}

/**
 * Operational state mirrored for observability (Phase 4, step 1). These two
 * tables mirror what the bot already keeps under history/; nothing reads them
 * back into the pipeline and the publish path is unaffected.
 */
export interface ContentQueueRow {
  entry_id: string;
  topic: string;
  added_at: string;
  source: string | null;
  rationale: string | null;
  status: string;
  channel_id: string;
  synced_at: string | null;
}

export interface PipelineRunStage {
  stage: string;
  timestamp: string;
  note?: string;
}

export interface PipelineRunRow {
  run_id: string;
  topic: string;
  current_stage: string;
  /** The audit-trail flag set by tools/approve_run.py. Nothing gates publishing on it. */
  human_approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  history: PipelineRunStage[] | null;
  started_at: string | null;
  updated_at: string | null;
  channel_id: string;
  synced_at: string | null;
}

/**
 * Multi-channel (Phase 5). See supabase/migrations/0001_multi_channel.sql.
 */

export type ChannelStatus = "ACTIVE" | "PAUSED";

/** Generator settings for one channel. All optional — an omitted field falls
 * back to the bot's own config on the server side. */
export interface ChannelAgentConfig {
  language?: string;
  target_duration_seconds?: number;
  tts_provider?: string;
  elevenlabs_voice_id?: string;
  edge_tts_voice?: string;
  system_prompt?: string;
  niche_rules?: string;
  visual_style_prompt?: string;
  /**
   * YouTube channel ids this channel monitors. A monitoring setting rather than
   * a generator one, kept in the same JSON so a channel's whole configuration
   * lives in one column. Absent means "inherit COMPETITOR_CHANNEL_IDS" (the
   * default channel's legacy behaviour); an explicit [] means "watch nobody".
   */
  competitor_channel_ids?: string[];
}

export interface ChannelScheduleConfig {
  publish_hour_utc?: number | null;
  enabled?: boolean;
}

/**
 * A *reference* to a publishing credential — deliberately never the credential.
 * `ref` names the server-side secret (CHRONOS_YT_TOKEN_<REF>); the token itself
 * exists only on the machine that publishes. There is no field here, and no
 * column in the table, that could hold one.
 */
export interface ChannelCredentialRef {
  provider?: string;
  ref?: string;
  youtube_channel_id?: string;
  /** Public channel facts, read back from YouTube when the channel was
   *  confirmed at creation. Proof the right channel was opened — never a
   *  credential, and never a substitute for the live credential status. */
  youtube_title?: string;
  youtube_thumbnail?: string;
  youtube_custom_url?: string;
  subscriber_count?: string;
  video_count?: string;
  /** When channels.list last answered for this channel. Set together with
   *  `youtube_channel_id`; the pair is what the database checks before it will
   *  let the row be ACTIVE, and what the scheduler checks before it will run
   *  it. Absent means the row is a draft that never resolved to a real
   *  channel. */
  verified_at?: string;
}

export interface ChannelRow {
  channel_id: string;
  name: string;
  niche: string;
  status: ChannelStatus | string;
  agent_config: ChannelAgentConfig | null;
  schedule_config: ChannelScheduleConfig | null;
  credential_ref: ChannelCredentialRef | null;
  /**
   * False (the default) means a rendered video stays private until someone
   * approves it here. True lets the pipeline take it public by itself — still
   * only after the publish gate passes. The gate is in front of both paths.
   */
  auto_publish: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** Credential *health*, written by the bot. Status only — see the note above. */
export interface ChannelCredentialRow {
  channel_id: string;
  provider: string;
  status: "connected" | "not_connected" | "expired" | "error" | string;
  youtube_channel_id: string | null;
  expires_at: string | null;
  last_verified_at: string | null;
  detail: string | null;
  synced_at: string | null;
}

/** Learned topic score, keyed per channel so two channels never collide. */
export interface ChannelTopicPerformanceRow {
  channel_id: string;
  topic: string;
  score: number;
  videos_analyzed: number;
  avg_views_per_day: number | null;
  reason: string | null;
  updated_at: string;
}

/**
 * Measurement (Phase 6). See supabase/migrations/0002_measurement.sql.
 */

/**
 * One measured quantity consumed by one video.
 *
 * `quantity` is always a fact the pipeline observed. `estimated_usd` is only
 * present when the operator configured a rate for that unit (CHRONOS_PRICE_*);
 * null means "we know how much was used, we do not claim to know the price".
 * See modules/cost_ledger.py.
 */
export interface VideoCostRow {
  id: number;
  video_id: string | null;
  channel_id: string;
  slug: string | null;
  unit: string;
  quantity: number;
  stage: string | null;
  estimated_usd: number | null;
  recorded_at: string;
}

/** One point of a video's audience-retention curve. */
export interface RetentionPointRow {
  video_id: string;
  /** 0.0-1.0 through the video. */
  elapsed_ratio: number;
  /** Share of viewers still watching there, or null when not measured. */
  watch_ratio: number | null;
  measured_date: string;
}
