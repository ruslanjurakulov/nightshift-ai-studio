"""0199: channel research. What would break without these, proven against a real Postgres:

* another organization (or a stranger) reading a channel's research, or telling a channel it cannot see from one that does not exist;
* anon or a signed-in member reaching a worker function (claim, store, purge, the research quota);
* a member writing a cache or the queue directly instead of through the functions (rule 3: the browser writes a row and stops);
* a duplicate press queueing a second request (two spends), or a fourth topic search in one Pacific day;
* a row older than 30 days being shown (YouTube's limit on non-authorized data), or surviving the purge;
* a hidden subscriber count stored as a number, or a comment's words returned under any key but untrusted_*;
* the research quota spending publish-when-approved's ceiling, or the other way round.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import psycopg
import pytest

from sec_db import ANON, SERVICE, acting, as_superuser

COMP = "UCabcdefghijklmnopqrstuv"   # 24 characters: UC + 22
COMP2 = "UCzyxwvutsrqponmlkjihgfe"
VIDEO = "dQw4w9WgXcQ"


@contextmanager
def scratch(conn):
    """One transaction, rolled back at the end, in which several callers act in turn (each step in its own savepoint)."""
    with conn.transaction(force_rollback=True):
        yield Steps(conn)


class Steps:
    def __init__(self, conn):
        self.conn = conn

    def call(self, who, query, params=None):
        """(ok, value_or_sqlstate) for one statement as `who`; the role and claims end with the statement."""
        try:
            with self.conn.transaction():
                self.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
                self.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
                self.conn.execute(f"set local role {who.role}")
                cur = self.conn.execute(query, params)
                row = cur.fetchone() if cur.description else None
                self.conn.execute("reset role")
                self.conn.execute("select set_config('request.jwt.claims', '', true)")
                return True, (row[0] if row else None)
        except psycopg.Error as e:
            return False, e.sqlstate

    def owner(self, query, params=None):
        cur = self.conn.execute(query, params)
        return cur.fetchone()[0] if cur.description else None


def ok(result):
    assert result[0], f"refused: {result[1]}"
    return result[1]


def test_a_member_reads_and_others_get_the_missing_answer(conn, sc):
    alice, bob = sc.alice, sc.bob
    with scratch(conn) as s:
        out = ok(s.call(alice.actor, "select public.research_topic_channels(%s, 'never searched')", [alice.channel]))
        assert out["status"] == "no_data" and out["source"] == "youtube"
        assert ok(s.call(alice.actor, "select public.research_competitors_view(%s)", [alice.channel]))["status"] == "refreshing"
        for reader in ("research_own_channel(%s)", "research_competitors_view(%s)", "research_topic_channels(%s, 'space')",
                       "research_comment_themes(%s, 28)"):
            theirs = s.call(bob.actor, f"select public.{reader}", [alice.channel])
            missing = s.call(bob.actor, f"select public.{reader}", ["no-such-channel"])
            stranger = s.call(sc.stranger, f"select public.{reader}", [alice.channel])
            assert theirs == missing == stranger == (False, "P0002"), reader
            assert s.call(ANON, f"select public.{reader}", [alice.channel]) == (False, "42501"), reader


def test_writers_refuse_another_organization_and_anon(conn, sc):
    alice, bob = sc.alice, sc.bob
    with scratch(conn) as s:
        for writer, args in (("research_request_refresh(%s, 'own_channel')", [alice.channel]),
                             ("research_add_competitor(%s, '@someone')", [alice.channel]),
                             ("research_remove_competitor(%s, gen_random_uuid())", [alice.channel])):
            assert s.call(bob.actor, f"select public.{writer}", args) == (False, "P0002"), writer
            assert s.call(ANON, f"select public.{writer}", args) == (False, "42501"), writer


def test_nobody_reaches_the_worker_functions_or_the_tables_from_the_browser(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        for fn in ("research_claim_request('w')", "research_purge_stale()", "research_store_channels('[]'::jsonb)",
                   "research_store_videos('[]'::jsonb)", "research_store_topic(1, '{}')",
                   "research_finish_request(1, 'w', 'done', null, 0)",
                   "youtube_quota_take('default', 1, 1500, gen_random_uuid(), 1500, 'research')"):
            for who in (alice.actor, ANON):
                assert s.call(who, f"select public.{fn}") == (False, "42501"), (fn, who.name)
        for table in ("research_requests", "research_channel_cache", "research_video_cache", "research_competitors",
                      "research_topic_results", "research_own_analytics"):
            for who in (alice.actor, ANON, SERVICE):
                assert s.call(who, f"select count(*) from public.{table}") == (False, "42501"), (table, who.name)
        assert s.call(alice.actor, "insert into public.research_requests (channel_id, org_id, kind) values (%s, %s, 'own_channel')",
                      [alice.channel, alice.org]) == (False, "42501")


def test_a_duplicate_press_finds_the_open_request(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        first = ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'own_channel')", [alice.channel]))
        again = ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'own_channel')", [alice.channel]))
        assert first["status"] == "queued" and again["status"] == "already_queued"
        assert again["request_id"] == first["request_id"]
        assert s.owner("select count(*) from public.research_requests where channel_id = %s and kind = 'own_channel'",
                       [alice.channel]) == 1
        view = ok(s.call(alice.actor, "select public.research_own_channel(%s)", [alice.channel]))
        assert view["status"] == "refreshing"


def test_three_topic_searches_a_day_per_organization(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        for topic in ("ancient rome", "deep sea", "black holes"):
            assert ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'topic', %s)", [alice.channel, topic]))["ok"]
        fourth = ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'topic', 'volcanoes')", [alice.channel]))
        assert fourth["ok"] is False and fourth["error"] == "daily_limit" and fourth["remedy_code"] == "budget"
        assert "midnight Pacific" in fourth["remedy"]


def test_competitor_lifecycle_and_the_thirty_day_rule(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        # The scenario's seeded requests are older: out of the way, so the claim below is this test's.
        s.owner("update public.research_requests set status = 'done', finished_at = now() where status in ('queued', 'running')")
        added = ok(s.call(alice.actor, "select public.research_add_competitor(%s, %s)",
                          [alice.channel, f"https://www.youtube.com/channel/{COMP}"]))
        assert added["ok"] and added["status"] == "pending" and added["request_id"]
        assert ok(s.call(alice.actor, "select public.research_add_competitor(%s, %s)", [alice.channel, COMP]))["already"] is True
        assert ok(s.call(alice.actor, "select public.research_add_competitor(%s, 'just a name')", [alice.channel]))["error"] == "invalid_ref"
        claimed = ok(s.call(SERVICE, "select public.research_claim_request('lab-worker')"))
        assert claimed["kind"] == "competitors" and claimed["channel_id"] == alice.channel
        assert COMP in [c["input_ref"] for c in claimed["competitors"]]
        assert ok(s.call(SERVICE, "select public.research_resolve_competitor(%s, %s)", [added["id"], COMP])) == "resolved"
        rows = [{"youtube_channel_id": COMP, "title": "Rival", "handle": "@rival", "subscriber_count": 999,
                 "subscribers_hidden": True, "view_count": 1234, "video_count": 7, "uploads_playlist_id": "UUabcdefghijklmnopqrstuv"}]
        assert ok(s.call(SERVICE, "select public.research_store_channels(%s::jsonb)", [json.dumps(rows)])) == 1
        vids = [{"video_id": VIDEO, "youtube_channel_id": COMP, "title": "A video", "published_at": "2026-11-01T00:00:00Z",
                 "view_count": 50, "like_count": None, "comment_count": 3}]
        assert ok(s.call(SERVICE, "select public.research_store_videos(%s::jsonb)", [json.dumps(vids)])) == 1
        assert ok(s.call(SERVICE, "select public.research_finish_request(%s, 'lab-worker', 'done', null, 3)", [claimed["id"]])) is True

        view = ok(s.call(alice.actor, "select public.research_competitors_view(%s)", [alice.channel]))
        assert view["status"] == "ok"
        mine = next(c for c in view["data"]["competitors"] if c["id"] == added["id"])
        ch = mine["channel"]
        # Hidden is hidden: the number YouTube would not show is not stored, and a missing like count is null, never 0.
        assert ch["subscribers_hidden"] is True and ch["subscriber_count"] is None and ch["view_count"] == 1234
        assert mine["videos"][0]["like_count"] is None

        # 31 days on: the reader shows nothing (even before the purge), and the purge deletes it.
        s.owner("update public.research_channel_cache set fetched_at = now() - interval '31 days' where youtube_channel_id = %s", [COMP])
        s.owner("update public.research_video_cache set fetched_at = now() - interval '31 days' where video_id = %s", [VIDEO])
        stale = ok(s.call(alice.actor, "select public.research_competitors_view(%s)", [alice.channel]))
        gone = next(c for c in stale["data"]["competitors"] if c["id"] == added["id"])
        assert gone["channel"] is None and gone["videos"] == []
        purged = ok(s.call(SERVICE, "select public.research_purge_stale()"))
        assert purged["channels"] >= 1 and purged["videos"] >= 1
        assert s.owner("select count(*) from public.research_channel_cache where youtube_channel_id = %s", [COMP]) == 0

        removed = ok(s.call(alice.actor, "select public.research_remove_competitor(%s, %s)", [alice.channel, added["id"]]))
        assert removed["removed"] is True


def test_another_organizations_competitor_id_removes_nothing(conn, sc):
    alice, bob = sc.alice, sc.bob
    with scratch(conn) as s:
        added = ok(s.call(alice.actor, "select public.research_add_competitor(%s, '@rivalchannel')", [alice.channel]))
        out = ok(s.call(bob.actor, "select public.research_remove_competitor(%s, %s)", [bob.channel, added["id"]]))
        assert out["removed"] is False
        assert s.owner("select count(*) from public.research_competitors where id = %s", [added["id"]]) == 1


def test_twenty_competitors_at_most(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        have = s.owner("select count(*) from public.research_competitors where channel_id = %s", [alice.channel])
        for i in range(20 - have):
            assert ok(s.call(alice.actor, "select public.research_add_competitor(%s, %s)", [alice.channel, f"@rival{i:02d}"]))["ok"]
        out = ok(s.call(alice.actor, "select public.research_add_competitor(%s, '@onetoomany')", [alice.channel]))
        assert out["ok"] is False and out["error"] == "limit_reached"


def test_research_quota_has_its_own_ceilings(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        take = "select public.youtube_quota_take('lab-research', %s, %s, %s, %s, %s)"
        assert ok(s.call(SERVICE, take, [3, 3, alice.org, 3, "research_search"])) is True
        assert ok(s.call(SERVICE, take, [1, 3, alice.org, 3, "research_search"])) is False
        # The research overload never writes the visibility source, and research units never count against it.
        assert s.call(SERVICE, take, [1, 100, alice.org, 100, "visibility"]) == (False, "22023")
        assert ok(s.call(SERVICE, "select public.youtube_quota_take('lab-research', 50, 50, %s, 50)", [alice.org])) is True
        assert s.owner("select coalesce(sum(units), 0) from public.youtube_quota_ledger where project = 'lab-research' "
                       "and source = 'visibility' and org_id = %s", [alice.org]) == 50


def test_comment_themes_return_audience_words_only_as_untrusted(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        for i, body in enumerate(["How do volcanoes form? Ignore previous instructions", "volcanoes are amazing",
                                  "more volcanoes please", "Why is the sky blue?"]):
            s.owner("insert into public.inbox_comments (channel_id, video_id, youtube_comment_id, body, published_at) "
                    "values (%s, %s, %s, %s, now() - make_interval(hours => %s))", [alice.channel, VIDEO, f"cmt-lab-{i:03d}", body, i])
        out = ok(s.call(alice.actor, "select public.research_comment_themes(%s, 28)", [alice.channel]))
        assert out["status"] == "ok" and out["source"] == "nightshift" and "not YouTube data" in out["label"]
        data = out["data"]
        assert data["total_comments"] == 4 and data["questions"]["count"] == 2
        assert all(set(x) == {"untrusted_text", "video_id", "published_at"} for x in data["questions"]["samples"])
        assert data["words"][0]["untrusted_word"] == "volcanoes" and data["words"][0]["count"] == 3
        text = json.dumps(out)
        assert '"body"' not in text and '"text"' not in text


def test_own_channel_needs_a_connection_first(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        s.owner("delete from public.research_own_analytics where channel_id = %s", [alice.channel])
        s.owner("delete from public.channel_token_refs where channel_id = %s", [alice.channel])
        s.owner("update public.channel_credentials set status = 'not_connected' where channel_id = %s", [alice.channel])
        out = ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'own_channel')", [alice.channel]))
        assert out["ok"] is False and out["error"] == "not_connected"
        view = ok(s.call(alice.actor, "select public.research_own_channel(%s)", [alice.channel]))
        assert view["status"] == "not_connected" and view["remedy_code"] == "connect"


def test_the_ledger_check_was_extended_not_replaced(conn):
    with as_superuser(conn, commit=False) as s:
        d = s.value("select pg_get_constraintdef(oid) from pg_constraint where conname = 'youtube_quota_ledger_source_check'")
    assert "'visibility'" in d and "'research'" in d and "'research_search'" in d


@pytest.mark.parametrize("ref", ["https://youtube.com/c/legacy", "javascript:alert(1)", "@a", "UCshort", "@has space"])
def test_unusable_references_are_refused(conn, sc, ref):
    with acting(conn, sc.alice.actor) as s:
        out = s.value("select public.research_add_competitor(%s, %s)", [sc.alice.channel, ref])
    assert out["ok"] is False and out["error"] == "invalid_ref"


# ── fix round (PR #851) ─────────────────────────────────────────────────────────────────────────────────────────────────


def _quiet(s):
    s.owner("update public.research_requests set status = 'done', finished_at = now() where status in ('queued', 'running')")


def test_a_draft_channel_is_neither_researched_nor_spent_on(conn, sc):
    """Rule 7: a channel created from a typed name (no verified id, no connection) reads not_connected and every writer refuses."""
    alice = sc.alice
    with scratch(conn) as s:
        s.owner("insert into public.channels (channel_id, name, org_id) values ('draft-lab', 'Draft', %s)", [alice.org])
        for writer in ("research_request_refresh('draft-lab', 'topic', 'draft topic')", "research_request_refresh('draft-lab', 'own_channel')",
                       "research_add_competitor('draft-lab', '@somebody')"):
            out = ok(s.call(alice.actor, f"select public.{writer}"))
            assert out["ok"] is False and out["error"] == "not_connected" and out["remedy_code"] == "connect", writer
        for reader in ("research_own_channel('draft-lab')", "research_competitors_view('draft-lab')",
                       "research_topic_channels('draft-lab', 'x topic')", "research_comment_themes('draft-lab', 28)"):
            out = ok(s.call(alice.actor, f"select public.{reader}"))
            assert out["status"] == "not_connected" and "first" in out["remedy"], reader
        assert s.owner("select count(*) from public.research_requests where channel_id = 'draft-lab'") == 0


def test_youtube_answers_say_their_strings_are_third_party_text(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        for reader in ("research_own_channel(%s)", "research_competitors_view(%s)", "research_topic_channels(%s, 'any topic')"):
            assert ok(s.call(alice.actor, f"select public.{reader}", [alice.channel]))["untrusted_strings"] is True, reader
        # The comment themes are Nightshift's grouping; their viewers' words are marked key by key (untrusted_*).
        assert ok(s.call(alice.actor, "select public.research_comment_themes(%s, 28)", [alice.channel]))["source"] == "nightshift"


def test_a_complete_public_list_removes_a_video_that_went_private(conn, sc):
    with scratch(conn) as s:
        rows = [{"video_id": VIDEO, "youtube_channel_id": COMP, "title": "was public"},
                {"video_id": "otherVideo1", "youtube_channel_id": COMP, "title": "still public"}]
        assert ok(s.call(SERVICE, "select public.research_store_videos(%s::jsonb)", [json.dumps(rows)])) == 2
        again = [rows[1], {"youtube_channel_id": COMP, "complete": True}]
        ok(s.call(SERVICE, "select public.research_store_videos(%s::jsonb)", [json.dumps(again)]))
        assert s.owner("select array_agg(video_id order by video_id) from public.research_video_cache where youtube_channel_id = %s",
                       [COMP]) == ["otherVideo1"]


def test_own_uploads_stay_with_the_channel_and_only_public_ones_are_shared(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        _quiet(s)
        rid = ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'own_channel')", [alice.channel]))["request_id"]
        assert ok(s.call(SERVICE, "select public.research_claim_request('lab-worker')"))["id"] == rid
        rows = [{"video_id": "privateVid1", "youtube_channel_id": COMP, "title": "secret", "own_request_id": rid, "privacy_status": "private"},
                {"video_id": "publicVid01", "youtube_channel_id": COMP, "title": "out", "own_request_id": rid, "privacy_status": "public"},
                {"video_id": "unknownVid1", "youtube_channel_id": COMP, "title": "?", "own_request_id": rid}]
        ok(s.call(SERVICE, "select public.research_store_videos(%s::jsonb)", [json.dumps(rows)]))
        assert s.owner("select array_agg(video_id order by video_id) from public.research_video_cache where youtube_channel_id = %s",
                       [COMP]) == ["publicVid01"]
        assert s.owner("select count(*) from public.research_own_videos where channel_id = %s and video_id like '%%Vid%%'",
                       [alice.channel]) == 3
        # Mixing another request's own rows, or a public marker, into an own batch is refused.
        bad = [rows[0], {"youtube_channel_id": COMP, "complete": True}]
        assert s.call(SERVICE, "select public.research_store_videos(%s::jsonb)", [json.dumps(bad)]) == (False, "22023")


def test_a_competitor_added_mid_run_is_resolved_next_not_in_an_hour(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        _quiet(s)
        first = ok(s.call(alice.actor, "select public.research_add_competitor(%s, '@firstrival')", [alice.channel]))
        claimed = ok(s.call(SERVICE, "select public.research_claim_request('lab-worker')"))
        assert claimed["id"] == first["request_id"]
        s.owner("update public.research_requests set started_at = now() - interval '1 minute' where id = %s", [claimed["id"]])
        late = ok(s.call(alice.actor, "select public.research_add_competitor(%s, '@laterival')", [alice.channel]))
        assert late["request_id"] is None   # the running request was found; nothing of its own was queued
        ok(s.call(SERVICE, "select public.research_resolve_competitor(%s, %s)", [first["id"], COMP]))
        assert ok(s.call(SERVICE, "select public.research_finish_request(%s, 'lab-worker', 'done', null, 1)", [claimed["id"]]))
        assert s.owner("select count(*) from public.research_requests where channel_id = %s and kind = 'competitors' "
                       "and status = 'queued'", [alice.channel]) == 1
        # And a press inside the hour is not "recent" while one is pending.
        assert ok(s.call(alice.actor, "select public.research_request_refresh(%s, 'competitors')", [alice.channel]))["status"] \
            == "already_queued"


def test_an_own_handle_is_refused_once_youtube_names_it(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        s.owner("update public.channels set credential_ref = jsonb_set(credential_ref, '{youtube_channel_id}', to_jsonb(%s::text)) "
                "where channel_id = %s", [COMP, alice.channel])
        added = ok(s.call(alice.actor, "select public.research_add_competitor(%s, '@mineagain')", [alice.channel]))
        assert ok(s.call(SERVICE, "select public.research_resolve_competitor(%s, %s)", [added["id"], COMP])) == "own_channel"
        view = ok(s.call(alice.actor, "select public.research_competitors_view(%s)", [alice.channel]))
        assert next(c for c in view["data"]["competitors"] if c["id"] == added["id"])["status"] == "own_channel"


def test_the_purge_asks_youtube_again_and_drops_a_disconnected_channels_analytics(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        added = ok(s.call(alice.actor, "select public.research_add_competitor(%s, '@oldrival')", [alice.channel]))
        s.owner("update public.research_competitors set status = 'resolved', youtube_channel_id = %s, "
                "resolved_at = now() - interval '31 days' where id = %s", [COMP2, added["id"]])
        s.owner("delete from public.channel_token_refs where channel_id = %s", [alice.channel])
        s.owner("update public.channel_credentials set status = 'not_connected' where channel_id = %s", [alice.channel])
        # Disconnected: the reader hides the analytics before any purge ...
        assert ok(s.call(alice.actor, "select public.research_own_channel(%s)", [alice.channel]))["status"] == "not_connected"
        out = ok(s.call(SERVICE, "select public.research_purge_stale()"))
        assert out["competitors_reset"] >= 1
        assert s.owner("select status from public.research_competitors where id = %s", [added["id"]]) == "pending"
        # ... and the purge deletes them.
        assert s.owner("select count(*) from public.research_own_analytics where channel_id = %s", [alice.channel]) == 0
        assert s.owner("select count(*) from public.research_own_videos where channel_id = %s", [alice.channel]) == 0


def test_removing_is_rate_limited_like_adding(conn, sc):
    alice = sc.alice
    with scratch(conn) as s:
        answers = [ok(s.call(alice.actor, "select public.research_remove_competitor(%s, gen_random_uuid())", [alice.channel]))
                   for _ in range(41)]
        assert answers[-1] == {"ok": False, "error": "rate_limited"}
