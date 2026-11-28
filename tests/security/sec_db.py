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
    render_job_params_valid(): it comes off first too, and goes back with put_back_0122. 0226 sits on 0122's render_jobs_payment_guard()
    (0122's rollback refuses its body): it comes off first, and goes back with put_back_0122."""
    take_off_0226(session)
    take_off_0145(session)
    if _has_0127(session):
        take_off_0127(session)
    text = ROLLBACK_0122.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0122(session) -> None:
    session.conn.execute(MIGRATION_0122.read_text(encoding="utf-8"))
    put_back_0127(session)
    put_back_0145(session)
    put_back_0226(session)


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
    render_job_params_valid(), so it comes off first too (and goes back with put_back_0127); and 0226, which sits on 0122's
    render_jobs_payment_guard(), the same way."""
    take_off_0226(session)
    take_off_0145(session)
    text = ROLLBACK_0127.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0127(session) -> None:
    session.conn.execute(MIGRATION_0127.read_text(encoding="utf-8"))
    put_back_0145(session)
    put_back_0226(session)


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
    off before, and 0226, which sits on 0133's request_brand_scan() (0133's rollback refuses its body)."""
    take_off_0226(session)
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
    test's transaction). 0226 sits on 0136's four-argument request_editor_export() (0136's rollback refuses its body): it comes off
    first, and put_back_0136 puts it back."""
    if not has_0136(session):
        return
    take_off_0226(session)
    text = ROLLBACK_0136.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0136(session) -> None:
    session.conn.execute(MIGRATION_0136.read_text(encoding="utf-8"))
    put_back_0226(session)


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
    that is rolled back (its rows go too). 0226 sits on 0137's request_character_swap() (0137's rollback refuses its body): it comes
    off first, and put_back_0137 puts it back."""
    take_off_0226(session)
    session.conn.execute("set local nightshift.character_swap_rollback_delete_rows = 'yes'")
    text = ROLLBACK_0137.read_text(encoding="utf-8")
    session.conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0137(session) -> None:
    session.conn.execute(MIGRATION_0137.read_text(encoding="utf-8"))
    put_back_0226(session)


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
MIGRATION_0218 = MIGRATIONS / "0218_creative_prompt_limits.sql"
ROLLBACK_0218 = REPO / "docs" / "sql" / "rollback_0218_creative_prompt_limits.sql"
#: 0218 (a prompt the model cannot take, a negative prompt its adapter drops, a seed) sits on 0208's creative_price and
#: creative_params_problem (and 0171's film_price, which every such sequence keeps): out with 0208, back after it.
ON_0156 = (*ON_0156, MIGRATION_0218.name)
#: Migrations written on 0155's creative_price (or on one that is), which refuse to apply without it: a sequence that leaves 0155 out
#: leaves these out too, in this order. (0156 also sits on 0126's creative_params_problem, which every sequence that reaches 0155 has
#: applied already.)
#: 0219 (the operator route for connected assistants) refuses to apply before 0218 (which sits on 0208): a sequence that leaves
#: 0208 or 0218 out leaves 0219 out too, and puts it back last.
ON_0156 = (*(f for f in ON_0156 if f != "0219_oauth_creative_operator_models.sql"), "0219_oauth_creative_operator_models.sql")
#: 0224 (dated credit prices) sits on 0218's creative_price and refuses any other body; it names nothing of 0219's. After
#: 0219, as applied live (0218, 0219, 0224, 0230).
ON_0156 = (*(f for f in ON_0156 if f != "0224_dated_credit_price.sql"), "0224_dated_credit_price.sql")
#: 0228 (music per request, S6) sits on 0224's creative_price and 0218's creative_params_problem, and refuses any other body: right
#: after 0224, wherever they go.
ON_0156 = (*(f for f in ON_0156 if f != "0228_music_per_request_price.sql"), "0228_music_per_request_price.sql")
#: 0230 (the country gate reads an allow-list vendor's own list) replaces 0208's creative_jobs_geo_gate and refuses to apply without
#: it: a sequence that leaves 0208 out leaves 0230 out too, and puts it back last.
ON_0156 = (*(f for f in ON_0156 if f != "0230_geo_gate_allow_list.sql"), "0230_geo_gate_allow_list.sql")
#: 0238 (a country-listed row with an allow-list may go on sale) refuses to apply unless 0230's gate is live: after 0230, last.
ON_0156 = (*ON_0156, "0238_country_list_sale_needs_allow_list.sql")
#: 0235 (Film Studio's operator preview) replaces 0218's film_price (and 0171's, 0215's and 0166's callers of film_check_model) and
#: refuses any other body: a sequence that leaves 0218 out leaves 0235 out too, and puts it back last.
ON_0156 = (*ON_0156, "0235_film_operator_preview.sql")
#: 0236 (clip sound refused until the cut keeps it) replaces 0235's film_price and refuses any other body: a sequence that leaves 0235
#: out leaves 0236 out too, and puts it back last.
ON_0156 = (*ON_0156, "0236_film_clip_sound_gate.sql")
#: 0239 (a film's key frame quoted the way it is made) replaces 0236's film_price and 0235's film_apply_settings and film_save_scenes
#: and refuses any other body: a sequence that leaves 0235 (so 0236) out leaves 0239 out too, and puts it back right after 0236.
ON_0156 = (*ON_0156, "0239_film_keyframe_refs_quote.sql")
#: 0241 (a scene's own sound and its lines) replaces 0239's film_price and film_save_scenes and refuses any other body: right after it.
ON_0156 = (*ON_0156, "0241_film_scene_dialogue.sql")
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
#: 0215 (archive and resume) replaces 0198's start_film and film_claim_segment and refuses to apply without 0198: after it, in both
#: lists, for the same reason.
ON_0139 = (*ON_0139, "0215_film_archive_resume.sql")
#: 0218 sits on 0208's bodies: it moves with it, right after it.
ON_0139 = (*(f for f in ON_0139 if f != MIGRATION_0218.name), MIGRATION_0218.name)
#: 0219 (the operator route for connected assistants) replaces 0192's oauth_creative_models / oauth_creative_quote and 0191's
ON_0139 = (*(f for f in ON_0139 if f != "0219_oauth_creative_operator_models.sql"), "0219_oauth_creative_operator_models.sql")
#: 0224 sits on 0218's creative_price: after 0219, as applied live.
ON_0139 = (*(f for f in ON_0139 if f != "0224_dated_credit_price.sql"), "0224_dated_credit_price.sql")
#: 0228 (music per request) sits on 0224's creative_price and 0218's creative_params_problem: right after 0224.
ON_0139 = (*(f for f in ON_0139 if f != "0228_music_per_request_price.sql"), "0228_music_per_request_price.sql")
#: 0226 (only a member spends, on every path) replaces 0192's create_creative_job and start_workflow_run and calls 0215's
#: is_org_spender, and refuses to apply without 0215: after it, in both lists, for the same reason.
ON_0139 = (*ON_0139, "0226_org_spender_everywhere.sql")
#: 0232 (one plan per film, its turns reserved) replaces 0226's ai_chat_reserve_turn and ai_chat_plan_end and refuses to apply
#: without them: right after it, in both lists.
ON_0139 = (*ON_0139, "0232_ai_chat_film_plan_leases.sql")
#: 0230 sits on 0208's gate: after 0208 (and everything put back after it), last.
ON_0139 = (*(f for f in ON_0139 if f != "0230_geo_gate_allow_list.sql"), "0230_geo_gate_allow_list.sql")
#: 0231 (cancel audit) asks for 0226's cancel_workflow_run and refuses to apply without it: after it, in both lists.
ON_0139 = (*ON_0139, "0231_cancel_audit.sql")
#: 0238 asks for 0230's gate: after 0230, last (ON_0156's copy moved here).
ON_0139 = (*(f for f in ON_0139 if f != "0238_country_list_sale_needs_allow_list.sql"), "0238_country_list_sale_needs_allow_list.sql")
#: 0235 sits on 0218's film_price and 0215's film_resume_precheck and calls 0139's creative_operator_preview: last.
ON_0139 = (*(f for f in ON_0139 if f != "0235_film_operator_preview.sql"), "0235_film_operator_preview.sql")
#: 0236 sits on 0235's film_price: after it, last.
ON_0139 = (*(f for f in ON_0139 if f != "0236_film_clip_sound_gate.sql"), "0236_film_clip_sound_gate.sql")
#: 0239 sits on 0236's film_price and 0235's film_apply_settings / film_save_scenes: right after 0236.
ON_0139 = (*(f for f in ON_0139 if f != "0239_film_keyframe_refs_quote.sql"), "0239_film_keyframe_refs_quote.sql")
#: 0241 sits on 0239's film_price and film_save_scenes: right after 0239, last.
ON_0139 = (*(f for f in ON_0139 if f != "0241_film_scene_dialogue.sql"), "0241_film_scene_dialogue.sql")
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
           "0208_geo_gate_and_image_size_price.sql",
           "0215_film_archive_resume.sql",
           # 0226 sits on 0215 (is_org_spender) and 0192's bodies, and on nothing of 0208's or 0218's: out and back after 0215.
           "0226_org_spender_everywhere.sql",
           # 0231 asks for 0226's cancel_workflow_run: out and back right after it.
           "0231_cancel_audit.sql",
           # 0232 sits on 0226's ai_chat_reserve_turn and ai_chat_plan_end: out and back right after it.
           "0232_ai_chat_film_plan_leases.sql",
           # 0218 sits on 0208's creative_price and creative_params_problem: out and back with it, after it.
           "0218_creative_prompt_limits.sql",
           # 0219 replaces 0192's and 0191's oauth_creative_* bodies and refuses to apply without 0218: last.
           "0219_oauth_creative_operator_models.sql",
           # 0224 sits on 0218's creative_price (and refuses any other body): out and back with it, after 0219, as applied live.
           "0224_dated_credit_price.sql",
           # 0228 sits on 0224's creative_price and 0218's creative_params_problem: out and back with them, after them.
           "0228_music_per_request_price.sql",
           # 0230 replaces 0208's creative_jobs_geo_gate and refuses to apply without 0208: out and back with it.
           "0230_geo_gate_allow_list.sql",
           # 0238 refuses to apply unless 0230's gate is live: out and back with it.
           "0238_country_list_sale_needs_allow_list.sql",
           # 0235 replaces 0218's film_price and 0215's film_resume_precheck and refuses to apply without them: last.
           "0235_film_operator_preview.sql",
           # 0236 replaces 0235's film_price and 0215's film_assembly_retryable and refuses to apply without them.
           "0236_film_clip_sound_gate.sql",
           # 0239 replaces 0236's film_price and 0235's film_apply_settings and film_save_scenes.
           "0239_film_keyframe_refs_quote.sql",
           # 0241 replaces 0239's film_price and film_save_scenes and refuses to apply without them: last.
           "0241_film_scene_dialogue.sql")

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
    take_off_0235(session)  # 0235's film_check_model calls 0139's creative_operator_preview, which this rollback drops
    take_off_0188(session)
    if has_0149(session) or has_0153(session) or has_0155(session) or has_0156(session) or has_0159(session):
        take_off_0149(session)
    session.conn.execute(rollback_0139_body())


def put_back_0139(session) -> None:
    session.conn.execute(MIGRATION_0139.read_text(encoding="utf-8"))
    put_back_0149(session)
    put_back_0188(session)
    put_back_0235(session)


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
#: md5 of 0224's creative_price body: 0218's plus one line that reads the rate through credits_per_unit_now (the dated price).
#: The same body 0218's own 0224 branch writes (CREATIVE_PRICE_0218_0224 below).
CREATIVE_PRICE_0224 = "ea2b58e88fe34ae18b261e5a0fbef435"
MIGRATION_0224 = MIGRATIONS / "0224_dated_credit_price.sql"
ROLLBACK_0224 = REPO / "docs" / "sql" / "rollback_0224_dated_credit_price.sql"


def has_0159(conn_or_session) -> bool:
    """0159's creative_price, or 0208's on top of it, or 0218's on 0208's (take_off_0159 takes both off first)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = any (%s) from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)",
        [[CREATIVE_PRICE_0159, CREATIVE_PRICE_0208, CREATIVE_PRICE_0218, CREATIVE_PRICE_0218_0224, CREATIVE_PRICE_0228]]).fetchone()[0])


def has_0208(conn_or_session) -> bool:
    """0208's creative_price, or 0218's on top of it (take_off_0208 takes 0218 off first)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) = any (%s) from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)",
        [[CREATIVE_PRICE_0208, CREATIVE_PRICE_0218, CREATIVE_PRICE_0218_0224, CREATIVE_PRICE_0228]]).fetchone()[0])


def has_0224(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.creative_price(uuid, text, text, jsonb)") == CREATIVE_PRICE_0224


def rollback_0224_body() -> str:
    """0224's rollback without its own begin / commit. Harmless where 0224 is not on (it leaves any other creative_price alone); the
    schedule table stays either way (the rollback keeps the owner's rows)."""
    text = ROLLBACK_0224.read_text(encoding="utf-8")
    # 0228 sits on 0224's creative_price and 0224's rollback refuses a later body: 0228's rollback (harmless where it is not on) first,
    # so that every caller of this helper, not only take_off_0224, can take 0224 off.
    return rollback_0228_body() + "\n" + "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0224(conn_or_session) -> None:
    """0224 sits on 0218's creative_price. 0218's rollback would keep its line (0218 carries a 0224 branch) without 0224's list guard
    and reader being undone with it, so 0224 comes off first with its own rollback."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0228(conn)
    if conn.execute("select to_regprocedure('public.credits_per_unit_now(text)') is not null").fetchone()[0]:
        conn.execute(rollback_0224_body())


def put_back_0224(conn_or_session) -> None:
    """0224 again, only on 0218's exact creative_price (its drift guard refuses any other body) and when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0224(conn) and _md5_of(conn, "public.creative_price(uuid, text, text, jsonb)") == CREATIVE_PRICE_0218:
        conn.execute(MIGRATION_0224.read_text(encoding="utf-8"))
    # 0228 on it again (it applies only on 0224's creative_price and does nothing where it is on already).
    put_back_0228(conn)


def rollback_0208_body() -> str:
    """0208's rollback, with 0224's and 0218's first (each sits on the one before, and each rollback refuses a later body): 0224's is
    harmless where it is not on, 0218's runs only where 0218 is on. (0238 is taken off by take_off_0208, which can ask the database
    whether it is on: a scratch database that dropped 0142's CHECK to put a country-listed model on sale has nothing to take off.)"""
    text = ROLLBACK_0208.read_text(encoding="utf-8")
    return rollback_0224_body() + "\n" + rollback_0218_if_on() + "\n" + "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0208(conn_or_session) -> None:
    """0208 replaces creative_price() on 0159's body, creative_params_problem() on 0156's, creative_regions_problem() on 0126's and
    reroute_creative_job() on 0196's, and their replays and rollbacks refuse any other body: taken off first with its own rollback,
    put back with put_back_0208."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0238(conn)  # 0238's CHECK lets a country-listed row on sale only behind the gate this rollback drops: off first
    take_off_0218(conn)
    conn.execute(rollback_0208_body())


def put_back_0208(conn_or_session) -> None:
    """0208 again, only where it can apply (0159's creative_price and 0196's reroute_creative_job are on) and is not on already; then
    0224 on it."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0208(conn) and has_0159(conn) and has_0196(conn):
        conn.execute(MIGRATION_0208.read_text(encoding="utf-8"))
    put_back_0218(conn)
    put_back_0230(conn)


MIGRATION_0230 = MIGRATIONS / "0230_geo_gate_allow_list.sql"
ROLLBACK_0230 = REPO / "docs" / "sql" / "rollback_0230_geo_gate_allow_list.sql"
#: md5 (white space folded) of creative_jobs_geo_gate: 0208's body, and 0230's allow-list read on it (BR-S6-04).
GEO_GATE_0208 = "71468a6f60d2659cd44199a3c834dc69"
GEO_GATE_0230 = "6d28388da6b6b927b0da500524fe0325"


def put_back_0230(conn_or_session) -> None:
    """0230 again where 0208's gate body is live: a replay of 0208 (create or replace) puts 0208's body back over 0230's, and 0208's
    rollback drops the function with whichever body it has, so only this step is needed to keep the chain at its end state."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if _md5_of(conn, "public.creative_jobs_geo_gate()") == GEO_GATE_0208:
        conn.execute(MIGRATION_0230.read_text(encoding="utf-8"))
    put_back_0238(conn)


MIGRATION_0238 = MIGRATIONS / "0238_country_list_sale_needs_allow_list.sql"
ROLLBACK_0238 = REPO / "docs" / "sql" / "rollback_0238_country_list_sale_needs_allow_list.sql"


def has_0238(conn_or_session) -> bool:
    """0238's CHECK is the live one: the only definition of model_registry_countries_before_sale that reads available_countries."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce(bool_or(position('available_countries' in pg_get_constraintdef(oid)) > 0), false) from pg_constraint "
        "where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale'").fetchone()[0])


def rollback_0238_body() -> str:
    """0238's rollback without its own begin / commit: 0142's CHECK back (it refuses while a country-listed row is on sale)."""
    text = ROLLBACK_0238.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0238(conn_or_session) -> None:
    """0238 out (0142's CHECK back), before anything takes 0230's gate away or replays 0142."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0238(conn):
        conn.execute(rollback_0238_body())


def put_back_0238(conn_or_session) -> None:
    """0238 again, only where 0230's gate is live (its guard refuses any other body) and it is not on already. A replay of 0142
    (drop, then add) puts 0142's CHECK back over 0238's, so a test that replays 0142 calls this after."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0238(conn) and _md5_of(conn, "public.creative_jobs_geo_gate()") == GEO_GATE_0230:
        conn.execute(MIGRATION_0238.read_text(encoding="utf-8"))


MIGRATION_0234 = MIGRATIONS / "0234_agent_drafts_operator_only.sql"
ROLLBACK_0234 = REPO / "docs" / "sql" / "rollback_0234_agent_drafts_operator_only.sql"
#: md5 (white space folded) of save_agent_workflow_draft: 0130's body (rollback_0130 pins it), and 0234's operator check on it.
AGENT_SAVE_0130 = "7fe9d1359748e6e311f95678843a6b2e"
AGENT_SAVE_0234 = "3ec1e1922060eb771bf57be879d5bfb2"
AGENT_DELETE_0234 = "2f7e029a513675feeed6aded38622c63"


def has_0234(conn_or_session) -> bool:
    """0234 replaces both draft functions in one transaction, so the save's body is enough to tell."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.save_agent_workflow_draft(uuid, integer, jsonb)") == AGENT_SAVE_0234


def rollback_0234_body() -> str:
    """0234's rollback without its own begin / commit, to run inside a test's transaction."""
    text = ROLLBACK_0234.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0234(conn_or_session) -> None:
    """0234 replaces 0130's two draft functions, and rollback_0130 refuses any body but 0130's. A test that applies rollback_0130 (or
    replays 0130) on a database that has 0234 takes 0234 off first with its own rollback, and puts it back with put_back_0234."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0234(conn):
        conn.execute(rollback_0234_body())


def put_back_0234(conn_or_session) -> None:
    """0234 again where 0130's save body is live (a replay of 0130 puts 0130's bodies back over 0234's)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if _md5_of(conn, "public.save_agent_workflow_draft(uuid, integer, jsonb)") == AGENT_SAVE_0130:
        conn.execute(MIGRATION_0234.read_text(encoding="utf-8"))


def rollback_0159_body() -> str:
    """0159's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database).
    0208 sits on 0159's creative_price, so its rollback runs first: on a database without 0208 it finds the earlier bodies, puts the
    same ones back and drops nothing that is there, so it is harmless where 0208 was never applied."""
    text = ROLLBACK_0159.read_text(encoding="utf-8")
    return rollback_0208_body() + "\n" + "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0159(session) -> None:
    """0159 replaces creative_price() on 0156's body, and 0156 (its replay and its rollback) refuses any other body. A test that replays
    0156 or applies its rollback on a database that has 0159 takes 0159 off first with its own rollback, and puts it back with
    put_back_0159 where the chain goes on. 0208 sits on 0159's body, and 0218 on 0208's, so they come off first when they are there
    (rollback_0159_body runs both rollbacks, each only where its file is on)."""
    session.conn.execute(rollback_0159_body())


def put_back_0159(session) -> None:
    session.conn.execute(MIGRATION_0159.read_text(encoding="utf-8"))
    put_back_0208(session)  # and 0218 on it (put_back_0208 does both)


#: md5 of 0218's three bodies (white space folded), the way its drift guards read them.
CREATIVE_PARAMS_PROBLEM_0218 = "cb7ad6cd459f31259445bedd1a4a0c88"
CREATIVE_PRICE_0218 = "59c5c289009a874af043c534b29934ee"
#: 0224 (stream S10, not on main) adds one line to 0208's creative_price; 0218 applied on that base keeps it. Both bases, both results.
CREATIVE_PRICE_0208_0224 = "d5bc7c5ef1c3d823ece05b9d00274042"
CREATIVE_PRICE_0218_0224 = "ea2b58e88fe34ae18b261e5a0fbef435"
FILM_PRICE_0218 = "3c22f87be736c073d17d93e040e914e1"
#: The bodies 0218 is written on: 0208's creative_params_problem and creative_price, 0171's film_price.
_BEFORE_0218 = {"public.creative_params_problem(text, jsonb)": CREATIVE_PARAMS_PROBLEM_0208,
                "public.creative_price(uuid, text, text, jsonb)": CREATIVE_PRICE_0208,
                "public.film_price(public.films)": "5de6c9bb2a74079e2078cad2d91b3c34"}


def _md5_of(conn, sig: str):
    return conn.execute("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)",
                        [sig]).fetchone()[0] if conn.execute("select to_regprocedure(%s) is not null", [sig]).fetchone()[0] else None


def has_0218(conn_or_session) -> bool:
    """0218 replaces all three in one transaction, so its creative_price body is enough to tell."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.creative_price(uuid, text, text, jsonb)") in (CREATIVE_PRICE_0218, CREATIVE_PRICE_0218_0224,
                                                                               CREATIVE_PRICE_0228)


def rollback_0218_body() -> str:
    """0218's rollback without its own begin / commit, to run inside a test's transaction (or as one statement on a scratch database)."""
    text = ROLLBACK_0218.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def rollback_0218_if_on() -> str:
    """0218's rollback as one statement that runs only where 0218 is on (rollback_0208_body, and so rollback_0159_body, start with it:
    their SQL is run as text by tests, which cannot ask has_0218 first)."""
    body = rollback_0218_body()
    assert "$rb0218$" not in body
    # 0235 sits on 0218's film_price (0218's rollback refuses its body): off first, where it is on.
    return rollback_0235_if_on() + "\n" + (f"do $if0218$ begin if (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc "
            f"where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')) in ('{CREATIVE_PRICE_0218}', "
            f"'{CREATIVE_PRICE_0218_0224}') then "
            f"execute $rb0218${body}$rb0218$; end if; end $if0218$;")


def take_off_0218(conn_or_session) -> None:
    """0218 replaces creative_params_problem() and creative_price() on 0208's bodies and film_price() on 0171's, and those files'
    replays and rollbacks refuse any other body. A test that replays or rolls back 0208 (and so 0159 or 0156) or 0171 takes 0218 off
    first with its own rollback (take_off_0208 and take_off_0171 do it), and puts it back with put_back_0218 once all three are on."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0235(conn)  # 0235 replaces 0218's film_price, and 0218's rollback refuses any other body
    # 0228 sits on 0224's creative_price and 0218's creative_params_problem: take_off_0224 takes it off first.
    take_off_0224(conn)
    if has_0218(conn):
        conn.execute(rollback_0218_body())


def put_back_0218(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    live = {sig: _md5_of(conn, sig) for sig in _BEFORE_0218}
    live["public.creative_price(uuid, text, text, jsonb)"] = {CREATIVE_PRICE_0208_0224: CREATIVE_PRICE_0208}.get(
        live["public.creative_price(uuid, text, text, jsonb)"], live["public.creative_price(uuid, text, text, jsonb)"])
    if not has_0218(conn) and live == _BEFORE_0218:
        conn.execute(migration_0218_lab())
    # 0224 first, then 0228, which applies only on 0224's creative_price.
    put_back_0224(conn)
    put_back_0228(conn)
    put_back_0235(conn)


#: 0228 (music per request, S6): 0224's creative_price and 0218's creative_params_problem, one marked hunk each. Its guard accepts
#: only 0224's creative_price (CREATIVE_PRICE_0218_0224) and 0218's creative_params_problem, or its own bodies.
MIGRATION_0228 = MIGRATIONS / "0228_music_per_request_price.sql"
ROLLBACK_0228 = REPO / "docs" / "sql" / "rollback_0228_music_per_request_price.sql"
CREATIVE_PRICE_0228 = "33bb0ea77aedd1ffc3df339034adc6d3"
CREATIVE_PARAMS_PROBLEM_0228 = "0570bb5a1f749b7e3d556c87443bf17b"


def rollback_0228_body() -> str:
    """0228's rollback without its own begin / commit. Harmless where 0228 is not on (it puts a body back only from 0228's own)."""
    text = ROLLBACK_0228.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def has_0228(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.creative_price(uuid, text, text, jsonb)") == CREATIVE_PRICE_0228


def take_off_0228(conn_or_session) -> None:
    """0228 sits on 0224's creative_price and 0218's creative_params_problem, and their rollbacks refuse (or leave) its bodies: it comes
    off first, with its own rollback."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0228(conn) or _md5_of(conn, "public.creative_params_problem(text, jsonb)") == CREATIVE_PARAMS_PROBLEM_0228:
        conn.execute(rollback_0228_body())


def put_back_0228(conn_or_session) -> None:
    """0228 again, only on 0224's creative_price and 0218's creative_params_problem (its drift guard refuses any other body)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if (not has_0228(conn) and _md5_of(conn, "public.creative_price(uuid, text, text, jsonb)") == CREATIVE_PRICE_0218_0224
            and _md5_of(conn, "public.creative_params_problem(text, jsonb)") == CREATIVE_PARAMS_PROBLEM_0218):
        conn.execute(MIGRATION_0228.read_text(encoding="utf-8"))


MIGRATION_0236 = MIGRATIONS / "0236_film_clip_sound_gate.sql"
ROLLBACK_0236 = REPO / "docs" / "sql" / "rollback_0236_film_clip_sound_gate.sql"
#: md5 of 0236's film_price and film_assembly_retryable (white space folded), the way its drift guard and end state read them.
FILM_PRICE_0236 = "af0fb80cce8e92fd2360aa6d5366a942"
FILM_ASSEMBLY_RETRYABLE_0215 = "82ec51dabd0ff178ec2280bc0c56e62b"
FILM_ASSEMBLY_RETRYABLE_0236 = "88a312d28e63be043796bcc86f024164"


def has_0236(conn_or_session) -> bool:
    """0236's film_price is live, by itself or under 0239 (whose film_price is 0236's plus its own hunks)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.film_price(public.films)") in (FILM_PRICE_0236, FILM_PRICE_0239, FILM_PRICE_0241)


def take_off_0236(conn_or_session) -> None:
    """0236 (a scene's clip sound refused until the cut keeps it) replaces 0235's film_price and 0215's film_assembly_retryable, and
    those files' replays and rollbacks refuse any other body: take_off_0235 (so take_off_0218, take_off_0215, take_off_0139 and the
    files they reach) and take_off_0215 take it off first with its own rollback, and put_back_0235 / put_back_0215 put it back once
    both bodies are there again. Its column goes with the rollback and comes back off (the default) with the replay."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0239(conn)  # 0239 replaces 0236's film_price, which 0236's rollback refuses: off first
    if has_0236(conn):
        text = ROLLBACK_0236.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def rollback_0236_if_on() -> str:
    """0236's rollback as one statement that runs only where 0236's film_price is live: rollback_0235_if_on (and so
    rollback_0218_if_on) starts with it, for the tests that run that SQL as text."""
    text = ROLLBACK_0236.read_text(encoding="utf-8")
    body = "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))
    assert "$rb0236$" not in body and "$if0236$" not in body
    # 0239 sits on 0236's film_price (0236's rollback refuses its body): off first, where it is on.
    return rollback_0239_if_on() + "\n" + (f"do $if0236$ begin if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
            f"where oid = to_regprocedure('public.film_price(public.films)')) = '{FILM_PRICE_0236}' then "
            f"execute $rb0236${body}$rb0236$; end if; end $if0236$;")


def put_back_0236(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0236(conn) and _md5_of(conn, "public.film_price(public.films)") == FILM_PRICE_0235 \
            and _md5_of(conn, "public.film_assembly_retryable(text)") == FILM_ASSEMBLY_RETRYABLE_0215 \
            and conn.execute("select to_regclass('public.film_studio_settings') is not null").fetchone()[0]:
        conn.execute(MIGRATION_0236.read_text(encoding="utf-8"))
    put_back_0239(conn)


def migration_0218_lab() -> str:
    """0218's text for a lab database that already holds synthetic registry rows (synced by the tests, without takes_negative_prompt):
    the file's sync-order check is skipped for that one transaction, the way the file's header says the lab does."""
    return "select set_config('nightshift.m0218_lab_registry', 'on', true);\n" + MIGRATION_0218.read_text(encoding="utf-8")


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
    take_off_0218(conn)  # 0218 replaces 0171's film_price, and 0171's rollback refuses any other body
    take_off_0187(conn)
    if has_0171(conn):
        conn.execute(rollback_0171_body(override=True))


def put_back_0171(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0171(conn):
        conn.execute(MIGRATION_0171.read_text(encoding="utf-8"))
    put_back_0187(conn)
    put_back_0218(conn)


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
    take_off_0219(conn)  # 0219 sits on 0192's oauth_creative_quote and oauth_creative_models, and 0192's rollback refuses them
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
    put_back_0219(conn)


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
    take_off_0215(conn)  # 0215 sits on 0198's start_film, film_claim_segment and claim_creative_job; 0198's rollback refuses it
    if has_0198(conn):
        text = ROLLBACK_0198.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0198(conn_or_session) -> None:
    """0198 again, once 0192 (whose bodies it builds on) is on, and only when it is not on already; then 0215 on it."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0198(conn) and has_0192(conn):
        conn.execute(MIGRATION_0198.read_text(encoding="utf-8"))
    put_back_0215(conn)


MIGRATION_0215 = MIGRATIONS / "0215_film_archive_resume.sql"
ROLLBACK_0215 = REPO / "docs" / "sql" / "rollback_0215_film_archive_resume.sql"


def has_0215(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.start_film_resume(uuid, text, text)') is not null").fetchone()[0])


def take_off_0215(conn_or_session) -> None:
    """0215 (archive and resume of a paused film; the worker's id kept out of members' reads) replaces 0166's film_read and
    archive_film and 0198's start_film, film_claim_segment and claim_creative_job, and its functions read 0171's film_segments.
    0166's and 0198's drift guards and rollbacks, and 0171's rollback, refuse while it is on, so take_off_0198 takes it off first
    (take_off_0192, take_off_0187 and take_off_0171 reach it through it). Its rollback keeps the columns and checks it added (the
    record of a resume), which put_back_0215 picks up again as its own. 0226's bodies call 0215's is_org_spender, which this rollback
    drops: 0226 comes off first."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0236(conn)  # 0236 replaces 0215's film_assembly_retryable, and 0215's replay and rollback refuse any other body
    take_off_0235(conn)  # 0235 replaces 0215's film_resume_precheck, and 0215's rollback and replay refuse any other body
    take_off_0226(conn)
    if has_0215(conn):
        text = ROLLBACK_0215.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0215(conn_or_session) -> None:
    """0215 again, once 0198 (whose bodies it builds on) and 0187 / 0192 (whose questions it asks) are on, when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0215(conn) and has_0198(conn) and has_0187(conn) and has_0192(conn):
        conn.execute(MIGRATION_0215.read_text(encoding="utf-8"))
    put_back_0226(conn)
    put_back_0235(conn)
    put_back_0236(conn)


MIGRATION_0226 = MIGRATIONS / "0226_org_spender_everywhere.sql"
ROLLBACK_0226 = REPO / "docs" / "sql" / "rollback_0226_org_spender_everywhere.sql"


def _0226_paths():
    import sec_org_spender_0226  # the one list of the twenty-eight bodies: signature, role, earlier md5, 0226's md5

    return sec_org_spender_0226.PATHS


def has_0226(conn_or_session) -> bool:
    """Any of the twenty-eight bodies is 0226's. Not all: a lab that replays an older file (0057, 0094, ...) puts that one body back and
    leaves the rest, and the rest still has to come off before an earlier rollback runs."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    session = SimpleSession(conn)
    return any(_live_md5(session, sig) == now_ for sig, *_rest, now_ in _0226_paths())


def take_off_0226(conn_or_session) -> None:
    """0226 (only a member spends, on every path) replaces twenty-eight bodies of 0042, 0057, 0074, 0080, 0085, 0093, 0094, 0120, 0122,
    0133, 0136, 0137, 0147 and 0192 (one hunk each) and calls 0215's is_org_spender. 0192's drift guard, and the rollbacks of the files
    whose bodies it replaced, refuse while it is on, and 0215's rollback drops what it calls: take_off_0215 takes it off first
    (take_off_0198, take_off_0192, take_off_0187 and take_off_0171 reach it through it), and so do the take-offs of the other files."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0231(conn)  # 0231 asks for 0226's cancel_workflow_run: off first
    take_off_0232(conn)  # 0232 sits on 0226's ai_chat_reserve_turn and ai_chat_plan_end, which 0226's guard and rollback refuse
    if has_0226(conn):
        # Whole first (its guard takes a mix of the earlier and its own bodies), so that its rollback, which asks for all twenty-eight, runs.
        conn.execute(MIGRATION_0226.read_text(encoding="utf-8"))
        text = ROLLBACK_0226.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0226(conn_or_session) -> None:
    """0226 again, when it is not on and its guard would take it: 0215's is_org_spender is there and each of the twenty-eight bodies is the
    earlier file's (a chain that left one of those files out leaves 0226 out too, the way put_back_0145 does)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0226(conn) or not conn.execute("select to_regprocedure('public.is_org_spender(uuid, text)') is not null").fetchone()[0]:
        return
    session = SimpleSession(conn)
    if all(_live_md5(session, sig) in (was, now_) for sig, _role, _src, was, now_ in _0226_paths()):
        conn.execute(MIGRATION_0226.read_text(encoding="utf-8"))
    put_back_0231(conn)
    put_back_0232(conn)


MIGRATION_0231 = MIGRATIONS / "0231_cancel_audit.sql"
ROLLBACK_0231 = REPO / "docs" / "sql" / "rollback_0231_cancel_audit.sql"
#: cancel_creative_job's bodies: 0198's (what 0231 replaces, and what 0198's rollback asks for) and 0231's.
CANCEL_CREATIVE_JOB_0198 = "2720d62c17ae26bce439a28280964575"
CANCEL_CREATIVE_JOB_0231 = "c210f8e4684e154d40f7029b5c94b893"


def _0231_bodies():
    import sec_cancel_audit_0231  # the one list of the four bodies: signature, earlier file, earlier md5, 0231's md5

    return sec_cancel_audit_0231.BODIES


def has_0231(conn_or_session) -> bool:
    """Any of the four bodies is 0231's. Not all: a lab that replays 0036, 0073, 0074 or 0083 puts one body back silently and leaves the
    rest, which still has to come off before an earlier rollback runs."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    session = SimpleSession(conn)
    return any(_live_md5(session, sig) == now_ for sig, _src, _was, now_ in _0231_bodies())


def take_off_0231(conn_or_session) -> None:
    """0231 (a workflow step's job is cancelled by the run's rule, every cancel and every real stop recorded, a browser writes no cancel
    row, a member takes no workflow step's key) replaces 0198's cancel_creative_job, 0226's create_creative_job and cancel_workflow_run
    and 0192's workflow_advance_locked, which those files' rollbacks and guards refuse: take_off_0226 takes it off first (take_off_0215,
    take_off_0198 and take_off_0192 reach it through it)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0231(conn):
        # Whole first (its guard takes a mix of the earlier and its own bodies), so that its rollback, which asks for all four, runs.
        conn.execute(MIGRATION_0231.read_text(encoding="utf-8"))
        text = ROLLBACK_0231.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0231(conn_or_session) -> None:
    """0231 again, when it is not on and its guard would take it: 0226 on and each of the four bodies the earlier file's."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    session = SimpleSession(conn)
    if (not has_0231(conn) and has_0226(conn)
            and all(_live_md5(session, sig) == was for sig, _src, was, _now in _0231_bodies())):
        conn.execute(MIGRATION_0231.read_text(encoding="utf-8"))


MIGRATION_0232 = MIGRATIONS / "0232_ai_chat_film_plan_leases.sql"
ROLLBACK_0232 = REPO / "docs" / "sql" / "rollback_0232_ai_chat_film_plan_leases.sql"


def has_0232(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.ai_chat_film_plan_begin(uuid, uuid, integer)') is not null").fetchone()[0])


def take_off_0232(conn_or_session) -> None:
    """0232 (one storyboard plan per film, its turns reserved at begin) replaces 0226's ai_chat_reserve_turn and ai_chat_plan_end and
    0199's ai_chat_used and ai_chat_trial_left. 0226's guard and rollback refuse its bodies, so take_off_0226 takes it off first. Its
    rollback drops the film lease table (it references films, so 0166's rollback needs it gone): the rows are kept here and
    put_back_0232 writes them again, so the scenario's seeded leases survive a take-off and put-back that is committed."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0232(conn):
        _STASH_0232[conn.info.dbname] = conn.execute("select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)::text "
                                             "from public.ai_chat_film_plan_leases l").fetchone()[0]
        text = ROLLBACK_0232.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0232(conn_or_session) -> None:
    """0232 again, once the bodies it sits on are 0226's and 0199's (its guard refuses any other), when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0232(conn):
        return
    import sec_film_lease_0232  # the one list of the bodies 0232 replaces and relies on

    session = SimpleSession(conn)
    if all(_live_md5(session, sig) == was for sig, was, _now in sec_film_lease_0232.GUARD):
        conn.execute(MIGRATION_0232.read_text(encoding="utf-8"))
        rows = _STASH_0232.pop(conn.info.dbname, None)
        if rows:
            # Rows whose film or conversation went with an earlier take-off are not written back (their foreign keys would refuse).
            conn.execute("insert into public.ai_chat_film_plan_leases "
                         "select r.* from jsonb_populate_recordset(null::public.ai_chat_film_plan_leases, %s::jsonb) r "
                         "where exists (select 1 from public.films f where f.id = r.film_id) "
                         "and exists (select 1 from public.ai_chat_sessions x where x.id = r.session_id) on conflict (film_id) do nothing",
                         [rows])


#: What take_off_0232 found in the film lease table, by database (a take-off and its put-back may use two connections).
_STASH_0232: dict = {}


class SimpleSession:
    """What _live_md5 reads (``.conn``), for a helper handed a bare connection."""

    def __init__(self, conn):
        self.conn = conn


MIGRATION_0219 = MIGRATIONS / "0219_oauth_creative_operator_models.sql"
ROLLBACK_0219 = REPO / "docs" / "sql" / "rollback_0219_oauth_creative_operator_models.sql"


def has_0219(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.oauth_creative_org_model_state(uuid, text, text)') is not null").fetchone()[0])


def take_off_0219(conn_or_session) -> None:
    """0219 (the operator route for connected assistants, the ByteDance refusal, the recorded exposure) replaces oauth_creative_models()
    and oauth_creative_quote() (0192's bodies) and oauth_creative_create() (0191's). 0192's rollback refuses any other body, and a
    replay of 0191 would silently put 0191's create back, so take_off_0192 takes 0219 off first. Its rollback keeps the exposure
    columns, which put_back_0219 picks up again as its own."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0219(conn):
        text = ROLLBACK_0219.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0219(conn_or_session) -> None:
    """0219 again, once 0192 (whose bodies it builds on) is on, and only when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0219(conn) or not has_0192(conn):
        return
    conn.execute(MIGRATION_0219.read_text(encoding="utf-8"))


MIGRATION_0219 = MIGRATIONS / "0219_oauth_creative_operator_models.sql"
ROLLBACK_0219 = REPO / "docs" / "sql" / "rollback_0219_oauth_creative_operator_models.sql"


def has_0219(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.oauth_creative_org_model_state(uuid, text, text)') is not null").fetchone()[0])


def take_off_0219(conn_or_session) -> None:
    """0219 (the operator route for connected assistants, the ByteDance refusal, the recorded exposure) replaces oauth_creative_models()
    and oauth_creative_quote() (0192's bodies) and oauth_creative_create() (0191's). 0192's rollback refuses any other body, and a
    replay of 0191 would silently put 0191's create back, so take_off_0192 takes 0219 off first. Its rollback keeps the exposure
    columns, which put_back_0219 picks up again as its own."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0219(conn):
        text = ROLLBACK_0219.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0219(conn_or_session) -> None:
    """0219 again, once 0192 (whose bodies it builds on) is on, and only when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0219(conn) or not has_0192(conn):
        return
    conn.execute(MIGRATION_0219.read_text(encoding="utf-8"))


MIGRATION_0233 = MIGRATIONS / "0233_platform_roster_closed.sql"
ROLLBACK_0233 = REPO / "docs" / "sql" / "rollback_0233_platform_roster_closed.sql"


def has_0233(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return not conn.execute("select has_function_privilege('authenticated', 'public.owner_add_member(text,text,text)', 'EXECUTE')").fetchone()[0]


def take_off_0233(conn_or_session) -> None:
    """0233 (nobody changes the platform roster from a browser) revokes EXECUTE on 0107's three roster functions and INSERT, UPDATE,
    DELETE on app_members from the API roles. The 0107 tests of those functions' own checks (last owner, self change, owner-only) and
    of the direct-write trail take it off with its rollback inside their rolled-back transaction: the functions are still in the
    database, and their checks are what a later re-grant would rely on."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0233(conn):
        text = ROLLBACK_0233.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def put_back_0233(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0233(conn):
        conn.execute(MIGRATION_0233.read_text(encoding="utf-8"))


MIGRATION_0235 = MIGRATIONS / "0235_film_operator_preview.sql"
ROLLBACK_0235 = REPO / "docs" / "sql" / "rollback_0235_film_operator_preview.sql"
#: md5 of 0235's bodies (white space folded), the way its drift guard and end state read them.
FILM_PRICE_0235 = "186d34ffb633bc56a91bbf617b0b7520"
FILM_CHECK_MODEL_0235 = "5a2c4ed8d8b56bc63d6d095085ab0361"
FILM_MODEL_PROBLEM_0235 = "48d25f5cb4f21b9cea72658968d9c952"
#: The bodies 0235 is written on: 0218's film_price, 0171's film_precheck, 0215's film_resume_precheck, 0166's film_apply_settings and
#: film_save_scenes.
_BEFORE_0235 = {"public.film_price(public.films)": FILM_PRICE_0218,
                "public.film_precheck(public.films)": "ff4fa7e8a6386420f32ab6a3a85a778c",
                "public.film_resume_precheck(public.films, uuid)": "aa7275ed5e8520af52cabd03c2f930d8",
                "public.film_apply_settings(public.films, jsonb, text[])": "248ffb76f60f3a6f4e8b34b85cd0c92b",
                "public.film_save_scenes(public.films, jsonb)": "c836631256f669318c9ef499d7c4c54b"}


def has_0235(conn_or_session) -> bool:
    """0235 adds the four-argument film_check_model in the same transaction as its five replacements."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute("select to_regprocedure('public.film_check_model(text, text[], text, uuid)') is not null").fetchone()[0])


def take_off_0235(conn_or_session) -> None:
    """0235 (Film Studio's operator preview) replaces 0218's film_price, 0171's film_precheck, 0215's film_resume_precheck and 0166's
    film_apply_settings and film_save_scenes, and those files' replays and rollbacks refuse any other body: take_off_0218 (so
    take_off_0171 and take_off_0208), take_off_0215 (so take_off_0198, take_off_0192, take_off_0187) and take_off_0139 take it off first
    with its own rollback, and their put-backs put it back once every body it is written on is there again."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0236(conn)  # 0236 replaces 0235's film_price, and 0235's rollback refuses any other body
    if has_0235(conn):
        text = ROLLBACK_0235.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def rollback_0235_if_on() -> str:
    """0235's rollback as one statement that runs only where 0235 is on (its four-argument film_check_model is there): rollback_0218_if_on
    (and so rollback_0208_body and rollback_0159_body) starts with it, for the tests that run that SQL as text."""
    text = ROLLBACK_0235.read_text(encoding="utf-8")
    body = "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))
    assert "$rb0235$" not in body and "$if0235$" not in body
    # 0236 sits on 0235's film_price (0235's rollback refuses its body): off first, where it is on.
    return rollback_0236_if_on() + "\n" + (f"do $if0235$ begin if to_regprocedure('public.film_check_model(text, text[], text, uuid)') is not null then "
            f"execute $rb0235${body}$rb0235$; end if; end $if0235$;")


def put_back_0235(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0235(conn) and has_0139(conn) and {sig: _md5_of(conn, sig) for sig in _BEFORE_0235} == _BEFORE_0235:
        conn.execute(MIGRATION_0235.read_text(encoding="utf-8"))
    put_back_0236(conn)


MIGRATION_0239 = MIGRATIONS / "0239_film_keyframe_refs_quote.sql"
ROLLBACK_0239 = REPO / "docs" / "sql" / "rollback_0239_film_keyframe_refs_quote.sql"
#: md5 of 0239's bodies (white space folded), the way its drift guard and end state read them.
FILM_PRICE_0239 = "02016cc4a695a54c5693a5066247269b"
FILM_APPLY_SETTINGS_0239 = "9a2ae594cb08df36973c7e656a7f1c9d"
FILM_SAVE_SCENES_0239 = "4115ba8800b1b1a702585267d27af17c"
#: The bodies 0239 is written on: 0236's film_price, 0235's film_apply_settings and film_save_scenes.
_BEFORE_0239 = {"public.film_price(public.films)": FILM_PRICE_0236,
                "public.film_apply_settings(public.films, jsonb, text[])": "f5cdf963343a4b722333eaf0d13bd840",
                "public.film_save_scenes(public.films, jsonb)": "d2d32abea21beb742eea14d92ad6e9fd"}


def has_0239(conn_or_session) -> bool:
    """0239 replaces its three bodies in one transaction: film_price holding 0239's body is the file."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.film_price(public.films)") in (FILM_PRICE_0239, FILM_PRICE_0241)


def take_off_0239(conn_or_session) -> None:
    """0239 (a film's key frame quoted the way it is made) replaces 0236's film_price and 0235's film_apply_settings and film_save_scenes,
    and 0236's and 0235's replays and rollbacks refuse any other body: take_off_0236 (which take_off_0235, take_off_0215, take_off_0218
    and take_off_0139 reach) takes it off first with its own rollback, and put_back_0236 puts it back once every body it is written on
    is there again."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    take_off_0241(conn)  # 0241 replaces 0239's film_price and film_save_scenes, which 0239's rollback refuses: off first
    if has_0239(conn):
        text = ROLLBACK_0239.read_text(encoding="utf-8")
        conn.execute("\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;")))


def rollback_0239_if_on() -> str:
    """0239's rollback as one statement that runs only where 0239 is on (film_price holds its body): rollback_0236_if_on (and so
    rollback_0235_if_on) starts with it, for the tests that run that SQL as text."""
    text = ROLLBACK_0239.read_text(encoding="utf-8")
    body = "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))
    assert "$rb0239$" not in body and "$if0239$" not in body
    # 0241 sits on 0239's film_price (0239's rollback refuses its body): off first, where it is on.
    return rollback_0241_if_on() + "\n" + (f"do $if0239$ begin if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
            f"where oid = to_regprocedure('public.film_price(public.films)')) = '{FILM_PRICE_0239}' then "
            f"execute $rb0239${body}$rb0239$; end if; end $if0239$;")


def put_back_0239(conn_or_session) -> None:
    """0239 again, once 0236's film_price and 0235's two save bodies are on, and only when it is not on already."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0239(conn) and {sig: _md5_of(conn, sig) for sig in _BEFORE_0239} == _BEFORE_0239:
        conn.execute(MIGRATION_0239.read_text(encoding="utf-8"))
    put_back_0241(conn)


MIGRATION_0241 = MIGRATIONS / "0241_film_scene_dialogue.sql"
ROLLBACK_0241 = REPO / "docs" / "sql" / "rollback_0241_film_scene_dialogue.sql"
#: md5 of 0241's two bodies (white space folded), the way its drift guard and end state read them; it is written on 0239's.
FILM_SAVE_SCENES_0241 = "50942d89b6c407fc7438fe158cdd8115"
FILM_PRICE_0241 = "3607297484f191d45ff9a1f63a11c5b5"
#: The rollback's own switch, for a lab whose scenes it may empty (the rollback refuses while a scene holds a sound role or lines).
_DISCARD_0241 = "set local nightshift.rollback_0241_discard_sound = 'on';"


def has_0241(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return _md5_of(conn, "public.film_price(public.films)") == FILM_PRICE_0241


def rollback_0241_body() -> str:
    text = ROLLBACK_0241.read_text(encoding="utf-8")
    return _DISCARD_0241 + "\n" + "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0241(conn_or_session) -> None:
    """0241 (a scene's own sound and its spoken lines) replaces 0239's film_price and film_save_scenes, and 0239's replay and rollback
    refuse any other body: take_off_0239 (so take_off_0236, take_off_0235 and everything that reaches them) takes it off first with its
    own rollback, told to discard the lab's lines, and put_back_0239 puts it back once 0239's bodies are there again."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if has_0241(conn):
        conn.execute(rollback_0241_body())


def rollback_0241_if_on() -> str:
    """0241's rollback as one statement that runs only where 0241's film_price is live: rollback_0239_if_on starts with it."""
    body = rollback_0241_body()
    assert "$rb0241$" not in body and "$if0241$" not in body
    return (f"do $if0241$ begin if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
            f"where oid = to_regprocedure('public.film_price(public.films)')) = '{FILM_PRICE_0241}' then "
            f"execute $rb0241${body}$rb0241$; end if; end $if0241$;")


def put_back_0241(conn_or_session) -> None:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    if not has_0241(conn) and _md5_of(conn, "public.film_price(public.films)") == FILM_PRICE_0239 \
            and _md5_of(conn, "public.film_save_scenes(public.films, jsonb)") == FILM_SAVE_SCENES_0239:
        conn.execute(MIGRATION_0241.read_text(encoding="utf-8"))


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
