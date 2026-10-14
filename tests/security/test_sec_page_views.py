"""Migration 0103: first-party, cookieless page counts for the public site.

The table holds daily totals and no row describes a person, so the attacks are
on what an anonymous caller can DO with the one function it may call, and on
what the table could be made to hold. What would break without each:

* the table being read or written directly by any API role (isolation of the
  table is also covered row by row by test_sec_isolation.py);
* a path outside the public marketing pages (an app page, /api, an arbitrary
  string) being stored, which would let anyone fill the table with their own text;
* a malformed referring host being stored as given (a path, a query, a script);
* the table growing without bound through invented referring hosts or language codes;
* the platform-wide ceiling not holding, so the function becomes a way to hammer
  the database;
* a refusal answering with an error (SQL text) that tells a prober which rule
  they hit;
* the closed path list being callable, or the function losing its pinned search_path.
"""

from __future__ import annotations

import json

import pytest

from sec_db import ANON, as_superuser, user

SC = None


@pytest.fixture(autouse=True)
def _scenario(sc):
    global SC
    SC = sc


def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def call(s, actor, query, params=None):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    out = s.run(query, params)
    as_owner(s)
    return out


def record(s, actor, path="/pricing", ref="", device="desktop", lang="en"):
    return call(s, actor, "select public.record_page_view(%s, %s, %s, %s)", [path, ref, device, lang])


def total(s, where="true", params=None):
    as_owner(s)
    return s.value(f"select coalesce(sum(views), 0) from public.site_page_views where {where}", params)


def reset_ceiling(s):
    as_owner(s)
    s.rows("delete from public.web_rate_counters where bucket = 'pageview.anon@60' returning 1")


@pytest.fixture
def world(conn):
    with as_superuser(conn, commit=False) as s:
        reset_ceiling(s)
        s.rows("delete from public.site_page_views returning 1")
        yield s


PUBLIC_PAGES = [
    "/", "/studio", "/pricing", "/solutions", "/solutions/youtube-channels", "/solutions/creative-studio",
    "/solutions/developers", "/docs/api", "/mcp", "/privacy", "/terms",
]


@pytest.mark.parametrize("path", PUBLIC_PAGES)
def test_anon_counts_a_public_page_and_the_same_view_adds_up(world, path):
    assert record(world, ANON, path).ok
    assert record(world, ANON, path).ok
    assert total(world, "path = %s", [path]) == 2


def test_a_signed_in_person_is_counted_the_same_and_is_not_recorded(world):
    who = user("reader", "reader@lab.test")
    assert record(world, who).ok
    as_owner(world)
    cols = [r[0] for r in world.rows("select column_name from information_schema.columns where table_name = 'site_page_views'")]
    assert sorted(cols) == ["day", "device", "lang", "path", "ref_host", "views"]  # nothing that could hold a person


@pytest.mark.parametrize(
    "path",
    ["/login", "/signup", "/api/v1/models", "/api/pv", "/chronos/videos", "/all-channels", "/pricing/", "/Pricing", "/pricing?x=1",
     "/pricing#a", "/docs/cli", "/docs/skills", "/atelier/a", "", "x", "/" + "a" * 200, "<script>alert(1)</script>"],
)
def test_a_path_outside_the_public_pages_is_not_stored_and_does_not_error(world, path):
    out = record(world, ANON, path)
    assert out.ok, out  # no SQL text for a prober
    assert total(world) == 0


def test_null_arguments_are_ignored_quietly(world):
    for args in ([None, "", "desktop", "en"], ["/", None, None, "en"], ["/", "", "desktop", None]):
        assert call(world, ANON, "select public.record_page_view(%s, %s, %s, %s)", args).ok
    assert total(world) == 0


@pytest.mark.parametrize("device,lang", [("tablet", "en"), ("", "en"), ("desktop", "english"), ("desktop", "EN"), ("Mobile", "en"), ("desktop", ""), ("desktop", "e1"), ("desktop", "en-US"), ("desktop", "<b>")])
def test_device_is_a_closed_list_and_language_a_short_lowercase_code(world, device, lang):
    assert record(world, ANON, "/", "", device, lang).ok
    assert total(world) == 0


@pytest.mark.parametrize(
    "ref",
    ["https://evil.example/path?q=1", "evil.example/path", "a b", "evil.example:8080", "-bad.example", "x" * 120,
     "<script>", "evil.example?x=1", "evil.example#f", "ev il.example"],
)
def test_a_referrer_that_is_not_a_plain_host_is_read_as_direct_never_stored_as_given(world, ref):
    assert record(world, ANON, "/", ref).ok
    as_owner(world)
    assert world.value("select count(*) from public.site_page_views where ref_host = %s", [ref]) == 0
    assert total(world, "ref_host = ''") == 1


def test_a_host_is_lowercased_and_kept_by_name(world):
    assert record(world, ANON, "/", "News.Example.COM").ok
    assert total(world, "ref_host = 'news.example.com'") == 1


def test_the_table_refuses_anything_the_function_would(world):
    as_owner(world)
    for cols in (
        "('/login', '', 'desktop', 'en')",
        "('/', 'a b', 'desktop', 'en')",
        "('/', '', 'tablet', 'en')",
        "('/', '', 'desktop', 'DE')",
        "('/', '', 'desktop', 'english')",
    ):
        out = world.run(f"insert into public.site_page_views (path, ref_host, device, lang, day) select v.*, current_date from (values {cols}) v(a,b,c,d)")
        assert not out.ok and out.sqlstate in ("23514", "42703", "42804"), (cols, out)
    out = world.run("insert into public.site_page_views (day, path, device, lang, views) values (current_date, '/', 'desktop', 'en', -1)")
    assert not out.ok and out.sqlstate == "23514", out


def test_the_table_is_closed_to_every_api_role(world):
    who = user("reader", "reader@lab.test")
    for actor in (ANON, who):
        for q in (
            "select * from public.site_page_views",
            "insert into public.site_page_views (day, path, device, lang, views) values (current_date, '/', 'desktop', 'en', 1)",
            "update public.site_page_views set views = 0",
            "delete from public.site_page_views",
        ):
            out = call(world, actor, q)
            assert not out.ok and out.sqlstate == "42501", (actor.name, q, out)


def test_the_closed_path_list_is_not_callable_through_the_api(world):
    who = user("reader", "reader@lab.test")
    for actor in (ANON, who):
        out = call(world, actor, "select public.site_page_path_ok('/')")
        assert not out.ok and out.sqlstate == "42501", (actor.name, out)


def test_the_platform_wide_ceiling_holds_at_600_a_minute(world):
    for _ in range(605):
        assert record(world, ANON, "/").ok
    assert total(world) == 600


def test_invented_referring_hosts_stop_growing_the_table_at_the_row_cap(world):
    as_owner(world)
    # Fill today to the cap with distinct hosts, written by the owner as the function would.
    world.rows(
        "insert into public.site_page_views (day, path, ref_host, device, lang, views) "
        "select (now() at time zone 'utc')::date, '/', 'h' || g || '.example', 'desktop', 'en', 1 "
        "from generate_series(1, 3000) g returning 1"
    )
    assert record(world, ANON, "/", "brand-new.example").ok
    assert record(world, ANON, "/", "", "desktop", "zz").ok  # an invented language code is folded the same way
    as_owner(world)
    assert world.value("select count(*) from public.site_page_views where ref_host = 'brand-new.example' or lang = 'zz'") == 0
    assert total(world, "ref_host = 'other' and lang = 'xx'") == 1
    assert total(world, "ref_host = '' and lang = 'xx'") == 1
    # an already-known host keeps counting under its own name
    assert record(world, ANON, "/", "h5.example").ok
    assert total(world, "ref_host = 'h5.example'") == 2


def test_days_are_utc_dates_and_separate_rows(world):
    assert record(world, ANON, "/").ok
    as_owner(world)
    assert world.value("select count(distinct day) from public.site_page_views") == 1
    assert world.value("select day = (now() at time zone 'utc')::date from public.site_page_views limit 1") is True
