"""Migration 0205: "Publish to platforms" refuses a video whose publish-gate verdict is missing; it never passes (BR-LIVE-04).

What would break without these (each in a real database):

  * a video with NO stored gate verdict is cross-posted, because publish_request_refusal (0029) looked for publish.allowed /
    publish.blocked events by video_id and the pipeline emits them with the channel only, so nothing ever matched;
  * a gate-blocked verdict stored on the video does not refuse;
  * a malformed verdict ({"allowed": "true"} as text) reads as a pass;
  * a browser's publish_requests insert for such a video is queued instead of refused (the trigger asks the same function);
  * the md5 guard lets the file replace a body it has not read; the rollback does not put back 0029's body exactly.
"""

from __future__ import annotations

import json
import re

import sec_db
from sec_db import SERVICE, as_superuser
from test_sec_approve_video import VID, acting, uploaded

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0205_publish_refusal_gate_verdict.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0205_publish_refusal_gate_verdict.sql"
REFUSAL = "select public.publish_request_refusal(%s)"
BLOCKED = {"allowed": False, "blocks": ["rights"], "warnings": [], "checks_run": ["rights"]}
ALLOWED = {"allowed": True, "blocks": [], "warnings": [], "checks_run": ["rights", "facts"]}


def _video(su, channel, verdict):
    """An uploaded, approved video: everything 0029 checks passes, so only the gate decides. The channel's two-person rule is off
    here (inside the rolled-back world): another file may have left it on, and that reason comes after the gate's."""
    su.rows("update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) - 'require_two_person_publish' "
            "where channel_id = %s returning 1", [channel])
    uploaded(su, channel, review_state="approved", gate_verdict=None if verdict is None else json.dumps(verdict))


def test_a_video_with_no_stored_verdict_is_refused_gate_unknown_never_passed(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, None)
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) == "gate_unknown"


def test_a_blocked_verdict_refuses_gate_blocked_and_an_allowed_one_passes(conn, sc):
    for verdict, want in ((BLOCKED, "gate_blocked"),
                          ({"allowed": True, "blocks": ["facts"]}, "gate_blocked"),
                          ({"allowed": "true", "blocks": []}, "gate_unknown"),
                          ({"blocks": []}, "gate_unknown"),
                          # Breach (hardening): a blocks list that is not a list is not a readable verdict.
                          ({"allowed": True, "blocks": "rights"}, "gate_unknown"),
                          ({"allowed": True, "blocks": None}, "gate_unknown"),
                          ({"allowed": True, "blocks": {"rights": 1}}, "gate_unknown"),
                          ({"allowed": True}, None),
                          (ALLOWED, None)):
        with as_superuser(conn, commit=False) as su:
            _video(su, sc.bob.channel, verdict)
            with acting(conn, SERVICE) as s:
                assert s.value(REFUSAL, [VID]) == want, verdict


def test_a_browser_request_for_a_video_with_no_verdict_is_recorded_refused(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        _video(su, bob.channel, None)
        with acting(conn, bob.actor) as s:
            out = s.run("insert into public.publish_requests (video_id, account_id) values (%s, %s) returning status, reason",
                        [VID, bob.social_account])
        assert out.ok and out.rows[0] == ("refused", "gate_unknown"), out


def _norm_md5(body: str) -> str:
    import hashlib

    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", body).encode()).hexdigest()


def test_the_guard_names_both_bodies_and_refuses_any_other(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    hashes = re.findall(r"array\['([0-9a-f]{32})', '([0-9a-f]{32})'\]", text)
    assert len(hashes) == 1
    old, new = hashes[0]
    m0029 = (sec_db.REPO / "supabase" / "migrations" / "0029_publish_targets.sql").read_text(encoding="utf-8")
    i = m0029.index("create or replace function public.publish_request_refusal(p_video_id text)")
    body = m0029[m0029.index("$$", i) + 2: m0029.index("$$;", i)]
    assert _norm_md5(body) == old
    i = text.index("create or replace function public.publish_request_refusal(p_video_id text)")
    assert _norm_md5(text[text.index("$$", i) + 2: text.index("$$;", i)]) == new
    with as_superuser(conn, commit=False) as su:
        # A body that is neither: the file must stop, not overwrite what it has not read.
        su.conn.execute("create or replace function public.publish_request_refusal(p_video_id text) returns text "
                        "language sql stable security definer set search_path = '' as $$ select 'someone else''s'::text $$")
        out = su.run(text)
        assert not out.ok and "read the live body first" in str(out)


def test_applying_again_changes_nothing_and_the_rollback_puts_back_0029(conn, sc):
    text = MIGRATION.read_text(encoding="utf-8")
    rollback = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        sig = "public.publish_request_refusal(text)"
        live = su.value("select md5(pg_get_functiondef(%s::regprocedure)) || proacl::text from pg_proc where oid = %s::regprocedure", [sig, sig])
        su.conn.execute(text)
        assert su.value("select md5(pg_get_functiondef(%s::regprocedure)) || proacl::text from pg_proc where oid = %s::regprocedure", [sig, sig]) == live
        su.conn.execute(rollback)
        _video(su, sc.bob.channel, None)
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) is None   # 0029's body: the gap is back, as the rollback says
        su.conn.execute(text)
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) == "gate_unknown"
        assert su.value("select has_function_privilege('authenticated', %s::regprocedure, 'EXECUTE')", [sig]) is False
        assert su.value("select has_function_privilege('service_role', %s::regprocedure, 'EXECUTE')", [sig]) is True


def test_the_rollback_takes_back_only_0205s_own_body(conn):
    """Breach (hardening): applied after a later file replaced the function again, an unguarded rollback would silently undo that
    file and reopen BR-LIVE-04. It refuses instead."""
    rollback = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("create or replace function public.publish_request_refusal(p_video_id text) returns text "
                        "language sql stable security definer set search_path = '' as $$ select 'a later file''s'::text $$")
        out = su.run(rollback)
        assert not out.ok and "undo the later file first" in str(out)
