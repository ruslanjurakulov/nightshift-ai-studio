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
 * jobs), `videos` (a channel with videos made and one waiting for approval),
 * `running` (a clip being made right now), `low` (a few credits left),
 * `extraoff` (extra credits switched off), `unpriced` (no price is set: the
 * estimate and the clip price are unknown, never 0). `FAKE_MODELS=1` is not
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

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The @supabase/ssr session cookie for a fake signed-in session against `url`. */
export function sessionCookie(url = FAKE_URL_DEFAULT, state = "") {
  const host = new URL(url).hostname.split(".")[0];
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const claims = { sub: USER.id, exp, role: "authenticated", aud: "authenticated", ...(state ? { qa: state } : {}) };
  const jwt = [b64url(JSON.stringify({ alg: "none", typ: "JWT" })), b64url(JSON.stringify(claims)), "unsigned"].join(".");
  const session = { access_token: jwt, token_type: "bearer", expires_in: 86400, expires_at: exp, refresh_token: "visual-qa", user: USER };
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
  extraoff: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 500, bonus: 0, on: false },
  unpriced: { plan: "creator", granted: 2000, spent: 1240, held: 0, extra: 500, bonus: 100, on: true },
};
const PLANS = {
  free: { id: "free", name: "Free", monthly_credits: 0, is_default: true, sort_order: 0, slots: 1, priority: 0, api: false },
  creator: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false, sort_order: 1, slots: 2, priority: 1, api: true },
  pro: { id: "pro", name: "Pro", monthly_credits: 6000, is_default: false, sort_order: 2, slots: 4, priority: 2, api: true },
};
const switchState = new Map(); // state -> switch pressed in this process

function stateOf(req) {
  const m = /^Bearer\s+[^.]+\.([^.]+)\./.exec(String(req.headers.authorization || ""));
  if (!m) return "";
  try {
    return JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).qa || "";
  } catch {
    return "";
  }
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
const APP_STATES = new Set(["new", "videos", "running", "low", "extraoff", "unpriced"]);
const MODELS = [
  { id: "qa-clip-fast", display_name: "Quick clip", capabilities: ["t2v", "i2v", "t2i"], availability: "ga", verified_at: "2026-09-01T00:00:00Z" },
  { id: "qa-clip-best", display_name: "Best clip", capabilities: ["t2v", "i2v"], availability: "ga", verified_at: "2026-09-01T00:00:00Z" },
];
const VIDEOS = [
  { channel_id: "night-owl", video_id: "v1", title: "Why octopuses dream in colour", topic: "octopus", published_at: "2026-10-01T10:00:00Z", privacy: "private", publish_state: "uploaded" },
  { channel_id: "night-owl", video_id: "v2", title: "The lighthouse that never slept", topic: "lighthouse", published_at: "2026-09-28T10:00:00Z", privacy: "private", publish_state: "uploaded" },
  { channel_id: "night-owl", video_id: "run-3", title: "The last train from Samarkand", topic: "train", published_at: null, privacy: null, publish_state: "awaiting_approval" },
];
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

// The consent screen and Connected apps (0093): made-up app, made-up return address.
RPC.oauth_begin_authorization = { ok: true, entitled: true, client_name: "Claude", redirect_uri: "https://claude.ai/api/mcp/auth_callback", workspace_name: "QA Studio", plan: "creator", scopes: ["videos:read", "videos:create", "videos:publish"], default_limit_credits: 500, max_limit_credits: 20000, exempt: false };
RPC.oauth_my_grants = [
  { id: "00000000-0000-4000-8000-0000000000c1", client_name: "Claude", scopes: ["videos:read", "videos:create"], monthly_limit_credits: 500, spent_this_month_credits: 120, created_at: "2026-09-10T08:00:00Z", last_used_at: "2026-10-02T09:00:00Z", status: "active", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
  { id: "00000000-0000-4000-8000-0000000000c2", client_name: "Cursor", scopes: ["videos:read"], monthly_limit_credits: 200, spent_this_month_credits: 0, created_at: "2026-09-20T08:00:00Z", last_used_at: null, status: "paused_plan", redirect_uris: ["http://localhost:6274/cb"] },
];

const PRICE = (unit, credits_per_unit, margin) => ({ unit, credits_per_unit, margin, updated_at: "2026-09-30T12:00:00Z", updated_by: null });
const TABLES = {
  channels: [CHANNEL],
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
    if (url.pathname === "/auth/v1/user") return send(res, 200, USER);
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
      if (rpc[1] in RPC) return send(res, 200, RPC[rpc[1]]);
      return send(res, 403, { code: "42501", message: "visual-qa fake: not available" });
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)/);
    if (table && req.method === "GET") {
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
        if (table[1] === "creative_jobs") rows = JOBS(state);
        if (table[1] === "model_registry") rows = state === "new" ? [] : MODELS;
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
