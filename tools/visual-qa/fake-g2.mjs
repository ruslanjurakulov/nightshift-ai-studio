#!/usr/bin/env node
/**
 * Made-up rows for the channel and library pages (Channels, Accounts, Portfolio, Series, Topics, Memory, Styles,
 * Models, Providers, Integrations), laid over tools/visual-qa/fake-supabase.mjs so those pages can be photographed
 * with something on them. Screenshots only: read-only, binds to 127.0.0.1, holds no secret, spends nothing.
 *
 *   node tools/visual-qa/fake-g2.mjs          # :54427, with the plain fake on :54428 behind it
 *   (build or `next dev` the app with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54427)
 *   node tools/visual-qa/visual-qa.mjs --fake-session http://127.0.0.1:54427 --fake-state g2 ...
 *
 * States (the session's "qa" claim): `g2` is a customer with two channels and some history, `g2new` is a person
 * with nothing yet, and either may end in `:admin` to be a platform admin (the operator screens are theirs).
 */
import http from "node:http";
import { startFakeSupabase } from "./fake-supabase.mjs";

const PORT = Number(process.env.PORT || 54427);
const UPSTREAM = PORT + 1;

const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ORG = "00000000-0000-4000-8000-0000000000b1";

const CHANNELS = [
  {
    channel_id: "night-owl", name: "Night Owl", niche: "Sea creatures and strange coasts", status: "ACTIVE", org_id: ORG,
    agent_config: { target_duration_seconds: 120, language: "en", tts_provider: "edge", edge_tts_voice: "en-US-AriaNeural", visual_style_prompt: "Slow dark water, soft light from above, no faces.", storyboard_review: true },
    schedule_config: { enabled: true, publish_hour_utc: 16 },
    credential_ref: { verified_at: ago(40 * DAY), youtube_channel_id: "UC_visual_qa_fake", youtube_custom_url: "@nightowl" },
    auto_publish: false, dna_format: "documentary", dna_aspect: "16:9", dna_tone: "Quiet, curious, never loud.", created_at: ago(90 * DAY), updated_at: ago(2 * DAY),
  },
  {
    channel_id: "quiet-harbour", name: "Quiet Harbour", niche: "Slow stories of ports and ships", status: "PAUSED", org_id: ORG,
    agent_config: { target_duration_seconds: 480, language: "en" },
    schedule_config: { enabled: false },
    credential_ref: null, auto_publish: false, created_at: ago(20 * DAY), updated_at: ago(5 * DAY),
  },
];

const videos = [
  ["v1", "night-owl", "Why octopuses dream in colour", "octopus", 1], ["v2", "night-owl", "The lighthouse that never slept", "lighthouse", 4],
  ["v3", "night-owl", "What lives under a frozen lake", "lake", 9], ["v4", "night-owl", "The coast that moves every night", "coast", 15],
  ["v5", "quiet-harbour", "The last ferry of the winter", "ferry", 12],
].map(([video_id, channel_id, title, topic, d]) => ({ video_id, channel_id, title, topic, slug: video_id, published_at: ago(d * DAY), privacy: "public", publish_state: "uploaded", format: "long" }));

const TABLES = {
  channels: CHANNELS,
  channel_credentials: [{ channel_id: "night-owl", provider: "youtube", status: "connected", youtube_channel_id: "UC_visual_qa_fake", expires_at: null, last_verified_at: ago(2 * DAY), detail: null, synced_at: ago(DAY) }],
  videos,
  metrics_snapshots: [
    { video_id: "v1", snapshot_date: ago(DAY).slice(0, 10), views: 12840, likes: 910, comment_count: 64, watch_time_minutes: 5200, average_view_duration_seconds: 71, impressions: 90000, impression_ctr: 0.061 },
    { video_id: "v2", snapshot_date: ago(DAY).slice(0, 10), views: 8120, likes: 540, comment_count: 31, watch_time_minutes: 3100, average_view_duration_seconds: 66, impressions: 61000, impression_ctr: 0.052 },
    { video_id: "v3", snapshot_date: ago(DAY).slice(0, 10), views: 3310, likes: 190, comment_count: 12, watch_time_minutes: 1200, average_view_duration_seconds: 58, impressions: 30000, impression_ctr: 0.044 },
  ],
  content_queue: [
    { entry_id: "q1", topic: "The salt road under the sea", added_at: ago(DAY), source: "intel", rationale: null, status: "queued", channel_id: "night-owl", synced_at: ago(DAY) },
    { entry_id: "q2", topic: "A harbour that sank twice", added_at: ago(2 * DAY), source: "intel", rationale: null, status: "queued", channel_id: "night-owl", synced_at: ago(DAY) },
  ],
  system_events: [
    { event_key: "e1", channel_id: "night-owl", event: "upload.completed", ts: ago(DAY).replace(/Z$/, ""), video_id: "v1", job_id: null, agent: "uploader", status: "ok", duration_ms: 1200, metadata: null },
    { event_key: "e2", channel_id: "night-owl", event: "script.completed", ts: ago(2 * DAY).replace(/Z$/, ""), video_id: null, job_id: null, agent: "writer", status: "ok", duration_ms: 900, metadata: null },
    { event_key: "e3", channel_id: "night-owl", event: "feedback.generated", ts: ago(5 * DAY).replace(/Z$/, ""), video_id: null, job_id: null, agent: "feedback", status: "ok", duration_ms: 400, metadata: null },
    { event_key: "e4", channel_id: "quiet-harbour", event: "upload.failed", ts: ago(6 * DAY).replace(/Z$/, ""), video_id: null, job_id: null, agent: "uploader", status: "failed", duration_ms: 300, metadata: null },
    { event_key: "e5", channel_id: null, event: "system.heartbeat", ts: ago(60_000).replace(/Z$/, ""), video_id: null, job_id: null, agent: "system", status: "ok", duration_ms: null, metadata: null },
    { event_key: "e6", channel_id: "night-owl", event: "revenue.tracked", ts: ago(3 * DAY).replace(/Z$/, ""), video_id: null, job_id: null, agent: "revenue", status: "ok", duration_ms: null, metadata: { total_usd: 184.2, channel_rpm_usd: 3.4, measured_count: 3, video_count: 4, currency: "USD", top_earners: [] } },
  ],
  video_costs: [
    { id: 1, video_id: "v1", channel_id: "night-owl", slug: "v1", unit: "video_minute", quantity: 2, stage: "render", estimated_usd: 6.4, recorded_at: ago(DAY) },
    { id: 2, video_id: "v2", channel_id: "night-owl", slug: "v2", unit: "video_minute", quantity: 2, stage: "render", estimated_usd: 6.1, recorded_at: ago(4 * DAY) },
    { id: 3, video_id: "v5", channel_id: "quiet-harbour", slug: "v5", unit: "video_minute", quantity: 8, stage: "render", estimated_usd: 22.8, recorded_at: ago(12 * DAY) },
  ],
  content_series: [
    { series_id: "s1", channel_id: "night-owl", name: "Strange coasts", description: "One coastline a week, told slowly.", niche: "Coasts", language: "en", format: "long", content_type: "documentary", visual_style: "Slow dark water", voice_style: "Calm", cadence: { long_per_week: 1 }, platforms: ["youtube"], automation_level: "autopilot_approval", status: "ACTIVE", created_at: ago(60 * DAY), updated_at: ago(3 * DAY) },
    { series_id: "s2", channel_id: "night-owl", name: "One minute under", description: "A single sea creature in a minute.", niche: "Sea life", language: "en", format: "short", content_type: "short", visual_style: "Macro", voice_style: "Warm", cadence: { shorts_per_day: 1 }, platforms: ["youtube", "tiktok"], automation_level: "assisted", status: "PAUSED", created_at: ago(30 * DAY), updated_at: ago(9 * DAY) },
    { series_id: "s3", channel_id: "quiet-harbour", name: "Winter ferries", description: null, niche: "Ships", language: "en", format: "long", content_type: "documentary", visual_style: null, voice_style: null, cadence: {}, platforms: ["youtube"], automation_level: "manual", status: "ACTIVE", created_at: ago(14 * DAY), updated_at: ago(14 * DAY) },
  ],
  topic_performance: [],
  channel_topic_performance: [
    ["octopus colour change", 84, 3, 2400.5, "Beat the channel's usual views by a wide margin"], ["lighthouse keepers", 71, 2, 1100, "Strong watch time, steady views"],
    ["frozen lake life", 52, 1, 640, "Good first week; no second video to confirm"], ["ship graveyards", 33, 2, 210.2, "Views below the channel's usual"], ["tide tables", 18, 1, 90, null],
  ].map(([topic, score, videos_analyzed, avg_views_per_day, reason]) => ({ channel_id: "night-owl", topic, score, videos_analyzed, avg_views_per_day, reason, updated_at: ago(2 * DAY) })),
  demand_signals: [
    ["how do octopuses sleep", 41], ["why is the sea salty", 27], ["lighthouse keeper stories", 19], ["deepest lake in the world", 12],
  ].map(([topic_phrase, mention_count], i) => ({ id: i + 1, channel_id: "night-owl", topic_phrase, mention_count, example_comment_ids: null, polled_date: ago((i + 1) * DAY) })),
  feedback_signals: [
    { video_id: "v1", channel_id: "night-owl", topic: "octopus colour change", signal: "outperformed", metric_value: 12840, channel_baseline: 6200, detail: "Views ran twice the channel's usual.", analyzed_date: ago(DAY) },
    { video_id: "v2", channel_id: "night-owl", topic: "lighthouse keepers", signal: "held_viewers", metric_value: 66, channel_baseline: 60, detail: "Viewers stayed longer than usual.", analyzed_date: ago(3 * DAY) },
    { video_id: "v4", channel_id: "night-owl", topic: "ship graveyards", signal: "underperformed", metric_value: 900, channel_baseline: 6200, detail: "Views well under the channel's usual.", analyzed_date: ago(8 * DAY) },
  ],
  worker_status: [
    { worker_id: "media-1", kind: "media", state: "running", detail: "Idle, waiting for work", version: "2026.10.1", started_at: ago(2 * DAY), updated_at: ago(20_000) },
    { worker_id: "creative-1", kind: "creative", state: "running", detail: null, version: "2026.10.1", started_at: ago(2 * DAY), updated_at: ago(15_000) },
    { worker_id: "pipeline-1", kind: "pipeline", state: "failed", detail: "Lost its connection", version: "2026.10.1", started_at: ago(DAY), updated_at: ago(40 * 60_000) },
  ],
};
// Models a workspace may use (sellable_models) and their rates (credit_rates), named for what they make, never for a vendor.
const spec = (output, unit, extra = {}) => ({ output, unit, inputs: { image_refs_max: 1 }, limits: { max_prompt_chars: 2000, max_concurrent_per_org: 1 }, api_exposure: "any", ...extra });
const SELLABLE = [
  { id: "qa-quick-clip", display_name: "Quick clip", provider: "qa", capabilities: ["t2v", "i2v"], credit_unit: "model_quick_clip_second", credits_per_unit: 3, spec: spec("video", "second", { aspect_ratios: ["16:9", "9:16"], resolutions: ["720p"], default_resolution: "720p", durations_s: [5, 10], audio_out: true, quality_tier: 3, speed_tier: 4 }) },
  { id: "qa-best-clip", display_name: "Best clip", provider: "qa", capabilities: ["t2v", "i2v"], credit_unit: "model_best_clip_second", credits_per_unit: 7, spec: spec("video", "second", { aspect_ratios: ["16:9", "9:16"], resolutions: ["1080p"], default_resolution: "1080p", durations_s: [5, 10], audio_out: true, quality_tier: 5, speed_tier: 2 }) },
  { id: "qa-still", display_name: "Still maker", provider: "qa", capabilities: ["t2i", "edit"], credit_unit: "model_still_image", credits_per_unit: 2, spec: spec("image", "image", { aspect_ratios: ["1:1", "16:9"], inputs: { image_refs_max: 8 } }) },
  { id: "qa-voice", display_name: "Narrator", provider: "qa", capabilities: ["tts"], credit_unit: "model_voice_character", credits_per_unit: 0.02, spec: spec("audio", "character", {}) },
].map((m) => ({ availability: "ga", verified_at: "2026-09-30T10:00:00Z", entitlement: null, margin: null, ...m }));
const RATES = [...SELLABLE.map((m) => ({ unit: m.credit_unit, credits_per_unit: m.credits_per_unit, margin: 0, note: null, updated_at: ago(DAY) })), { unit: "video_minute", credits_per_unit: 60, margin: 0, note: null, updated_at: ago(DAY) }];

// A person with nothing yet: the plain fake already answers `new` with no channel; these stay empty too.
const EMPTY = new Set(["g2new"]);

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}
function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The state this session carries, and the same request with the state the plain fake knows. */
function split(req) {
  const m = /^Bearer\s+([^.]+)\.([^.]+)\.(.*)$/.exec(String(req.headers.authorization || ""));
  if (!m) return { qa: "", admin: false, auth: req.headers.authorization };
  let claims;
  try {
    claims = b64urlJson(m[2]);
  } catch {
    return { qa: "", admin: false, auth: req.headers.authorization };
  }
  const raw = String(claims.qa || "");
  const admin = raw.endsWith(":admin");
  const qa = admin ? raw.slice(0, -6) : raw;
  const base = qa === "g2" ? "videos" : qa === "g2new" ? "new" : qa;
  const next = { ...claims, ...(base ? { qa: base } : {}) };
  if (!base) delete next.qa;
  return { qa, admin, auth: `Bearer ${m[1]}.${b64url(JSON.stringify(next))}.${m[3]}` };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const { qa, admin, auth } = split(req);
  const mine = qa === "g2" || qa === "g2new";
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)/);
  if (mine && rpc && rpc[1] === "is_platform_admin") return send(res, 200, admin);
  if (qa === "g2" && rpc && rpc[1] === "sellable_models") return send(res, 200, SELLABLE);
  if (qa === "g2" && rpc && rpc[1] === "credit_rates") return send(res, 200, RATES);
  const table = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)/);
  if (mine && !rpc && table && req.method === "GET" && table[1] in TABLES) {
    let rows = EMPTY.has(qa) ? [] : TABLES[table[1]];
    // The simple filters PostgREST is asked for: `col=eq.value` and `col=is.null`.
    for (const [k, v] of url.searchParams) {
      if (v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      else if (v === "is.null") rows = rows.filter((r) => r[k] === null || r[k] === undefined);
    }
    const single = String(req.headers.accept || "").includes("vnd.pgrst.object");
    if (single) return rows.length ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "0 rows" });
    return send(res, 200, rows);
  }
  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM}` };
  if (auth) headers.authorization = auth;
  const up = http.request({ host: "127.0.0.1", port: UPSTREAM, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => send(res, 502, { message: "fake upstream is down" }));
  req.pipe(up);
});

await startFakeSupabase(UPSTREAM);
server.listen(PORT, "127.0.0.1", () => process.stdout.write(`fake supabase (g2 rows) on http://127.0.0.1:${PORT}\n`));
