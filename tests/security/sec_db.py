"""Database plumbing for the security lab: build a scratch database from the
repository's own SQL, and act inside it as a given API caller.

Everything here talks to a plain Postgres 16 (the CI service container, or a
local cluster). ``bootstrap.sql`` stands in for what Supabase provides before
our SQL runs; see that file for what is emulated and why it is enough.

The admin DSN comes from ``NIGHTSHIFT_SECURITY_PG`` and must be a superuser
(``postgres``): it creates the scratch database, applies the migrations and
switches into the API roles with ``SET LOCAL ROLE``.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence

import psycopg
from psycopg import sql

REPO = Path(__file__).resolve().parents[2]
BOOTSTRAP = Path(__file__).resolve().parent / "bootstrap.sql"
SCHEMA = REPO / "supabase" / "schema.sql"
MIGRATIONS = REPO / "supabase" / "migrations"

DSN_ENV = "NIGHTSHIFT_SECURITY_PG"

_MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def admin_dsn() -> Optional[str]:
    return os.environ.get(DSN_ENV) or None


def one_rate_window(dsn: str, window_s: int, need_s: float = 20.0) -> None:
    """Wait, if needed, so the next ``need_s`` seconds of a test fall in one window of take_web_rate (0042/0087).

    take_web_rate counts in fixed windows (floor(now / window)), and the first call of a new window deletes the caller's older windows
    of that bucket (0087; BR-G-004 pins it). A test that makes several counted calls, each in its own transaction, and then reads the
    counter or expects the limit, is right only inside one window: across the boundary the count starts again at 1 and the earlier
    calls are gone. That is the limiter working as designed, not a call escaping it, and it failed test_sec_films_money once on #824
    (10 refused starts from 17:59:59.69 to 18:00:00.34 summed to 7: three in the old hour, seven in the new one). The clock is the
    database's own, the one take_web_rate reads. At most ``need_s`` of waiting, and only that close to a boundary.
    """
    with psycopg.connect(dsn, autocommit=True) as c:
        epoch = float(c.execute("select extract(epoch from clock_timestamp())").fetchone()[0])
    left = window_s - (epoch % window_s)
    if left < need_s:
        time.sleep(left + 0.05)


MIGRATION_0119 = MIGRATIONS / "0119_channel_settings_guard.sql"
ROLLBACK_0119 = REPO / "docs" / "sql" / "rollback_0119_channel_settings_guard.sql"


def take_off_0119(session) -> None:
    """0119 replaces channels_config_guard() on 0117's body, and 0117 (and its rollback) refuse any other body. A test that replays
    or rolls back 0117 takes 0119 off first with its own rollback, and puts it back with put_back_0119 where the chain goes on."""
    text = ROLLBACK_0119.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0119(session) -> None:
    session.conn.execute(MIGRATION_0119.read_text(encoding="utf-8"))


MIGRATION_0121 = MIGRATIONS / "0121_voice_job_gates.sql"
ROLLBACK_0121 = REPO / "docs" / "sql" / "rollback_0121_voice_job_gates.sql"


def take_off_0121(session) -> None:
    """0121 replaces claim_voice_job() and channel_voice_config_problem() on 0117's bodies and adds three functions. A test that replays
    0117 or applies its rollback on a database that has 0121 takes 0121 off first with its own rollback, and puts it back with
    put_back_0121 where the chain goes on. 0145 sits on 0117's audit_action_allowed(), so it comes off here too (every replay of 0117
    goes through this helper) and goes back with put_back_0121."""
    take_off_0145(session)
    text = ROLLBACK_0121.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0121(session) -> None:
    session.conn.execute(MIGRATION_0121.read_text(encoding="utf-8"))
    put_back_0145(session)


MIGRATION_0122 = MIGRATIONS / "0122_series_template_carrier.sql"
ROLLBACK_0122 = REPO / "docs" / "sql" / "rollback_0122_series_template_carrier.sql"


def take_off_0122(session) -> None:
    """0122 replaces render_job_params_valid(), render_jobs_payment_guard(), series_plans_terms_frozen() and request_series_plan() on 0120's
    bodies, and 0120 (and its rollback) refuse any other body. A test that replays 0120 or applies its rollback on a database that has 0122
    takes 0122 off first with its own rollback, and puts it back with put_back_0122 where the chain goes on. 0127 sits on 0122's
    request_series_plan(), and 0122's rollback refuses any other body, so 0127 comes off first when it is there. 0145 sits on 0122's
    render_job_params_valid(): it comes off first too, and goes back with put_back_0122."""
    take_off_0145(session)
    if _has_0127(session):
        take_off_0127(session)
    text = ROLLBACK_0122.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0122(session) -> None:
    session.conn.execute(MIGRATION_0122.read_text(encoding="utf-8"))
    put_back_0127(session)
    put_back_0145(session)


MIGRATION_0145 = MIGRATIONS / "0145_made_for_kids.sql"
ROLLBACK_0145 = REPO / "docs" / "sql" / "rollback_0145_made_for_kids.sql"
#: The bodies 0145 replaces, as 0122, 0117 and 0116 left them: 0145 goes back on only on top of all three (tests/test_made_for_kids_migration.py
#: pins the same two hashes in the file's drift guard).
_BEFORE_0145 = {"public.render_job_params_valid(jsonb, text)": "a9367e46ea79e8d57ce1c876333b5508",
                "public.audit_action_allowed(text)": "d622e052a695fef125d3b2b621cdda27",
                "public.approve_video_publish(text, text, jsonb)": "0e9a1608120a5fb7b48eab1c6cb08ee0"}


def _live_md5(session, signature: str):
    row = session.conn.execute("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)",
                               [signature]).fetchone()
    return row[0] if row else None


MIGRATION_0227 = MIGRATIONS / "0227_owner_model_terms_acceptance.sql"
ROLLBACK_0227 = REPO / "docs" / "sql" / "rollback_0227_owner_model_terms_acceptance.sql"


def take_off_0227(session) -> None:
    """Restore 0145's audit action list before rolling back or replaying 0145."""
    if session.value("select to_regprocedure('public.model_terms_acceptance_guard()') is not null"):
        text = ROLLBACK_0227.read_text(encoding="utf-8")
        session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0227(session) -> None:
    """Restore 0227 after replaying the migrations that supply 0145's audit list."""
    session.conn.execute(MIGRATION_0227.read_text(encoding="utf-8"))


def take_off_0145(session) -> None:
    """0145 replaces render_job_params_valid() on 0122's body, audit_action_allowed() on 0117's, approve_video_publish() on 0116's and 0076's render_jobs_insert policy, and
    adds set_video_made_for_kids(); 0122, 0117 and their rollbacks refuse any other body. Taken off with its own rollback when it is there
    (the columns stay, as the rollback keeps them); put back with put_back_0145."""
    take_off_0227(session)
    if session.conn.execute("select to_regprocedure('public.set_video_made_for_kids(text, boolean, boolean, text)') is not null").fetchone()[0]:
        text = ROLLBACK_0145.read_text(encoding="utf-8")
        session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0145(session) -> None:
    """0145 again, once the chain under it is whole again (0122's and 0117's bodies live) and it is not on already: the helpers that take
    0121 or 0122 off and on call this, in whichever order a test puts them back."""
    if session.conn.execute("select to_regprocedure('public.set_video_made_for_kids(text, boolean, boolean, text)') is not null").fetchone()[0]:
        return
    if all(_live_md5(session, sig) == h for sig, h in _BEFORE_0145.items()):
        session.conn.execute(MIGRATION_0145.read_text(encoding="utf-8"))


ROLLBACK_0164 = REPO / "docs" / "sql" / "rollback_0164_public_site_stats.sql"
#: 0164 (the site's live counters) refuses to apply without 0112's videos.cut_sha256 and 0116's video_visibility_requests: a base
#: built without either leaves it out too (name prefix), and take_off_0164 takes it off the full chain before comparing to it.
#: 0202 (channel research) needs 0116's youtube_quota_ledger and visibility_channel_connected the same way.
#: 0205 (publish_request_refusal) reads videos.gate_verdict (0112) and refuses to apply without it.
NEEDS_0112_0116 = ("0164_", "0202_", "0205_")


def take_off_0164(session) -> None:
    """0164's own rollback, when it is there: its three functions and site_settings go; it replaced nothing, so nothing comes back."""
    if session.conn.execute("select to_regprocedure('public.public_site_stats()') is not null").fetchone()[0]:
        text = ROLLBACK_0164.read_text(encoding="utf-8")
        session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0164(session) -> None:
    """0164 again, once 0112 and 0116 are back (it refuses to apply without them), and only when it is not on already."""
    if session.conn.execute("select to_regprocedure('public.public_site_stats()') is null").fetchone()[0]:
        session.conn.execute((MIGRATIONS / "0164_public_site_stats.sql").read_text(encoding="utf-8"))


ROLLBACK_0202 = REPO / "docs" / "sql" / "rollback_0202_channel_research.sql"


def take_off_0202(session) -> None:
    """0202's own rollback, when it is there: its tables and functions go and youtube_quota_ledger's source CHECK is 0116's again (it
    replaced nothing of 0112's or 0116's, so nothing else comes back). A test that rolls 0116 back takes it off first."""
    if session.conn.execute("select to_regprocedure('public.research_own_channel(text)') is not null").fetchone()[0]:
        text = ROLLBACK_0202.read_text(encoding="utf-8")
        session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0202(session) -> None:
    """0202 again, once 0116 is back (it refuses to apply without it), and only when it is not on already."""
    if session.conn.execute("select to_regprocedure('public.research_own_channel(text)') is null").fetchone()[0]:
        session.conn.execute((MIGRATIONS / "0202_channel_research.sql").read_text(encoding="utf-8"))


MIGRATION_0127 = MIGRATIONS / "0127_series_plan_caps.sql"
ROLLBACK_0127 = REPO / "docs" / "sql" / "rollback_0127_series_plan_caps.sql"


def _has_0127(session) -> bool:
    return bool(session.conn.execute("select to_regclass('public.series_plan_cap_settings') is not null").fetchone()[0])


def take_off_0127(session) -> None:
    """0127 replaces request_series_plan() on 0122's body (and adds series_plan_cap_settings), and 0122 (and its rollback) refuse any other
    body. A test that replays 0122 or applies its rollback on a database that has 0127 takes 0127 off first with its own rollback, and puts
    it back with put_back_0127 where the chain goes on. Every test that reaches 0122's bodies comes through here, and 0145 sits on 0122's
    render_job_params_valid(), so it comes off first too (and goes back with put_back_0127)."""
    take_off_0145(session)
    text = ROLLBACK_0127.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0127(session) -> None:
    session.conn.execute(MIGRATION_0127.read_text(encoding="utf-8"))
    put_back_0145(session)


MIGRATION_0131 = MIGRATIONS / "0131_ads_factory.sql"
ROLLBACK_0131 = REPO / "docs" / "sql" / "rollback_0131_ads_factory.sql"

MIGRATION_0133 = MIGRATIONS / "0133_brand_scan.sql"
ROLLBACK_0133 = REPO / "docs" / "sql" / "rollback_0133_brand_scan.sql"


MIGRATION_0134 = MIGRATIONS / "0134_brand_scan_followup.sql"
ROLLBACK_0134 = REPO / "docs" / "sql" / "rollback_0134_brand_scan_followup.sql"


def take_off_0134(session) -> None:
    """0134 replaces brand_scan_fail_locked() on 0133's body, and 0133 (and its rollback) refuse any other body. A test that replays 0133
    or applies its rollback on a database that has 0134 takes 0134 off first with its own rollback, and puts it back with put_back_0134
    where the chain goes on."""
    text = ROLLBACK_0134.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0134(session) -> None:
    session.conn.execute(MIGRATION_0134.read_text(encoding="utf-8"))


def take_off_0133(session) -> None:
    """0133's checks use 0131's text rules, so 0131's rollback refuses while 0133 is in place. A test that rolls back 0131 takes 0133 off
    first with its own rollback (its rows go too: the test runs in a transaction that is rolled back). 0134 sits on 0133's body: it comes
    off before."""
    take_off_0134(session)
    session.conn.execute("set local nightshift.brand_scan_rollback_delete_rows = 'yes'")
    text = ROLLBACK_0133.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


MIGRATION_0132 = MIGRATIONS / "0132_editor_hires_export.sql"
ROLLBACK_0132 = REPO / "docs" / "sql" / "rollback_0132_editor_hires_export.sql"


def has_0132(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regclass('public.editor_export_hires_prices') is not null").fetchone()[0])


MIGRATION_0136 = MIGRATIONS / "0136_editor_export_paid_1080p.sql"
ROLLBACK_0136 = REPO / "docs" / "sql" / "rollback_0136_editor_export_paid_1080p.sql"


def has_0136(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.editor_export_price_1080p()') is not null").fetchone()[0])


def take_off_0136(session) -> None:
    """0136 replaces 0132's request functions, quote, terms and price trail, and 0132 (its replay and its rollback) refuses any other body.
    A test that replays 0132 or applies its rollback on a database that has 0136 takes 0136 off first with its own rollback (inside the
    test's transaction)."""
    if not has_0136(session):
        return
    text = ROLLBACK_0136.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0136(session) -> None:
    session.conn.execute(MIGRATION_0136.read_text(encoding="utf-8"))


def take_off_0132(session) -> None:
    """0132 replaces editor_export_frame() on 0129's body (and adds the paid overload), and 0129 (and its rollback) refuse any other
    list. A test that replays 0129 or applies its rollback on a database that has 0132 takes 0132 off first with its own rollback
    (inside the test's transaction), and puts it back with put_back_0132 where the chain goes on."""
    if not has_0132(session):
        return
    take_off_0136(session)
    text = ROLLBACK_0132.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0132(session) -> None:
    session.conn.execute(MIGRATION_0132.read_text(encoding="utf-8"))


MIGRATION_0137 = MIGRATIONS / "0137_character_studio.sql"
ROLLBACK_0137 = REPO / "docs" / "sql" / "rollback_0137_character_studio.sql"


def take_off_0137(session) -> None:
    """0137 names only objects of 0018 / 0020 / 0036 / 0038 / 0054 / 0107, so nothing earlier waits for its rollback; a test that needs the
    database without 0137 (the rollback and re-apply in test_sec_character_swap.py) takes it off with its own rollback inside a transaction
    that is rolled back (its rows go too)."""
    session.conn.execute("set local nightshift.character_swap_rollback_delete_rows = 'yes'")
    text = ROLLBACK_0137.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0137(session) -> None:
    session.conn.execute(MIGRATION_0137.read_text(encoding="utf-8"))


MIGRATION_0125 = MIGRATIONS / "0125_model_shutdown.sql"
ROLLBACK_0125 = REPO / "docs" / "sql" / "rollback_0125_model_shutdown.sql"


def take_off_0125(session) -> None:
    """0125 replaces sellable_models() and creative_price() on 0124's bodies, and 0124 (and its rollback) refuse any other body. A test that
    replays 0124 or applies its rollback on a database that has 0125 takes 0125 off first with its own rollback, and puts it back with
    put_back_0125 where the chain goes on. 0139 sits on 0125's creative_price(), and 0125's rollback refuses any other body, so 0139
    comes off first when it is there."""
    take_off_0192(session)  # 0192 sits on sellable_models (0188's, on 0125's), which 0125's rollback refuses
    if has_0139(session):
        take_off_0139(session)
    text = ROLLBACK_0125.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0125(session) -> None:
    session.conn.execute(MIGRATION_0125.read_text(encoding="utf-8"))
    put_back_0139(session)
    put_back_0192(session)


MIGRATION_0139 = MIGRATIONS / "0139_operator_preview.sql"
ROLLBACK_0139 = REPO / "docs" / "sql" / "rollback_0139_operator_preview.sql"
MIGRATION_0149 = MIGRATIONS / "0149_preview_price_by_resolution.sql"
ROLLBACK_0149 = REPO / "docs" / "sql" / "rollback_0149_preview_price_by_resolution.sql"
MIGRATION_0153 = MIGRATIONS / "0153_preview_price_by_quality.sql"
ROLLBACK_0153 = REPO / "docs" / "sql" / "rollback_0153_preview_price_by_quality.sql"
MIGRATION_0155 = MIGRATIONS / "0155_shape_offered_by_model.sql"
ROLLBACK_0155 = REPO / "docs" / "sql" / "rollback_0155_shape_offered_by_model.sql"
MIGRATION_0156 = MIGRATIONS / "0156_named_resolution_params.sql"
ROLLBACK_0156 = REPO / "docs" / "sql" / "rollback_0156_named_resolution_params.sql"
MIGRATION_0159 = MIGRATIONS / "0159_duration_offered_by_model.sql"
ROLLBACK_0159 = REPO / "docs" / "sql" / "rollback_0159_duration_offered_by_model.sql"
MIGRATION_0208 = MIGRATIONS / "0208_geo_gate_and_image_size_price.sql"
ROLLBACK_0208 = REPO / "docs" / "sql" / "rollback_0208_geo_gate_and_image_size_price.sql"
#: Migrations written on 0156's creative_price, which refuse to apply without it: a sequence that leaves 0156 out leaves these out too.
#: 0208 sits on 0159's creative_price (and 0156's creative_params_problem).
ON_0156 = (MIGRATION_0159.name, MIGRATION_0208.name)
#: Migrations written on 0155's creative_price (or on one that is), which refuse to apply without it: a sequence that leaves 0155 out
#: leaves these out too, in this order. (0156 also sits on 0126's creative_params_problem, which every sequence that reaches 0155 has
#: applied already.)
ON_0155 = (MIGRATION_0156.name, *ON_0156)
#: Migrations written on 0153's creative_price (or on one that is), which refuse to apply without it: a sequence that leaves 0153 out
#: leaves these out too, in this order.
ON_0153 = (MIGRATION_0155.name, *ON_0155)
#: Migrations written on 0149's creative_price (or on one that is), which refuse to apply without it: a sequence that leaves 0149 out
#: leaves these out too, in this order.
ON_0149 = (MIGRATION_0153.name, *ON_0153)
#: Migrations written on 0139's creative_price (or on one that is), which refuse to apply without it: a sequence that leaves 0139 out
#: leaves these out too, in this order.
ON_0139 = (MIGRATION_0149.name, *ON_0149)
#: 0188 (Recraft web_mcp) replaces 0125's sellable_models and 0124's api_creative_model_ok and refuses any other body: it does not sit
#: on 0139, but every sequence that leaves 0139 out leaves 0125's sitters out, so it is added here, last.
ON_0139 = (*ON_0139, "0188_recraft_web_mcp.sql")
#: 0191 (the MCP Studio tools) calls 0125's model_past_shutdown and sellable_models and refuses to apply without them: likewise.
ON_0139 = (*ON_0139, "0191_mcp_oauth_creative.sql")
#: 0192 (the adult attestation) replaces 0188's sellable_models and two of 0191's functions, and refuses any other body: last, after
#: both, so that every sequence that leaves out 0125 or a file on it leaves 0192 out too. It also sits on 0174, so it is listed again
#: at the end of ON_0124 (a sequence that puts both lists back applies it once, last).
ON_0139 = (*ON_0139, "0192_adult_attestation.sql", "0196_adult_attestation_google_runs.sql")
#: 0198 (Film Studio's switch per organization) replaces 0192's quote_film and start_film and refuses to apply without 0192: after it
#: (and after 0196, by number) in both lists, for the same reason.
ON_0139 = (*ON_0139, "0198_film_studio_org_switch.sql")
#: 0208 also replaces 0196's reroute_creative_job and refuses to apply without it, so it moves from its place in ON_0156 to the end:
#: a sequence that puts these back in this order reaches 0196 before 0208.
ON_0139 = (*(f for f in ON_0139 if f != MIGRATION_0208.name), MIGRATION_0208.name)
#: Migrations written on 0125's bodies (or on one that is), which refuse to apply without it: a sequence that leaves 0125 out leaves
#: these out too, in this order.
ON_0125 = (MIGRATION_0139.name, *ON_0139)
#: Migrations that call 0124's model_is_available() and refuse to apply without it (0151, the Studio's probe seed; 0162, the MCP
#: Studio tools' API functions, whose guard names it): a sequence that leaves 0124 out leaves these out too, and puts them back
#: after it, in this order. 0164 (the site's live counters) does not need 0124; it is listed so that a sequence which leaves 0124
#: out and puts it back still ends on the newest file, as build_sequence() does. 0174 (rights acknowledgement) replaces 0124's
#: api_creative_refusal and its drift guard refuses any other body, so it goes out and back with 0124 too.
ON_0124 = ("0151_model_probe_seconds.sql", "0162_api_creative_models.sql", "0164_public_site_stats.sql",
           "0174_rights_acknowledgement.sql", "0187_rights_acknowledgement_inputs.sql", "0191_mcp_oauth_creative.sql",
           "0192_adult_attestation.sql", "0196_adult_attestation_google_runs.sql", "0198_film_studio_org_switch.sql",
           # 0208 sits on 0196's reroute_creative_job (and refuses to apply without it): out and back with it, last.
           "0208_geo_gate_and_image_size_price.sql")

#: 0165 (the referral programme) replaces friend_invite_pay_locked() and my_friend_invite() on 0092's bodies; its guard accepts
#: 0092's body or its own, so a test that replays 0092 puts 0165 back on afterwards (test_sec_friend_invites.py). It names
#: nothing of 0124's, so no sequence that leaves 0124 out needs to leave it out.
MIGRATION_0165 = MIGRATIONS / "0165_referral_rewards.sql"
ROLLBACK_0165 = REPO / "docs" / "sql" / "rollback_0165_referral_rewards.sql"


def has_0139(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is not null").fetchone()[0])


def rollback_0139_body() -> str:
    """0139's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database)."""
    text = ROLLBACK_0139.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0139(session) -> None:
    """0139 replaces creative_price() on 0125's body (and adds creative_operator_preview / operator_preview_models), and 0125 (its replay
    and its rollback) refuses any other body. A test that replays 0125 or applies its rollback on a database that has 0139 takes 0139 off
    first with its own rollback, and puts it back with put_back_0139 where the chain goes on. 0149 sits on 0139's creative_price(), and
    0139's rollback refuses any other body, so 0149 comes off first when it is there (and 0153, which sits on 0149's, before it, and
    0155, which sits on 0153's, before that, and 0156 on 0155's before that, and 0159 on 0156's before that)."""
    take_off_0188(session)
    if has_0149(session) or has_0153(session) or has_0155(session) or has_0156(session) or has_0159(session):
        take_off_0149(session)
    session.conn.execute(rollback_0139_body())


def put_back_0139(session) -> None:
    session.conn.execute(MIGRATION_0139.read_text(encoding="utf-8"))
    put_back_0149(session)
    put_back_0188(session)


#: md5 of 0149's creative_price body (white space folded), the way its drift guard reads it.
CREATIVE_PRICE_0149 = "728241a09e56f65e19efc460afea7355"


def has_0149(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0149]).fetchone()[0])


def rollback_0149_body() -> str:
    """0149's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database)."""
    text = ROLLBACK_0149.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0149(session) -> None:
    """0149 replaces creative_price() on 0139's body, and 0139 (its replay and its rollback) refuses any other body. A test that replays
    0139 or applies its rollback on a database that has 0149 takes 0149 off first with its own rollback, and puts it back with
    put_back_0149 where the chain goes on. 0153 sits on 0149's creative_price(), and 0149's rollback refuses any other body, so 0153
    comes off first when it is there (and 0155, which sits on 0153's, before it, and 0156 on 0155's before that, and 0159 on 0156's
    before that)."""
    if has_0153(session) or has_0155(session) or has_0156(session) or has_0159(session):
        take_off_0153(session)
    session.conn.execute(rollback_0149_body())


def put_back_0149(session) -> None:
    session.conn.execute(MIGRATION_0149.read_text(encoding="utf-8"))
    put_back_0153(session)


#: md5 of 0153's creative_price body (white space folded), the way its drift guard reads it.
CREATIVE_PRICE_0153 = "28130a014027e6ad0b7876a78d69a396"


def has_0153(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0153]).fetchone()[0])


def rollback_0153_body() -> str:
    """0153's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database)."""
    text = ROLLBACK_0153.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0153(session) -> None:
    """0153 replaces creative_price() on 0149's body, and 0149 (its replay and its rollback) refuses any other body. A test that replays
    0149 or applies its rollback on a database that has 0153 takes 0153 off first with its own rollback, and puts it back with
    put_back_0153 where the chain goes on. 0155 sits on 0153's creative_price(), and 0153's rollback refuses any other body, so 0155
    comes off first when it is there (and 0156, which sits on 0155's, before it, and 0159 on 0156's before that)."""
    if has_0155(session) or has_0156(session) or has_0159(session):
        take_off_0155(session)
    session.conn.execute(rollback_0153_body())


def put_back_0153(session) -> None:
    session.conn.execute(MIGRATION_0153.read_text(encoding="utf-8"))
    put_back_0155(session)


#: md5 of 0155's creative_price body (white space folded), the way its drift guard reads it.
CREATIVE_PRICE_0155 = "48105e11fbd820b6f103c19b8fd1e693"


def has_0155(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0155]).fetchone()[0])


def rollback_0155_body() -> str:
    """0155's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database)."""
    text = ROLLBACK_0155.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0155(session) -> None:
    """0155 replaces creative_price() on 0153's body, and 0153 (its replay and its rollback) refuses any other body. A test that replays
    0153 or applies its rollback on a database that has 0155 takes 0155 off first with its own rollback, and puts it back with
    put_back_0155 where the chain goes on. 0156 sits on 0155's creative_price(), and 0155's rollback refuses any other body, so 0156
    comes off first when it is there (and 0159, which sits on 0156's, before it)."""
    if has_0156(session) or has_0159(session):
        take_off_0156(session)
    session.conn.execute(rollback_0155_body())


def put_back_0155(session) -> None:
    session.conn.execute(MIGRATION_0155.read_text(encoding="utf-8"))
    put_back_0156(session)


#: md5 of 0156's creative_price and creative_params_problem bodies (white space folded), the way its drift guards read them.
CREATIVE_PRICE_0156 = "a70dba23b303c72f2b9f5dc5acb3b3ec"
CREATIVE_PARAMS_PROBLEM_0156 = "25ee9cc62a27ad3a19e71008b04f3f36"


def has_0156(conn_or_session) -> bool:
    """0156 replaces both functions in one transaction, so its creative_price body is enough to tell."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0156]).fetchone()[0])


def rollback_0156_body() -> str:
    """0156's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database)."""
    text = ROLLBACK_0156.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0156(session) -> None:
    """0156 replaces creative_price() on 0155's body and creative_params_problem() on 0126's, and 0155 and 0126 (their replays and their
    rollbacks) refuse any other body. A test that replays either, or applies either rollback, on a database that has 0156 takes 0156 off
    first with its own rollback, and puts it back with put_back_0156 where the chain goes on. 0159 sits on 0156's creative_price(), and
    0156's rollback refuses any other body, so 0159 comes off first when it is there."""
    if has_0159(session):
        take_off_0159(session)
    session.conn.execute(rollback_0156_body())


def put_back_0156(session) -> None:
    session.conn.execute(MIGRATION_0156.read_text(encoding="utf-8"))
    put_back_0159(session)


#: md5 of 0159's creative_price body (white space folded), the way its drift guard reads it.
CREATIVE_PRICE_0159 = "dafc5edae0000e741ac1b19bd0075790"
#: md5 of 0208's creative_price body: 0208 replaces 0159's (and 0156's creative_params_problem).
CREATIVE_PRICE_0208 = "f61aaddd5686045961addd6f14a02c32"
CREATIVE_PARAMS_PROBLEM_0208 = "7ccde072309a637d9b07e59f1be45d20"


def has_0159(conn_or_session) -> bool:
    """0159's creative_price, or 0208's on top of it (take_off_0159 takes 0208 off first)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = any (%s) from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)",
        [[CREATIVE_PRICE_0159, CREATIVE_PRICE_0208]]).fetchone()[0])


def has_0208(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0208]).fetchone()[0])


def rollback_0208_body() -> str:
    text = ROLLBACK_0208.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0208(conn_or_session) -> None:
    """0208 replaces creative_price() on 0159's body, creative_params_problem() on 0156's, creative_regions_problem() on 0126's and
    reroute_creative_job() on 0196's, and their replays and rollbacks refuse any other body: taken off first with its own rollback,
    put back with put_back_0208."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    conn.execute(rollback_0208_body())


def put_back_0208(conn_or_session) -> None:
    """0208 again, only where it can apply (0159's creative_price and 0196's reroute_creative_job are on) and is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0208(conn) or not has_0159(conn) or not has_0196(conn):
        return
    conn.execute(MIGRATION_0208.read_text(encoding="utf-8"))


def rollback_0159_body() -> str:
    """0159's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database).
    0208 sits on 0159's creative_price, so its rollback runs first: on a database without 0208 it finds the earlier bodies, puts the
    same ones back and drops nothing that is there, so it is harmless where 0208 was never applied."""
    text = ROLLBACK_0159.read_text(encoding="utf-8")
    return rollback_0208_body() + "\n" + "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0159(session) -> None:
    """0159 replaces creative_price() on 0156's body, and 0156 (its replay and its rollback) refuses any other body. A test that replays
    0156 or applies its rollback on a database that has 0159 takes 0159 off first with its own rollback, and puts it back with
    put_back_0159 where the chain goes on. 0208 sits on 0159's body, so it comes off first when it is there."""
    session.conn.execute(rollback_0159_body())


def put_back_0159(session) -> None:
    session.conn.execute(MIGRATION_0159.read_text(encoding="utf-8"))
    put_back_0208(session)


MIGRATION_0167 = MIGRATIONS / "0167_refund_hold_recovery.sql"
ROLLBACK_0167 = REPO / "docs" / "sql" / "rollback_0167_refund_hold_recovery.sql"


def has_0167(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.credit_refund_recover()') is not null").fetchone()[0])


def take_off_0167(conn_or_session) -> None:
    """0167 replaces refund_purchased_credits() on 0034's body, which 0146 (its replay) pins ("what it builds on and leaves alone"), and
    credit_transactions_apply_lots() on 0165's body, which 0165's replay and rollback pin. A test that replays 0146 or 0165, or applies
    either rollback, on a database that has 0167 takes 0167 off first with its own rollback (it puts 0034's refund body and 0165's lot
    trigger back; the recoveries table stays), and puts it back with put_back_0167 where the chain goes on."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0172(conn)  # 0172 sits on 0167's lot trigger, and 0167's rollback refuses any other body
    if has_0167(conn):
        text = ROLLBACK_0167.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0167(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0167(conn):
        conn.execute(MIGRATION_0167.read_text(encoding="utf-8"))
    put_back_0172(conn)


MIGRATION_0172 = MIGRATIONS / "0172_grant_reversal_hold_recovery.sql"
ROLLBACK_0172 = REPO / "docs" / "sql" / "rollback_0172_grant_reversal_hold_recovery.sql"


def has_0172(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.credit_grant_reversal_recover()') is not null").fetchone()[0])


def take_off_0172(conn_or_session) -> None:
    """0172 replaces credit_transactions_apply_lots() on 0167's body (which 0167's replay and rollback pin) and owner_reverse_grant() on
    0107's, and its collector trigger makes 0167's end state (exactly two AFTER INSERT triggers on the ledger) false. A test that replays
    0167 or applies its rollback takes 0172 off first with its own rollback (the recoveries table stays), and puts it back with
    put_back_0172 where the chain goes on. take_off_0167 / put_back_0167 do both."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0172(conn):
        text = ROLLBACK_0172.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0172(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0172(conn) and has_0167(conn):
        conn.execute(MIGRATION_0172.read_text(encoding="utf-8"))


MIGRATION_0171 = MIGRATIONS / "0171_films_money.sql"
ROLLBACK_0171 = REPO / "docs" / "sql" / "rollback_0171_films_money.sql"
_OVERRIDE_0171 = "-- set local nightshift.rollback_0171_discard_segments = 'on';"


def has_0171(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return conn.execute("select to_regclass('public.film_segments') is not null").fetchone()[0]


def rollback_0171_body(override: bool = False) -> str:
    """rollback_0171 without its own begin/commit (the caller's transaction holds it), with the override line set when asked."""
    out = []
    for ln in ROLLBACK_0171.read_text(encoding="utf-8").splitlines():
        if ln.strip() in ("begin;", "commit;"):
            continue
        if override and ln.strip() == _OVERRIDE_0171:
            ln = "set local nightshift.rollback_0171_discard_segments = 'on';"
        out.append(ln)
    return "\n".join(out)


def take_off_0171(conn_or_session) -> None:
    """0171 replaces 0166's films_status_check (adds 'queued'), and 0166's rollback refuses while film_segments exists, so a test that
    replays or rolls back 0166 takes 0171 off first with its own rollback (override on: the lab's segments are not kept) and puts it
    back with put_back_0171 where the chain goes on. 0187 (and 0192 on it) sit on 0171's start_film, and 0171's rollback refuses any
    other body, so they come off first (take_off_0187 takes 0192 off too) and go back with put_back_0171."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0187(conn)
    if has_0171(conn):
        conn.execute(rollback_0171_body(override=True))


def put_back_0171(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0171(conn):
        conn.execute(MIGRATION_0171.read_text(encoding="utf-8"))
    put_back_0187(conn)


MIGRATION_0174 = MIGRATIONS / "0174_rights_acknowledgement.sql"
ROLLBACK_0174 = REPO / "docs" / "sql" / "rollback_0174_rights_acknowledgement.sql"


def has_0174(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.acknowledge_rights(text, text, text, text)') is not null").fetchone()[0])


def take_off_0174(conn_or_session) -> None:
    """0174 replaces create_creative_job() (0075's body), workflow_quote_steps() and start_workflow_run() (0073's) and
    api_creative_refusal() (0124's). 0124's drift guard refuses any body but its own, so a test that replays 0124 takes 0174 off
    first. 0075 and 0073 do NOT refuse: 0075's guard is a position() check that 0174's body also passes, and 0073 has none, so
    replaying either over 0174 silently puts the old body back and removes the gate. A test that replays them takes 0174 off first
    too, and puts it back after. The rollback brings the four earlier bodies back and drops 0174's functions and its requirement
    guard, while rights_acknowledgements (the record, with its append-only triggers), rights_acknowledgement_kinds and
    model_registry.requires_acknowledgement stay. put_back_0174 applies 0174 again; it picks the kept tables up as its own."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0187(conn)
    if has_0174(conn):
        text = ROLLBACK_0174.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0174(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0174(conn):
        conn.execute(MIGRATION_0174.read_text(encoding="utf-8"))
    put_back_0187(conn)


MIGRATION_0187 = MIGRATIONS / "0187_rights_acknowledgement_inputs.sql"
ROLLBACK_0187 = REPO / "docs" / "sql" / "rollback_0187_rights_acknowledgement_inputs.sql"


def has_0187(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.film_acknowledgement_missing(public.films, uuid)') is not null").fetchone()[0])


MIGRATION_0200 = MIGRATIONS / "0200_film_assembly_orphans.sql"
ROLLBACK_0200 = REPO / "docs" / "sql" / "rollback_0200_film_assembly_orphans.sql"


def has_0200(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select to_regprocedure('public.film_discard_unrecorded_assembly(uuid, uuid)') is not null").fetchone()[0])


def take_off_0200(conn_or_session) -> None:
    """0200's film_discard_unrecorded_assembly reads 0171's film_segments, and 0171's rollback refuses while a later function does,
    so it comes off before 0171 (take_off_0187 runs first in every 0171 take-off) and goes back with put_back_0171 / put_back_0187."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0200(conn):
        text = ROLLBACK_0200.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0200(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0200(conn) and has_0171(conn):
        conn.execute(MIGRATION_0200.read_text(encoding="utf-8"))


MIGRATION_0212 = MIGRATIONS / "0212_film_sweep.sql"
ROLLBACK_0212 = REPO / "docs" / "sql" / "rollback_0212_film_sweep.sql"


def has_0212(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.film_sweep(text)') is not null").fetchone()[0])


def take_off_0212(conn_or_session) -> None:
    """0212's film_sweep_status reads 0171's film_segments (and 0166's rollback refuses any film_ function left), so, like 0200, it
    comes off before 0171 (take_off_0187 does it) and goes back with put_back_0171 / put_back_0187."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0212(conn):
        text = ROLLBACK_0212.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0212(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0212(conn) and has_0171(conn):
        conn.execute(MIGRATION_0212.read_text(encoding="utf-8"))


def take_off_0187(conn_or_session) -> None:
    """0187 replaces rights_acknowledgement_missing() (0174's body), reroute_creative_job() (0088's) and start_film() (0171's). 0174's
    and 0171's drift guards and rollbacks refuse any body but their own, so a test that replays or rolls back 0174 or 0171 takes 0187
    off first (take_off_0174 and take_off_0171 do it), and put_back_0174 / put_back_0171 put it back once both are on again."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0200(conn)  # 0200 reads 0171's film_segments: off before anything under it
    take_off_0212(conn)  # 0212 reads 0171's film_segments too
    take_off_0192(conn)  # 0192 sits on 0187's start_film, and 0187's rollback refuses any other body
    if has_0187(conn):
        text = ROLLBACK_0187.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0187(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0187(conn) and has_0174(conn) and has_0171(conn):
        conn.execute(MIGRATION_0187.read_text(encoding="utf-8"))
    put_back_0192(conn)
    put_back_0200(conn)
    put_back_0212(conn)


MIGRATION_0189 = MIGRATIONS / "0189_job_video_and_list_order.sql"
ROLLBACK_0189 = REPO / "docs" / "sql" / "rollback_0189_job_video_and_list_order.sql"


def has_0189(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.render_job_video_id(public.render_jobs)') is not null").fetchone()[0])


def take_off_0189(conn_or_session) -> None:
    """0189 replaces api_get_job() and oauth_get_job() (0111's bodies) and api_list_videos() (0042's). 0111's replay and rollback
    refuse any other body, so a test that replays or rolls back 0111 takes 0189 off first (inside its own transaction)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0189(conn):
        text = ROLLBACK_0189.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


MIGRATION_0188 = MIGRATIONS / "0188_recraft_web_mcp.sql"
ROLLBACK_0188 = REPO / "docs" / "sql" / "rollback_0188_recraft_web_mcp.sql"


def has_0188(conn_or_session) -> bool:
    """0188 leaves no function of its own: its sellable_models body names 'web_mcp'."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select position('web_mcp' in prosrc) > 0 from pg_proc "
                             "where oid = to_regprocedure('public.sellable_models(text, text)')").fetchone()[0] or False)


def take_off_0188(conn_or_session) -> None:
    """0188 replaces sellable_models() (0125's body) and api_creative_model_ok() (0124's); 0125's and 0124's replays and rollbacks
    refuse any other body, so a test that replays them takes 0188 off first (take_off_0139 does it, as 0125's other sitters)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0192(conn)  # 0192 sits on 0188's sellable_models, and 0188's rollback refuses any other body
    if has_0188(conn):
        text = ROLLBACK_0188.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0188(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0188(conn):
        conn.execute(MIGRATION_0188.read_text(encoding="utf-8"))
    put_back_0192(conn)


MIGRATION_0192 = MIGRATIONS / "0192_adult_attestation.sql"
ROLLBACK_0192 = REPO / "docs" / "sql" / "rollback_0192_adult_attestation.sql"


def has_0192(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.record_adult_attestation(boolean, text, text)') is not null").fetchone()[0])


def take_off_0192(conn_or_session) -> None:
    """0192 (the adult attestation) replaces quote_creative_job() and creative_platform_reserve() (0036's bodies), route_model() (0075's),
    sellable_models() (0188's), create_creative_job() and api_creative_refusal() (0174's), api_create_video() (0147's), quote_film()
    (0171's), start_film() (0187's), oauth_creative_quote() and oauth_creative_models() (0191's), api_request_download() (0170's) and
    oauth_create_video() (0094's), workflow_advance_locked() (0083's) and start_workflow_run() (0174's), and adds the hold, download
    and run gate triggers. 0125's, 0147's, 0170's, 0171's, 0174's, 0187's and
    0188's drift guards and rollbacks refuse any body but their own, so take_off_0125, take_off_0174, take_off_0187 and take_off_0188
    take 0192 off first (take_off_0171 and take_off_0139 reach it through them; a lab that replays 0147, 0170 or 0191 undoes it
    first too). 0093, 0094 and 0191 do NOT refuse: replaying one over 0192 silently removes that gate, so a lab that replays them
    takes 0192 off first as well. Its rollback puts the fifteen earlier bodies back and drops its functions and triggers;
    adult_attestations (the record, with its append-only triggers) stays, and put_back_0192 picks it up again."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0198(conn)  # 0198 sits on 0192's quote_film and start_film, and 0192's rollback refuses any other body
    take_off_0196(conn)  # 0196 sits on 0192's route_model, api_create_video and oauth_create_video; 0192's rollback refuses them
    if has_0192(conn):
        text = ROLLBACK_0192.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0192(conn_or_session) -> None:
    """0192 again, once 0125, 0171, 0174 and the two files on them it builds on (0187's start_film, 0188's sellable_models) are on
    (it refuses to apply without any of them), and only when it is not on already; then the files on it, in number order (0196's
    video bodies, 0198's film bodies), each when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if (not has_0192(conn) and has_0174(conn) and has_0171(conn) and has_0187(conn) and has_0188(conn)
            and conn.execute("select to_regprocedure('public.oauth_creative_quote(text, text, text, jsonb, text)') is not null").fetchone()[0]
            and conn.execute("select to_regprocedure('public.model_past_shutdown(jsonb)') is not null").fetchone()[0]):
        conn.execute(MIGRATION_0192.read_text(encoding="utf-8"))
    put_back_0196(conn)
    put_back_0198(conn)


MIGRATION_0196 = MIGRATIONS / "0196_adult_attestation_google_runs.sql"
ROLLBACK_0196 = REPO / "docs" / "sql" / "rollback_0196_adult_attestation_google_runs.sql"


def has_0196(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.render_run_google_stages(text, jsonb)') is not null").fetchone()[0])


def take_off_0196(conn_or_session) -> None:
    """0196 (a video run on Google needs an adult answer) replaces 0192's route_model, api_create_video and oauth_create_video and
    0187's reroute_creative_job, and points 0192's run gate at its own function; 0192's and 0187's guards and rollbacks refuse its
    bodies, so take_off_0192 takes 0196 off first (and take_off_0187 reaches it through take_off_0192)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0208(conn):
        take_off_0208(conn)  # 0208 sits on 0196's reroute_creative_job, and 0196's rollback refuses 0208's body
    if has_0196(conn):
        text = ROLLBACK_0196.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0196(conn_or_session) -> None:
    """0196 again, once 0192 is on (it refuses to apply without it), and only when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0196(conn) and has_0192(conn):
        conn.execute(MIGRATION_0196.read_text(encoding="utf-8"))
    put_back_0208(conn)


def attest_adults(conn_or_session, *uids) -> None:
    """Record "18 or older" for these lab people, as the database owner (record_adult_attestation is the app's path; this is the
    seed's). Since 0196 a video run, a series plan and a scene repair spend on Google, so a lab person who queues one has to have
    answered, as a real one does. The first answer stands: a person who already answered keeps their answer."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not conn.execute("select to_regclass('public.adult_attestations') is not null").fetchone()[0]:
        return
    for uid in uids:
        if uid:
            conn.execute("insert into public.adult_attestations (user_id, adult, terms_version, method) "
                         "values (%s, true, '2026-11-20', 'email_signup') on conflict (user_id) do nothing", [uid])


MIGRATION_0198 = MIGRATIONS / "0198_film_studio_org_switch.sql"
ROLLBACK_0198 = REPO / "docs" / "sql" / "rollback_0198_film_studio_org_switch.sql"


def has_0198(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.film_studio_on_for(uuid)') is not null").fetchone()[0])


def take_off_0198(conn_or_session) -> None:
    """0198 (Film Studio's switch per organization, the take's creative job) replaces quote_film() and start_film() (0192's bodies) and
    film_claim_segment() (0171's). 0192's and 0171's drift guards and rollbacks refuse any other body, so take_off_0192 takes 0198 off
    first (take_off_0187 and take_off_0171 reach it through it). It also replaces 0171's film_fail_locked, film_begin_take and
    film_settle_locked (whose rollback refuses them), 0036's claim_creative_job and cancel_creative_job and 0064's notify trigger:
    a lab that rolls back or replays 0036, 0064 or 0171 takes 0198 off first. Its rollback keeps
    org_film_settings.film_studio_enabled, which put_back_0198 picks up again as its own."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0198(conn):
        text = ROLLBACK_0198.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0198(conn_or_session) -> None:
    """0198 again, once 0192 (whose bodies it builds on) is on, and only when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0198(conn) or not has_0192(conn):
        return
    conn.execute(MIGRATION_0198.read_text(encoding="utf-8"))


def migration_files() -> list[Path]:
    """Every migration, in sorted filename order — the order a fresh project
    applies them. Numbers need not be contiguous (migrations can merge out of
    order), but two files with the same number are an error: their relative
    order would be an accident of naming. A .sql file that does not match the
    naming rule is an error too, rather than silently skipped — an unapplied
    migration is exactly what this lab exists to notice."""
    files = sorted(p for p in MIGRATIONS.iterdir() if p.suffix == ".sql")
    bad = [p.name for p in files if not _MIGRATION_RE.match(p.name)]
    if bad:
        raise RuntimeError(f"migration files not named NNNN_name.sql: {bad}")
    seen: dict[str, str] = {}
    dupes = []
    for p in files:
        n = _MIGRATION_RE.match(p.name).group(1)
        if n in seen:
            dupes.append(f"{seen[n]} / {p.name}")
        seen[n] = p.name
    if dupes:
        raise RuntimeError(f"two migrations share a number: {dupes}")
    return files


def build_sequence() -> list[Path]:
    """What a fresh Supabase project runs, in order: the platform stand-in,
    schema.sql (docs/SUPABASE.md step 2), then every migration."""
    return [BOOTSTRAP, SCHEMA, *migration_files()]


class ApplyError(RuntimeError):
    pass


def _dsn_for(dsn: str, dbname: str) -> str:
    return psycopg.conninfo.make_conninfo(dsn, dbname=dbname)


def create_database(dsn: str, dbname: str) -> str:
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(dbname)))
        c.execute(sql.SQL("create database {}").format(sql.Identifier(dbname)))
    return _dsn_for(dsn, dbname)


def drop_database(dsn: str, dbname: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(dbname)))


def apply_files(db_dsn: str, files: Sequence[Path]) -> None:
    """Apply each file in its own round trip, stopping at the first error with
    the file name in the message. Files are sent whole (simple protocol), the
    way the Supabase SQL editor runs them."""
    with psycopg.connect(db_dsn, autocommit=True) as c:
        for f in files:
            try:
                c.execute(f.read_text(encoding="utf-8"))
            except psycopg.Error as e:
                diag = e.diag
                where = f" ({diag.context.strip()})" if diag and diag.context else ""
                raise ApplyError(f"{f.relative_to(REPO)}: {diag.sqlstate if diag else ''} "
                                 f"{str(e).strip()}{where}") from e


def build(dsn: str, dbname: str) -> str:
    db_dsn = create_database(dsn, dbname)
    apply_files(db_dsn, build_sequence())
    return db_dsn


# ── acting as an API caller ─────────────────────────────────────────────────

@dataclass(frozen=True)
class Actor:
    """Someone making a request through PostgREST."""

    name: str
    role: str  # anon | authenticated | service_role
    uid: Optional[str] = None
    email: Optional[str] = None

    def claims(self) -> dict[str, Any]:
        c: dict[str, Any] = {"role": self.role}
        if self.uid:
            c["sub"] = self.uid
        if self.email:
            c["email"] = self.email
        return c


ANON = Actor("anon", "anon")
SERVICE = Actor("service", "service_role")


def user(name: str, email: str, uid: Optional[str] = None) -> Actor:
    return Actor(name, "authenticated", uid or str(uuid.uuid4()), email)


@dataclass
class Outcome:
    ok: bool
    rowcount: int = 0
    rows: list = None  # type: ignore[assignment]
    sqlstate: Optional[str] = None
    error: Optional[str] = None

    def __repr__(self) -> str:  # readable in assertion messages
        if self.ok:
            return f"<ok rowcount={self.rowcount} rows={self.rows!r}>"
        return f"<error {self.sqlstate}: {self.error}>"


class Session:
    """One transaction as one caller. Every statement runs in its own
    savepoint, so a refused attack does not poison the next one."""

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def run(self, query, params: Optional[Sequence[Any]] = None) -> Outcome:
        try:
            with self.conn.transaction():
                cur = self.conn.execute(query, params)
                rows = cur.fetchall() if cur.description else []
                return Outcome(True, cur.rowcount, rows)
        except psycopg.Error as e:
            return Outcome(False, sqlstate=e.sqlstate, error=str(e).strip().splitlines()[0])

    def rows(self, query, params: Optional[Sequence[Any]] = None) -> list:
        out = self.run(query, params)
        if not out.ok:
            raise AssertionError(f"query failed: {out!r}\n{query}")
        return out.rows

    def value(self, query, params: Optional[Sequence[Any]] = None) -> Any:
        rows = self.rows(query, params)
        return rows[0][0] if rows else None


@contextmanager
def acting(conn: psycopg.Connection, who: Actor, *, commit: bool = False) -> Iterator[Session]:
    """A transaction in which PostgREST would be serving `who`: the JWT claims
    set for this transaction only, and the API role switched to. Rolled back
    unless `commit` — an attack must never leave anything behind for the next
    test to trip over."""
    with conn.transaction(force_rollback=not commit):
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
        conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
        conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
        yield Session(conn)


@contextmanager
def as_superuser(conn: psycopg.Connection, *, commit: bool = True) -> Iterator[Session]:
    """The database owner, for seeding what only Supabase itself could write
    (auth.users, Vault) and for reading the ground truth an attack is checked
    against."""
    with conn.transaction(force_rollback=not commit):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        yield Session(conn)


def main() -> int:
    """`python tests/security/sec_db.py`: apply bootstrap, schema.sql and every
    migration, in order, to a fresh database — the CI step that fails the job
    on the first migration that does not apply."""
    dsn = admin_dsn()
    if not dsn:
        print(f"{DSN_ENV} is not set", file=sys.stderr)
        return 2
    dbname = "ns_security_migrations"
    db_dsn = create_database(dsn, dbname)
    try:
        for f in build_sequence():
            apply_files(db_dsn, [f])
            print(f"applied {f.relative_to(REPO)}")
    except ApplyError as e:
        print(f"::error::{e}", file=sys.stderr)
        return 1
    finally:
        drop_database(dsn, dbname)
    return 0


if __name__ == "__main__":
    sys.exit(main())
