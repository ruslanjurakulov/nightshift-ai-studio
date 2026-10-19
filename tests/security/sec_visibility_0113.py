"""Security-lab contract for migration 0113 (publish when approved: the switch, the queue, the quota ledger).

Wired in like the other per-migration files:

  * sec_expectations.py, at the bottom:
        import sec_visibility_0113; sec_visibility_0113.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_visibility_0113.seed(conn, sc)

Two tables, neither writable by any API role (the service key included):

  video_visibility_requests  Channel: members read their organization's rows (RLS, without the worker's own columns);
                             every write is one of the functions below. own_insert is False, so the lab proves the refusal.
  youtube_quota_ledger       Platform: a platform admin may SELECT; written only by youtube_quota_take() / youtube_quota_refund().

Every new function is declared: the two person-facing ones are USER (a signed-in caller; the function itself raises 42501 for
anyone who is not an administrator and a real member of the channel's organization, which test_sec_visibility.py proves), the
worker's are SERVICE (granted to service_role only), and the vocabulary list is SERVICE (no API role at all).

The seeded request of each tenant is FINISHED (refused: not_enabled), so the shared scenario never hands the worker's claim a
live row that another test did not create.
"""

from __future__ import annotations

import hashlib


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Channel, Platform

    tables.update({
        "video_visibility_requests": Channel(),
        "youtube_quota_ledger": Platform(),
    })
    functions.update({
        # the person's own session (each checks the organization and the role itself)
        "set_channel_publish_on_approve": USER,
        "retry_video_visibility": USER,
        # the worker (service role only)
        "claim_visibility_request": SERVICE,
        "mark_visibility_submitting": SERVICE,
        "finish_visibility_request": SERVICE,
        "visibility_request_refusal": SERVICE,
        "youtube_quota_take": SERVICE,
        "youtube_quota_refund": SERVICE,
        # internal: the one list of closed words; no API role
        "visibility_reason_words": SERVICE,
        "visibility_channel_connected": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        for t in sc.tenants():
            s.rows(
                "insert into public.video_visibility_requests (org_id, channel_id, video_id, approved_cut_sha256, decided_at, "
                "expires_at, status, reason, finished_at) "
                "values (%s, %s, %s, %s, now(), now() + interval '24 hours', 'refused', 'not_enabled', now()) returning 1",
                [t.org, t.channel, t.video, hashlib.sha256(f"seed-{t.key}".encode()).hexdigest()])
        s.rows("insert into public.youtube_quota_ledger (day, project, source, org_id, units) "
               "values (current_date, 'seed', 'visibility', '00000000-0000-0000-0000-000000000000', 50) returning 1")
