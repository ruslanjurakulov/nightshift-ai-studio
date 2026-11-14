"""Film Studio P1 (migration 0166), attacked in a real database.

A film is a draft: a topic or script, its format and look, and a storyboard of up to 60 scenes with their frame roles and references.
The only doors are create_film_draft, save_film, archive_film and film_json. What would break without each guard (each test names
the guard it pins; removing that guard from the migration makes it fail):

  * nothing spends: no film call moves a credit, opens a hold, or creates a creative job or a render job;
  * tenancy: another organization's film reads exactly like a missing one (P0002, the same answer for a random id), through every
    table and through film_json; a viewer reads but cannot create, save or archive; anon and the service role call nothing;
  * no direct writes: no API role inserts, updates or deletes any film table, and film_events refuses even the database owner's
    update or delete (append-only);
  * draft only: save_film is refused once the film has left draft or planned (film_not_editable), at a stale version (film_changed),
    and two saves of one version make one edit (the row lock);
  * every state-changing call writes exactly one event naming its actor and role; a refused call and a replay write none;
  * the limits: 60 scenes, 3-30 s, 1-3 shots, 1200 s in total, the target, the source, the texts, 16 + 8 references, 50 open drafts;
  * frame roles: the first scene cannot continue from a previous one, `next_keyframe` needs a next scene with a key frame, a picture
    must be a live image of this library, and a take with a last frame needs a first frame;
  * models: a model chosen must be on sale for its role now, a model already saved is not re-checked by an unrelated edit, and no
    Seedance model is accepted even when the registry would sell it;
  * idempotency: a replayed key answers the first film; a key reused for another request is a conflict; two creates at once make one;
  * the migration: re-applying it changes nothing, it refuses a body or a table that is not its own, and the rollback refuses while
    films exist, takes everything out with its override, and 0166 applies again after it.

Runs in its own scratch database (it commits), with a registry installed through sync_model_registry and real probe rows.
"""

from __future__ import annotations

import json
import os
import threading
import uuid

import psycopg
import pytest

import sec_db

MIGRATION = sec_db.MIGRATIONS / "0166_films_core.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0166_films_core.sql"
TABLES = ("films", "film_scenes", "film_refs", "film_takes", "film_events")


def uid(n: int) -> str:
    return str(uuid.UUID(int=0x166000 + n))


# (id, provider, adapter, capabilities, credit unit). Every one is made sellable except vid-hidden.
MODELS = [
    ("img-key", "acme", "image.acme", ["t2i", "edit"], "model_img_key_image"),
    ("vid-clip", "acme", "video.acme", ["t2v", "i2v"], "model_vid_clip_second"),
    ("vid-clip-b", "acme", "video.acme", ["i2v"], "model_vid_clip_b_second"),
    ("vid-hidden", "acme", "video.acme", ["i2v"], "model_vid_hidden_second"),
    ("tts-a", "acme", "audio.acme", ["tts"], "model_tts_a_character"),
    # Sellable as far as the registry is concerned (no terms gate, verified, priced): 0166 must still refuse them.
    ("seedance-lab", "acme", "video.acme", ["i2v"], "model_seedance_lab_second"),
    ("bd-video", "bytedance", "video.acme", ["i2v"], "model_bd_video_second"),
    ("vid-sd-adapter", "acme", "video.seedance2", ["i2v"], "model_vid_sd_adapter_second"),
]

SETTINGS = {"title": "The lighthouse", "language": "en", "target_seconds": 180}


def claims(role, user=None):
    c = {"role": role}
    if user:
        c["sub"] = user
    return json.dumps(c)


class Org:
    def __init__(self, org, owner, admin, editor, viewer):
        self.org, self.owner, self.admin, self.editor, self.viewer = org, owner, admin, editor, viewer
        self.channel = ""
        self.image = ""
        self.image2 = ""
        self.video = ""
        self.audio = ""


class Db:
    def __init__(self, dsn):
        self.dsn = dsn
        self.n = 0
        self.keys = 0

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, user, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, user)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise

    def one(self, role, user, q, p=None):
        return self.act(role, user, q, p)[0][0]

    def asset(self, org, kind="image", mime="image/png"):
        return str(self.su(
            "select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, 'generated', "
            "p_width => 64, p_height => 64, p_provenance => '{}'::jsonb) ->> 'id'",
            [org, kind, mime, uuid.uuid4().hex * 2])[0][0])

    def new_org(self):
        self.n += 1
        n = self.n
        org = str(uuid.UUID(int=0x166A0000 + n))
        people = [uid(n * 4 + i) for i in range(4)]
        roles = ("owner", "admin", "editor", "viewer")
        for u, role in zip(people, roles):
            self.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{role}{n}@films.lab"])
        self.su("insert into public.organizations (id, name, slug) values (%s, %s, %s)", [org, f"Films{n}", f"org-film-{n}"])
        for u, role in zip(people, roles):
            self.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)",
                    [org, u, f"{role}{n}@films.lab", role])
        self.su("select public.grant_credits(%s, 100, 'test')", [org])
        o = Org(org, *people)
        o.channel = f"chan-film-{n}"
        self.su("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'film', 'PAUSED', %s)",
                [o.channel, f"Film channel {n}", org])
        o.image, o.image2 = self.asset(org), self.asset(org)
        o.video = self.asset(org, "video", "video/mp4")
        o.audio = self.asset(org, "audio", "audio/mpeg")
        return o

    def key(self) -> str:
        self.keys += 1
        return f"film-key-{self.keys:06d}"

    # ── the calls under test ────────────────────────────────────────────────
    def create(self, who, org, settings=None, kind="topic", text="A lighthouse keeper's last night", channel=None, key=None):
        return self.one("authenticated", who, "select public.create_film_draft(%s::uuid, %s, %s, %s, %s::jsonb, %s)",
                        [org, channel, kind, text, json.dumps(SETTINGS if settings is None else settings), key or self.key()])

    def save(self, who, film, version, patch):
        return self.one("authenticated", who, "select public.save_film(%s::uuid, %s::integer, %s::jsonb)",
                        [film, version, json.dumps(patch)])

    def archive(self, who, film):
        return self.one("authenticated", who, "select public.archive_film(%s::uuid)", [film])

    def read(self, who, film):
        return self.one("authenticated", who, "select public.film_json(%s::uuid)", [film])

    # ── ground truth ────────────────────────────────────────────────────────
    def events(self, film):
        return self.su("select event, actor::text, actor_role, detail from public.film_events where film_id = %s order by id", [film])

    def money(self, org):
        return self.su(
            "select (select row(balance, reserved)::text from public.credit_accounts where org_id = %(o)s), "
            "(select count(*) from public.credit_reservations where org_id = %(o)s), "
            "(select count(*) from public.credit_transactions where org_id = %(o)s), "
            "(select count(*) from public.creative_jobs where org_id = %(o)s), "
            "(select count(*) from public.render_jobs)", {"o": org})[0]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_films_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0]}}
            for m, prov, a, caps, unit in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit in MODELS:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 2, 0) "
             "on conflict (unit) do update set credits_per_unit = 2, margin = 0", [unit])
        if m == "vid-hidden":
            continue
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    sellable = {r[0] for r in d.su("select id from public.sellable_models(null, 'web')")}
    assert sellable >= {m for m, *_ in MODELS} - {"vid-hidden"}, sellable  # the refusals below are 0166's, not the registry's
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# A fresh pair of organizations for every test: the open-draft limit (50) would otherwise be reached by the tests themselves.
@pytest.fixture
def a(db):
    return db.new_org()


@pytest.fixture
def b(db):
    return db.new_org()


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def scenes(n, seconds=10, **extra):
    return [{"title": f"Scene {i + 1}", "narration": f"Line {i + 1}.", "visual_prompt": f"shot {i + 1}",
             "planned_seconds": seconds, **extra} for i in range(n)]


# ── nothing spends ──────────────────────────────────────────────────────────

def test_no_film_call_moves_a_credit_opens_a_hold_or_queues_a_job(db, a):
    before = db.money(a.org)
    f = db.create(a.editor, a.org, channel=a.channel)
    fid = f["film"]["id"]
    s = db.save(a.editor, fid, 1, {"clip_model": "vid-clip", "keyframe_model": "img-key", "scenes": scenes(10)})
    db.read(a.viewer, fid)
    db.archive(a.editor, fid)
    assert s["totals"] == {"scenes": 10, "planned_seconds": 100}
    assert db.money(a.org) == before


# ── tenancy ─────────────────────────────────────────────────────────────────

def test_another_organizations_film_reads_exactly_like_a_missing_one(db, a, b):
    fid = db.create(a.editor, a.org)["film"]["id"]
    db.save(a.editor, fid, 1, {"refs": [{"kind": "style", "asset_id": a.image}], "scenes": scenes(2)})
    db.su("insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind) "
          "select film_id, org_id, id, 1, 0, 'keyframe' from public.film_scenes where film_id = %s", [fid])
    for who in (b.owner, b.editor, b.viewer):
        for t in TABLES:
            col = "id" if t == "films" else "film_id"
            assert db.one("authenticated", who, f"select count(*) from public.{t} where {col} = %s", [fid]) == 0, t
        missing = err(lambda: db.read(who, str(uuid.uuid4())))
        assert err(lambda: db.read(who, fid)) == missing == ("P0002", "not_found", "")
        assert err(lambda: db.save(who, fid, 2, {"title": "Mine now"}))[:2] == ("P0002", "not_found")
        assert err(lambda: db.archive(who, fid))[:2] == ("P0002", "not_found")
    for t in TABLES:
        col = "id" if t == "films" else "film_id"
        assert db.one("authenticated", a.viewer, f"select count(*) from public.{t} where {col} = %s", [fid]) > 0, t


def test_a_film_cannot_be_created_in_another_organization_or_aimed_at_its_channel(db, a, b):
    assert err(lambda: db.create(b.owner, a.org))[:2] == ("42501", "forbidden")
    code, word, detail = err(lambda: db.create(a.editor, a.org, channel=b.channel))
    assert (code, word) == ("NS400", "invalid_params") and "channel" in detail
    fid = db.create(a.editor, a.org)["film"]["id"]
    assert err(lambda: db.save(a.editor, fid, 1, {"channel_id": b.channel}))[:2] == ("NS400", "invalid_params")
    assert err(lambda: db.save(a.editor, fid, 1, {"channel_id": "no-such-channel"}))[:2] == ("NS400", "invalid_params")


def test_a_viewer_reads_but_cannot_create_save_or_archive(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    assert db.read(a.viewer, fid)["film"]["id"] == fid
    assert err(lambda: db.create(a.viewer, a.org))[:2] == ("42501", "forbidden")
    assert err(lambda: db.save(a.viewer, fid, 1, {"title": "Viewer edit"}))[:2] == ("42501", "forbidden")
    assert err(lambda: db.archive(a.viewer, fid))[:2] == ("42501", "forbidden")
    assert [e[0] for e in db.events(fid)] == ["created"]


def test_a_call_without_a_signed_in_user_is_refused(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    for q, p in (("select public.film_json(%s::uuid)", [fid]),
                 ("select public.save_film(%s::uuid, 1, '{\"title\": \"x\"}'::jsonb)", [fid]),
                 ("select public.archive_film(%s::uuid)", [fid]),
                 ("select public.create_film_draft(%s::uuid, null, 'topic', 'x', '{}'::jsonb, 'nobody-key-1')", [a.org])):
        with pytest.raises(psycopg.Error) as e:
            db.act("authenticated", None, q, p)
        assert e.value.sqlstate == "42501", q


@pytest.mark.parametrize("role", ["anon", "service_role"])
def test_the_anon_key_and_the_service_role_call_no_film_function(db, a, role):
    fid = db.create(a.editor, a.org)["film"]["id"]
    calls = [("select public.film_json(%s::uuid)", [fid]),
             ("select public.save_film(%s::uuid, 1, '{\"title\": \"x\"}'::jsonb)", [fid]),
             ("select public.archive_film(%s::uuid)", [fid]),
             ("select public.create_film_draft(%s::uuid, null, 'topic', 'x', '{}'::jsonb, 'anon-key-0001')", [a.org]),
             ("select public.film_read(%s::uuid)", [fid]),
             ("select public.film_log(%s::uuid, %s::uuid, null, 'forged')", [fid, a.org])]
    for q, p in calls:
        with pytest.raises(psycopg.Error) as e:
            db.act(role, None, q, p)
        assert e.value.sqlstate == "42501" and "permission denied" in str(e.value), q


@pytest.mark.parametrize("role", ["authenticated", "anon", "service_role"])
def test_no_api_role_writes_any_film_table_directly(db, a, role):
    fid = db.create(a.editor, a.org)["film"]["id"]
    db.save(a.editor, fid, 1, {"scenes": scenes(1)})
    who = a.owner if role == "authenticated" else None
    attacks = [
        "insert into public.films (org_id, title, source_kind, language, target_seconds, idempotency_key, request_hash) "
        f"values ('{a.org}', 'x', 'topic', 'en', 120, 'direct-key-01', '{'0' * 32}')",
        f"update public.films set status = 'ready' where id = '{fid}'",
        f"delete from public.films where id = '{fid}'",
        f"insert into public.film_scenes (film_id, org_id, position, planned_seconds) values ('{fid}', '{a.org}', 5, 10)",
        f"update public.film_scenes set narration = 'x' where film_id = '{fid}'",
        f"delete from public.film_scenes where film_id = '{fid}'",
        f"insert into public.film_refs (film_id, org_id, kind, asset_id, position) values ('{fid}', '{a.org}', 'style', '{a.image}', 3)",
        f"insert into public.film_takes (film_id, org_id, version, shot_index, kind) values ('{fid}', '{a.org}', 1, 0, 'narration')",
        f"insert into public.film_events (film_id, org_id, actor_role, event) values ('{fid}', '{a.org}', 'service', 'forged')",
        f"update public.film_events set event = 'forged' where film_id = '{fid}'",
        f"delete from public.film_events where film_id = '{fid}'",
    ]
    for q in attacks:
        with pytest.raises(psycopg.Error) as e:
            db.act(role, who, q)
        # The privilege, not only RLS: a stray grant would still be stopped by the missing policy with the same SQLSTATE, and the
        # first writer function that forgot its own checks would then be one policy away from a hole.
        assert e.value.sqlstate == "42501" and "permission denied for table" in str(e.value), q
    granted = db.su("select t, p from unnest(%s::text[]) t, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p "
                    "where has_table_privilege(%s, 'public.' || t, p)", [list(TABLES), role])
    assert granted == [], granted
    assert db.su("select status, version from public.films where id = %s", [fid]) == [("draft", 2)]
    rls = db.su("select bool_and(relrowsecurity) from pg_class where oid = any(%s::regclass[])",
                [[f"public.{t}" for t in TABLES]])[0][0]
    assert rls


def test_film_events_refuse_an_update_or_delete_even_from_the_database_owner(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    for q in (f"update public.film_events set event = 'forged' where film_id = '{fid}'",
              f"delete from public.film_events where film_id = '{fid}'",
              "truncate public.film_events cascade"):
        with pytest.raises(psycopg.Error) as e:
            db.su(q)
        assert e.value.sqlstate == "42501" and "append-only" in str(e.value), q
    assert [e[0] for e in db.events(fid)] == ["created"]


# ── draft only, versions, the lock ──────────────────────────────────────────

def test_a_save_bumps_the_version_and_a_stale_version_is_refused(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    assert db.save(a.editor, fid, 1, {"title": "Second title"})["film"]["version"] == 2
    code, word, detail = err(lambda: db.save(a.editor, fid, 1, {"title": "Lost update"}))
    assert (code, word) == ("NS409", "film_changed") and "version 2" in detail
    assert db.read(a.editor, fid)["film"]["title"] == "Second title"


@pytest.mark.parametrize("status", ["planning", "running", "draining", "paused", "assembling", "ready", "failed", "cancelled"])
def test_save_and_archive_are_refused_once_the_film_has_left_draft(db, a, status):
    fid = db.create(a.editor, a.org)["film"]["id"]
    db.su("update public.films set status = %s where id = %s", [status, fid])
    assert err(lambda: db.save(a.editor, fid, 1, {"title": "Too late"}))[:2] == ("NS409", "film_not_editable")
    assert err(lambda: db.save(a.owner, fid, 1, {"scenes": scenes(1)}))[:2] == ("NS409", "film_not_editable")
    assert err(lambda: db.archive(a.owner, fid))[:2] == ("NS409", "film_not_editable")
    assert db.read(a.viewer, fid)["editable"] is False
    assert [e[0] for e in db.events(fid)] == ["created"]


def test_a_planned_film_is_still_a_draft_an_archived_one_is_not(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    db.su("update public.films set status = 'planned' where id = %s", [fid])
    assert db.save(a.editor, fid, 1, {"title": "Reviewed"})["editable"] is True
    archived = db.archive(a.editor, fid)
    assert archived["film"]["status"] == "archived" and archived["editable"] is False
    assert err(lambda: db.save(a.editor, fid, 3, {"title": "Back from the dead"}))[:2] == ("NS409", "film_not_editable")
    assert db.archive(a.editor, fid)["film"]["version"] == 3  # again: nothing changes, nothing is written
    assert [e[0] for e in db.events(fid)] == ["created", "saved", "archived"]


def test_two_saves_of_the_same_version_make_one_edit_and_one_refusal(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    results, gate = [], threading.Barrier(2)

    def go(title):
        gate.wait()
        try:
            results.append(("ok", db.save(a.editor, fid, 1, {"title": title, "scenes": scenes(3)})["film"]["version"]))
        except psycopg.Error as e:
            results.append((e.sqlstate, str(e).splitlines()[0]))

    threads = [threading.Thread(target=go, args=(f"Racer {i}",)) for i in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == [("NS409", "film_changed"), ("ok", 2)]
    assert [e[0] for e in db.events(fid)] == ["created", "saved"]
    assert db.su("select count(*) from public.film_scenes where film_id = %s", [fid])[0][0] == 3


# ── the audit trail ─────────────────────────────────────────────────────────

def test_every_state_changing_call_writes_exactly_one_event_naming_its_actor(db, a):
    f = db.create(a.editor, a.org, channel=a.channel)
    fid = f["film"]["id"]
    db.save(a.admin, fid, 1, {"title": "By the admin", "scenes": scenes(2)})
    err(lambda: db.save(a.editor, fid, 1, {"title": "stale"}))            # refused: no event
    err(lambda: db.save(a.editor, fid, 2, {"scenes": scenes(61)}))        # refused: no event
    db.archive(a.owner, fid)
    ev = db.events(fid)
    assert [(e[0], e[1], e[2]) for e in ev] == [("created", a.editor, "editor"), ("saved", a.admin, "admin"),
                                                ("archived", a.owner, "owner")]
    assert ev[0][3] == {"source_kind": "topic", "channel_id": a.channel}
    assert ev[1][3] == {"from_version": 1, "to_version": 2, "fields": ["scenes", "title"], "scenes": 2}
    assert ev[2][3] == {"from_status": "draft"}
    shown = db.read(a.viewer, fid)["events"]
    assert [e["event"] for e in shown] == ["archived", "saved", "created"] and shown[0]["actor"] == a.owner


# ── idempotency ─────────────────────────────────────────────────────────────

def test_a_replayed_key_answers_the_first_film_and_a_reused_key_is_a_conflict(db, a):
    key = db.key()
    first = db.create(a.editor, a.org, key=key)
    again = db.create(a.editor, a.org, key=key)
    assert again["film"]["id"] == first["film"]["id"]
    assert db.su("select count(*) from public.films where org_id = %s and idempotency_key = %s", [a.org, key])[0][0] == 1
    assert [e[0] for e in db.events(first["film"]["id"])] == ["created"]
    assert "request_hash" not in first["film"]
    code, word, _ = err(lambda: db.create(a.editor, a.org, text="Another film entirely", key=key))
    assert (code, word) == ("NS409", "idempotency_conflict")
    for bad in ("short", "has space in it", "x" * 129, "-leading-dash"):
        assert err(lambda: db.create(a.editor, a.org, key=bad))[:2] == ("NS400", "invalid_idempotency_key")


def test_two_creates_at_once_with_one_key_make_one_film(db, a):
    key, ids, gate = db.key(), [], threading.Barrier(3)

    def go():
        gate.wait()
        ids.append(db.create(a.editor, a.org, key=key)["film"]["id"])

    threads = [threading.Thread(target=go) for _ in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(ids) == 3 and len(set(ids)) == 1
    assert len(db.events(ids[0])) == 1


# ── the limits ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("patch,word,needle", [
    ({"scenes": scenes(61)}, "limit_reached", "at most 60 scenes"),
    ({"scenes": scenes(41, seconds=30)}, "limit_reached", "1230 s"),
    ({"scenes": scenes(1, seconds=2)}, "invalid_params", "planned_seconds"),
    ({"scenes": scenes(1, seconds=31)}, "invalid_params", "planned_seconds"),
    ({"scenes": scenes(1, seconds=7.5)}, "invalid_params", "planned_seconds"),
    ({"scenes": [{"title": "No length"}]}, "invalid_params", "planned_seconds is required"),
    ({"scenes": scenes(1, shot_count=0)}, "invalid_params", "shot_count"),
    ({"scenes": scenes(1, shot_count=4)}, "invalid_params", "shot_count"),
    ({"scenes": scenes(1, title="t" * 121)}, "invalid_params", "title"),
    ({"scenes": scenes(1, narration="n" * 2001)}, "invalid_params", "narration"),
    ({"scenes": scenes(1, visual_prompt="p" * 2001)}, "invalid_params", "visual_prompt"),
    ({"scenes": scenes(1, negative_prompt="p" * 1001)}, "invalid_params", "negative_prompt"),
    ({"scenes": scenes(1, camera="orbit")}, "invalid_params", "unknown field camera"),
    ({"scenes": scenes(1, clip_params={"seed": 4})}, "invalid_params", "unknown field seed"),
    ({"scenes": scenes(1, clip_params={"audio": "yes"})}, "invalid_params", "audio"),
    ({"scenes": scenes(1, transition_in="wipe")}, "invalid_params", "transition_in"),
    ({"scenes": {"not": "a list"}}, "invalid_params", "scenes must be a list"),
    ({"title": ""}, "invalid_params", "title must not be empty"),
    ({"title": "​⁠ "}, "invalid_params", "title must not be empty"),
    ({"title": "t" * 121}, "invalid_params", "title"),
    ({"target_seconds": 59}, "invalid_params", "target_seconds"),
    ({"target_seconds": 1201}, "invalid_params", "target_seconds"),
    ({"source_text": "s" * 2001}, "invalid_params", "at most 2000"),
    ({"language": "de"}, "invalid_params", "language"),
    ({"aspect": "4:3"}, "invalid_params", "aspect"),
    ({"resolution": "8k"}, "invalid_params", "resolution"),
    ({"music_gain_db": 3}, "invalid_params", "music_gain_db"),
    ({"duck_db": -12.25}, "invalid_params", "duck_db"),
    ({"status": "ready"}, "invalid_params", "unknown field status"),
    ({"version": 9}, "invalid_params", "unknown field version"),
    ({"org_id": str(uuid.uuid4())}, "invalid_params", "unknown field org_id"),
    ({}, "invalid_params", "at least one field"),
])
def test_a_save_outside_the_limits_is_refused_and_changes_nothing(db, a, patch, word, needle):
    fid = db.create(a.editor, a.org)["film"]["id"]
    code, got, detail = err(lambda: db.save(a.editor, fid, 1, patch))
    assert (code, got) == ("NS400", word) and needle in detail, detail
    assert db.su("select version, title from public.films where id = %s", [fid]) == [(1, SETTINGS["title"])]
    assert db.su("select count(*) from public.film_scenes where film_id = %s", [fid])[0][0] == 0


def test_the_exact_limits_are_allowed(db, a):
    fid = db.create(a.editor, a.org, settings={**SETTINGS, "target_seconds": 1200})["film"]["id"]
    full = scenes(60, seconds=20, shot_count=3, title="t" * 120, narration="n" * 2000)
    assert db.save(a.editor, fid, 1, {"scenes": full})["totals"] == {"scenes": 60, "planned_seconds": 1200}
    script = db.create(a.editor, a.org, kind="script", text="s" * 40000)
    assert len(script["film"]["source_text"]) == 40000


@pytest.mark.parametrize("kind,text,settings,word,needle", [
    ("topic", "t" * 2001, SETTINGS, "invalid_params", "at most 2000"),
    ("script", "s" * 40001, SETTINGS, "invalid_params", "at most 40000"),
    ("topic", "", SETTINGS, "invalid_params", "source_text must not be empty"),
    ("storyboard", "x", SETTINGS, "invalid_params", "source_kind"),
    ("topic", "x", {"language": "en", "target_seconds": 120}, "invalid_params", "required"),
    ("topic", "x", {**SETTINGS, "source_text": "twice"}, "invalid_params", "arguments"),
    ("topic", "x", {**SETTINGS, "channel_id": "chan"}, "invalid_params", "arguments"),
    ("topic", "x", {**SETTINGS, "status": "ready"}, "invalid_params", "unknown field status"),
    ("topic", "x", {**SETTINGS, "voice": {"source": "channel"}}, "invalid_params", "needs the film to have a channel"),
])
def test_a_create_outside_the_limits_is_refused(db, a, kind, text, settings, word, needle):
    code, got, detail = err(lambda: db.create(a.editor, a.org, settings=settings, kind=kind, text=text))
    assert (code, got) == ("NS400", word) and needle in detail, detail


def test_an_organization_keeps_at_most_fifty_open_drafts_and_archiving_frees_a_place(db):
    o = db.new_org()
    ids = [db.create(o.editor, o.org)["film"]["id"] for _ in range(50)]
    code, word, detail = err(lambda: db.create(o.editor, o.org))
    assert (code, word) == ("NS400", "limit_reached") and "50" in detail
    db.archive(o.editor, ids[0])
    assert db.create(o.editor, o.org)["film"]["status"] == "draft"


def test_reference_limits_and_ownership(db, a, b):
    fid = db.create(a.editor, a.org)["film"]["id"]
    many = [{"kind": "style", "asset_id": db.asset(a.org)} for _ in range(17)]
    assert err(lambda: db.save(a.editor, fid, 1, {"refs": many}))[:2] == ("NS400", "limit_reached")
    assert db.save(a.editor, fid, 1, {"refs": many[:16]})["refs"][15]["position"] == 15
    nine = [{"kind": "location", "asset_id": x["asset_id"]} for x in many[:9]]
    assert err(lambda: db.save(a.editor, fid, 2, {"scenes": scenes(1, refs=nine)}))[:2] == ("NS400", "limit_reached")
    twice = [{"kind": "style", "asset_id": a.image}, {"kind": "location", "asset_id": a.image}]
    assert "twice" in err(lambda: db.save(a.editor, fid, 2, {"refs": twice}))[2]
    for bad in ({"kind": "style", "asset_id": b.image}, {"kind": "style", "asset_id": a.video},
                {"kind": "style", "asset_id": str(uuid.uuid4())}):
        assert err(lambda: db.save(a.editor, fid, 2, {"refs": [bad]}))[:2] == ("NS400", "asset_not_usable")
    b_char = db.su("insert into public.characters (org_id, name) values (%s, 'bob_hero') returning id::text", [b.org])[0][0]
    a_char = db.su("insert into public.characters (org_id, name) values (%s, 'alice_hero') returning id::text", [a.org])[0][0]
    assert "not a character of this organization" in err(
        lambda: db.save(a.editor, fid, 2, {"refs": [{"kind": "character", "character_id": b_char}]}))[2]
    assert "kind character" in err(lambda: db.save(a.editor, fid, 2, {"refs": [{"kind": "style", "character_id": a_char}]}))[2]
    assert "exactly one" in err(
        lambda: db.save(a.editor, fid, 2, {"refs": [{"kind": "character", "character_id": a_char, "asset_id": a.image}]}))[2]
    ok = db.save(a.editor, fid, 2, {"refs": [{"kind": "character", "character_id": a_char}],
                                    "scenes": scenes(1, refs=[{"kind": "location", "asset_id": a.image2}])})
    assert [r["character_id"] for r in ok["refs"]] == [a_char]
    assert [r["asset_id"] for r in ok["scenes"][0]["refs"]] == [a.image2]


# ── the storyboard: identity, order, frame roles ────────────────────────────

def test_scenes_keep_their_ids_through_a_reorder_and_a_scene_left_out_is_deleted(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    s1 = db.save(a.editor, fid, 1, {"scenes": scenes(3)})["scenes"]
    one, two, three = (s["id"] for s in s1)
    s2 = db.save(a.editor, fid, 2, {"scenes": [{"id": three}, {"id": one, "narration": "Moved."}, {"planned_seconds": 5}]})["scenes"]
    assert [s["id"] for s in s2[:2]] == [three, one] and s2[2]["id"] not in (one, two, three)
    assert [s["position"] for s in s2] == [0, 1, 2]
    assert s2[0]["title"] == "Scene 3" and s2[1]["narration"] == "Moved." and s2[1]["title"] == "Scene 1"
    assert db.su("select count(*) from public.film_scenes where id = %s", [two])[0][0] == 0
    assert "listed twice" in err(lambda: db.save(a.editor, fid, 3, {"scenes": [{"id": one}, {"id": one}]}))[2]
    other = db.create(a.editor, a.org)["film"]["id"]
    assert "not a scene of this film" in err(lambda: db.save(a.editor, other, 1, {"scenes": [{"id": one}]}))[2]


def test_a_scene_that_has_takes_cannot_be_deleted(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    first, second = (s["id"] for s in db.save(a.editor, fid, 1, {"scenes": scenes(2)})["scenes"])
    db.su("insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind) values (%s, %s, %s, 1, 0, 'keyframe')",
          [fid, a.org, first])
    assert err(lambda: db.save(a.editor, fid, 2, {"scenes": [{"id": second}]}))[:2] == ("NS409", "scene_has_takes")
    assert len(db.save(a.editor, fid, 2, {"scenes": [{"id": second}, {"id": first}]})["scenes"][1]["takes"]) == 1


def test_frame_roles_are_checked_against_the_neighbouring_scenes(db, a, b):
    fid = db.create(a.editor, a.org)["film"]["id"]
    assert "no previous scene" in err(lambda: db.save(a.editor, fid, 1, {"scenes": scenes(1, first_frame="previous")}))[2]
    assert "next_keyframe" in err(lambda: db.save(a.editor, fid, 1, {"scenes": scenes(2, last_frame="next_keyframe")}))[2]
    chained = [dict(scenes(1)[0], last_frame="next_keyframe"), dict(scenes(1)[0], first_frame="previous")]
    assert "key frame of its own" in err(lambda: db.save(a.editor, fid, 1, {"scenes": chained}))[2]
    assert "first_frame_asset_id" in err(lambda: db.save(a.editor, fid, 1, {"scenes": scenes(1, first_frame="asset")}))[2]
    for bad in (b.image, a.video, str(uuid.uuid4())):
        out = err(lambda: db.save(a.editor, fid, 1, {"scenes": scenes(1, first_frame="asset", first_frame_asset_id=bad)}))
        assert out[:2] == ("NS400", "asset_not_usable")
    good = [dict(scenes(1)[0], first_frame="asset", first_frame_asset_id=a.image, last_frame="next_keyframe"),
            dict(scenes(1)[0], last_frame="asset", last_frame_asset_id=a.image2),
            dict(scenes(1)[0], first_frame="previous")]
    s = db.save(a.editor, fid, 1, {"scenes": good})["scenes"]
    assert [(x["first_frame"], x["last_frame"]) for x in s] == [("asset", "next_keyframe"), ("keyframe", "asset"), ("previous", "none")]
    # Switching a mode away from `asset` lets go of its picture; nothing is left that the mode does not use.
    s = db.save(a.editor, fid, 2, {"scenes": [{"id": s[0]["id"], "first_frame": "keyframe"}, {"id": s[1]["id"], "last_frame": "none"},
                                              {"id": s[2]["id"]}]})["scenes"]
    assert s[0]["first_frame_asset_id"] is None and s[1]["last_frame_asset_id"] is None


def test_a_take_with_a_last_frame_must_have_a_first_frame(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    sid = db.save(a.editor, fid, 1, {"scenes": scenes(1)})["scenes"][0]["id"]
    with pytest.raises(psycopg.Error) as e:
        db.su("insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, last_frame_asset_id) "
              "values (%s, %s, %s, 1, 1, 'clip', %s)", [fid, a.org, sid, a.image])
    assert e.value.sqlstate == "23514"
    db.su("insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, first_frame_asset_id, "
          "last_frame_asset_id, reference_asset_ids) values (%s, %s, %s, 1, 1, 'clip', %s, %s, %s::uuid[])",
          [fid, a.org, sid, a.image, a.image2, [a.image]])
    take = db.read(a.viewer, fid)["scenes"][0]["takes"][0]
    assert (take["first_frame_asset_id"], take["last_frame_asset_id"], take["reference_asset_ids"]) == (a.image, a.image2, [a.image])


def test_text_is_cleaned_of_invisible_characters_before_it_is_stored(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    hidden = "a calm sea​‮ at dawn\U000e0049\U000e0047"
    s = db.save(a.editor, fid, 1, {"title": "  Two⁠  words ", "scenes": scenes(1, visual_prompt=hidden, narration="one\r\ntwo")})
    assert s["film"]["title"] == "Two words"
    assert s["scenes"][0]["visual_prompt"] == "a calm sea at dawn"
    assert s["scenes"][0]["narration"] == "one\ntwo"


def test_film_json_says_missing_for_a_reference_frame_kit_or_track_that_is_gone(db, a):
    kit = db.su("insert into public.style_kits (org_id, name) values (%s, 'Noir') returning id::text", [a.org])[0][0]
    char = db.su("insert into public.characters (org_id, name) values (%s, 'keeper') returning id::text", [a.org])[0][0]
    pic, frame = db.asset(a.org), db.asset(a.org)
    fid = db.create(a.editor, a.org, settings={**SETTINGS, "style_kit_id": kit, "music_asset_id": a.audio})["film"]["id"]
    j = db.save(a.editor, fid, 1, {"refs": [{"kind": "style", "asset_id": pic}, {"kind": "character", "character_id": char}],
                                   "scenes": scenes(1, first_frame="asset", first_frame_asset_id=frame)})
    assert (j["style_kit_missing"], j["music_missing"], [r["missing"] for r in j["refs"]], j["scenes"][0]["first_frame_missing"]) \
        == (False, False, [False, False], False)
    assert j["scenes"][0]["current_version"] is None and j["scenes"][0]["takes"] == []
    db.su("update public.media_assets set deleted_at = now() where id = any(%s::uuid[])", [[pic, frame, a.audio]])
    db.su("delete from public.style_kits where id = %s", [kit])   # an editor's direct delete (0047) is not blocked by a film
    db.su("delete from public.characters where id = %s", [char])
    j = db.read(a.viewer, fid)
    assert (j["style_kit_missing"], j["music_missing"], [r["missing"] for r in j["refs"]], j["scenes"][0]["first_frame_missing"]) \
        == (True, True, [True, True], True)
    db.su("update public.media_assets set deleted_at = null where id = %s", [a.audio])


# ── models ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("model", ["seedance-lab", "bd-video", "vid-sd-adapter"])
def test_no_seedance_model_is_accepted_even_when_the_registry_would_sell_it(db, a, model):
    fid = db.create(a.editor, a.org)["film"]["id"]
    for patch in ({"clip_model": model}, {"keyframe_model": model}, {"scenes": scenes(1, clip_model=model)}):
        code, word, detail = err(lambda: db.save(a.editor, fid, 1, patch))
        assert (code, word) == ("NS400", "model_not_offered") and "Seedance" in detail, patch
    assert err(lambda: db.create(a.editor, a.org, settings={**SETTINGS, "clip_model": model}))[1] == "model_not_offered"


def test_a_model_must_be_on_sale_for_its_role_when_chosen(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    for patch in ({"clip_model": "vid-hidden"}, {"clip_model": "no-such-model"}, {"clip_model": "img-key"},
                  {"keyframe_model": "vid-clip"}, {"voice": {"source": "creative_tts", "model": "img-key", "voice_id": "Narrator1"}},
                  {"scenes": scenes(1, keyframe_model="tts-a")}):
        assert err(lambda: db.save(a.editor, fid, 1, patch))[:2] == ("NS400", "model_not_available"), patch
    assert err(lambda: db.save(a.editor, fid, 1, {"clip_model": "Bad Id"}))[:2] == ("NS400", "invalid_params")
    j = db.save(a.editor, fid, 1, {"clip_model": "vid-clip", "keyframe_model": "img-key",
                                   "voice": {"source": "creative_tts", "model": "tts-a", "voice_id": "Narrator1"}})
    assert (j["film"]["clip_model"], j["film"]["keyframe_model"], j["film"]["voice"]["model"]) == ("vid-clip", "img-key", "tts-a")


def test_a_saved_model_that_goes_off_sale_does_not_block_an_unrelated_edit(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    sid = db.save(a.editor, fid, 1, {"clip_model": "vid-clip-b", "scenes": scenes(1, clip_model="vid-clip-b")})["scenes"][0]["id"]
    db.su("update public.model_registry set availability = 'hidden' where id = 'vid-clip-b'")
    try:
        j = db.save(a.editor, fid, 2, {"title": "Renamed", "clip_model": "vid-clip-b",
                                       "scenes": [{"id": sid, "clip_model": "vid-clip-b", "narration": "Edited."}]})
        assert j["film"]["clip_model"] == j["scenes"][0]["clip_model"] == "vid-clip-b"
        other = db.create(a.editor, a.org)["film"]["id"]
        assert err(lambda: db.save(a.editor, other, 1, {"clip_model": "vid-clip-b"}))[1] == "model_not_available"
    finally:
        db.su("update public.model_registry set availability = 'beta' where id = 'vid-clip-b'")


def test_a_channel_voice_needs_the_film_to_have_a_channel(db, a):
    fid = db.create(a.editor, a.org, channel=a.channel, settings={**SETTINGS, "voice": {"source": "channel"}})["film"]["id"]
    assert "needs the film to have a channel" in err(lambda: db.save(a.editor, fid, 1, {"channel_id": None}))[2]
    assert "takes no model" in err(lambda: db.save(a.editor, fid, 1, {"voice": {"source": "channel", "voice_id": "x"}}))[2]
    assert db.save(a.editor, fid, 1, {"channel_id": None, "voice": None})["film"]["channel_id"] is None


# ── the migration itself ────────────────────────────────────────────────────

SNAPSHOT = """
select jsonb_build_object(
  'constraints', (select jsonb_agg(conname || ' ' || pg_get_constraintdef(oid) order by conname) from pg_constraint
                   where conrelid = any(array['public.films','public.film_scenes','public.film_refs','public.film_takes',
                                              'public.film_events']::regclass[])),
  'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname = 'public' and tablename like 'film%%'),
  'policies', (select jsonb_agg(policyname || ' ' || qual order by policyname) from pg_policies where tablename like 'film%%'),
  'functions', (select jsonb_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(array_to_string(p.proacl, ','), '')
                                 order by p.oid::regprocedure::text)
                  from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and (p.proname like 'film\\_%%' or p.proname in ('create_film_draft', 'save_film', 'archive_film'))),
  'grants', (select jsonb_agg(grantee || ' ' || table_name || ' ' || privilege_type order by grantee, table_name, privilege_type)
               from information_schema.role_table_grants where table_schema = 'public' and table_name like 'film%%'),
  'triggers', (select jsonb_agg(tgname order by tgname) from pg_trigger where tgrelid = 'public.film_events'::regclass),
  'rows', (select jsonb_build_array((select count(*) from public.films), (select count(*) from public.film_scenes),
                                    (select count(*) from public.film_refs), (select count(*) from public.film_takes),
                                    (select count(*) from public.film_events),
                                    (select md5(string_agg(to_jsonb(f)::text, ',' order by id)) from public.films f))))
"""


def test_reapplying_the_migration_changes_nothing(db, a):
    fid = db.create(a.editor, a.org)["film"]["id"]
    db.save(a.editor, fid, 1, {"refs": [{"kind": "style", "asset_id": a.image}], "scenes": scenes(3)})
    before = db.su(SNAPSHOT)[0][0]
    db.su(MIGRATION.read_text(encoding="utf-8"))
    db.su(MIGRATION.read_text(encoding="utf-8"))
    assert db.su(SNAPSHOT)[0][0] == before


def test_the_migration_refuses_a_body_or_a_table_that_is_not_its_own(db):
    text = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.film_is_editable(p_status text) returns boolean "
                  "language sql immutable set search_path = public, pg_temp as $$ select true $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "film_is_editable(text) with a body that is not this file's" in str(e.value)
        c.rollback()
        c.execute("alter table public.film_events rename column actor_role to role_of_actor")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "public.film_events that is not this file's" in str(e.value)
        c.rollback()
    assert db.su("select public.film_is_editable('ready')")[0][0] is False


def _rollback_text(override: bool) -> str:
    lines = []
    for ln in ROLLBACK.read_text(encoding="utf-8").splitlines():
        if ln.strip() in ("begin;", "commit;"):
            continue
        if override and ln.strip() == "-- set local nightshift.rollback_0166_discard_films = 'on';":
            ln = "set local nightshift.rollback_0166_discard_films = 'on';"
        lines.append(ln)
    return "\n".join(lines)


def test_the_rollback_refuses_while_films_exist_then_takes_everything_out_and_0166_applies_again(db, a):
    db.create(a.editor, a.org)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        with pytest.raises(psycopg.Error) as e:
            c.execute(_rollback_text(override=False))
        assert "films exist and would be deleted" in str(e.value)
        c.rollback()
        c.execute(_rollback_text(override=True))
        gone = c.execute("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'film%'").fetchone()[0]
        assert gone == 0
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute("select count(*) from public.films").fetchone()[0] == 0
        assert c.execute("select has_function_privilege('authenticated', 'public.save_film(uuid, integer, jsonb)', 'execute')").fetchone()[0]
        c.rollback()  # the lab keeps its films: the whole round trip is undone
    assert db.su("select count(*) from public.films")[0][0] > 0
