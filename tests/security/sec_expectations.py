"""What every table and every callable function is supposed to allow.

This file is the contract a migration signs. The catalog tests enumerate the
database (every RLS table in ``public``, every function the API roles could
reach) and fail on anything that is not declared here, so a new table or
function cannot ship without someone deciding — in review, in this file — who
may read it, who may write it, and whose rows it holds.

Table kinds
-----------
``Org(col)``      the row belongs to the organization in ``col``.
``Channel(col)``  the row belongs to the organization that owns the channel in
                  ``col``. ``null_is_platform``: a row with no channel is the
                  operator's global infrastructure.
``Video(col)``    the row belongs to the organization that owns the video's channel.
``Platform()``    operator-only data (the operator's providers, spend, roster).
``Public()``      readable by any signed-in user (and by anon if ``anon``):
                  price lists, region-wide public YouTube data. Nobody writes.
``Service()``     no API role reads or writes it; only the service key does.

``own_read``   the tenant can read its own rows (the positive control that
               keeps the isolation tests from passing vacuously).
``own_insert`` the tenant may insert a row into its own scope directly
               (an INSERT policy exists for the table).
``operator_reads``  False for a person's private inbox: the platform admin does
               not read it either (test_sec_notifications.py proves that).
``own_insert_setup``  SQL the tenant runs first, in the same transaction, for
               a table whose own-row insert needs something only the tenant
               can create (a render job needs its own fresh credit hold,
               migration 0041). Returns a jsonb of column values for the row;
               ``%(org)s`` is the tenant's organization.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class Kind:
    kind: str
    col: Optional[str] = None
    null_is_platform: bool = False
    own_read: bool = True
    own_insert: bool = False
    anon: bool = False
    # Columns to give fresh values when cloning a row for an insert attack,
    # beyond the primary key and unique constraints (expression indexes).
    mutate: Tuple[str, ...] = ()
    own_insert_setup: Optional[str] = None
    # False for a table that is one person's own inbox (notifications, 0064):
    # not even a platform admin reads another person's rows, so the "operator
    # still reads every tenant" check does not apply to it.
    operator_reads: bool = True


def Org(col="org_id", **kw) -> Kind:
    return Kind("org", col, **kw)


def Channel(col="channel_id", **kw) -> Kind:
    return Kind("channel", col, **kw)


def Video(col="video_id", **kw) -> Kind:
    return Kind("video", col, **kw)


def Platform(**kw) -> Kind:
    return Kind("platform", own_read=False, **kw)


def Public(**kw) -> Kind:
    return Kind("public", own_read=False, **kw)


def Service(**kw) -> Kind:
    return Kind("service", own_read=False, **kw)


TABLES: Dict[str, Kind] = {
    # tenancy
    "organizations": Org("id"),
    # No direct write for any API role since 0091: a workspace has one person (create_organization() adds it).
    "org_members": Org(mutate=("email",)),
    "app_members": Platform(),
    # channels and everything the pipeline writes about them
    # No direct INSERT for any API role since 0086: create_channel() is the way in
    # (so own_insert is False: the lab then proves the refusal).
    "channels": Org(),
    "channel_credentials": Channel(),
    "channel_token_refs": Service(),
    "channel_topic_performance": Channel(),
    "competitor_snapshots": Channel("chronos_channel_id"),
    "content_queue": Channel(),
    "content_series": Channel(own_insert=True),
    "demand_signals": Channel(),
    "feedback_signals": Channel(),
    "learnings": Channel(),
    "pipeline_runs": Channel(),
    "publish_approvals": Channel(own_insert=True),
    "review_intents": Channel(own_insert=True),
    "video_costs": Channel(),
    "videos": Channel(),
    "metrics_snapshots": Video(),
    "retention_points": Video(),
    # A customer's run carries a fresh, open queue hold of its own org (0041).
    "render_jobs": Channel(own_insert=True, own_insert_setup=(
        "select jsonb_build_object('credit_ref', r ->> 'job_id') "
        "from public.reserve_credits(%(org)s, 'rj-' || gen_random_uuid()::text, 60) r")),
    # mixed streams: channel rows are the tenant's, channel-less rows the operator's
    "system_events": Channel(null_is_platform=True),
    "alert_events": Channel(null_is_platform=True, own_insert=True),
    "app_audit_log": Channel(null_is_platform=True, own_insert=True),
    # credits
    "credit_accounts": Org(),
    "credit_transactions": Org(),
    "credit_reservations": Org(),
    "credit_refunds": Service(),
    # 0084 (BR-G-001): the base rates, margins and notes are the operator's;
    # members read the rates as charged through credit_rates().
    "credit_prices": Platform(),
    "payment_events": Service(),
    # downloads and publishing
    "download_masters": Org(),
    "download_requests": Org(),
    "publish_requests": Org(own_insert=True),
    "social_accounts": Org(),
    "social_account_secrets": Service(),
    # public API
    "api_accounts": Org(),
    "api_settings": Org(),
    "api_keys": Org(),
    "api_creative_jobs": Org(),
    "api_ledger": Org(),
    "api_requests": Org(),
    "api_holds": Org(),
    "api_idempotency": Service(),
    "api_rate_counters": Service(),
    "api_prices": Public(anon=True),
    # web/API hardening (0042): written only by their security-definer functions
    "welcome_credit_claims": Service(),
    "web_rate_counters": Service(),
    "telegram_updates": Service(),
    # the operator's own providers and legacy global scores
    "provider_balances": Platform(),
    "provider_billing_settings": Platform(),
    "provider_topups": Platform(),
    "topic_performance": Platform(),
    # region-wide public YouTube data, owned by no channel (0018: deliberately global)
    "trending_snapshots": Public(),
    # media library (0038): rows appear only through its functions
    "media_assets": Org(),
    "media_uploads": Org(),
    "org_storage_quota": Org(),
    "media_storage_settings": Public(),
    # model registry (0035): signed-in users read sellable rows' public columns;
    # probe runs are the operator's evidence
    "model_registry": Public(),
    "model_probe_runs": Platform(),
    # creative generations (0036) and their provider cost (0037: operator economics)
    "creative_jobs": Org(),
    "creative_job_events": Org(),
    "creative_job_costs": Platform(),
    # Model Router (0075, BR-L-022): a routed job's ranked candidates and tried
    # models. No API role at all (not even the service key): only the definer
    # functions create_creative_job / reroute_creative_job touch it.
    "creative_job_routes": Service(),
    # worker status (0045): the operator's view of the workers; written only by report_worker_status()
    "worker_status": Platform(),
}


# ── views ────────────────────────────────────────────────────────────────────
# A view must be declared here AND run with the caller's rights
# (security_invoker), or it reads past every policy of the tables under it.
# Only Platform views exist so far: nobody but the operator reads a row.

VIEWS: Dict[str, Kind] = {
    "creative_economics": Platform(),
}


# ── functions ────────────────────────────────────────────────────────────────
# name -> (anon may execute, authenticated may execute). Trigger functions and
# functions owned by an extension are not listed (nobody calls them directly).
#
# SERVICE: the workers' and webhooks' functions. Neither API role may call them.
# USER:    a signed-in user may call it; the function checks org membership or
#          platform admin itself (tests in test_sec_attacks.py prove the check).
# HELPER:  a read-only helper the RLS policies are built from; signed-in only
#          (0033: anon may not probe tenancy, e.g. channel_org of any id).
# HELPER_ANON: pure functions with nothing to reveal.
# API:     the public REST API's entry points: anon calls them with a key hash.

SERVICE = (False, False)
USER = (False, True)
API = (True, False)
HELPER_ANON = (True, True)
HELPER = (False, True)
# PRICE_LIST: a price list anyone may read, signed in or not (it names what a
#          member is already charged, never the margin): 0089.
PRICE_LIST = (True, True)

FUNCTIONS: Dict[str, Tuple[bool, bool]] = {
    # tenancy and roles (0007, 0018)
    "accessible_channel_ids": HELPER,
    "accessible_org_ids": HELPER,
    "accessible_video_ids": HELPER,
    "app_members_empty": HELPER,
    "app_role_rank": HELPER_ANON,
    "bind_current_member": HELPER,
    "accept_org_invite": SERVICE,  # closed by 0091: no invitations
    "bind_org_memberships": USER,
    "decline_org_invite": SERVICE,  # closed by 0091: no invitations
    "my_confirmed_email": HELPER,
    "my_invites": SERVICE,  # closed by 0091: no invitations
    "channel_org": HELPER,
    "create_organization": USER,
    "current_app_role": HELPER,
    "default_org_id": HELPER_ANON,
    "in_default_org_roster": HELPER,
    "invite_org_member": SERVICE,  # closed by 0091: no invitations
    "is_org_member": HELPER,
    "is_platform_admin": HELPER,
    "my_organizations": HELPER,
    "org_role": HELPER,
    "platform_role": HELPER,
    "render_job_params_valid": HELPER_ANON,
    # credits (0020, 0021, 0027)
    "add_purchased_credits": SERVICE,
    "capture_credits": SERVICE,
    "credit_account_lock": SERVICE,
    "credit_log": SERVICE,
    "credit_release_locked": SERVICE,
    "credits_exempt": HELPER,
    "credits_round_up": HELPER,
    "credits_trusted_caller": SERVICE,
    "expire_credit_reservations": SERVICE,
    "grant_credits": USER,
    "record_payment_event": SERVICE,
    "refund_purchased_credits": SERVICE,
    "release_credits": SERVICE,
    "reserve_credits": USER,
    "start_credit_reservation": SERVICE,
    # render queue (0017)
    "claim_render_job": SERVICE,
    # channel tokens (0022)
    "channel_token_allowed_scopes": SERVICE,
    "channel_token_status": USER,
    "channel_token_trusted_caller": SERVICE,
    "read_channel_token": SERVICE,
    "revoke_channel_token": USER,
    "store_channel_token": USER,
    # social accounts and publishing (0028, 0029)
    "claim_publish_request": SERVICE,
    "publish_channel_connected": SERVICE,
    "publish_request_refusal": SERVICE,
    "read_social_token": SERVICE,
    "revoke_social_account": USER,
    "rotate_social_token": SERVICE,
    "set_social_account_status": SERVICE,
    "social_allowed_scopes": SERVICE,
    "social_destroy_secret": SERVICE,
    "social_put_secret": SERVICE,
    "social_token_ok": SERVICE,
    "social_trusted_caller": SERVICE,
    "store_social_account": USER,
    # paid downloads (0030)
    "claim_download_request": SERVICE,
    "download_credits_price": SERVICE,
    "download_fail_locked": SERVICE,
    "download_quality_side": SERVICE,
    "download_refund_locked": SERVICE,
    "finish_download_request": SERVICE,
    "forget_download_master": SERVICE,
    "record_download_master": SERVICE,
    "request_download": USER,
    # public API (0031)
    "api_account_lock": SERVICE,
    "api_act_as": SERVICE,
    "api_activate": USER,
    "api_add_topup": SERVICE,
    "api_adjust_balance": USER,
    "api_audit": SERVICE,
    "api_auth": API,
    "api_balance": API,
    "api_begin": SERVICE,
    "api_console": USER,
    "api_create_video": API,
    "api_creative_create": API,
    "api_creative_get": API,
    "api_creative_job_json": SERVICE,
    "api_creative_model_ok": SERVICE,
    "api_creative_month_credits": SERVICE,
    "api_creative_quote": API,
    "api_creative_refusal": SERVICE,
    "api_endpoint_scope": SERVICE,
    "api_err": SERVICE,
    "api_expire_holds_locked": SERVICE,
    "api_finish": SERVICE,
    "api_get_download": API,
    "api_get_job": API,
    "api_get_video": API,
    "api_hold_start": SERVICE,
    "api_idem_begin": SERVICE,
    "api_idem_end": SERVICE,
    "api_legacy_scopes": SERVICE,
    "api_list_channels": API,
    "api_list_connected_accounts": API,
    "api_list_videos": API,
    "api_log": SERVICE,
    "api_month_spend": SERVICE,
    "api_ok": SERVICE,
    "api_org_eligible": SERVICE,
    "api_refund_topup": SERVICE,
    "api_request_download": API,
    "api_request_publish": API,
    "api_scopes_valid": SERVICE,
    "api_set_monthly_limit": USER,
    "api_settle_locked": SERVICE,
    "api_tier_for": SERVICE,
    "api_tier_limits": SERVICE,
    "api_usage": USER,
    "api_video_json": SERVICE,
    "api_video_price": SERVICE,
    "create_api_key": USER,
    "create_scoped_api_key": USER,
    "revoke_api_key": USER,
    "set_api_key_access": USER,
    "set_api_key_limit": USER,
    # web/API hardening (0042)
    "take_web_rate": USER,
    "welcome_email_key": SERVICE,
    # media library (0038)
    "request_upload": USER,
    "begin_upload_receive": USER,
    "finish_upload_receive": USER,
    "soft_delete_asset": USER,
    "claim_media_upload": SERVICE,
    "reject_media_upload": SERVICE,
    "register_asset": SERVICE,
    "claim_media_purge": SERVICE,
    "mark_asset_purged": SERVICE,
    "media_mime_kind": SERVICE,
    "media_ext_mime": SERVICE,
    "media_clean_name": SERVICE,
    "media_normalize_mime": SERVICE,
    "media_quota_lock": SERVICE,
    "media_quota_limit": SERVICE,
    "media_pending_bytes": SERVICE,
    "media_uploads_sweep": SERVICE,
    # model registry (0035)
    "sellable_models": USER,
    # the price list as charged, never the margin (0084)
    "credit_rates": USER,
    # what a video costs in credits, for the public price pages (0089)
    "public_video_rates": PRICE_LIST,
    "model_registry_admin": USER,
    "record_model_probe": SERVICE,
    "sync_model_registry": SERVICE,
    # creative jobs (0036): members quote / create / cancel; the worker runs them
    "quote_creative_job": USER,
    "create_creative_job": USER,
    "cancel_creative_job": USER,
    "claim_creative_job": SERVICE,
    "heartbeat_creative_job": SERVICE,
    "advance_creative_job": SERVICE,
    "finish_creative_job": SERVICE,
    "expire_creative_jobs": SERVICE,
    "creative_capability_supported": SERVICE,
    "creative_end_locked": SERVICE,
    "creative_expire_locked": SERVICE,
    "creative_job_json": SERVICE,
    "creative_job_log": SERVICE,
    "creative_json_int": SERVICE,
    "creative_params_problem": SERVICE,
    "creative_platform_release": SERVICE,
    "creative_platform_reserve": SERVICE,
    "creative_price": SERVICE,
    "creative_quantity": SERVICE,
    "creative_refuse": SERVICE,
    # media inputs (0046): the source check is internal; the worker re-reads
    # the source of a job it holds and attaches the job's library outputs
    "creative_source_problem": SERVICE,
    "creative_job_source": SERVICE,
    "attach_creative_job_assets": SERVICE,
    # voice tools (0050): a recording's length prices the job; read inside
    # creative_price only, never through the API
    "creative_source_seconds": SERVICE,
    # video tools (0052): the picture rules for a first or an end frame,
    # read inside creative_source_problem only
    "creative_picture_problem": SERVICE,
    # style inputs (0048): the kit check is internal; the worker reads the
    # style of a job it holds (its kit and @characters, in the job's org)
    "creative_style_problem": SERVICE,
    "creative_job_style": SERVICE,
    # provider costs (0037)
    "record_creative_job_cost": SERVICE,
    # worker status (0045): workers report; a signed-in user may ask only whether media checking runs
    "report_worker_status": SERVICE,
    "media_pipeline_state": USER,
}


# Migration 0034 (plans, entitlements, credit lots): tests/security/sec_plans_0034.py
import sec_plans_0034  # noqa: E402

sec_plans_0034.extend(TABLES, FUNCTIONS)

# Migration 0047 (style kits, characters): tests/security/sec_style_0047.py
import sec_style_0047  # noqa: E402

sec_style_0047.extend(TABLES, FUNCTIONS)

# Migration 0049 (media library folders): tests/security/sec_folders_0049.py
import sec_folders_0049  # noqa: E402

sec_folders_0049.extend(TABLES, FUNCTIONS)

# Migration 0054 (video editor projects and exports): tests/security/sec_editor_0054.py
import sec_editor_0054  # noqa: E402

sec_editor_0054.extend(TABLES, FUNCTIONS)

# Migration 0056 (Channel DNA): tests/security/sec_dna_0056.py
import sec_dna_0056  # noqa: E402

sec_dna_0056.extend(TABLES, FUNCTIONS)

# Migration 0057 (storyboard review): tests/security/sec_storyboard_0057.py
import sec_storyboard_0057  # noqa: E402

sec_storyboard_0057.extend(TABLES, FUNCTIONS)

# Migration 0058 (storyboard editing, re-open after a failed render): tests/security/sec_storyboard_0058.py
import sec_storyboard_0058  # noqa: E402

sec_storyboard_0058.extend(TABLES, FUNCTIONS)

# Migration 0072 (auto-captions): tests/security/sec_captions_0072.py
import sec_captions_0072  # noqa: E402

sec_captions_0072.extend(TABLES, FUNCTIONS)

# Migration 0064 (in-app notifications): tests/security/sec_notify_0064.py
import sec_notify_0064  # noqa: E402

sec_notify_0064.extend(TABLES, FUNCTIONS)

# Migration 0063 (operator margin report): tests/security/sec_margin_0063.py
import sec_margin_0063  # noqa: E402

sec_margin_0063.extend(TABLES, FUNCTIONS)

# Migration 0065 (the Style Library's add function): tests/security/sec_style_0065.py
import sec_style_0065  # noqa: E402

sec_style_0065.extend(TABLES, FUNCTIONS)

# Migration 0073 (workflow apps): tests/security/sec_workflows_0073.py
import sec_workflows_0073  # noqa: E402

sec_workflows_0073.extend(TABLES, FUNCTIONS)

# Migration 0075 (Model Router v1): tests/security/sec_router_0075.py
import sec_router_0075  # noqa: E402

sec_router_0075.extend(TABLES, FUNCTIONS)

# Migration 0076 (scene regeneration v2): tests/security/sec_scene_regen_0076.py
import sec_scene_regen_0076  # noqa: E402

sec_scene_regen_0076.extend(TABLES, FUNCTIONS)

# Migrations 0086-0088 (channel configuration lock, audit and rate hardening,
# failover reason): tests/security/sec_channel_lock_0086.py
import sec_channel_lock_0086  # noqa: E402

sec_channel_lock_0086.extend(TABLES, FUNCTIONS)

# Migration 0080 (multi-clip repurposing): tests/security/sec_repurpose_0080.py
import sec_repurpose_0080  # noqa: E402

sec_repurpose_0080.extend(TABLES, FUNCTIONS)

# Migration 0081 (the comment inbox): tests/security/sec_inbox_0081.py
import sec_inbox_0081  # noqa: E402

sec_inbox_0081.extend(TABLES, FUNCTIONS)

# Migration 0094 (extra credits switch, the Usage page): tests/security/sec_extra_credits_0094.py
import sec_extra_credits_0094  # noqa: E402

sec_extra_credits_0094.extend(TABLES, FUNCTIONS)

# Migration 0092 (Invite friends): tests/security/sec_friend_invites_0092.py
import sec_friend_invites_0092  # noqa: E402

sec_friend_invites_0092.extend(TABLES, FUNCTIONS)
