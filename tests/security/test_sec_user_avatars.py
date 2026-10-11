"""Migration 0097: a private profile photo per person (bucket "avatars").

A profile photo is personal data, so the attacks here are on who can reach it.
What would break without each:

* one person reading, overwriting or deleting another person's photo (a folder
  that is not theirs);
* a person using their own folder as general storage: another file name, a
  sub-folder, a different case, a trailing slash, or renaming their object into
  somebody else's folder with an UPDATE;
* the signed-out key reading or writing anything in the bucket;
* the policies leaking sideways, onto another bucket's objects;
* the bucket turning public, growing past 256 KB or taking another mime type;
* a second apply of the migration (it is run by hand) widening or duplicating
  anything.

The lab's storage schema is the stand-in in bootstrap.sql (storage.buckets,
storage.objects with RLS on, storage.foldername()), the same one 0004 and 0026
already run against; it has no Storage API, so the byte-level checks (WebP
magic, dimensions) are the route's tests in command-center, not here.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, MIGRATIONS, acting, as_superuser, user

MIGRATION = "0097_user_avatars.sql"


def person(tag="av"):
    return user(tag, f"{tag}-{uuid.uuid4().hex[:8]}@lab.test")


def own(who):
    return f"{who.uid}/avatar.webp"


def seed_object(conn, name, bucket="avatars"):
    with as_superuser(conn) as s:
        s.rows("insert into storage.objects (bucket_id, name) values (%s, %s) returning 1", [bucket, name])


def exists(conn, name, bucket="avatars"):
    with as_superuser(conn, commit=False) as s:
        return s.value("select count(*) from storage.objects where bucket_id = %s and name = %s", [bucket, name]) >= 1


# ── the bucket ──────────────────────────────────────────────────────────────

def test_bucket_is_private_small_and_webp_only(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'")
    assert row == [(False, 262144, ["image/webp"])]


def test_reapplying_the_migration_is_a_noop_and_repairs_a_flipped_bucket(conn):
    sql = (MIGRATIONS / MIGRATION).read_text()
    with as_superuser(conn, commit=False) as s:
        before = s.rows("select policyname, cmd, roles::text, qual, with_check from pg_policies "
                        "where schemaname = 'storage' and tablename = 'objects' order by policyname")
        # Someone made the bucket public and loosened it by hand; the next apply puts it back.
        s.conn.execute("update storage.buckets set public = true, file_size_limit = null, allowed_mime_types = null "
                       "where id = 'avatars'")
        s.conn.execute(sql)
        s.conn.execute(sql)
        after = s.rows("select policyname, cmd, roles::text, qual, with_check from pg_policies "
                       "where schemaname = 'storage' and tablename = 'objects' order by policyname")
        bucket = s.rows("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'")
        assert s.value("select count(*) from storage.buckets where id = 'avatars'") == 1
    assert after == before
    assert bucket == [(False, 262144, ["image/webp"])]


def test_the_policies_are_four_own_object_rules_for_authenticated_only(conn):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select policyname, cmd, roles::text from pg_policies "
                      "where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\\_%' "
                      "order by policyname")
        # every policy on the table names a bucket, so none can reach the avatars bucket unnamed
        unscoped = s.rows("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' "
                          "and coalesce(qual, '') not like '%bucket_id%' and coalesce(with_check, '') not like '%bucket_id%'")
    assert rows == [
        ("avatars_delete_own", "DELETE", "{authenticated}"),
        ("avatars_insert_own", "INSERT", "{authenticated}"),
        ("avatars_select_own", "SELECT", "{authenticated}"),
        ("avatars_update_own", "UPDATE", "{authenticated}"),
    ]
    assert unscoped == []


# ── the person's own object ─────────────────────────────────────────────────

def test_a_person_can_add_read_replace_and_remove_their_own_photo(conn):
    me = person()
    with acting(conn, me) as s:
        assert s.run("insert into storage.objects (bucket_id, name) values ('avatars', %s)", [own(me)]).ok
        assert s.value("select count(*) from storage.objects where bucket_id = 'avatars'") == 1
        out = s.run("update storage.objects set created_at = now() where bucket_id = 'avatars' and name = %s", [own(me)])
        assert out.ok and out.rowcount == 1
        out = s.run("delete from storage.objects where bucket_id = 'avatars' and name = %s", [own(me)])
        assert out.ok and out.rowcount == 1
        assert s.value("select count(*) from storage.objects where bucket_id = 'avatars'") == 0


# ── another person's object ─────────────────────────────────────────────────

def test_another_persons_photo_cannot_be_read_replaced_or_deleted(conn):
    victim, attacker = person("victim"), person("attacker")
    seed_object(conn, own(victim))
    with acting(conn, attacker) as s:
        assert s.rows("select name from storage.objects where bucket_id = 'avatars'") == []
        assert s.rows("select name from storage.objects where bucket_id = 'avatars' and name = %s", [own(victim)]) == []
        assert not s.run("insert into storage.objects (bucket_id, name) values ('avatars', %s)", [own(victim)]).ok
        up = s.run("update storage.objects set created_at = now() where bucket_id = 'avatars' and name = %s", [own(victim)])
        assert not up.ok or up.rowcount == 0
        dele = s.run("delete from storage.objects where bucket_id = 'avatars' and name = %s", [own(victim)])
        assert dele.ok and dele.rowcount == 0
    assert exists(conn, own(victim))


def test_nobody_can_seed_a_file_into_another_persons_folder(conn):
    victim, attacker = person("victim"), person("attacker")
    with acting(conn, attacker) as s:
        for name in (f"{victim.uid}/avatar.webp", f"{victim.uid}/other.webp", f"{victim.uid}/x/avatar.webp"):
            assert not s.run("insert into storage.objects (bucket_id, name) values ('avatars', %s)", [name]).ok, name


def test_a_person_cannot_rename_their_object_into_another_folder_or_name(conn):
    me, other = person("me"), person("other")
    seed_object(conn, own(me))
    with acting(conn, me) as s:
        for target in (own(other), f"{me.uid}/other.webp", f"{me.uid}/x/avatar.webp", "avatar.webp"):
            out = s.run("update storage.objects set name = %s where bucket_id = 'avatars' and name = %s", [target, own(me)])
            assert not out.ok, target
    assert exists(conn, own(me))


# ── only that one name ──────────────────────────────────────────────────────

def _wrong_names(who):
    return [
        f"{who.uid}/avatar.png",
        f"{who.uid}/avatar.webp.png",
        f"{who.uid}/Avatar.webp",
        f"{who.uid}/AVATAR.WEBP",
        f"{who.uid}/other.webp",
        f"{who.uid}/avatar.webp/",
        f"{who.uid}//avatar.webp",
        f"{who.uid}/./avatar.webp",
        f"{who.uid}/sub/avatar.webp",
        f"{who.uid}/sub/deeper/avatar.webp",
        f"{who.uid}/avatar.webp ",
        f"{who.uid} /avatar.webp",
        f"{str(who.uid).upper()}/avatar.webp",
        f"/{who.uid}/avatar.webp",
        "avatar.webp",
        f"x/{who.uid}/avatar.webp",
        "",
    ]


def test_only_the_exact_object_name_is_writable(conn):
    me = person()
    with acting(conn, me) as s:
        for name in _wrong_names(me):
            out = s.run("insert into storage.objects (bucket_id, name) values ('avatars', %s)", [name])
            assert not out.ok, repr(name)


@pytest.mark.parametrize("verb", ["select", "update", "delete"])
def test_a_wrong_name_in_my_own_folder_is_invisible_and_untouchable(conn, verb):
    # Only the database owner can put these there (a stale upload, a dashboard click).
    me = person()
    names = _wrong_names(me)[:-1]
    for n in names:
        seed_object(conn, n)
    with acting(conn, me) as s:
        if verb == "select":
            assert s.rows("select name from storage.objects where bucket_id = 'avatars'") == []
        elif verb == "update":
            out = s.run("update storage.objects set created_at = now() where bucket_id = 'avatars'")
            assert not out.ok or out.rowcount == 0
        else:
            out = s.run("delete from storage.objects where bucket_id = 'avatars'")
            assert out.ok and out.rowcount == 0
    for n in names:
        assert exists(conn, n), n


# ── the other buckets are not touched ───────────────────────────────────────

def test_an_avatar_path_in_another_bucket_gets_no_rights(conn):
    me = person()
    with acting(conn, me) as s:
        for bucket in ("previews", "voice-previews"):
            out = s.run("insert into storage.objects (bucket_id, name) values (%s, %s)", [bucket, own(me)])
            assert not out.ok, bucket


def test_other_buckets_keep_their_own_rules(conn, sc):
    # 0004 / the channel rules still decide what a member sees of "previews";
    # 0097 neither widens it nor takes it away.
    with acting(conn, sc.bob.actor) as s:
        names = [r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'")]
        assert names == [f"{sc.bob.channel}/slug-b.mp4"]
        assert s.value("select count(*) from storage.objects where bucket_id = 'avatars'") == 0


# ── signed out ──────────────────────────────────────────────────────────────

def test_the_anon_key_sees_and_changes_nothing(conn):
    victim = person("victim")
    seed_object(conn, own(victim))
    with acting(conn, ANON) as s:
        out = s.run("select name from storage.objects where bucket_id = 'avatars'")
        assert (not out.ok) or out.rows == []
        assert not s.run("insert into storage.objects (bucket_id, name) values ('avatars', %s)", [own(victim)]).ok
        assert not s.run("insert into storage.objects (bucket_id, name) values ('avatars', %s)", [f"{uuid.uuid4()}/avatar.webp"]).ok
        up = s.run("update storage.objects set created_at = now() where bucket_id = 'avatars'")
        assert (not up.ok) or up.rowcount == 0
        dele = s.run("delete from storage.objects where bucket_id = 'avatars'")
        assert (not dele.ok) or dele.rowcount == 0
    assert exists(conn, own(victim))
