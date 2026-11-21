#!/usr/bin/env node
/**
 * Screenshots only: wraps fake-supabase.mjs and adds made-up rows for the
 * insight and operations pages (events, metrics, signals, alerts, audit,
 * margin), so those pages can be photographed with data in them. Same rules as
 * the fake it wraps: 127.0.0.1, no secret, read only, nothing real.
 *
 *   FAKE=empty|full node tools/visual-qa/fake-insight.mjs      # :54399
 *
 * FAKE=empty passes everything through (the pages' empty states).
 * The session state to use is "videos" (a channel with two uploaded videos).
 */
import http from "node:http";
process.env.FAKE_ADMIN = "1";
const { startFakeSupabase } = await import("./fake-supabase.mjs");

const INNER = Number(process.env.INNER || 54398);
const PORT = Number(process.env.PORT || 54399);
const FULL = (process.env.FAKE || "full") === "full";
await startFakeSupabase(INNER);

const now = Date.now();
const ago = (min) => new Date(now - min * 60_000).toISOString();
const day = (n) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);
const CH = "night-owl";

const VIDEOS = [
  ["v1", "Why octopuses dream in colour", "octopus", 12],
  ["v2", "The lighthouse that never slept", "lighthouse", 15],
  ["v3", "Eight minutes inside a salt mine", "salt", 21],
  ["v4", "The last train from Samarkand", "train", 26],
  ["v5", "What the moon does to tides, honestly", "moon", 30],
  ["v6", "A map that was wrong for 90 years", "maps", 35],
].map(([video_id, title, topic, d]) => ({ channel_id: CH, video_id, title, topic, published_at: ago(d * 1440), privacy: "private", publish_state: "uploaded" }));

const SNAP = [
  ["v1", 18400, 1320, 210, 212, 0.071, 91000],
  ["v2", 9100, 540, 88, 188, 0.058, 60500],
  ["v3", 4300, 150, 31, 141, 0.044, 40200],
  ["v4", 2100, 66, 9, 119, null, null],
  ["v5", 780, 20, 3, null, null, null],
].map(([video_id, views, likes, comment_count, avd, ctr, imp]) => ({ video_id, snapshot_date: day(0), views, likes, comment_count, watch_time_minutes: null, average_view_duration_seconds: avd, impressions: imp, impression_ctr: ctr }));

const EVENTS = (() => {
  const e = [];
  let n = 0;
  const add = (event, agent, status, min, metadata = null, video_id = null, duration_ms = null) =>
    e.push({ event_key: `k${n++}`, channel_id: CH, event, ts: ago(min), video_id, job_id: null, agent, status, duration_ms, metadata });
  add("system.heartbeat", "Scheduler", "completed", 8, { ok: true });
  add("feedback.generated", "FeedbackEngine", "completed", 40, { topics: 6 });
  add("script.completed", "ScriptWriter", "completed", 95, { words: 1180 }, "v4", 41200);
  add("voice.completed", "VoiceAgent", "completed", 92, { seconds: 421 }, "v4", 18800);
  add("media.completed", "MediaAgent", "running", 5, null, "v5");
  add("render.failed", "Renderer", "failed", 130, { cause: "out of memory" }, "v5", 4200);
  add("upload.completed", "Uploader", "completed", 300, { private: true }, "v3", 9100);
  add("analytics.polled", "Analytics", "completed", 22, { videos: 5 });
  add("topic.scored", "TopicManager", "completed", 55, { topic: "salt" });
  add("budget.forecast", "Advisor", "completed", 60, { spent_usd: 18.4, projected_usd: 41.2, ceiling_usd: 60, elapsed_days: 11, days_in_month: 31, projected_exceeds: false, has_unpriced: true });
  add("publish.timing", "Advisor", "completed", 61, { best_hour_utc: 15, best_weekday: 4, best_weekday_name: "Thursday", samples: 5, timezone: "UTC" });
  add("repackage.suggested", "Advisor", "completed", 62, { count: 2, worst: { title: "A map that was wrong for 90 years", video_id: "v6", ctr: 0.021, channel_median_ctr: 0.056 } });
  add("durability.check", "Advisor", "completed", 63, { local_videos: 6, remote_videos: 6, mirrored: true, mirror_configured: true, gap: 0 });
  add("agent.plan", "Autopilot", "completed", 64, { topic: "Why salt built cities", rationale: "Two of the last three salt videos beat the channel's views per day.", source: "proven", video_provider: "clip engine", voice_provider: "voice engine" });
  add("niche.rpm", "Advisor", "completed", 65, { best_niche: "history", niches: [{ niche: "history", tier: 1, avg_views: 7200, rpm_usd: null }, { niche: "nature", tier: 1, avg_views: 5100, rpm_usd: null }] });
  add("publish.blocked", "Gate", "completed", 130, { blocks: ["One claim has no source"], warnings: ["The title is long for a phone"] }, "v5");
  add("publish.allowed", "Gate", "completed", 310, { blocks: [], warnings: [] }, "v3");
  return e;
})();

const SIGNALS = [
  ["v1", "octopus", "HIGH_VIEWS_PER_DAY", 6.1, 2.4, "2.5x the channel's average", 1],
  ["v2", "lighthouse", "HIGH_CTR", 0.058, 0.039, "above baseline", 3],
  ["v6", "maps", "LOW_CTR", 0.021, 0.056, "a third of the baseline", 4],
  ["v5", "moon", "LOW_VIEWS_PER_DAY", 0.6, 2.4, null, 5],
].map(([video_id, topic, signal, metric_value, channel_baseline, detail, d]) => ({ video_id, channel_id: CH, topic, signal, metric_value, channel_baseline, detail, analyzed_date: ago(d * 1440) }));

const TOPICS = [
  ["octopus", 82, 2, "Strong views per day", 6.1], ["lighthouse", 64, 2, "Above average click-through", 3.4],
  ["salt", 48, 1, null, 1.9], ["maps", 31, 1, "Click-through well under baseline", 0.9],
].map(([topic, score, videos_analyzed, reason, avg]) => ({ topic, score, videos_analyzed, avg_views_per_day: avg, reason, updated_at: ago(180) }));

const LEARNINGS = [
  { id: "00000000-0000-4000-8000-0000000000e1", channel_id: CH, kind: "title_pattern", observation: "Titles that open with a question did better than statements on this channel.", evidence: { videos: 5, mean_ctr_question: 0.064, mean_ctr_statement: 0.041 }, confidence: 0.62, status: "pending", created_at: ago(300), decided_at: null, decided_by: null },
  { id: "00000000-0000-4000-8000-0000000000e2", channel_id: CH, kind: "length", observation: "Videos near eight minutes held viewers longer than those over twelve.", evidence: { videos: 4 }, confidence: null, status: "approved", created_at: ago(5000), decided_at: ago(4000), decided_by: "qa" },
];

const ALERTS = [
  { id: "a1", at: ago(20), kind: "publish.blocked", severity: "critical", channel_id: CH, title: "A publish was held by the gate", body: "The script has an unsourced claim; nothing was published.", delivered: true },
  { id: "a2", at: ago(240), kind: "quota.low", severity: "warn", channel_id: CH, title: "Upload quota is running low", body: null, delivered: false },
  { id: "a3", at: ago(2000), kind: "digest.sent", severity: "info", channel_id: null, title: "Weekly digest sent", body: null, delivered: true },
];

const AUDIT = [
  { id: "u1", at: ago(15), actor_user_id: "x", actor_email: "qa@example.com", action: "channel.schedule.update", target: "night-owl", detail: { publish_hour_utc: 15, enabled: true }, channel_id: CH },
  { id: "u2", at: ago(900), actor_user_id: "x", actor_email: "qa@example.com", action: "learning.approve", target: "00000000-0000-4000-8000-0000000000e2", detail: null, channel_id: CH },
  { id: "u3", at: ago(4000), actor_user_id: "x", actor_email: null, action: "member.invite", target: "ana@example.com", detail: { role: "editor" }, channel_id: null },
];

const COSTS = [
  { id: 1, video_id: "v1", channel_id: CH, slug: null, unit: "video_second", quantity: 120, stage: "media", estimated_usd: 0.84, recorded_at: ago(12 * 1440) },
  { id: 2, video_id: "v1", channel_id: CH, slug: null, unit: "tts_characters", quantity: 4200, stage: "voice", estimated_usd: 0.19, recorded_at: ago(12 * 1440) },
  { id: 3, video_id: "v2", channel_id: CH, slug: null, unit: "video_second", quantity: 150, stage: "media", estimated_usd: null, recorded_at: ago(15 * 1440) },
  { id: 4, video_id: "v3", channel_id: CH, slug: null, unit: "tts_characters", quantity: 3100, stage: "voice", estimated_usd: 0.14, recorded_at: ago(21 * 1440) },
];

const RETENTION = [];
for (const v of ["v1", "v2", "v3"]) for (let i = 0; i <= 10; i++) {
  const r = i / 10;
  const w = Math.max(0.12, 1 - 0.5 * r - (r > 0.4 && r < 0.6 ? 0.18 * (r - 0.4) * 5 : r >= 0.6 ? 0.18 : 0) - (v === "v3" ? 0.05 * r : 0));
  RETENTION.push({ video_id: v, elapsed_ratio: r, watch_ratio: w, measured_date: day(0) });
}

const QUEUE = [
  { entry_id: "q1", topic: "Why salt built cities", added_at: ago(600), source: "proven", rationale: "Two of the last three salt videos did well.", status: "queued", channel_id: CH, synced_at: null },
  { entry_id: "q2", topic: "The octopus sequel", added_at: ago(3000), source: "demand", rationale: null, status: "published", channel_id: CH, synced_at: null },
];
const RUNS = [
  { run_id: "run-2026-10-09-salt", topic: "Why salt built cities", current_stage: "voice", human_approved: false, approved_by: null, approved_at: null, history: [], started_at: ago(200), updated_at: ago(90), channel_id: CH, synced_at: null },
];

const MARGIN = [
  { day: day(1), model: "qa-clip-fast", capability: "t2v", jobs_completed: 14, jobs_released: 1, jobs_internal: 0, credits_sold: 560, credits_released: 40, credits_paid: 500, credits_free: 60, credits_unvalued: 0, revenue_usd: 5.6, provider_usd: 3.1, provider_usd_released: 0.2, jobs_uncosted: 0, jobs_released_uncosted: 0, margin_usd: 2.5, margin_pct: 44.6, flags: ["released_jobs", "free_credits"] },
  { day: day(2), model: "qa-clip-best", capability: "t2v", jobs_completed: 6, jobs_released: 0, jobs_internal: 1, credits_sold: 480, credits_released: 0, credits_paid: 480, credits_free: 0, credits_unvalued: 0, revenue_usd: 4.8, provider_usd: null, provider_usd_released: null, jobs_uncosted: 6, jobs_released_uncosted: 0, margin_usd: null, margin_pct: null, flags: ["unpriced_cost", "internal_jobs"] },
  { day: day(3), model: "qa-clip-fast", capability: "i2v", jobs_completed: 3, jobs_released: 0, jobs_internal: 0, credits_sold: 120, credits_released: 0, credits_paid: 0, credits_free: 120, credits_unvalued: 0, revenue_usd: 0, provider_usd: 0.7, provider_usd_released: 0, jobs_uncosted: 0, jobs_released_uncosted: 0, margin_usd: -0.7, margin_pct: null, flags: ["free_credits"] },
];

const TABLES = { videos: VIDEOS, metrics_snapshots: SNAP, system_events: EVENTS, feedback_signals: SIGNALS, topic_performance: TOPICS, channel_topic_performance: TOPICS.map((t) => ({ ...t, channel_id: CH })), learnings: LEARNINGS, alert_events: ALERTS, app_audit_log: AUDIT, video_costs: COSTS, retention_points: RETENTION, content_queue: QUEUE, pipeline_runs: RUNS };

function pass(req, res, body) {
  const p = http.request({ host: "127.0.0.1", port: INNER, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  p.on("error", () => { res.writeHead(502); res.end(); });
  if (body) p.end(body); else req.pipe(p);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)/);
  if (FULL && req.method === "GET" && m) {
    if (url.pathname.includes("/rpc/")) {
      if (m[1] === "rpc") {
        const fn = url.pathname.split("/rpc/")[1];

      }
    } else if (TABLES[m[1]]) {
      let rows = TABLES[m[1]];
      // The one filter the pages lean on: event=in.(a,b).
      const ev = url.searchParams.get("event");
      if (ev && ev.startsWith("in.(")) {
        const names = ev.slice(4, -1).split(",");
        rows = rows.filter((r) => names.includes(r.event));
      }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify(rows));
    }
  }
  if (FULL && req.method === "POST" && url.pathname.endsWith("/rpc/operator_margin_report")) {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify(MARGIN));
  }
  pass(req, res);
}).listen(PORT, "127.0.0.1", () => process.stdout.write(`fake insight (${FULL ? "full" : "empty"}) on :${PORT}\n`));
