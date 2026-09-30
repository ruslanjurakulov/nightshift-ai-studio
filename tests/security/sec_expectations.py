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
    "org_members": Org(own_insert=True, mutate=("email",)),
    "app_members": Platform(),
    # channels and everything the pipeline writes about them
    "channels": Org(own_insert=True),
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
    "render_jobs": Channel(own_insert=True),
    # mixed streams: channel rows are the tenant's, channel-less rows the operator's
    "system_events": Channel(null_is_platform=True),
    "alert_events": Channel(null_is_platform=True, own_insert=True),
    "app_audit_log": Channel(null_is_platform=True, own_insert=True),
    # credits
    "credit_accounts": Org(),
    "credit_transactions": Org(),
    "credit_reservations": Org(),
    "credit_refunds": Service(),
    "credit_prices": Public(),
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
    "api_ledger": Org(),
    "api_requests": Org(),
    "api_holds": Org(),
    "api_idempotency": Service(),
    "api_rate_counters": Service(),
    "api_prices": Public(anon=True),
    # the operator's own providers and legacy global scores
    "provider_balances": Platform(),
    "provider_billing_settings": Platform(),
    "provider_topups": Platform(),
    "topic_performance": Platform(),
    # region-wide public YouTube data, owned by no channel (0018: deliberately global)
    "trending_snapshots": Public(),
}


# ── functions ────────────────────────────────────────────────────────────────
# name -> (anon may execute, authenticated may execute). Trigger functions and
# functions owned by an extension are not listed (nobody calls them directly).
#
# SERVICE: the workers' and webhooks' functions. Neither API role may call them.
# USER:    a signed-in user may call it; the function checks org membership or
#          platform admin itself (tests in test_sec_attacks.py prove the check).
# HELPER:  a pure or read-only helper the RLS policies are built from.
# API:     the public REST API's entry points: anon calls them with a key hash.

SERVICE = (False, False)
USER = (False, True)
API = (True, False)
HELPER_ANON = (True, True)
HELPER = (False, True)

FUNCTIONS: Dict[str, Tuple[bool, bool]] = {
    # tenancy and roles (0007, 0018)
    "accessible_channel_ids": HELPER_ANON,
    "accessible_org_ids": HELPER_ANON,
    "accessible_video_ids": HELPER_ANON,
    "app_members_empty": HELPER_ANON,
    "app_role_rank": HELPER_ANON,
    "bind_current_member": HELPER_ANON,
    "bind_org_memberships": USER,
    "channel_org": HELPER_ANON,
    "create_organization": USER,
    "current_app_role": HELPER_ANON,
    "default_org_id": HELPER_ANON,
    "in_default_org_roster": HELPER_ANON,
    "invite_org_member": USER,
    "is_org_member": HELPER_ANON,
    "is_platform_admin": HELPER_ANON,
    "my_organizations": HELPER_ANON,
    "org_role": HELPER_ANON,
    "platform_role": HELPER_ANON,
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
    "api_err": SERVICE,
    "api_expire_holds_locked": SERVICE,
    "api_finish": SERVICE,
    "api_get_download": API,
    "api_get_job": API,
    "api_get_video": API,
    "api_hold_start": SERVICE,
    "api_idem_begin": SERVICE,
    "api_idem_end": SERVICE,
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
    "api_set_monthly_limit": USER,
    "api_settle_locked": SERVICE,
    "api_tier_for": SERVICE,
    "api_tier_limits": SERVICE,
    "api_usage": USER,
    "api_video_json": SERVICE,
    "api_video_price": SERVICE,
    "create_api_key": USER,
    "revoke_api_key": USER,
    "set_api_key_limit": USER,
}
