"""Migration 0110 (promo and custom brand-channel posts, Telegram only). It is DORMANT: nothing calls the two new
functions, so this file pins what a new kind of public post must never be able to do:

  * be made by anyone but the signed-in platform owner/admin (custom, typed on the page) or the worker's service key
    (promo, drafted from a reviewed file), or by the owner function as a `promo` row;
  * be approved by the act of making it, go out without the owner's approval of EXACTLY these words, or go out in a
    week that already holds two posts of any other kind (news, price, promo and custom share the 2 per 7 days);
  * be made twice by a double tap, or have the owner's words overwritten by the worker;
  * change anything the live worker does: the 0108 functions, the status machine and the kill switch are untouched.

Each test runs in a transaction that is rolled back, as one caller (``Tx.as_``), with the JWT claims PostgREST would hand
the database. The one race test commits its rows on purpose and removes them again. The helpers are those of
test_sec_marketing_posts.py and test_sec_owner_safety.py; the 0108 and 0109 suites run unchanged beside this file.
"""

from __future__ import annotations

import json
import re

import psycopg
import pytest

from sec_db import ANON, REPO, SERVICE, as_superuser
from test_sec_marketing_posts import (OWNER_CALLS, TEXTS, approve, chash, claim, complete, draft, enable, price_draft,
                                      raw, run, send, status, used)
from test_sec_owner_safety import aal2, audits, events, factors, gate_on, second_connection, tx

MIGRATION = REPO / "supabase" / "migrations" / "0110_marketing_promo_custom.sql"
PREVIOUS = REPO / "supabase" / "migrations" / "0108_marketing_posts.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0110_marketing_promo_custom.sql"

NEW_FUNCTIONS = {"owner_marketing_create", "marketing_draft_upsert_v2"}
CREATE_SIG = "public.owner_marketing_create(text,jsonb,text,text)"
V2_SIG = "public.marketing_draft_upsert_v2(text,text,jsonb,text,jsonb,timestamptz,text,text,text)"
V1_SIG = "public.marketing_draft_upsert(text,text,jsonb,text,jsonb,timestamptz,text,text,text)"
# What 0110 must leave exactly as 0108 made it: the live worker and the owner page call these.
UNCHANGED_0108 = ("marketing_posts_guard", "marketing_texts_ok", "marketing_post_hash", "marketing_cap_used",
                  "owner_marketing_get", "owner_marketing_edit", "owner_marketing_approve", "owner_marketing_reject",
                  "owner_marketing_kill", "marketing_draft_upsert", "claim_marketing_post", "complete_marketing_post",
                  "marketing_posts_no_delete")
NEW_ACTION = "marketing.create"
ZERO_UUID = "00000000-0000-0000-0000-0000000000bb"


def rid(n=1):
    return f"req-{n:04d}-abcdefghij"


@pytest.fixture
def op(sc):
    return sc.operator


# ── plumbing ────────────────────────────────────────────────────────────────

def create(t, who, request_id=None, texts=None, link=None):
    return t.as_(who).value("select public.owner_marketing_create(%s, %s::jsonb, %s)",
                            [request_id or rid(), json.dumps(texts or TEXTS), link])


def create_raw(t, who, request_id, texts, link=None, *kind):
    """The call with arguments exactly as given (None stays SQL null); a kind is passed only when one is given."""
    args = [request_id, None if texts is None else json.dumps(texts), link]
    if kind:
        return t.as_(who).run("select public.owner_marketing_create(%s, %s::jsonb, %s, %s)", [*args, kind[0]])
    return t.as_(who).run("select public.owner_marketing_create(%s, %s::jsonb, %s)", args)


def promo(t, slug="welcome", texts=None, link=None, media=None, who=SERVICE):
    return t.as_(who).value(
        "select public.marketing_draft_upsert_v2(%s, 'promo', %s::jsonb, %s, '{}'::jsonb, null, %s, 'telegram', %s)",
        [f"promo:{slug}:telegram", json.dumps(texts or TEXTS), f"promo:{slug}", media, link])


def make(t, op, kind, n=1):
    """One draft of any kind; returns its id."""
    if kind == "custom":
        out = create(t, op, rid(n))
    elif kind == "promo":
        out = promo(t, f"slug-{n}")
    elif kind == "news":
        return draft(t, f"news:mk-{n}", pr=100 + n)
    else:
        return price_draft(t, f"price:mk-{n}")
    assert out["ok"], out
    return out["id"]


def prow(t, pid):
    cols = ("kind", "target", "status", "idempotency_key", "source_ref", "link", "media_path", "facts", "texts",
            "approved_by", "approved_hash", "approved_at", "expires_at", "edited_by", "edited_at", "content_hash")
    return dict(zip(cols, t.sup("select " + ", ".join(cols) + " from public.marketing_posts where id = %s", [pid])[0]))


def count_kind(t, kind):
    return t.sup("select count(*) from public.marketing_posts where kind = %s", [kind])[0][0]


def _list(text):
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", text, re.S).group(1)
    return set(re.findall(r"'([a-z_.]+)'", block))


# ── who may call what ───────────────────────────────────────────────────────

def test_anon_and_everyone_who_is_not_a_platform_admin_is_refused_by_the_owner_function(conn, sc):
    with tx(conn) as t:
        out = t.anon().run("select public.owner_marketing_create(%s, %s::jsonb, null)", [rid(), json.dumps(TEXTS)])
        assert not out.ok and out.sqlstate == "42501", out
        for who in (sc.bob.actor, sc.alice.actor, sc.dana, sc.stranger, SERVICE):
            out = t.as_(who).run("select public.owner_marketing_create(%s, %s::jsonb, null)", [rid(), json.dumps(TEXTS)])
            assert not out.ok and out.sqlstate == "42501", (getattr(who, "name", who), out)
        assert count_kind(t, "custom") == 0
        assert t.sup("select count(*) from public.app_audit_log where action = %s", [NEW_ACTION])[0][0] == 0


def test_the_worker_function_v2_is_for_the_service_key_only(conn, sc):
    call = ("select public.marketing_draft_upsert_v2('promo:attack-1:telegram', 'promo', "
            "'{\"uz\":\"a\",\"ru\":\"b\",\"en\":\"c\"}'::jsonb, 'promo:attack-1')")
    with tx(conn) as t:
        for who in (None, sc.operator, sc.bob.actor, sc.alice.actor, sc.dana, sc.stranger):
            out = t.anon().run(call) if who is None else t.as_(who).run(call)
            assert not out.ok and out.sqlstate == "42501", (getattr(who, "name", "anon"), out)
        assert t.as_(SERVICE).value(call)["ok"] is True
    with as_superuser(conn, commit=False) as s:
        assert [s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [r, V2_SIG]) for r in
                ("anon", "authenticated", "service_role")] == [False, False, True]
        assert [s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [r, CREATE_SIG]) for r in
                ("anon", "authenticated", "service_role")] == [False, True, False]


def test_both_new_functions_are_definers_with_a_pinned_search_path(conn):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') from pg_proc p "
                      "where p.pronamespace = 'public'::regnamespace and p.proname = any(%s)", [sorted(NEW_FUNCTIONS)])
    assert {r[0] for r in rows} == NEW_FUNCTIONS
    for name, definer, config in rows:
        assert definer and any(c.startswith("search_path=") and "pg_temp" in c for c in config), (name, config)


def test_the_service_key_cannot_use_the_owner_function_and_the_owner_cannot_use_v2(conn, sc, op):
    with tx(conn) as t:
        assert t.as_(SERVICE).run("select public.owner_marketing_create(%s, %s::jsonb, null)",
                                  [rid(), json.dumps(TEXTS)]).sqlstate == "42501"
        out = t.as_(op).run("select public.marketing_draft_upsert_v2('promo:x-1:telegram', 'promo', %s::jsonb, 'promo:x-1')",
                            [json.dumps(TEXTS)])
        assert out.sqlstate == "42501", out


# ── the owner types a post ──────────────────────────────────────────────────

def test_the_owner_types_a_custom_draft_and_it_is_only_a_draft(conn, sc, op):
    with tx(conn) as t:
        out = create(t, op, rid(1), link="/pricing")
        assert out["ok"] and out["created"] is True and out["status"] == "draft" and out["kind"] == "custom", out
        r = prow(t, out["id"])
        assert (r["kind"], r["target"], r["status"]) == ("custom", "telegram", "draft")
        assert r["idempotency_key"] == f"custom:{rid(1)}:telegram" and r["source_ref"] == f"owner:{op.uid}"
        assert r["texts"] == TEXTS and r["link"] == "/pricing" and r["media_path"] is None and r["facts"] == {}
        assert r["approved_by"] is None and r["approved_hash"] is None and r["approved_at"] is None and r["expires_at"] is None
        assert r["edited_at"] is None and out["content_hash"] == r["content_hash"] and len(r["content_hash"]) == 64


def test_creating_is_audited_with_the_lengths_and_the_hash_and_never_the_words(conn, sc, op):
    with tx(conn) as t:
        out = create(t, op, rid(1), link="/studio")
        rows = audits(t, NEW_ACTION)
        assert len(rows) == 1
        action, actor, _email, target, detail = rows[0]
        assert actor == str(op.uid) and target == str(out["id"])
        assert detail["post_id"] == str(out["id"]) and detail["kind"] == "custom" and detail["has_link"] is True
        assert detail["content_hash"] == out["content_hash"]
        assert detail["chars"] == {k: len(v) for k, v in TEXTS.items()}
        assert not any(v in json.dumps(detail, ensure_ascii=False) for v in TEXTS.values())
        ev = events(t, NEW_ACTION)
        assert len(ev) == 1 and ev[0][1] == "notice" and ev[0][4] == str(out["id"])


def test_a_double_tap_returns_the_same_post_and_never_a_second(conn, sc, op):
    with tx(conn) as t:
        first = create(t, op, rid(1))
        second = create(t, op, rid(1))
        assert first["created"] is True and second["created"] is False and second["ok"] is True
        assert first["id"] == second["id"] and second["same_texts"] is True and second["status"] == "draft"
        assert second["content_hash"] == first["content_hash"]
        assert t.sup("select count(*) from public.marketing_posts where idempotency_key = %s", [f"custom:{rid(1)}:telegram"])[0][0] == 1
        assert len(audits(t, NEW_ACTION)) == 1, "the retry is not a second creation"
        # a different request id is a different post
        assert create(t, op, rid(2))["id"] != first["id"] and count_kind(t, "custom") == 2


def test_the_same_request_with_other_words_keeps_the_first_words_and_says_so(conn, sc, op):
    with tx(conn) as t:
        first = create(t, op, rid(1))
        again = create(t, op, rid(1), texts={**TEXTS, "en": "Other words"})
        assert again["id"] == first["id"] and again["created"] is False and again["same_texts"] is False
        assert prow(t, first["id"])["texts"] == TEXTS


def test_a_retry_after_the_owner_edited_or_rejected_the_post_does_not_bring_it_back(conn, sc, op):
    with tx(conn) as t:
        first = create(t, op, rid(1))
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [first["id"], json.dumps({**TEXTS, "en": "Mine"})])["ok"]
        again = create(t, op, rid(1))
        assert again["created"] is False and prow(t, first["id"])["texts"]["en"] == "Mine"
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [first["id"]])["ok"]
        gone = create(t, op, rid(1))
        assert gone["created"] is False and gone["status"] == "rejected" and count_kind(t, "custom") == 1


def test_a_request_id_another_person_used_is_not_ours_to_hand_back(conn, sc, op):
    with tx(conn) as t:
        out = run(t, "insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) values (%s, 'custom', %s::jsonb, %s)",
                  [f"custom:{rid(9)}:telegram", json.dumps(TEXTS), f"owner:{ZERO_UUID}"])
        assert out.ok, out
        got = create(t, op, rid(9))
        assert got["ok"] is False and got["error"] == "key_reused", got
        assert count_kind(t, "custom") == 1 and audits(t, NEW_ACTION) == []


def test_two_sessions_with_one_request_id_make_one_post(conn, sc):
    """Committed on purpose: two sessions cannot see each other's rolled-back rows. The second waits for the first
    (it cannot slip a second row in) and then finds the first one's post."""
    op = sc.operator
    key = f"custom:{rid(77)}:telegram"
    a = b = None

    def as_admin(c):
        claims = op.claims()
        claims["aal"] = "aal1"
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
        c.execute("set local role authenticated")

    call = "select public.owner_marketing_create(%s, %s::jsonb, null)"
    try:
        a, b = second_connection(conn), second_connection(conn)
        as_admin(a)
        first = a.execute(call, [rid(77), json.dumps(TEXTS)]).fetchone()[0]   # uncommitted: holds the key
        assert first["created"] is True
        as_admin(b)
        b.execute("set local lock_timeout = '400ms'")
        with pytest.raises(psycopg.errors.LockNotAvailable):
            b.execute(call, [rid(77), json.dumps(TEXTS)])
        b.rollback()
        a.commit()
        as_admin(b)
        second = b.execute(call, [rid(77), json.dumps(TEXTS)]).fetchone()[0]
        b.commit()
        assert second["created"] is False and second["id"] == first["id"]
        with as_superuser(conn, commit=False) as s:
            assert s.value("select count(*) from public.marketing_posts where idempotency_key = %s", [key]) == 1
    finally:
        for x in (a, b):
            if x is not None:
                x.close()
        with as_superuser(conn) as s:
            s.run("set local session_replication_role = replica")
            s.run("delete from public.marketing_posts where idempotency_key = %s", [key])
            s.run("delete from public.app_audit_log where action = %s", [NEW_ACTION])
            s.run("delete from public.security_events where kind = %s", [NEW_ACTION])
            s.run("delete from public.web_rate_counters where bucket like 'owner:marketing_create%%'")


# ── what the owner function refuses ─────────────────────────────────────────

@pytest.mark.parametrize("kind", ["promo", "news", "price", "showcase", "Custom", "custom ", "", None])
def test_the_owner_function_makes_custom_posts_only(conn, sc, op, kind):
    with tx(conn) as t:
        out = create_raw(t, op, rid(), TEXTS, None, kind)
        assert out.ok and out.rows[0][0]["error"] == "bad_kind", out
        assert t.sup("select count(*) from public.marketing_posts where idempotency_key like 'custom:%%' or kind <> 'news'")[0][0] == 0
        assert audits(t, NEW_ACTION) == []


def test_the_owner_function_accepts_custom_spelled_out(conn, sc, op):
    with tx(conn) as t:
        out = create_raw(t, op, rid(), TEXTS, None, "custom")
        assert out.ok and out.rows[0][0]["ok"] is True and out.rows[0][0]["kind"] == "custom"


@pytest.mark.parametrize("request_id", [None, "", "short", "x" * 15, "a" * 65, "has space 1234567890", "colon:1234567890abcdef",
                                       "slash/1234567890abcdef", "../1234567890abcdef", "unicodé-1234567890abc", "line\n1234567890abcdef"])
def test_a_request_id_must_have_the_shape_of_a_key(conn, sc, op, request_id):
    with tx(conn) as t:
        out = create_raw(t, op, request_id, TEXTS)
        assert out.ok and out.rows[0][0]["error"] == "bad_request_id", out
        assert count_kind(t, "custom") == 0 and audits(t, NEW_ACTION) == []


@pytest.mark.parametrize("texts", [
    None, {"uz": "a", "ru": "b"}, {"uz": "a", "ru": "b", "en": "c", "fr": "d"}, {"uz": "a", "ru": "b", "xx": "c"},
    {"uz": "a", "ru": "b", "en": ""}, {"uz": "a", "ru": "b", "en": "   "}, {"uz": "a", "ru": "b", "en": 5},
    {"uz": "a", "ru": "b", "en": None}, {"uz": "a", "ru": "b", "en": ["c"]}, {"uz": "a" * 1001, "ru": "b", "en": "c"},
    {"uz": "a", "ru": "b", "en": "tab\there"}, {"uz": "a", "ru": "b", "en": "bell\x07"},
    ["a", "b", "c"], "text",
])
def test_the_texts_are_the_three_languages_and_nothing_else(conn, sc, op, texts):
    with tx(conn) as t:
        out = create_raw(t, op, rid(), texts)
        assert out.ok and out.rows[0][0]["error"] == "bad_texts", out
        assert count_kind(t, "custom") == 0 and audits(t, NEW_ACTION) == []


@pytest.mark.parametrize("ch", ["​", "‎", "‮", "⁦", " ", "﻿", "­", "\u0085", "\x7f", "⁠"])
def test_invisible_and_direction_changing_characters_are_refused_inside_a_text(conn, sc, op, ch):
    with tx(conn) as t:
        out = create_raw(t, op, rid(), {**TEXTS, "ru": f"Пример{ch}текста"})
        assert out.ok and out.rows[0][0]["error"] == "bad_texts", (repr(ch), out)
        assert count_kind(t, "custom") == 0


@pytest.mark.parametrize("link", ["https://evil.example/", "http://evil.example", "//evil.example", "/a//b", "/../x", "/a/../b",
                                  "pricing", "/UPPER", "/a b", "/", "/" + "a" * 80, "javascript:alert(1)", "/a?x=1", "/a#x"])
def test_a_link_is_a_path_on_our_own_site(conn, sc, op, link):
    with tx(conn) as t:
        out = create_raw(t, op, rid(), TEXTS, link)
        assert out.ok and out.rows[0][0]["error"] == "bad_link", (link, out)
        assert count_kind(t, "custom") == 0


@pytest.mark.parametrize("link", [None, "/pricing", "/studio/new-video", "/a1_b-2", "/" + "a" * 78])
def test_a_good_link_or_none_is_kept_as_typed(conn, sc, op, link):
    with tx(conn) as t:
        out = create(t, op, rid(), link=link)
        assert out["ok"] and prow(t, out["id"])["link"] == link


def test_the_texts_are_trimmed_like_a_draft_and_an_inner_new_line_survives(conn, sc, op):
    with tx(conn) as t:
        out = create(t, op, rid(), texts={"uz": "  uz\n", "ru": "\t ru ", "en": "\nline one\nline two\n "})
        assert out["ok"], out
        assert prow(t, out["id"])["texts"] == {"uz": "uz", "ru": "ru", "en": "line one\nline two"}


def test_the_caption_limits_of_a_draft_apply_and_the_whole_message_must_fit(conn, sc, op):
    with tx(conn) as t:
        assert create(t, op, rid(1), texts={k: "x" * 1000 for k in TEXTS})["ok"]          # 3160 of 4096
        # 0108's rule is on the table too: the same text with a video would not fit a 1024 caption
        assert t.sup("select public.marketing_texts_ok(%s::jsonb, true)", [json.dumps({k: "x" * 1000 for k in TEXTS})])[0][0] is False


# ── the second factor and the rate limit ────────────────────────────────────

def test_with_the_gate_on_a_password_only_session_is_refused_and_nothing_is_made(conn, sc, op):
    with tx(conn) as t:
        gate_on(t)
        factors(t, op, 2)
        out = create(t, op, rid(1))
        assert out["error"] == "mfa_required" and out["why"] == "aal1", out
        assert count_kind(t, "custom") == 0 and audits(t, NEW_ACTION) == []
        fresh = t.as_(op, extra={"amr": aal2(1)["amr"]}, aal="aal2").value(
            "select public.owner_marketing_create(%s, %s::jsonb, null)", [rid(1), json.dumps(TEXTS)])
        assert fresh["ok"] and fresh["created"] is True


def test_an_admin_with_no_authenticator_enrolled_is_never_locked_out_of_it(conn, sc, op):
    with tx(conn) as t:
        gate_on(t)
        assert create(t, op, rid(1))["ok"] is True


def test_creating_is_rate_limited_per_person_at_twenty(conn, sc, op):
    with tx(conn) as t:
        results = [create(t, op, rid(i)) for i in range(1, 22)]
        assert [r.get("error") for r in results[:20]] == [None] * 20
        assert results[20]["error"] == "rate_limited"
        assert count_kind(t, "custom") == 20


# ── a custom draft is never approved by being made ──────────────────────────

def test_a_new_custom_draft_is_not_sendable_and_goes_out_only_after_the_owner_approves_its_hash(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        out = create(t, op, rid(1))
        pid = out["id"]
        assert claim(t) == [], "a draft is not sendable, the poster being on notwithstanding"
        assert approve(t, op, pid, "f" * 64)["error"] == "content_changed"
        assert claim(t) == []
        ok = approve(t, op, pid, out["content_hash"])
        assert ok["ok"] and ok["already"] is False
        got = claim(t)
        assert [str(r[0]) for r in got] == [str(pid)] and got[0][1] == "custom" and got[0][2] == "telegram" and got[0][3] == TEXTS


def test_the_kill_switch_and_the_poster_off_rule_cover_the_new_kinds(conn, sc, op):
    with tx(conn) as t:
        a, b = make(t, op, "custom", 1), make(t, op, "promo", 2)
        assert approve(t, op, a)["error"] == "poster_off" and approve(t, op, b)["error"] == "poster_off"
        enable(t)
        assert approve(t, op, a)["ok"] and approve(t, op, b)["ok"]
        assert t.as_(op).value("select public.owner_marketing_kill(true, null)")["ok"]
        assert claim(t) == [], "the kill switch beats an approved custom or promo post"


# ── the weekly cap is shared by every kind ──────────────────────────────────

@pytest.mark.parametrize("first_two", [("custom", "promo"), ("custom", "news"), ("promo", "price"), ("custom", "custom"), ("news", "price")])
@pytest.mark.parametrize("third", ["custom", "promo", "news", "price"])
def test_news_price_promo_and_custom_share_the_two_posts_of_the_week(conn, sc, op, first_two, third):
    with tx(conn) as t:
        enable(t)
        ids = [make(t, op, kind, i) for i, kind in enumerate(first_two, 1)]
        late = make(t, op, third, 9)
        for pid in ids:
            assert approve(t, op, pid)["ok"], first_two
        refused = approve(t, op, late)
        assert refused["error"] == "cap_full" and refused["approved_waiting"] == 2 and refused["used_7d"] == 0, refused
        send(t)
        send(t)
        assert used(t) == 2 and t.as_(op).value("select public.owner_marketing_get()")["used_7d"] == 2
        again = approve(t, op, late)
        assert again["error"] == "cap_full" and again["used_7d"] == 2 and again["approved_waiting"] == 0, again
        # even an approval written past the owner function is never handed out in a full week
        raw(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), approved_hash = content_hash, "
               "expires_at = now() + interval '72 hours' where id = %s", [op.uid, late])
        assert status(t, late) == "approved" and claim(t) == []


def test_a_custom_or_promo_post_that_may_be_on_the_channel_keeps_its_slot(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        a, b = make(t, op, "custom", 1), make(t, op, "promo", 2)
        assert approve(t, op, a)["ok"] and approve(t, op, b)["ok"]
        first = claim(t, "worker-1", 30)
        assert len(first) == 1
        lost = first[0][0]
        run(t, "update public.marketing_posts set claimed_until = now() - interval '1 second' where id = %s", [lost])
        second = claim(t, "worker-2")
        assert len(second) == 1 and second[0][0] != lost
        assert status(t, lost) == "dead" and complete(t, lost, "worker-1", "sent") is False
        assert complete(t, second[0][0], "worker-2", "sent", mid="1") is True
        assert used(t) == 2 and claim(t) == []


# ── the new kinds follow the same life as news ──────────────────────────────

@pytest.mark.parametrize("kind", ["custom", "promo"])
def test_a_new_kind_goes_draft_approved_sending_sent_and_is_then_frozen(conn, sc, op, kind):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, kind)
        assert approve(t, op, pid)["ok"]
        got = claim(t)
        assert [str(r[0]) for r in got] == [str(pid)] and got[0][1] == kind
        assert complete(t, pid, "worker-1", "sent", mid="4242") is True
        assert status(t, pid) == "sent"
        sent = audits(t, "marketing.send")
        assert len(sent) == 1 and sent[0][4]["kind"] == kind and sent[0][4]["target"] == "telegram"
        for stmt in ("update public.marketing_posts set status = 'draft', approved_hash = null, approved_by = null, "
                     "approved_at = null, expires_at = null, claimed_by = null, claimed_at = null, claimed_until = null, sent_at = null",
                     "update public.marketing_posts set texts = texts", "update public.marketing_posts set link = '/x'"):
            out = run(t, stmt + " where id = %s", [pid])
            assert not out.ok and out.sqlstate == "23514", (kind, stmt, out)
        assert run(t, "delete from public.marketing_posts where id = %s", [pid]).sqlstate == "42501"


@pytest.mark.parametrize("kind", ["custom", "promo"])
def test_illegal_moves_are_refused_for_the_new_kinds_too(conn, sc, op, kind):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, kind)
        for target in ("sending", "sent", "failed", "dead"):
            out = run(t, "update public.marketing_posts set status = %s where id = %s", [target, pid])
            assert not out.ok and out.sqlstate == "23514", (target, out)
        assert run(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
                      "expires_at = now() + interval '72 hours', approved_hash = %s where id = %s",
                   [op.uid, "a" * 64, pid]).sqlstate == "23514"      # a forged approval: the hash is not the content's
        assert run(t, "update public.marketing_posts set kind = 'news' where id = %s", [pid]).sqlstate == "23514"
        assert run(t, "update public.marketing_posts set source_ref = 'pr:#1' where id = %s", [pid]).sqlstate == "23514"
        assert status(t, pid) == "draft"


@pytest.mark.parametrize("kind", ["custom", "promo"])
def test_an_edit_after_approval_voids_it_and_the_old_hash_cannot_be_approved(conn, sc, op, kind):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, kind)
        old = chash(t, pid)
        assert approve(t, op, pid)["ok"]
        out = t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "en": "Edited words"})])
        assert out["ok"] and out["status"] == "draft" and out["approval_voided"] is True, out
        r = prow(t, pid)
        assert r["status"] == "draft" and r["approved_hash"] is None and r["edited_at"] is not None
        assert claim(t) == []
        assert approve(t, op, pid, old)["error"] == "content_changed"
        assert approve(t, op, pid)["ok"]
        assert [str(x[0]) for x in claim(t)] == [str(pid)]


@pytest.mark.parametrize("kind", ["custom", "promo"])
def test_a_bare_write_under_an_approval_voids_it_and_a_tampered_hash_is_not_sent(conn, sc, op, kind):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, kind)
        assert approve(t, op, pid)["ok"]
        assert run(t, "update public.marketing_posts set link = '/pricing' where id = %s", [pid]).ok
        assert status(t, pid) == "draft" and prow(t, pid)["approved_hash"] is None
        assert approve(t, op, pid)["ok"]
        raw(t, "update public.marketing_posts set texts = jsonb_set(texts, '{en}', '\"Sneaky\"') where id = %s", [pid])
        assert status(t, pid) == "approved" and claim(t) == [], "the approved hash no longer matches the words as they stand"


def test_the_kind_is_part_of_the_hash_so_the_same_words_never_share_one(conn, sc, op):
    with tx(conn) as t:
        c, p, n = make(t, op, "custom", 1), make(t, op, "promo", 2), draft(t, "news:same-words", pr=5)
        assert len({chash(t, c), chash(t, p), chash(t, n)}) == 3


def test_edit_reject_and_the_audit_work_on_the_new_kinds(conn, sc, op):
    with tx(conn) as t:
        c, p = make(t, op, "custom", 1), make(t, op, "promo", 2)
        for pid in (c, p):
            assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "uz": "Yangi matn"})])["ok"]
            assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [pid])["ok"]
            assert status(t, pid) == "rejected"
        assert sorted(a[4]["kind"] for a in audits(t, "marketing.edit")) == ["custom", "promo"]
        assert sorted(a[4]["kind"] for a in audits(t, "marketing.reject")) == ["custom", "promo"]


def test_an_approval_lasts_72_hours_for_the_new_kinds_too(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, "custom")
        assert approve(t, op, pid)["ok"]
        raw(t, "update public.marketing_posts set expires_at = now() - interval '1 second' where id = %s", [pid])
        assert claim(t) == [] and status(t, pid) == "expired"


# ── the worker's v2 ─────────────────────────────────────────────────────────

def test_v2_drafts_a_promo_once_and_returns_it_again(conn, sc):
    with tx(conn) as t:
        first = promo(t, "welcome", link="/studio")
        second = promo(t, "welcome", link="/studio")
        assert first["ok"] and (first["created"], second["created"], second["updated"]) == (True, False, False)
        assert first["id"] == second["id"] and first["status"] == "draft"
        r = prow(t, first["id"])
        assert (r["kind"], r["target"], r["idempotency_key"], r["source_ref"]) == ("promo", "telegram", "promo:welcome:telegram", "promo:welcome")
        assert r["texts"] == TEXTS and r["link"] == "/studio" and r["approved_hash"] is None and r["edited_at"] is None
        assert count_kind(t, "promo") == 1


def test_a_promo_draft_follows_its_file_until_a_person_edits_it_and_never_after_that(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        first = promo(t, "follow")
        newer = promo(t, "follow", texts={**TEXTS, "en": "Better"})
        assert newer["updated"] is True and prow(t, first["id"])["texts"]["en"] == "Better"
        owner_words = {**TEXTS, "en": "The owner's own words"}
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [first["id"], json.dumps(owner_words)])["ok"]
        for file_text in (TEXTS, {**TEXTS, "en": "A newer file text"}):
            out = promo(t, "follow", texts=file_text)
            assert out["created"] is False and out["updated"] is False and out["owner_edited"] is True, out
            assert prow(t, first["id"])["texts"] == owner_words


def test_an_approved_promo_edited_back_to_draft_keeps_the_owners_words_and_a_decided_one_is_not_touched(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, "promo", 1)
        assert approve(t, op, pid)["ok"]
        owner_words = {**TEXTS, "ru": "Слова владельца"}
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps(owner_words)])["approval_voided"] is True
        out = promo(t, "slug-1", texts={**TEXTS, "ru": "Текст файла"})
        assert out["updated"] is False and out["owner_edited"] is True and prow(t, pid)["texts"] == owner_words
        # approved and untouched by an edit: the file may change, the approved words stay
        other = make(t, op, "promo", 2)
        assert approve(t, op, other)["ok"]
        out = promo(t, "slug-2", texts={**TEXTS, "en": "Worse"})
        assert out["updated"] is False and out["status"] == "approved" and prow(t, other)["texts"] == TEXTS
        # a rejected promo is not offered again
        gone = make(t, op, "promo", 3)
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [gone])["ok"]
        again = promo(t, "slug-3")
        assert again["created"] is False and again["status"] == "rejected"


@pytest.mark.parametrize("kind", ["custom", "showcase", "other", "Promo", "", None])
def test_v2_takes_news_price_and_promo_only(conn, sc, kind):
    with tx(conn) as t:
        out = t.as_(SERVICE).value("select public.marketing_draft_upsert_v2('custom:abcdefghijklmnop:telegram', %s, %s::jsonb, %s)",
                                   [kind, json.dumps(TEXTS), f"owner:{ZERO_UUID}"])
        assert out["ok"] is False and out["error"] == "bad_kind", out
        assert count_kind(t, "custom") == 0


@pytest.mark.parametrize("key,source,target,error", [
    ("promo:welcome:telegram", "promo:welcome", "instagram", "bad_target"),
    ("promo:welcome:telegram", "promo:welcome", None, "bad_target"),
    ("promo:welcome:telegram", "promo:Welcome", "telegram", "bad_source"),
    ("promo:welcome:telegram", "promo:bad slug", "telegram", "bad_source"),
    ("promo:welcome:telegram", "promo:" + "a" * 61, "telegram", "bad_source"),
    ("promo:welcome:telegram", "promo:", "telegram", "bad_source"),
    ("promo:welcome:telegram", "pr:#1", "telegram", "bad_source"),
    ("promo:welcome:telegram", None, "telegram", "bad_source"),
    ("promo:welcome", "promo:welcome", "telegram", "bad_key"),
    ("promo:welcome:instagram", "promo:welcome", "telegram", "bad_key"),
    ("promo:other:telegram", "promo:welcome", "telegram", "bad_key"),
    ("news:welcome:telegram", "promo:welcome", "telegram", "bad_key"),
    ("promo:welcome:telegram:x", "promo:welcome", "telegram", "bad_key"),
    (None, "promo:welcome", "telegram", "bad_key"),
])
def test_v2_refuses_a_promo_key_or_source_of_the_wrong_shape(conn, sc, key, source, target, error):
    with tx(conn) as t:
        out = t.as_(SERVICE).value("select public.marketing_draft_upsert_v2(%s, 'promo', %s::jsonb, %s, '{}'::jsonb, null, null, %s)",
                                   [key, json.dumps(TEXTS), source, target])
        assert out["ok"] is False and out["error"] == error, out
        assert count_kind(t, "promo") == 0


@pytest.mark.parametrize("args,error", [
    ({"texts": {"uz": "a", "ru": "b"}}, "bad_texts"),
    ({"texts": {**TEXTS, "fr": "d"}}, "bad_texts"),
    ({"texts": {**TEXTS, "en": ""}}, "bad_texts"),
    ({"texts": {**TEXTS, "en": "x" * 1001}}, "bad_texts"),
    ({"texts": {**TEXTS, "en": "zero​width"}}, "bad_texts"),
    ({"texts": {**TEXTS, "en": "bidi‮override"}}, "bad_texts"),
    ({"texts": {k: "x" * 400 for k in TEXTS}, "media": "showcase/a.mp4"}, "bad_texts"),    # a caption is 1024
    ({"media": "previews/private.mp4"}, "bad_media"),
    ({"media": "showcase/../previews/x.mp4"}, "bad_media"),
    ({"link": "https://evil.example/"}, "bad_link"),
    ({"link": "//evil.example"}, "bad_link"),
    ({"facts": "[]"}, "bad_facts"),
    ({"facts": '"text"'}, "bad_facts"),
    ({"facts": json.dumps({"x": "y" * 9000})}, "bad_facts"),
])
def test_v2_validates_a_promo_like_a_draft(conn, sc, args, error):
    with tx(conn) as t:
        out = t.as_(SERVICE).value(
            "select public.marketing_draft_upsert_v2('promo:val-1:telegram', 'promo', %s::jsonb, 'promo:val-1', %s::jsonb, null, %s, 'telegram', %s)",
            [json.dumps(args.get("texts", TEXTS)), args.get("facts", "{}"), args.get("media"), args.get("link")])
        assert out["ok"] is False and out["error"] == error, out
        assert count_kind(t, "promo") == 0


def test_a_promo_may_carry_a_video_from_the_public_bucket_with_a_caption_sized_text(conn, sc):
    with tx(conn) as t:
        out = promo(t, "with-video", texts={k: "x" * 200 for k in TEXTS}, media="showcase/promo/clip.mp4")
        assert out["ok"] and prow(t, out["id"])["media_path"] == "showcase/promo/clip.mp4"


def test_v2_hands_news_and_price_to_the_0108_function_and_the_two_agree(conn, sc):
    with tx(conn) as t:
        s = t.as_(SERVICE)
        a = s.value("select public.marketing_draft_upsert_v2('news:via-v2', 'news', %s::jsonb, 'pr:#5')", [json.dumps(TEXTS)])
        b = s.value("select public.marketing_draft_upsert('news:via-v2', 'news', %s::jsonb, 'pr:#5')", [json.dumps(TEXTS)])
        assert a["created"] is True and b["created"] is False and a["id"] == b["id"]
        changed = s.value("select public.marketing_draft_upsert_v2('news:via-v2', 'news', %s::jsonb, 'pr:#5')", [json.dumps({**TEXTS, "en": "Better"})])
        assert changed["updated"] is True
        # price keeps its rule: no time its facts were read, no post
        assert s.value("select public.marketing_draft_upsert_v2('price:via-v2', 'price', %s::jsonb, 'plan:plus')", [json.dumps(TEXTS)])["error"] == "facts_as_of_required"
        ok = s.value("select public.marketing_draft_upsert_v2('price:via-v2', 'price', %s::jsonb, 'plan:plus', '{}'::jsonb, now())", [json.dumps(TEXTS)])
        assert ok["created"] is True
        # a key of the wrong kind is refused by the 0108 rules, not waved through
        assert s.value("select public.marketing_draft_upsert_v2('promo:x-1:telegram', 'news', %s::jsonb, 'pr:#5')", [json.dumps(TEXTS)])["error"] == "bad_key"


def test_the_0108_function_still_refuses_the_new_kinds_and_a_promo_key_cannot_be_borrowed(conn, sc):
    with tx(conn) as t:
        s = t.as_(SERVICE)
        for kind, key, src in (("promo", "promo:welcome:telegram", "promo:welcome"), ("custom", f"custom:{rid()}:telegram", f"owner:{ZERO_UUID}")):
            out = s.value("select public.marketing_draft_upsert(%s, %s, %s::jsonb, %s)", [key, kind, json.dumps(TEXTS), src])
            assert out["ok"] is False and out["error"] == "bad_kind", (kind, out)
        promo(t, "welcome")
        out = s.value("select public.marketing_draft_upsert('promo:welcome:telegram', 'news', %s::jsonb, 'pr:#1')", [json.dumps(TEXTS)])
        assert out["ok"] is False, out
        assert count_kind(t, "news") == 1 and count_kind(t, "promo") == 1  # the seed's news and the promo


# ── the table's checks hold for a direct write ──────────────────────────────

GOOD_CUSTOM = (f"custom:{rid()}:telegram", "custom", f"owner:{ZERO_UUID}")


@pytest.mark.parametrize("values", [("promo:welcome:telegram", "promo", "promo:welcome"), GOOD_CUSTOM,
                                    ("promo:a:telegram", "promo", "promo:a"), ("promo:" + "a" * 60 + ":telegram", "promo", "promo:" + "a" * 60)])
def test_the_two_new_kinds_can_be_written_in_their_own_shape(conn, values):
    with tx(conn) as t:
        out = run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values (%s, %s, %s, %s::jsonb)",
                  [*values, json.dumps(TEXTS)])
        assert out.ok, out


@pytest.mark.parametrize("values,why", [
    (("promo:other:telegram", "promo", "promo:welcome"), "a promo key is its own source and target"),
    (("promo:welcome", "promo", "promo:welcome"), "a promo key names its target"),
    (("promo:Welcome:telegram", "promo", "promo:Welcome"), "upper case slug"),
    (("promo:" + "a" * 61 + ":telegram", "promo", "promo:" + "a" * 61), "slug of 61"),
    (("promo:welcome:telegram", "promo", "pr:#1"), "promo with a news source"),
    (("promo:welcome:telegram", "news", "promo:welcome"), "news with a promo source"),
    (("custom:" + "a" * 15 + ":telegram", "custom", f"owner:{ZERO_UUID}"), "request id of 15"),
    (("custom:" + "a" * 65 + ":telegram", "custom", f"owner:{ZERO_UUID}"), "request id of 65"),
    ((f"custom:{rid()}", "custom", f"owner:{ZERO_UUID}"), "a custom key names its target"),
    ((f"custom:{rid()}:telegram", "custom", "pr:#1"), "custom with a news source"),
    ((f"custom:{rid()}:telegram", "custom", "owner:not-a-user-id"), "custom with no user in the source"),
    ((f"custom:{rid()}:telegram", "custom", "promo:welcome"), "custom with a promo source"),
    ((f"custom:{rid()}.x:telegram", "custom", f"owner:{ZERO_UUID}"), "a dot is not in a request id"),
    ((f"promo:{rid()}:telegram", "custom", f"owner:{ZERO_UUID}"), "a key starts with its own kind"),
    (("campaign:x1", "campaign", "pr:#1"), "an unknown kind"),
])
def test_the_table_refuses_a_new_kind_in_the_wrong_shape(conn, values, why):
    with tx(conn) as t:
        out = run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values (%s, %s, %s, %s::jsonb)",
                  [*values, json.dumps(TEXTS)])
        assert out.sqlstate == "23514", (why, out)


def test_the_new_kinds_still_cannot_go_to_another_target_and_a_promo_is_not_a_showcase(conn):
    with tx(conn) as t:
        assert run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts, target) values "
                      "('promo:welcome:telegram', 'promo', 'promo:welcome', %s::jsonb, 'instagram')", [json.dumps(TEXTS)]).sqlstate == "23514"
        assert run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts, media_path) values "
                      "('promo:welcome:telegram', 'promo', 'promo:welcome', %s::jsonb, 'previews/x.mp4')", [json.dumps(TEXTS)]).sqlstate == "23514"
        assert run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values "
                      "('showcase:00000000-0000-0000-0000-000000000001', 'showcase', 'asset:00000000-0000-0000-0000-000000000001', %s::jsonb)",
                   [json.dumps(TEXTS)]).sqlstate == "23514"   # a showcase still needs its video


def test_the_new_kinds_cannot_be_written_by_any_api_role(conn, sc, op):
    with tx(conn) as t:
        for who in (op, sc.bob.actor, SERVICE):
            out = t.as_(who).run("insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values "
                                 "('promo:welcome:telegram', 'promo', 'promo:welcome', %s::jsonb)", [json.dumps(TEXTS)])
            assert not out.ok and out.sqlstate == "42501", (getattr(who, "name", who), out)
        anon = t.anon().run("insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values "
                            "('promo:welcome:telegram', 'promo', 'promo:welcome', %s::jsonb)", [json.dumps(TEXTS)])
        assert anon.sqlstate == "42501"


# ── the rest of the system is as 0108 and 0109 made it ──────────────────────

def _bodies(text):
    out = {}
    for name in UNCHANGED_0108:
        m = re.search(rf"create or replace function public\.{name}\(.*?\bas \$\$(.*?)\n\$\$;", text, re.S)
        assert m, name
        out[name] = m.group(1).strip()
    return out


def test_the_functions_the_live_worker_and_page_call_are_byte_for_byte_what_0108_made(conn):
    want = _bodies(PREVIOUS.read_text(encoding="utf-8"))
    with as_superuser(conn, commit=False) as s:
        for name, body in want.items():
            rows = s.rows("select p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = %s", [name])
            assert len(rows) == 1, (name, "no overload may appear beside it")
            assert rows[0][0].strip() == body, name
        # the 9-argument signature the worker calls by name is still the only marketing_draft_upsert
        assert s.value("select count(*) from pg_proc where proname = 'marketing_draft_upsert' and pronamespace = 'public'::regnamespace") == 1
        assert s.value("select to_regprocedure(%s) is not null", [V1_SIG]) is True


def test_the_cap_is_still_the_one_no_argument_function_counting_every_kind(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from pg_proc where proname = 'marketing_cap_used' and pronamespace = 'public'::regnamespace") == 1
        src = s.value("select prosrc from pg_proc where proname = 'marketing_cap_used' and pronamespace = 'public'::regnamespace")
        assert "kind" not in src and "target" not in src, "the count must not filter by kind"


def test_the_operator_summary_still_answers_with_the_new_kinds_in_it(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = make(t, op, "custom")
        assert approve(t, op, pid)["ok"]
        send(t, pid)
        out = t.as_(SERVICE).value("select public.operator_marketing_summary()")
        assert out["ok"] is True and out["last_sent_kind"] == "custom" and out["used_7d"] == 1
        assert out["counts"]["sent"] == 1 and len(out["counts"]) == 8
        assert "Namuna" not in json.dumps(out, ensure_ascii=False)


def test_a_customer_cannot_forge_the_new_audit_action(conn, sc):
    with tx(conn) as t:
        out = t.as_(sc.bob.actor).run("insert into public.app_audit_log (actor_user_id, action, channel_id) values (%s, %s, null)",
                                      [sc.bob.actor.uid, NEW_ACTION])
        assert not out.ok and out.sqlstate == "42501", out


# ── the audit list ──────────────────────────────────────────────────────────

def test_the_audit_list_is_0108s_verbatim_plus_exactly_marketing_create(conn):
    old, new = _list(PREVIOUS.read_text(encoding="utf-8")), _list(MIGRATION.read_text(encoding="utf-8"))
    assert old <= new, sorted(old - new)
    assert new - old == {NEW_ACTION}
    assert len(old) >= 78
    with as_superuser(conn, commit=False) as s:
        for a in sorted(new) + ["social.instagram.connect", "social.tiktok.disconnect", "learning.approve", "learning.reject"]:
            assert s.value("select public.audit_action_allowed(%s)", [a]) is True, a
        for a in ("marketing.creat", "marketing.create ", "Marketing.create", "marketing.steal", "marketing", "marketing.update",
                  "marketing.posted", "showcase.delete", "", None, "social.youtube.connect"):
            assert s.value("select public.audit_action_allowed(%s)", [a]) is False, a


def test_the_regex_families_of_the_audit_list_are_kept(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    assert r"'^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'" in text
    assert r"'^learning\.(approve|reject)$'" in text


# ── replay and rollback ─────────────────────────────────────────────────────

def test_the_migration_replays_without_changing_state(conn, sc, op):
    text = MIGRATION.read_text(encoding="utf-8")
    with tx(conn) as t:
        enable(t)
        c, p = make(t, op, "custom", 1), make(t, op, "promo", 2)
        assert approve(t, op, c)["ok"]
        before = t.sup("select id, kind, status, idempotency_key, content_hash from public.marketing_posts order by id")
        t.conn.execute("reset role")
        t.conn.execute(text)
        assert t.sup("select id, kind, status, idempotency_key, content_hash from public.marketing_posts order by id") == before
        assert t.sup("select enabled from public.marketing_settings")[0][0] is True    # the file never touches the switch
        for sig, want in ((CREATE_SIG, [False, True, False]), (V2_SIG, [False, False, True])):
            assert [t.sup("select has_function_privilege(%s, %s, 'EXECUTE')", [r, sig])[0][0]
                    for r in ("anon", "authenticated", "service_role")] == want, sig
        assert t.sup("select public.audit_action_allowed(%s)", [NEW_ACTION])[0][0] is True
        # the guards still hold afterwards
        assert run(t, "update public.marketing_posts set status = 'sent' where id = %s", [c]).sqlstate == "23514"
        assert create(t, op, rid(1))["created"] is False
        assert promo(t, "slug-2")["created"] is False and t.as_(op).value("select public.owner_marketing_get()")["ok"] is True


def _body(rollback):
    return "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_rollback_file_restores_0108s_audit_list_and_is_one_transaction():
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert _list(rollback) == _list(PREVIOUS.read_text(encoding="utf-8"))
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    for sig in ("owner_marketing_create(text, jsonb, text, text)",
                "marketing_draft_upsert_v2(text, text, jsonb, text, jsonb, timestamptz, text, text, text)"):
        assert f"drop function if exists public.{sig};" in rollback


def test_the_rollback_removes_exactly_the_two_functions_and_narrows_the_checks_and_the_migration_comes_back(conn, sc, op):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    with tx(conn) as t:
        before_fn = {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")}
        t.conn.execute(_body(rollback))
        after_fn = {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")}
        assert before_fn - after_fn == NEW_FUNCTIONS and after_fn <= before_fn
        assert t.sup("select to_regprocedure(%s) is not null", [V1_SIG])[0][0] is True
        assert t.sup("select public.audit_action_allowed(%s), public.audit_action_allowed('marketing.approve'), "
                     "public.audit_action_allowed('credits.grant'), public.audit_action_allowed('mcp.limit')", [NEW_ACTION])[0] == (False, True, True, True)
        # 0108's checks are back: a promo or a custom row is refused again, news is not
        assert run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values "
                      "('promo:welcome:telegram', 'promo', 'promo:welcome', %s::jsonb)", [json.dumps(TEXTS)]).sqlstate == "23514"
        assert run(t, "insert into public.marketing_posts (idempotency_key, kind, source_ref, texts) values "
                      "('news:after-rollback', 'news', 'pr:#1', %s::jsonb)", [json.dumps(TEXTS)]).ok
        assert t.sup("select count(*) from pg_constraint where conrelid = 'public.marketing_posts'::regclass "
                     "and conname = 'marketing_posts_key_shape_check'")[0][0] == 0
        # the worker and the owner page still work on 0108 alone
        enable(t)
        pid = draft(t, "news:rb-1")
        assert approve(t, op, pid)["ok"] and [str(r[0]) for r in claim(t)] == [str(pid)]
        # and applying the migration again restores everything
        t.conn.execute("reset role")
        t.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")} == before_fn
        assert t.sup("select public.audit_action_allowed(%s)", [NEW_ACTION])[0][0] is True
        assert promo(t, "again")["created"] is True and create(t, op, rid(5))["created"] is True


def test_a_rollback_with_a_promo_or_custom_row_keeps_the_wide_checks_because_a_post_is_never_deleted(conn, sc, op):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    with tx(conn) as t:
        c, p = make(t, op, "custom", 1), make(t, op, "promo", 2)
        t.conn.execute("reset role")
        t.conn.execute(_body(rollback))                      # a NOTICE, not an error
        assert t.sup("select count(*) from public.marketing_posts where id in (%s, %s)", [c, p])[0][0] == 2
        assert {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")} & NEW_FUNCTIONS == set()
        assert t.sup("select pg_get_constraintdef(oid) like '%%promo%%' from pg_constraint where conrelid = 'public.marketing_posts'::regclass "
                     "and conname = 'marketing_posts_kind_check'")[0][0] is True
        assert t.sup("select public.audit_action_allowed(%s)", [NEW_ACTION])[0][0] is False
        # the rows are still posts: they can be rejected and finish their life
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [c])["ok"]
        t.conn.execute("reset role")
        t.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert create(t, op, rid(1))["created"] is False and create(t, op, rid(1))["status"] == "rejected"
