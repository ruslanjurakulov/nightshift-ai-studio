#!/usr/bin/env node
/**
 * A stand-in Supabase for looking at the SIGNED-IN customer shell in a
 * browser without a database: it answers the handful of auth and PostgREST
 * calls the app layout makes with fixed, made-up rows (one organization, one
 * channel, a credit balance), and an empty list for everything else.
 *
 * Screenshots only. Binds to 127.0.0.1, holds no secret (the "anon key" the
 * app is built with is the literal string below, not a key), spends nothing,
 * writes nothing. Every write (POST/PATCH/DELETE other than the read-only
 * RPCs listed) is refused with 403, so a page cannot be tricked into
 * believing an action worked.
 *
 *   node tools/visual-qa/fake-supabase.mjs            # :54399
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && npx next start -p 3417
 *   node tools/visual-qa/visual-qa.mjs --base http://localhost:3417 --fake-session --pages /night-owl/home
 *
 * (NEXT_PUBLIC_* are inlined at build time: rebuild without them afterwards.)
 *
 * The Usage page (migration 0094) has states a real account is in only some of
 * the time, so the signed-in session can carry one: `sessionCookie(url, state)`
 * puts the state name in the (unsigned) token and the fake answers
 * usage_summary / billing_summary for that state. `set_use_extra_credits` is
 * answered and remembered per state, in memory, so the switch can be pressed.
 * States: sub0 (0% used), sub62, sub100 (extra on), sub100off (all plan credits
 * used, extra credits off with a pack waiting), zeroextra (62%, no pack), flip (62%,
 * for pressing the switch),
 * free (Free, welcome credits left), nolot (live plan, no credits added yet),
 * ended (live plan, last period's credits expired), off62 (62%, switch off).
 *
 * The app screens (Home, Create, the Studio clip desk) have their own states,
 * named for what a person is in: `new` (nothing yet: no channel, no videos, no
 * jobs), `videos` (a channel with videos made, one video and one storyboard waiting for approval),
 * `running` (a clip being made right now), `low` (a few credits left),
 * `extraoff` (extra credits switched off), `unpriced` (no price is set: the
 * estimate and the clip price are unknown, never 0). The Settings → Account and
 * security section (migration 0096) has three: `acct` (no @username yet),
 * `acct_handle` (has @ana.k, free to change) and `acct_cool` (changed 10 days
 * ago: the next change date is shown). The username check answers true for
 * every well-formed name except a few made-up held ones (see TAKEN_HANDLES),
 * from handle_available (signed in) and handle_available_public (the sign-up
 * form, through the app's own route). `FAKE_MODELS=1` is not
 * needed: every state but `new` offers two made-up clip models so the clip
 * desk has a price to show.
 */
import http from "node:http";

export const FAKE_URL_DEFAULT = "http://127.0.0.1:54399";
export const FAKE_ANON = "visual-qa-not-a-key";

const USER = {
  id: "00000000-0000-4000-8000-0000000000aa",
  aud: "authenticated",
  role: "authenticated",
  email: "qa@example.com",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

const ORG = { id: "00000000-0000-4000-8000-0000000000b1", name: "QA Studio", slug: "qa-studio", role: "owner", is_default: false };
const CHANNEL = {
  channel_id: "night-owl",
  name: "Night Owl",
  org_id: ORG.id,
  status: "ACTIVE",
  youtube_channel_id: "UC_visual_qa_fake",
  // A channel YouTube has answered for (rule 7): without this it is a draft and never runs.
  credential_ref: { verified_at: "2026-09-01T08:00:00Z", youtube_channel_id: "UC_visual_qa_fake" },
  auto_publish: false,
  // A length to price a run by (the Create page's estimate line).
  agent_config: { target_duration_seconds: 120 },
};

/** The signed-in user; with `avatarV` the profile photo's version marker is in the metadata (the layout reads it from /auth/v1/user). */
function userFor(avatarV) {
  return avatarV ? { ...USER, user_metadata: { avatar_v: avatarV } } : USER;
}

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The @supabase/ssr session cookie for a fake signed-in session against `url`. */
export function sessionCookie(url = FAKE_URL_DEFAULT, state = "", avatarV = 0, extra = {}) {
  const host = new URL(url).hostname.split(".")[0];
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const claims = { sub: USER.id, exp, role: "authenticated", aud: "authenticated", ...(state ? { qa: state } : {}), ...(avatarV ? { av: avatarV } : {}), ...extra };
  const jwt = [b64url(JSON.stringify({ alg: "none", typ: "JWT" })), b64url(JSON.stringify(claims)), "unsigned"].join(".");
  const session = { access_token: jwt, token_type: "bearer", expires_in: 86400, expires_at: exp, refresh_token: "visual-qa", user: userFor(avatarV) };
  return { name: `sb-${host}-auth-token`, value: "base64-" + b64url(JSON.stringify(session)) };
}

const DAY = 86_400_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

// One account per state: [plan id, credits granted this period, spent, held, extra (pack) credits, bonus credits, extra switch].
const STATES = {
  sub0: { plan: "creator", granted: 2000, spent: 0, held: 0, extra: 500, bonus: 0, on: true },
  sub62: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
  // The same account, for pressing the switch in a screenshot run without changing sub62 for the others.
  flip: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 500, bonus: 0, on: true },
  sub100: { plan: "creator", granted: 2000, spent: 2000, held: 0, extra: 500, bonus: 0, on: true },
  sub100off: { plan: "creator", granted: 2000, spent: 2000, held: 0, extra: 500, bonus: 0, on: false },
  zeroextra: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 0, bonus: 0, on: true },
  off62: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 500, bonus: 0, on: false },
  free: { plan: "free", granted: 0, spent: 0, held: 0, extra: 0, bonus: 100, on: true },
  nolot: { plan: "creator", granted: null, spent: 0, held: 0, extra: 0, bonus: 0, on: true },
  ended: { plan: "creator", granted: null, ended: true, spent: 0, held: 0, extra: 500, bonus: 0, on: true },
  // The app-screen states (see the header).
  new: { plan: "free", granted: 0, spent: 0, held: 0, extra: 0, bonus: 100, on: true },
  videos: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
  running: { plan: "creator", granted: 2000, spent: 1240, held: 240, extra: 500, bonus: 100, on: true },
  low: { plan: "creator", granted: 2000, spent: 1980, held: 0, extra: 0, bonus: 0, on: true },
  // The Studio canvas (tools/visual-qa/studio-canvas.mjs): the account of `videos`, with a library and three canvas jobs.
  canvas: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
  extraoff: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 500, bonus: 0, on: false },
  unpriced: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 500, bonus: 100, on: true },
  // The platform owner's view (FAKE_ADMIN is implied): two organizations, two channels, events, workers, alerts, balances.
  owner: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
  // Settings → Account and security (0096): the account of `videos`, with or without an @username.
  acct: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
  acct_handle: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
  acct_cool: { plan: "creator", granted: 2000, spent: 1240, held: 180, extra: 500, bonus: 100, on: true },
};
const PLANS = {
  free: { id: "free", name: "Free", monthly_credits: 0, is_default: true, sort_order: 0, slots: 1, priority: 0, api: false },
  creator: { id: "creator", name: "Plus", monthly_credits: 2000, is_default: false, sort_order: 1, slots: 2, priority: 1, api: true },
  pro: { id: "pro", name: "Pro", monthly_credits: 6000, is_default: false, sort_order: 2, slots: 4, priority: 2, api: true },
};
const switchState = new Map(); // state -> switch pressed in this process

function claimsOf(req) {
  const m = /^Bearer\s+[^.]+\.([^.]+)\./.exec(String(req.headers.authorization || ""));
  if (!m) return {};
  try {
    return JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) || {};
  } catch {
    return {};
  }
}
function stateOf(req) {
  return claimsOf(req).qa || "";
}

function accountFor(state) {
  const st = STATES[state];
  if (!st) return null;
  const on = switchState.has(state) ? switchState.get(state) : st.on;
  const live = st.plan !== "free";
  const left = st.granted === null ? 0 : st.granted - st.spent - st.held;
  const spendable = left + st.bonus + (on ? st.extra : 0);
  return { st, on, live, left, spendable, plan: PLANS[st.plan] };
}

function usageSummary(state) {
  const a = accountFor(state);
  if (!a) return null;
  const { st, plan } = a;
  const end = iso(21 * DAY);
  return {
    exempt: false,
    extra_enabled: a.on,
    plan: { id: plan.id, name: plan.name, monthly_credits: plan.monthly_credits, is_default: plan.is_default },
    subscription: a.live ? { status: "active", current_period_start: iso(-9 * DAY), current_period_end: end, cancel_at_period_end: false } : null,
    plan_credits:
      a.live && st.granted !== null
        ? { granted: st.granted, spent: st.spent, held: st.held, left: a.left, period_start: iso(-9 * DAY), period_end: end }
        : null,
    last_plan_period_end: a.live && (st.granted !== null || st.ended) ? iso(st.ended ? -2 * DAY : 21 * DAY) : null,
    extra_credits: { available: st.extra, soonest_expiry: st.extra > 0 ? iso(300 * DAY) : null },
    bonus_credits: { available: st.bonus, soonest_expiry: null },
    spendable_now: a.spendable,
    run_slots: { exempt: false, limit: plan.slots, active: state === "sub62" ? 1 : 0 },
    entitlements: { concurrency: plan.slots, queue_priority: plan.priority, api_access: plan.api },
  };
}

function billingSummary(state) {
  const a = accountFor(state);
  if (!a) return null;
  const { st, plan } = a;
  return {
    exempt: false,
    plan: { id: plan.id, name: plan.name, monthly_credits: plan.monthly_credits, is_default: plan.is_default },
    subscription: a.live
      ? { plan_id: plan.id, status: "active", current_period_end: iso(21 * DAY), cancel_at_period_end: false, manageable: true }
      : null,
    credits: { subscription: Math.max(a.left, 0), pack: st.extra, other: st.bonus, held: st.held },
    next_expiry: null,
    run_slots: { limit: plan.slots, active: 0 },
  };
}

function creditAccountFor(state) {
  const a = accountFor(state);
  if (!a) return { org_id: ORG.id, balance: 1240, reserved: 180 };
  const balance = Math.max(a.left, 0) + a.st.held + a.st.extra + a.st.bonus;
  return { org_id: ORG.id, balance, reserved: a.st.held };
}

// FAKE_ADMIN=1: the signed-in person is a platform admin, so the operator-only
// parts of the Credits page (the raw price list) can be photographed too.
const ADMIN = process.env.FAKE_ADMIN === "1";

// ── what each app-screen state has made ────────────────────────────────────
// Studio → Projects (migration 0166): made-up drafts for screenshots of the list and the canvas (run the app with
// NIGHTSHIFT_FILM_STUDIO=on). `new` has none; every other session reads these. Writes stay refused like every other write.
const FILM_ID = "0f000000-0000-4000-8000-00000000000f";
const FILM_LIMITS = {
  max_scenes: 60, scene_seconds_min: 3, scene_seconds_max: 30, max_shots: 3, max_film_seconds: 1200, target_seconds_min: 60,
  target_seconds_max: 1200, max_topic_chars: 2000, max_script_chars: 40000, max_title_chars: 120, max_narration_chars: 2000,
  max_prompt_chars: 2000, max_negative_chars: 1000, max_film_refs: 16, max_scene_refs: 8, max_open_drafts: 50, max_patch_bytes: 2000000,
  max_films_total: 500, max_events_per_film: 5000, creates_per_hour: 30, saves_per_hour: 240, archives_per_hour: 60,
};
const FILM_SCENES = [
  ["The stadium in orbit", "In 2050 the final is played above the clouds.", 18],
  ["Into the light", "Aziza, number ten, hears the crowd before she sees it.", 22],
  ["The floating ball", "The ball hangs for a second longer than it should.", 20],
  ["The roaring stands", "Ninety thousand voices, and every one of them is a fan.", 24],
  ["Rain turned off", "The storm is switched off at kick-off, as every week.", 16],
  ["The coach", "Coach Bek has one sentence for the second half.", 14],
].map(([title, narration, seconds], i) => ({
  id: `5${i}000000-0000-4000-8000-00000000000${i}`, position: i, title, narration, visual_prompt: "A neon stadium floating above the clouds, wide shot",
  negative_prompt: "", planned_seconds: seconds, shot_count: i === 1 ? 2 : 1, first_frame: i === 2 ? "previous" : "keyframe", first_frame_asset_id: null,
  last_frame: "none", last_frame_asset_id: null, keyframe_model: null, clip_model: null, clip_params: {}, transition_in: null, current_version: null,
  status: "draft", created_at: "2026-11-14T08:00:00Z", updated_at: "2026-11-14T08:00:00Z", first_frame_missing: false, last_frame_missing: false,
  refs: [], takes: [],
}));
const FILM_ROW = {
  id: FILM_ID, org_id: ORG.id, channel_id: "night-owl", title: "Football in 2050", source_kind: "topic", source_text: "Football in the year 2050: a final played above the clouds.",
  language: "uz", aspect: "16:9", target_seconds: 300, resolution: null, style_kit_id: null, keyframe_model: null, clip_model: null, voice: null,
  music_asset_id: null, music_gain_db: null, duck_db: null, captions_mode: "sidecar", transition_default: "cut", status: "draft", pause_reason: null,
  pause_detail: null, version: 7, idempotency_key: "film-visualqa0001", created_by: USER.id, created_at: "2026-11-14T08:00:00Z",
  updated_at: "2026-11-14T09:12:00Z", archived_at: null,
};
const FILM_LIST = [
  FILM_ROW,
  { ...FILM_ROW, id: "0f000000-0000-4000-8000-0000000000f2", title: "Samarkand at night, a city that never sleeps", language: "en", aspect: "9:16", target_seconds: 180, updated_at: "2026-11-13T18:40:00Z" },
  { ...FILM_ROW, id: "0f000000-0000-4000-8000-0000000000f3", title: "Как работает дождь", language: "ru", aspect: "1:1", target_seconds: 480, status: "planned", updated_at: "2026-11-12T10:05:00Z" },
];
// `timeline`: the Timeline's evidence (components/studio-timeline). The first two scenes have a chosen, finished clip take (measured
// 5.6 s and 7.2 s); the rest are drafts; a music file is set at −14 dB with −9 dB ducking; no narration take exists yet.
const TIMELINE_TAKE = (scene, i, seconds) => ({
  id: `7${i}000000-0000-4000-8000-00000000000${i}`, scene_id: scene.id, version: 1, shot_index: 1, kind: "clip", parent_take_id: null, attempt: 1,
  status: "completed", model: "qa-clip-fast", prompt_final: null, params: {}, duration_s: seconds, first_frame_asset_id: null, last_frame_asset_id: null,
  reference_asset_ids: [], reshoot: null, creative_job_id: null, result_asset_id: `7c000000-0000-4000-8000-00000000000${i}`,
  result_last_frame_asset_id: null, error_code: null, error: null, created_at: "2026-11-14T08:00:00Z", updated_at: "2026-11-14T08:00:00Z",
  finished_at: "2026-11-14T08:00:00Z",
});
const TIMELINE_SCENES = FILM_SCENES.map((s, i) => (i < 2 ? { ...s, current_version: 1, status: "ready", takes: [TIMELINE_TAKE(s, i, i === 0 ? 5.6 : 7.2)] } : s));
const TIMELINE_QUOTE = {
  film_id: FILM_ID, version: 7, priced: true, total: 16, quote_id: `fq-7-${"0".repeat(31)}1`, lines: [], scenes: [], refusals: [],
  planned_seconds: 114, assembly_minutes: 2, exempt: false, available: 1180, active_films: 0, film_studio_enabled: true,
  blocked_by: [], may_start: true, startable: true,
};
function filmJson(state) {
  const scenes = state === "film_empty" ? [] : state === "timeline" ? TIMELINE_SCENES : FILM_SCENES;
  const film = state === "timeline" ? { ...FILM_ROW, music_asset_id: "7c000000-0000-4000-8000-0000000000aa", music_gain_db: -14, duck_db: -9 } : FILM_ROW;
  return {
    film, editable: true, style_kit_missing: false, music_missing: false,
    totals: { scenes: scenes.length, planned_seconds: scenes.reduce((s, x) => s + x.planned_seconds, 0) },
    refs: [], scenes, takes: [], events: [], events_total: 7, events_truncated: false, limits: FILM_LIMITS,
  };
}

const APP_STATES = new Set(["timeline", "timeline_missing", "owner", "new", "videos", "running", "low", "extraoff", "unpriced", "acct", "acct_handle", "acct_cool", "canvas"]);
// Made-up held @usernames: the check says "taken" for these and "free" for anything else well formed.
const TAKEN_HANDLES = new Set(["taken.name", "maria.k", "alice.lab", "night.owl"]);
const handleRow = (state) =>
  state === "acct_handle"
    ? [{ handle: "ana.k", created_at: iso(-90 * DAY), changed_at: iso(-90 * DAY) }]
    : state === "acct_cool"
      ? [{ handle: "ana.k", created_at: iso(-90 * DAY), changed_at: iso(-10 * DAY) }]
      : [];
const MODELS = [
  { id: "qa-clip-fast", display_name: "Quick clip", capabilities: ["t2v", "i2v", "t2i"], availability: "ga", verified_at: "2026-09-01T00:00:00Z" },
  { id: "qa-clip-best", display_name: "Best clip", capabilities: ["t2v", "i2v"], availability: "ga", verified_at: "2026-09-01T00:00:00Z" },
];
const VIDEOS = [
  { channel_id: "night-owl", video_id: "v1", title: "Why octopuses dream in colour", topic: "octopus", published_at: "2026-10-01T10:00:00Z", privacy: "private", publish_state: "uploaded" },
  { channel_id: "night-owl", video_id: "v2", title: "The lighthouse that never slept", topic: "lighthouse", published_at: "2026-09-28T10:00:00Z", privacy: "private", publish_state: "uploaded" },
  { channel_id: "night-owl", video_id: "run-3", title: "The last train from Samarkand", topic: "train", published_at: null, privacy: null, publish_state: "awaiting_approval" },
];
// One storyboard waiting for approval (0057), so Home's "ready for your decision" card counts it beside the held video.
const STORYBOARD = {
  id: "00000000-0000-4000-8000-0000000000e1",
  channel_id: "night-owl",
  slug: "the-salt-road",
  topic: "The salt road",
  title: "The salt road",
  scenes: [{ n: 1, text: "A caravan leaves at dusk." }, { n: 2, text: "The well is dry." }],
  duration_s: 300,
  status: "ready",
  created_at: "2026-10-09T10:00:00Z",
  decided_at: null,
  credits_held: null,
  render_job_id: null,
};
const JOBS = (state) => {
  const base = {
    org_id: ORG.id, kind: "video", mode: "exact", requested_model: "qa-clip-fast", routed_model: null, fallback_from: null, fallback_reason: null,
    status: "completed", payer: "org", quoted_credits: 40, charged_credits: 40, error_code: null, error: null, result: {}, result_asset_ids: [], expires_at: null,
    finished_at: iso(-3_600_000),
  };
  const done = (n, capability, prompt, ago) => ({ ...base, id: `00000000-0000-4000-8000-00000000d0${n}`, capability, params: { prompt, aspect: "16:9", duration: 5 }, created_at: iso(-ago), updated_at: iso(-ago) });
  if (state === "new") return [];
  const out = [done(1, "t2v", "A fox crossing a snowy ridge at dawn", 86_400_000), done(2, "t2v", "Rain on a neon street, slow push in", 2 * 86_400_000)];
  if (state === "running") out.unshift({ ...base, id: "00000000-0000-4000-8000-00000000d0aa", capability: "t2v", status: "running", finished_at: null, charged_credits: null, params: { prompt: "A paper boat on a flooded street, cinematic", aspect: "16:9", duration: 5 }, created_at: iso(-90_000), updated_at: iso(-30_000) });
  return out;
};

// The Studio canvas's own jobs, read one at a time by id (GET /api/creative/jobs/{id}): a finished picture, a clip that failed
// with its reason, and a clip being made. Answered for any app state, by id only, so no other screen's job list changes.
// The pictures have thumb/display variants, so a done image shows its real result once tools/visual-qa/studio-canvas.mjs
// --media has drawn the files (the app serves them from NIGHTSHIFT_MEDIA_DIR, signed with MEDIA_URL_SECRET).
const CANVAS_ASSETS = [
  { id: "0c000000-0000-4000-8000-0000000000a1", kind: "image", mime: "image/jpeg", bytes: 220000, width: 1280, height: 720, duration_s: null, source: "generated", original_name: "Fox at dawn", variants: ["thumb", "display"], version: 1, created_at: "2026-11-14T08:00:00Z", folder_id: null },
  { id: "0c000000-0000-4000-8000-0000000000a2", kind: "image", mime: "image/jpeg", bytes: 180000, width: 1080, height: 1080, duration_s: null, source: "upload", original_name: "Samarkand gate", variants: ["thumb", "display"], version: 1, created_at: "2026-11-13T08:00:00Z", folder_id: null },
  { id: "0c000000-0000-4000-8000-0000000000a3", kind: "image", mime: "image/png", bytes: 90000, width: 1024, height: 1024, duration_s: null, source: "upload", original_name: "Logo", variants: ["thumb", "display"], version: 1, created_at: "2026-11-12T08:00:00Z", folder_id: null },
  { id: "0c000000-0000-4000-8000-0000000000a4", kind: "audio", mime: "audio/mpeg", bytes: 400000, width: null, height: null, duration_s: 31, source: "generated", original_name: "Narration take 1", variants: {}, version: 1, created_at: "2026-11-11T08:00:00Z", folder_id: null },
  // A finished clip with a measured length (the timeline lane draws it to scale; studio-canvas.mjs --media draws its thumbnail).
  { id: "0c000000-0000-4000-8000-0000000000a5", kind: "video", mime: "video/mp4", bytes: 2400000, width: 1280, height: 720, duration_s: 6, source: "generated", original_name: "Fox on the ridge", variants: ["thumb", "display"], version: 1, created_at: "2026-11-15T08:00:00Z", folder_id: null },
];
const CANVAS_JOBS = () => {
  const base = {
    org_id: ORG.id, kind: "image", mode: "exact", requested_model: "qa-clip-fast", routed_model: null, fallback_from: null, fallback_reason: null,
    payer: "org", quoted_credits: 40, error: null, result: {}, expires_at: null, params: { prompt: "A fox crossing a snowy ridge at dawn", aspect: "16:9", duration: 5 },
  };
  return [
    { ...base, id: "0c000000-0000-4000-8000-0000000000c1", capability: "t2i", status: "completed", charged_credits: 8, error_code: null, result_asset_ids: [CANVAS_ASSETS[0].id], created_at: iso(-3_600_000), finished_at: iso(-3_500_000) },
    { ...base, id: "0c000000-0000-4000-8000-0000000000c2", capability: "i2v", status: "failed", charged_credits: 0, error_code: "provider_timeout", result_asset_ids: [], created_at: iso(-1_800_000), finished_at: iso(-1_700_000), params: { ...base.params, source_asset_id: CANVAS_ASSETS[0].id } },
    { ...base, id: "0c000000-0000-4000-8000-0000000000c3", capability: "t2v", status: "running", charged_credits: null, error_code: null, result_asset_ids: [], created_at: iso(-90_000), started_at: iso(-80_000), finished_at: null },
    // For the timeline lane: a finished clip (its file measured at 6 s, asked for 5), a finished voice-over (its file 31 s), and a
    // clip being made that was asked for 8 s (drawn as requested, never as measured).
    { ...base, id: "0c000000-0000-4000-8000-0000000000c4", capability: "t2v", status: "completed", charged_credits: 40, error_code: null, result_asset_ids: [CANVAS_ASSETS[4].id], created_at: iso(-7_200_000), finished_at: iso(-7_000_000), params: { ...base.params, duration_s: 5 } },
    { ...base, id: "0c000000-0000-4000-8000-0000000000c5", capability: "tts", status: "completed", charged_credits: 6, error_code: null, result_asset_ids: [CANVAS_ASSETS[3].id], created_at: iso(-5_400_000), finished_at: iso(-5_300_000), params: { prompt: "At dawn the fox crosses the ridge." } },
    { ...base, id: "0c000000-0000-4000-8000-0000000000c6", capability: "t2v", status: "running", charged_credits: null, error_code: null, result_asset_ids: [], created_at: iso(-60_000), started_at: iso(-50_000), finished_at: null, params: { ...base.params, duration_s: 8 } },
  ];
};

// ── the platform owner's world (state "owner") ─────────────────────────────
const OWNER_ORG = { id: "00000000-0000-4000-8000-0000000000b0", name: "Nightshift", slug: "nightshift", role: "owner", is_default: true };
const OWNER_ORGS = [OWNER_ORG, { ...ORG, name: "Atelier Customer Studio" }];
const OWNER_CHANNELS = [
  { ...CHANNEL, channel_id: "chronos", name: "Chronos History", org_id: OWNER_ORG.id, niche: "history" },
  { ...CHANNEL, channel_id: "extinct-world", name: "Extinct World", org_id: OWNER_ORG.id, niche: "nature" },
];
const ev = (n, agent, event, status, minutesAgo, extra = {}) => ({
  id: n, ts: iso(-minutesAgo * 60_000).replace("Z", ""), agent, event, status, channel_id: "chronos", job_id: null, video_id: null, duration_ms: null, payload: {}, ...extra,
});
const OWNER_EVENTS = () => [
  ev(1, "intelligence_poll", "system.heartbeat", "running", 12),
  ev(2, "pipeline", "topic.selected", "running", 600),
  ev(3, "youtube_uploader", "upload.failed", "failed", 640),
  ev(4, "script_engine", "script.completed", "completed", 700),
  ev(5, "feedback_engine", "feedback.generated", "completed", 720),
  ev(6, "pipeline", "research.completed", "completed", 760),
  ev(7, "publish_gate", "gate.verdict", "completed", 800),
  ev(8, "research_engine", "research.started", "running", 820),
];
const OWNER_WORKERS = () => [
  { worker_id: "media-1", kind: "media", state: "running", detail: null, version: "1.4", started_at: iso(-DAY), updated_at: iso(-20_000) },
  { worker_id: "creative-1", kind: "creative", state: "running", detail: null, version: "1.4", started_at: iso(-DAY), updated_at: iso(-30 * 60_000) },
  { worker_id: "pipeline-1", kind: "pipeline", state: "running", detail: null, version: "1.4", started_at: iso(-DAY), updated_at: iso(-10_000) },
  { worker_id: "email-1", kind: "other", state: "stopped", detail: null, version: "1.4", started_at: iso(-DAY), updated_at: iso(-2 * 3_600_000) },
];
// The team page: the signed-in owner (the only owner), an admin and an invited editor.
const OWNER_MEMBERS = () => [
  { id: "m1", user_id: USER.id, email: USER.email, role: "owner", created_at: "2026-01-01T08:00:00Z" },
  { id: "m2", user_id: "00000000-0000-4000-8000-0000000000c2", email: "dilnoza@nightshift.uz", role: "admin", created_at: "2026-03-01T08:00:00Z" },
  { id: "m3", user_id: null, email: "bekzod@nightshift.uz", role: "editor", created_at: "2026-09-20T08:00:00Z" },
];
const OWNER_ALERTS = () => [
  { id: "a1", at: iso(-3 * 3_600_000), kind: "balance.low", severity: "warn", channel_id: null, title: "ElevenLabs balance is low", body: null, delivered: true },
  { id: "a2", at: iso(-5 * 3_600_000), kind: "upload.failed", severity: "critical", channel_id: "chronos", title: "Upload failed", body: null, delivered: true },
];
const OWNER_BALANCES = () => [
  { provider: "elevenlabs", metric: "credits", remaining: 18000, total: 100000, unit: "credits", tier: "creator", resets_at: iso(12 * DAY), source: "api", checked_at: iso(-2 * 3_600_000) },
  { provider: "gemini", metric: "usd", remaining: 80, total: 100, unit: "usd", tier: null, resets_at: null, source: "ledger", checked_at: iso(-3_600_000) },
];

const RPC = {
  my_organizations: [ORG],
  is_platform_admin: ADMIN,
  // Developers: an activated API workspace with made-up figures (read only).
  api_console: {
    eligible: true,
    activated_at: "2026-09-01T08:00:00Z",
    exempt: false,
    balance_cents: 2500,
    reserved_cents: 300,
    paid_total_cents: 5000,
    tier: 1,
    rpm: 60,
    concurrency: 2,
    tier_cap_cents: 10000,
    monthly_limit_cents: null,
    month_spend_cents: 1200,
    active_keys: 1,
  },
  // The price list as charged (0084): the estimate line needs a per-minute price.
  credit_rates: [
    { unit: "video_minute", credits_per_unit: 60, margin: 0, note: null, updated_at: "2026-10-01T00:00:00Z" },
    { unit: "job_minimum", credits_per_unit: 10, margin: 0, note: null, updated_at: "2026-10-01T00:00:00Z" },
  ],
  // Invite friends (0092): a made-up link with three of five friends joined.
  my_friend_invite: {
    enabled: true,
    required: 5,
    reward: 100,
    link: { token: "0123456789abcdef0123456789abcdef", created_at: "2026-10-01T00:00:00Z", org_id: ORG.id },
    joined: 3,
    paid: false,
    credits_paid: null,
    pending: false,
  },
};

// The referral programme (0165): made-up counts and today's made-up numbers, for the Credits card and the public /referral.
const REFERRAL_NUMBERS = { enabled: true, credits: 200, min_credits: 1000, hold_days: 30, qualify_days: 60, monthly_cap: 10 };
const REFERRALS_EMPTY = {
  ...REFERRAL_NUMBERS,
  link: { token: "0123456789abcdef0123456789abcdef", created_at: "2026-10-01T00:00:00Z" },
  org: { id: ORG.id, name: "QA Studio" },
  joined: 0, held: 0, due: 0, next_release_on: null, paid: 0, earned: 0, paid_this_month: 0, clawed: 0, clawed_credits: 0, claw_owed: 0, void: 0,
  milestone_credits: null,
};
RPC.my_referrals = { ...REFERRALS_EMPTY, joined: 6, held: 2, next_release_on: "2026-12-09", paid: 3, earned: 600, paid_this_month: 1, void: 1 };
RPC.claim_referral_rewards = RPC.my_referrals;
// The operator's panel (the `owner` session): no pg_cron schedule, so the panel's warning shows; one made-up last run.
RPC.referral_admin = {
  ...REFERRAL_NUMBERS, enabled: false, links_open: true, milestone_enabled: false, open_since: null, orphaned: 0,
  daily_cap: 50, updated_at: "2026-11-14T08:00:00Z", schedule: false,
  last_run: { at: "2026-11-14T09:05:00Z", links: 12, changed: 2, failed: 0, error: null }, runs_failed_24h: 0,
  links: 12, joins: 31, held: 4, due: 1, paid: 6, paid_today: 1, credits_month: 1200, credits_total: 1200,
  void_refunded: 1, void_same_payer: 0, void_member: 1, clawed: 1, claw_owed: 50, reversed_by_event: 0, milestone_rewards: 0,
};
RPC.referral_terms ={ ...REFERRAL_NUMBERS, daily_cap: 50, link_hourly_cap: 10, new_account_days: 3, updated_at: "2026-11-14T08:00:00Z" };

// The consent screen and Connected apps (0093): made-up app, made-up return address.
RPC.oauth_begin_authorization = { ok: true, entitled: true, client_name: "Claude", redirect_uri: "https://claude.ai/api/mcp/auth_callback", workspace_name: "QA Studio", plan: "creator", scopes: ["videos:read", "videos:create", "videos:publish"], default_limit_credits: 500, max_limit_credits: 20000, exempt: false };
RPC.oauth_my_grants = [
  { id: "00000000-0000-4000-8000-0000000000c1", client_name: "Claude", scopes: ["videos:read", "videos:create"], monthly_limit_credits: 500, spent_this_month_credits: 120, created_at: "2026-09-10T08:00:00Z", last_used_at: "2026-10-02T09:00:00Z", status: "active", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
  { id: "00000000-0000-4000-8000-0000000000c2", client_name: "Cursor", scopes: ["videos:read"], monthly_limit_credits: 200, spent_this_month_credits: 0, created_at: "2026-09-20T08:00:00Z", last_used_at: null, status: "paused_plan", redirect_uris: ["http://localhost:6274/cb"] },
];

// Developers (0031, 0062): made-up keys, usage and payments, so that page has rows to look at.
RPC.api_usage = {
  days: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(12 + (i % 19)).padStart(2, "0")}`, requests: 20 + ((i * 37) % 90), errors: i % 7 === 0 ? 2 : 0, spend_cents: 15 + ((i * 53) % 120) })),
  endpoints: [
    { endpoint: "videos.create", requests: 640, errors: 4 },
    { endpoint: "videos.list", requests: 1210, errors: 0 },
    { endpoint: "balance", requests: 380, errors: 0 },
  ],
};

const PRICE = (unit, credits_per_unit, margin) => ({ unit, credits_per_unit, margin, updated_at: "2026-09-30T12:00:00Z", updated_by: null });
const TABLES = {
  channels: [CHANNEL],
  api_keys: [
    { id: "k_7fd2a91c0b", name: "Production server", monthly_limit_cents: 5000, created_at: "2026-09-02T08:00:00Z", last_used_at: "2026-10-10T09:30:00Z", revoked_at: null, scopes: ["account:read", "videos:read", "videos:write"], rpm_limit: null, creative_monthly_credits: null },
    { id: "k_31c8e5a204", name: "Dashboard (read only)", monthly_limit_cents: null, created_at: "2026-09-15T08:00:00Z", last_used_at: null, revoked_at: null, scopes: ["account:read", "videos:read"], rpm_limit: 30, creative_monthly_credits: null },
    { id: "k_a09b44d7e1", name: "Generation worker", monthly_limit_cents: 2000, created_at: "2026-09-20T08:00:00Z", last_used_at: "2026-10-09T18:00:00Z", revoked_at: null, scopes: ["account:read", "creative:quote", "creative:create", "creative:read"], rpm_limit: 60, creative_monthly_credits: 500 },
    { id: "k_0e5513b8cc", name: "Old script", monthly_limit_cents: null, created_at: "2026-08-01T08:00:00Z", last_used_at: "2026-08-20T08:00:00Z", revoked_at: "2026-09-01T08:00:00Z", scopes: null, rpm_limit: null, creative_monthly_credits: null },
  ],
  api_ledger: [
    { id: 2, kind: "topup", amount_cents: 2500, external_id: "txn_01qa00000000000000000002", created_at: "2026-10-01T08:00:00Z" },
    { id: 1, kind: "topup", amount_cents: 2500, external_id: "txn_01qa00000000000000000001", created_at: "2026-09-01T08:00:00Z" },
  ],
  credit_accounts: [{ org_id: ORG.id, balance: 1240, reserved: 180 }],
  // Made-up rates, only so the operator's price list has rows to look at (FAKE_ADMIN=1).
  credit_prices: ADMIN
    ? [
        PRICE("video_minute", 40, 0.5),
        PRICE("job_minimum", 5, 0),
        PRICE("download_1080p_minute", 12, 0.25),
        PRICE("tts_characters", 0.008, 2),
        PRICE("model_example_second_1080p_silent", 3, 0.3),
        PRICE("custom_thing", 1, 0),
      ]
    : [],
  // The price list the Usage page reads for "what Free does not include" and the upgrade link.
  plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, sort_order: p.sort_order, monthly_credits: p.monthly_credits, is_default: p.is_default, is_public: true })),
  entitlement_keys: [
    { key: "concurrency", value_type: "int", default_value: 1, exempt_value: 1000, status: "enforced", sort_order: 10 },
    { key: "queue_priority", value_type: "int", default_value: 0, exempt_value: 10, status: "enforced", sort_order: 20 },
    { key: "api_access", value_type: "bool", default_value: false, exempt_value: true, status: "enforced", sort_order: 30 },
  ],
  plan_entitlements: Object.values(PLANS).flatMap((p) => [
    { plan_id: p.id, key: "concurrency", value: p.slots },
    { plan_id: p.id, key: "queue_priority", value: p.priority },
    { plan_id: p.id, key: "api_access", value: p.api },
  ]),
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export function startFakeSupabase(port = 54399) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204);
    if (url.pathname === "/auth/v1/user") {
      const claims = claimsOf(req);
      // `sessionCookie(url, "owner", 0, { mfa: 1 })` gives the owner one verified authenticator: the Security page then shows the "last factor" state.
      const user = userFor(claims.av);
      return send(res, 200, claims.qa === "owner" && claims.mfa === 1 ? { ...user, factors: [{ id: "f1000000-0000-4000-8000-000000000001", friendly_name: "Telefon", factor_type: "totp", status: "verified", created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z" }] } : user);
    }
    // Which sign-in providers are on (the "Continue with Google" button asks). FAKE_GOOGLE=1 switches Google on.
    if (url.pathname === "/auth/v1/settings") return send(res, 200, { external: { email: true, google: process.env.FAKE_GOOGLE === "1" } });
    if (url.pathname.startsWith("/auth/v1/")) return send(res, 200, {});
    const state = stateOf(req);
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)/);
    if (rpc) {
      // The Usage page's own functions, by the state the session carries.
      if (rpc[1] === "usage_summary" && state) return send(res, 200, usageSummary(state));
      if (rpc[1] === "billing_summary" && state) return send(res, 200, billingSummary(state));
      if (rpc[1] === "set_use_extra_credits" && state) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let on = true;
          try {
            on = JSON.parse(body).p_on === true;
          } catch {
            // an unreadable body leaves the switch on
          }
          switchState.set(state, on);
          send(res, 200, { use_extra_credits: on, changed: true });
        });
        return;
      }
      if (APP_STATES.has(state)) {
        if (rpc[1] === "credit_rates") return send(res, 200, state === "unpriced" ? [] : RPC.credit_rates);
        if (rpc[1] === "sellable_models") return send(res, 200, state === "new" ? [] : MODELS.map((m, i) => ({ id: m.id, spec: { quality_tier: i === 0 ? 2 : 3, speed_tier: i === 0 ? 3 : 1 }, entitlement: null })));
        if (rpc[1] === "quote_creative_job") {
          if (state === "unpriced") return send(res, 400, { code: "NS400", message: "unpriced" });
          return send(res, 200, { credits: 40 });
        }
      }
      if (rpc[1] === "handle_available" || rpc[1] === "handle_available_public") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let name = "";
          try {
            name = String(JSON.parse(body).p_handle ?? "");
          } catch {
            // an unreadable body asks about nothing
          }
          send(res, 200, !TAKEN_HANDLES.has(name));
        });
        return;
      }
      // The referral card (0165): `ref_empty` has a link and nobody joined yet; every other session has made-up referrals. The
      // "claim" moves nothing here: it answers the same counts as the read.
      if (state === "ref_empty" && (rpc[1] === "claim_referral_rewards" || rpc[1] === "my_referrals")) return send(res, 200, REFERRALS_EMPTY);
      if (state === "owner" && rpc[1] === "is_platform_admin") return send(res, 200, true);
      if (state === "owner" && rpc[1] === "bind_current_member") return send(res, 200, "owner");
      if (state === "owner" && rpc[1] === "my_organizations") return send(res, 200, OWNER_ORGS);
      // timeline_missing: the projects migration is not applied, so PostgREST has no such function (PGRST202).
      if (state === "timeline_missing" && rpc[1] === "film_json") return send(res, 404, { code: "PGRST202", message: "Could not find the function public.film_json" });
      if (state === "timeline" && rpc[1] === "quote_film") return send(res, 200, TIMELINE_QUOTE);
      if (state === "timeline" && rpc[1] === "take_web_rate") return send(res, 200, true);
      if (rpc[1] === "film_json") return state === "new" ? send(res, 404, { code: "P0002", message: "not_found" }) : send(res, 200, filmJson(state));
      if (rpc[1] in RPC) return send(res, 200, RPC[rpc[1]]);
      return send(res, 403, { code: "42501", message: "visual-qa fake: not available" });
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)/);
    if (table && (req.method === "GET" || req.method === "HEAD")) {
      let rows = table[1] === "credit_accounts" && state ? [creditAccountFor(state)] : (TABLES[table[1]] ?? []);
      if (APP_STATES.has(state)) {
        // A new person has no channel, video, job or model yet; the others have a channel.
        if (table[1] === "channels") rows = state === "new" ? [] : [CHANNEL];
        if (table[1] === "videos") {
          // heldOnly() asks published_at and privacy to be null; uploadedOnly() sends an `or`.
          const held = url.searchParams.get("published_at") === "is.null";
          const uploaded = url.searchParams.has("or");
          rows = state === "new" ? [] : VIDEOS.filter((v) => (held ? !v.published_at && !v.privacy : uploaded ? v.published_at || v.privacy : true));
        }
        if (table[1] === "storyboards") rows = state === "videos" && url.searchParams.get("status") === "eq.ready" ? [STORYBOARD] : [];
        if (table[1] === "creative_jobs") {
          const one = url.searchParams.get("id");
          rows = one?.startsWith("eq.") ? [...CANVAS_JOBS(), ...JOBS(state)].filter((j) => j.id === one.slice(3)) : JOBS(state);
        }
        if (table[1] === "media_assets" && (state === "canvas" || state === "low")) rows = CANVAS_ASSETS;
        if (table[1] === "user_handles") rows = handleRow(state);
        if (table[1] === "model_registry") rows = state === "new" ? [] : MODELS;
      }
      if (table[1] === "films") rows = state === "new" ? [] : FILM_LIST;
      if (state === "owner") {
        if (table[1] === "channels") rows = OWNER_CHANNELS;
        if (table[1] === "system_events") rows = OWNER_EVENTS();
        if (table[1] === "worker_status") rows = OWNER_WORKERS();
        if (table[1] === "alert_events") rows = OWNER_ALERTS();
        if (table[1] === "provider_balances") rows = OWNER_BALANCES();
        if (table[1] === "app_members") rows = OWNER_MEMBERS();
      }
      if (req.method === "HEAD") {
        // A count-only read (select(..., { count: "exact", head: true })): the count rides in Content-Range.
        res.writeHead(200, { "content-range": `${rows.length ? "0-" + (rows.length - 1) : "*"}/${rows.length}`, "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "content-range" });
        return res.end();
      }
      const single = String(req.headers.accept || "").includes("vnd.pgrst.object");
      if (single) return rows.length ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "0 rows" });
      return send(res, 200, rows);
    }
    return send(res, 403, { code: "42501", message: "visual-qa fake: read-only" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT || 54399);
  startFakeSupabase(port).then(() => process.stdout.write(`fake supabase on http://127.0.0.1:${port}\n`));
}
