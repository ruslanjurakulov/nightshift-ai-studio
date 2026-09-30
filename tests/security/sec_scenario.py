"""The world every attack runs against.

Two self-serve customers, Alice (org A) and Bob (org B), each signed up and
created their own organization through ``create_organization`` — the real
path, which also grants welcome credits. Everything else a tenant owns is
written the way it reaches production: by the pipeline and workers with the
service role, by the user's own session where a browser writes it
(publish_requests), and by the database owner where Supabase itself would
(auth.users, Vault) or where production writes only through a worker function
that is not what these tests exercise.

Around them:
  * the platform operator: owner on the platform roster (app_members) and of
    the default organization, which holds the operator's own channel;
  * Sam, a stranger who signed up and created nothing;
  * Dana, a plain member (viewer) of the operator's default organization —
    the shape of every account that existed before migration 0018;
  * a pending email invite into org A.

Every tenant row is recognisable by its owner: channel ``chan-a`` / video
``vid-a`` belong to org A, and so on. The expectations map
(sec_expectations.py) says, per table, which column carries the owner.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

import psycopg

from sec_db import SERVICE, Actor, acting, as_superuser, user

DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"


@dataclass
class Tenant:
    key: str  # 'a' | 'b'
    actor: Actor
    org: str = ""
    channel: str = ""
    video: str = ""
    social_account: str = ""
    api_key_id: str = ""
    api_key_hash: str = ""
    render_job: int = 0
    download_request: int = 0
    publish_request: int = 0
    media_asset: str = ""
    media_ticket: str = ""
    creative_job: str = ""


@dataclass
class Scenario:
    operator: Actor
    alice: Tenant
    bob: Tenant
    stranger: Actor
    dana: Actor
    invitee: Actor
    # ground truth for "who owns this row": channel -> org, video -> channel
    channel_org: Dict[str, str] = field(default_factory=dict)
    video_channel: Dict[str, str] = field(default_factory=dict)
    operator_video: str = "vid-op"

    def tenants(self):
        return (self.alice, self.bob)

    def org_of_channel(self, ch: Optional[str]) -> Optional[str]:
        return self.channel_org.get(ch) if ch is not None else None

    def org_of_video(self, vid: Optional[str]) -> Optional[str]:
        return self.org_of_channel(self.video_channel.get(vid)) if vid is not None else None


def _hex64(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _signup(conn: psycopg.Connection, who: Actor) -> None:
    with as_superuser(conn) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning id",
               [who.uid, who.email])


def _create_org(conn: psycopg.Connection, who: Actor, name: str) -> str:
    with acting(conn, who, commit=True) as s:
        return str(s.value("select public.create_organization(%s)", [name]))


def _as_service(conn: psycopg.Connection, statements) -> None:
    """Write rows the way the pipeline does, with the service key. A few
    tables are closed even to the service role and written only through a
    worker function (download_masters, render_jobs, …); seeding those goes
    through the owner instead, since the functions are not what is tested
    here. Only a privilege refusal falls back — any other error is a broken
    seed and fails loudly."""
    for q, p in statements:
        with acting(conn, SERVICE, commit=True) as s:
            out = s.run(q + " returning 1", p)
        if out.ok:
            continue
        if out.sqlstate != "42501":
            raise AssertionError(f"seed failed: {out!r}\n{q}")
        with as_superuser(conn) as s:
            s.rows(q + " returning 1", p)


def _seed_api_key(s, org: str, name: str, key_hash: str, uid: str) -> str:
    """An API key row that fits the schema either side of the change that
    stops storing a key prefix (api_keys.prefix: required 8 characters before
    it, always null after): no prefix first, then a valid one."""
    q = "insert into public.api_keys (org_id, name, prefix, key_hash, created_by) values (%s, %s, %s, %s, %s) returning id"
    out = s.run(q, [org, name, None, key_hash, uid])
    if not out.ok and out.sqlstate in ("23502", "23514"):  # not-null / check
        out = s.run(q, [org, name, "Pref0000", key_hash, uid])
    if not out.ok:
        raise AssertionError(f"seed failed: {out!r}")
    return str(out.rows[0][0])


def _seed_tenant(conn: psycopg.Connection, t: Tenant) -> None:
    k, org, uid = t.key, t.org, t.actor.uid
    t.channel, t.video = f"chan-{k}", f"vid-{k}"
    ch, vid = t.channel, t.video

    # What the pipeline and the workers write, with the service key.
    _as_service(conn, [
            ("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s)",
             [ch, f"Channel {k.upper()}", org]),
            ("insert into public.videos (video_id, channel_id, title, slug, review_state) values (%s, %s, %s, %s, 'pending')",
             [vid, ch, f"Video {k}", f"slug-{k}"]),
            ("insert into public.metrics_snapshots (video_id, snapshot_date, views) values (%s, '2026-09-01', 10)", [vid]),
            ("insert into public.retention_points (video_id, elapsed_ratio, watch_ratio, measured_date) values (%s, 0.5, 0.4, '2026-09-01')", [vid]),
            ("insert into public.feedback_signals (video_id, signal, analyzed_date, channel_id) values (%s, 'ctr', '2026-09-01', %s)", [vid, ch]),
            ("insert into public.competitor_snapshots (video_id, channel_id, polled_date, chronos_channel_id) values (%s, %s, '2026-09-01', %s)",
             [f"comp-{k}", f"UCcomp{k}", ch]),
            ("insert into public.demand_signals (topic_phrase, mention_count, polled_date, channel_id) values ('phrase', 3, '2026-09-01', %s)", [ch]),
            ("insert into public.content_queue (entry_id, topic, added_at, channel_id) values (%s, 'topic', '2026-09-01', %s)", [f"q-{k}", ch]),
            ("insert into public.pipeline_runs (run_id, topic, current_stage, channel_id) values (%s, 'topic', 'script', %s)", [f"run-{k}", ch]),
            ("insert into public.video_costs (video_id, channel_id, unit, quantity, recorded_at) values (%s, %s, 'tts_characters', 100, '2026-09-01')",
             [vid, ch]),
            ("insert into public.channel_topic_performance (channel_id, topic, score, videos_analyzed, updated_at) values (%s, 'topic', 0.5, 1, '2026-09-01')", [ch]),
            ("insert into public.channel_credentials (channel_id, provider, status) values (%s, 'youtube', 'connected')", [ch]),
            ("insert into public.content_series (series_id, channel_id, name) values (%s, %s, %s)", [f"series-{k}", ch, f"Series {k}"]),
            ("insert into public.review_intents (channel_id, video_id, action, created_by) values (%s, %s, 'approve', %s)", [ch, vid, uid]),
            ("insert into public.publish_approvals (channel_id, video_ref, requested_by) values (%s, %s, %s)", [ch, f"slug-{k}", uid]),
            ("insert into public.learnings (channel_id, kind, dedup_key, observation) values (%s, 'hook', %s, 'obs')", [ch, f"dk-{k}"]),
            ("insert into public.alert_events (kind, severity, channel_id, title) values ('run_failed', 'warn', %s, 'alert')", [ch]),
            ("insert into public.app_audit_log (actor_user_id, actor_email, action, channel_id) values (%s, %s, 'channel.update', %s)",
             [uid, t.actor.email, ch]),
            ("insert into public.system_events (event_key, event, ts, video_id, channel_id) values (%s, 'run_started', '2026-09-01T00:00:00Z', %s, %s)",
             [f"ev-{k}", vid, ch]),
            ("insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes) values (%s, %s, 1920, 1080, 60, 1000)", [vid, org]),
            ("insert into public.credit_refunds (refund_id, purchase_external_id, org_id, reason, requested, taken, shortfall) values (%s, %s, %s, 'refund', 1, 1, 0)",
             [f"rf-{k}", f"pay-{k}", org]),
            ("insert into public.payment_events (provider, event_id, event_type, status, org_id) values ('paddle', %s, 'transaction.completed', 'processed', %s)",
             [f"evt-{k}", org]),
            ("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 1000, 1000)", [org]),
            ("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')", [org, uid]),
            ("insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after) values (%s, 'topup', 1000, 1000, 0)", [org]),
    ])

    # Credits through the functions the workers use (trusted caller).
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.grant_credits(%s, 500, 'seed')", [org])
        s.value("select public.reserve_credits(%s, %s, 60)", [org, f"job-{k}"])

    # Rows the workers create through functions that are closed even to the
    # service role (render_jobs via claim, api_* via the API's own functions).
    # The tenant's render job is seeded after its plan (_seed_render_job).
    with as_superuser(conn) as s:
        t.download_request = s.value(
            "insert into public.download_requests (org_id, channel_id, video_id, quality, status, requested_by) "
            "values (%s, %s, %s, '1080p', 'ready', %s) returning id", [org, ch, vid, uid])
        t.api_key_hash = _hex64(f"key-{k}")
        t.api_key_id = _seed_api_key(s, org, f"key {k}", t.api_key_hash, uid)
        s.rows("insert into public.api_requests (org_id, key_id, endpoint, status) values (%s, %s, 'videos.list', 200) returning 1",
               [org, t.api_key_id])
        s.rows("insert into public.api_holds (ref, org_id, key_id, amount_cents) values (%s, %s, %s, 100) returning 1",
               [f"ah-{uuid.uuid4()}", org, t.api_key_id])
        s.rows("insert into public.api_idempotency (key_id, idem_key, endpoint, fingerprint) values (%s, %s, 'videos.create', %s) returning 1",
               [t.api_key_id, f"idem-{k}", _hex64(k)])
        s.rows("insert into public.api_rate_counters (key_id, minute, count) values (%s, date_trunc('minute', now()), 1) returning 1",
               [t.api_key_id])
        # creative_jobs / creative_job_events are written only through 0036's
        # functions (and those need a model registry the lab does not have).
        t.creative_job = str(s.value(
            "insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
            "quoted_credits, requested_by) values (%s, 't2i', 'img-x', 'img-x', '{\"prompt\": \"seed\"}', 'completed', 6, %s) "
            "returning id", [org, uid]))
        s.rows("insert into public.creative_job_events (job_id, org_id, event, status) values (%s, %s, 'created', 'queued') returning 1",
               [t.creative_job, org])

    # The worker's record of what that job cost at the provider (0037).
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.record_creative_job_cost(%s, 'acme', null, 'img-x-1', 'image', 1, null, null)",
                [t.creative_job])

    # What only Supabase itself writes: Vault secrets, Storage objects.
    with as_superuser(conn) as s:
        secret = s.value("select vault.create_secret(%s, %s)", [f"token-{k}", f"seed-{k}"])
        s.rows("insert into public.channel_token_refs (channel_id, provider, vault_secret_id, youtube_channel_id, connected_by) "
               "values (%s, 'youtube', %s, %s, %s) returning 1", [ch, secret, f"UCyt{k}", uid])
        t.social_account = str(s.value(
            "insert into public.social_accounts (org_id, platform, external_id, status, created_by) "
            "values (%s, 'instagram', %s, 'connected', %s) returning id", [org, f"ig-{k}", uid]))
        social_secret = s.value("select vault.create_secret(%s)", [f"social-{k}"])
        s.rows("insert into public.social_account_secrets (account_id, access_secret_id) values (%s, %s) returning 1",
               [t.social_account, social_secret])
        s.rows("insert into storage.objects (bucket_id, name) values ('previews', %s) returning 1", [f"{ch}/slug-{k}.mp4"])

    # What the browser writes, through the user's own session and the triggers.
    with acting(conn, t.actor, commit=True) as s:
        t.publish_request = s.value(
            "insert into public.publish_requests (video_id, account_id) values (%s, %s) returning id",
            [vid, t.social_account])

    # Media library (0038): an upload ticket through the member's own session
    # (which also creates the org's quota row), and an asset the way the
    # worker registers a generated file.
    with acting(conn, t.actor, commit=True) as s:
        t.media_ticket = str(s.value("select public.request_upload(%s, %s, 'image/png', 1000) ->> 'ticket'",
                                     [org, f"poster-{k}.png"]))
    with acting(conn, SERVICE, commit=True) as s:
        t.media_asset = str(s.value(
            "select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 1000, %s, 'generated', "
            "p_width => 64, p_height => 64, p_provenance => '{\"job_id\": \"cj:seed\"}'::jsonb) ->> 'id'",
            [org, _hex64(f"asset-{k}")]))


def _seed_render_job(conn: psycopg.Connection, t: Tenant) -> None:
    """The tenant's queued run, paid the way "Run now" pays for it: migration
    0041 refuses a customer's render job without an open queue hold, so a hold
    first, then the job carrying it and its length. After the plans are seeded:
    this is the tenant's second open hold, and 0034's Free plan allows one."""
    k, org, uid = t.key, t.org, t.actor.uid
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.reserve_credits(%s, %s, 60)", [org, f"rj-seed-{k}"])
    with as_superuser(conn) as s:
        t.render_job = s.value(
            "insert into public.render_jobs (channel_id, kind, params, status, requested_by, credit_ref) "
            "values (%s, 'daily', '{\"duration\": 300}', 'queued', %s, %s) returning id",
            [t.channel, uid, f"rj-seed-{k}"])


def _seed_operator(conn: psycopg.Connection, sc: Scenario) -> None:
    op = sc.operator
    with as_superuser(conn) as s:
        # The roster is claimed (the production state after 0007's bootstrap):
        # the operator owns the platform and the default organization.
        s.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner') returning 1", [op.uid, op.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
               [DEFAULT_ORG, op.uid, op.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [DEFAULT_ORG, sc.dana.uid, sc.dana.email])
    _as_service(conn, [
            ("insert into public.videos (video_id, channel_id, title, slug, review_state) values (%s, 'default', 'Op video', 'slug-op', 'pending')",
             [sc.operator_video]),
            ("insert into public.system_events (event_key, event, ts, channel_id) values ('ev-global', 'poll', '2026-09-01T00:00:00Z', null)", []),
            ("insert into public.system_events (event_key, event, ts, video_id, channel_id) values ('ev-op', 'run_started', '2026-09-01T00:00:00Z', %s, 'default')",
             [sc.operator_video]),
            ("insert into public.alert_events (kind, severity, channel_id, title) values ('provider_low', 'critical', null, 'global alert')", []),
            ("insert into public.app_audit_log (actor_user_id, actor_email, action, channel_id) values (%s, %s, 'secrets.update', null)", [op.uid, op.email]),
            ("insert into public.provider_balances (provider, metric, unit, source) values ('elevenlabs', 'characters', 'chars', 'api')", []),
            ("insert into public.provider_billing_settings (provider) values ('elevenlabs')", []),
            ("insert into public.provider_topups (provider, amount_usd) values ('elevenlabs', 10)", []),
            ("insert into public.topic_performance (topic, score, videos_analyzed, updated_at) values ('topic', 0.5, 1, '2026-09-01')", []),
            ("insert into public.trending_snapshots (video_id, polled_date) values ('trend-1', '2026-09-01')", []),
    ])


#: Model registry seed (0035): one model that is verified, priced and on sale,
#: one that is only in the file (hidden), and one whose vendor terms gate it.
MODEL_SOLD, MODEL_HIDDEN, MODEL_GATED = "lab-sold-1", "lab-hidden-1", "lab-gated-1"


def _model_row(mid: str, **spec) -> dict:
    return {"id": mid, "display_name": mid, "provider": "lab", "adapter": "image.openai",
            "capabilities": ["t2i"], "credit_unit": f"model_{mid.replace('-', '_')}_image",
            "entitlement": "models_image:basic",
            "spec": {"vendor_model": "lab-model-1", "output": "image", "pricing": {"unit": "image",
                     "provider_usd_per_unit": 0.04}, "terms_gate": None, **spec}}


def _seed_models(conn: psycopg.Connection) -> None:
    rows = [_model_row(MODEL_SOLD), _model_row(MODEL_HIDDEN),
            _model_row(MODEL_GATED, terms_gate="written_consent_required")]
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
        for mid in (MODEL_SOLD, MODEL_GATED):
            s.value("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, "
                    "null, null, 900, 1234, 'security-lab')", [mid])
        s.value("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', false, "
                "'auth', 'HTTP 401', 100, null, 'security-lab')", [MODEL_HIDDEN])
        s.rows("update public.model_registry set availability = 'beta' where id = %s returning 1", [MODEL_SOLD])
    with as_superuser(conn) as s:
        s.rows("insert into public.credit_prices (unit, credits_per_unit) values (%s, 4), (%s, 4), (%s, 4) returning 1",
               [f"model_{m.replace('-', '_')}_image" for m in (MODEL_SOLD, MODEL_HIDDEN, MODEL_GATED)])


def build_scenario(conn: psycopg.Connection) -> Scenario:
    sc = Scenario(
        operator=user("operator", "operator@nightshift.test"),
        alice=Tenant("a", user("alice", "alice@a.test")),
        bob=Tenant("b", user("bob", "bob@b.test")),
        stranger=user("sam", "sam@s.test"),
        dana=user("dana", "dana@d.test"),
        invitee=user("ivan", "ivan@a.test"),
    )
    for who in (sc.operator, sc.alice.actor, sc.bob.actor, sc.stranger, sc.dana, sc.invitee):
        _signup(conn, who)
    _seed_operator(conn, sc)
    _seed_models(conn)
    for t, name in ((sc.alice, "Alice Studio"), (sc.bob, "Bob Media")):
        t.org = _create_org(conn, t.actor, name)
        _seed_tenant(conn, t)
    # Plans (0034): Alice on Creator, Bob on Pro (tests/security/sec_plans_0034.py).
    import sec_plans_0034
    sec_plans_0034.seed(conn, sc)
    for t in sc.tenants():
        _seed_render_job(conn, t)
    # A pending invite into org A, addressed to Ivan's email, not yet accepted.
    with acting(conn, sc.alice.actor, commit=True) as s:
        s.value("select public.invite_org_member(%s, %s, 'viewer')", [sc.alice.org, sc.invitee.email])

    # One web rate-limit window each (0042), written the only way it can be:
    # by the user's own take_web_rate() call.
    with as_superuser(conn, commit=False) as s:
        has_rate = s.value("select to_regprocedure('public.take_web_rate(text,integer,integer)') is not null")
    if has_rate:
        for t in sc.tenants():
            with acting(conn, t.actor, commit=True) as s:
                s.value("select public.take_web_rate('scenario', 10, 3600)")
    # A Telegram update the control bot claimed, with the service key (0042).
    with as_superuser(conn, commit=False) as s:
        has_tg = s.value("select to_regclass('public.telegram_updates') is not null")
    if has_tg:
        _as_service(conn, [("insert into public.telegram_updates (update_id) values (1000)", [])])

    with as_superuser(conn) as s:
        sc.channel_org = {r[0]: str(r[1]) for r in s.rows("select channel_id, org_id from public.channels")}
        sc.video_channel = {r[0]: r[1] for r in s.rows("select video_id, channel_id from public.videos")}
    return sc
