"""Migration 0098: the private "previews" bucket is readable by the channel's own
people only, even when the live project carries a broad read policy no
migration created.

Storage policies are permissive and add up. The live project holds, besides the
repo's tenant-scoped ``previews_read`` (0018), a dashboard-made
``previews_read 1dyqf8r_0`` (SELECT to authenticated USING bucket_id =
'previews'): with it any signed-in user can list, read and sign every
customer's review render. The lab applies the repo's own migrations only, so it
could not see that drift. These tests build a scratch database up to 0097,
plant the drift policy by hand, attack it, then apply 0098 and attack again.

What would break without each:

* B reading A's preview (the leak) before the migration, and not after;
* the fix taking the owner's own access, or the platform admin's, away
  (previews_read re-asserted);
* the migration touching the intentionally shared voice-previews bucket, the
  avatars rules, or a policy for any other bucket;
* a differently named broad policy (a dashboard suffix differs per click), one
  that names the bucket only in WITH CHECK, or an ALL policy, surviving;
* a second apply changing anything, or any part failing on its own;
* a later migration reintroducing an unscoped policy that names the bucket.

Not covered here (stand-in storage schema, no Storage API): that Supabase
Storage's list / createSignedUrl endpoints evaluate this same policy for the
caller. They do (they run the SELECT as the caller); the lab checks the policy.
"""

from __future__ import annotations

import copy
import importlib
import os
import sys
import uuid
from pathlib import Path

import pytest

from sec_db import (ANON, MIGRATIONS, acting, apply_files, as_superuser, build_sequence,
                    create_database, admin_dsn, drop_database)

MIGRATION = "0098_previews_policy_scope.sql"
DRIFT = "previews_read 1dyqf8r_0"

POLICIES = ("select policyname, cmd, roles::text, qual, with_check from pg_policies "
            "where schemaname = 'storage' and tablename = 'objects' order by policyname")

# The migration's clean-up heuristic, as a query: a PERMISSIVE SELECT/ALL policy
# that names the previews bucket (the literal, or a '{previews,...}' array
# literal) and does not call the scoping functions, USING and WITH CHECK tested
# separately. It is what step 2 drops. It is NOT a proof of safety: see ALLOWLIST.
NAMED = r"(''previews''|\{([^}'']*,)?previews(,[^}'']*)?\}'')"
OFFENDERS = (
    "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' "
    "and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL') "
    f"and ((qual ~ '{NAMED}' and qual !~ '(accessible_channel_ids|is_platform_admin)') "
    f"  or (with_check ~ '{NAMED}' and with_check !~ '(accessible_channel_ids|is_platform_admin)')) "
    "order by policyname")

# The check that counts (the owner's primary verify): every policy on
# storage.objects must be one this repo creates.
ALLOWED = ("avatars_delete_own", "avatars_insert_own", "avatars_select_own", "avatars_update_own",
           "previews_read", "previews_review_link_read", "voice_previews_read",
           # 0117: the voice-samples bucket (one insert rule, four restrictive closers)
           "voice_samples_closed_delete", "voice_samples_closed_insert", "voice_samples_closed_select",
           "voice_samples_closed_update", "voice_samples_insert_own")
ALLOWLIST = (
    "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' "
    "and policyname not in ('" + "', '".join(ALLOWED) + "') order by policyname")

POLICIES_NAMES = "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'"

NON_OBJECTS = "select tablename, policyname from pg_policies where schemaname = 'storage' and tablename <> 'objects'"

NO_BUCKET = (
    "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' "
    "and cmd in ('SELECT', 'ALL') "
    "and coalesce(qual, '') not like '%bucket_id%' and coalesce(with_check, '') not like '%bucket_id%' "
    "order by policyname")


def migration_sql():
    return (MIGRATIONS / MIGRATION).read_text(encoding="utf-8")


def statements(sql_text):
    """The migration's statements, one by one, the way a person could paste
    them: a DO block runs from 'do $$' to 'end $$;', anything else to the first
    line that ends in ';'. Comment lines are skipped."""
    out, cur, in_do = [], [], False
    for line in sql_text.splitlines():
        if not cur and (not line.strip() or line.lstrip().startswith("--")):
            continue
        if not cur and line.lstrip().lower().startswith("do $$"):
            in_do = True
        cur.append(line)
        if (in_do and line.strip().lower() == "end $$;") or (not in_do and line.rstrip().endswith(";")):
            out.append("\n".join(cur))
            cur, in_do = [], False
    assert not cur, "trailing text that is not a statement"
    return out


def strays(s):
    return [r[0] for r in s.rows(ALLOWLIST)]


def offenders(s):
    return [r[0] for r in s.rows(OFFENDERS)]


def names(s, bucket, like=None):
    q = "select name from storage.objects where bucket_id = %s"
    p = [bucket]
    if like:
        q += " and name like %s"
        p.append(like)
    return sorted(r[0] for r in s.rows(q + " order by name", p))


def create_policy(s, name, body):
    s.conn.execute(f'create policy "{name}" on storage.objects {body}')


def _containers():
    return {(m, k): v for m, mod in list(sys.modules.items()) if m.startswith("sec_")
            for k, v in vars(mod).items() if isinstance(v, (dict, list, set)) and k.isupper()}


def _lab_state():
    """The seed modules (sec_folders_0049, sec_style_0047, ...) keep the ids
    they seeded in module-level dicts keyed by tenant. Building a second
    scenario here would overwrite the shared lab's ids, so snapshot them first
    and put them back after. Every sec_* module is imported first, so the
    snapshot also covers the ones build_scenario imports lazily."""
    for f in sorted(Path(__file__).parent.glob("sec_*.py")):
        importlib.import_module(f.stem)
    return {key: copy.deepcopy(v) for key, v in _containers().items()}


def _restore_lab_state(saved):
    for key, live in _containers().items():
        keep = saved[key]
        live.clear()
        if isinstance(live, list):
            live.extend(keep)
        else:
            live.update(keep)


class World:
    """A scratch database built up to the migration before 0098, with the drift
    policy planted, observed before and after applying 0098."""


@pytest.fixture(scope="module")
def world():
    import sec_scenario

    dsn = admin_dsn()
    if not dsn:
        msg = "NIGHTSHIFT_SECURITY_PG is not set: the security lab needs a scratch Postgres"
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(msg, pytrace=False)
        pytest.skip(msg)

    import psycopg
    dbname = f"ns_previews_{uuid.uuid4().hex[:8]}"
    db_dsn = create_database(dsn, dbname)
    conn = None
    try:
        apply_files(db_dsn, [f for f in build_sequence() if f.name != MIGRATION])
        conn = psycopg.connect(db_dsn, autocommit=True)
        saved = _lab_state()
        try:
            sc = sec_scenario.build_scenario(conn)
        finally:
            _restore_lab_state(saved)
        w = World()
        w.conn, w.sc = conn, sc
        w.a, w.b = sc.alice.channel, sc.bob.channel
        w.notices = []
        conn.add_notice_handler(lambda d: w.notices.append(d.message_primary))

        # The shared voice samples (0026 makes the bucket) and one preview per channel.
        with as_superuser(conn) as s:
            for name in ("voice-a.mp3", "voice-b.mp3"):
                s.rows("insert into storage.objects (bucket_id, name) values ('voice-previews', %s) returning 1", [name])
            for ch in (w.a, w.b):
                s.rows("insert into storage.objects (bucket_id, name) values ('previews', %s) returning 1", [f"{ch}/v1.mp4"])
            # The drift: what the dashboard left in the live project.
            create_policy(s, DRIFT, "for select to authenticated using (bucket_id = 'previews')")

        w.policies_before_fix = _policies(conn)
        w.before = _observe(conn, w)

        with as_superuser(conn) as s:
            s.conn.execute(migration_sql())
        w.policies_after_first = _policies(conn)
        w.notices_first = list(w.notices)
        with as_superuser(conn) as s:
            s.conn.execute(migration_sql())
        w.policies_after_second = _policies(conn)
        w.after = _observe(conn, w)
        yield w
    finally:
        if conn is not None:
            conn.close()
        drop_database(dsn, dbname)


def _policies(conn):
    with as_superuser(conn, commit=False) as s:
        return s.rows(POLICIES)


def _observe(conn, w):
    """What each caller can see of the previews bucket right now."""
    sc = w.sc
    seen = {}
    for label, who in (("alice", sc.alice.actor), ("bob", sc.bob.actor), ("stranger", sc.stranger),
                       ("operator", sc.operator), ("anon", ANON)):
        with acting(conn, who) as s:
            out = s.run("select name from storage.objects where bucket_id = 'previews' order by name")
            seen[label] = sorted(r[0] for r in out.rows) if out.ok else None
    return seen


A_OBJECTS = lambda w: sorted([f"{w.a}/slug-a.mp4", f"{w.a}/v1.mp4"])  # noqa: E731
B_OBJECTS = lambda w: sorted([f"{w.b}/slug-b.mp4", f"{w.b}/v1.mp4"])  # noqa: E731


# ── before: the drift leaks ─────────────────────────────────────────────────

def test_the_dashboard_policy_leaks_every_preview_to_any_signed_in_user(world):
    w = world
    assert DRIFT in [p[0] for p in w.policies_before_fix]
    # Bob and a stranger who owns nothing read Alice's channel: the leak.
    assert f"{w.a}/v1.mp4" in w.before["bob"]
    assert f"{w.b}/v1.mp4" in w.before["alice"]
    assert f"{w.a}/v1.mp4" in w.before["stranger"]
    # The signed-out key is not a signed-in user: the policy is "to authenticated".
    assert not w.before["anon"]


# ── after: tenant-scoped ────────────────────────────────────────────────────

def test_the_owner_reads_lists_and_signs_only_their_own_previews(world):
    w = world
    assert w.after["alice"] == A_OBJECTS(w)
    assert w.after["bob"] == B_OBJECTS(w)
    # createSignedUrl is a SELECT of one named object as the caller.
    with acting(w.conn, w.sc.alice.actor) as s:
        assert s.value("select count(*) from storage.objects where bucket_id = 'previews' and name = %s", [f"{w.a}/v1.mp4"]) == 1
        assert s.value("select count(*) from storage.objects where bucket_id = 'previews' and name = %s", [f"{w.b}/v1.mp4"]) == 0


def test_another_customer_sees_nothing_of_a_channel_that_is_not_theirs(world):
    w = world
    with acting(w.conn, w.sc.bob.actor) as s:
        assert s.rows("select name from storage.objects where bucket_id = 'previews' and name = %s", [f"{w.a}/v1.mp4"]) == []
        assert s.rows("select name from storage.objects where bucket_id = 'previews' and name like %s", [f"{w.a}/%"]) == []
        assert s.value("select count(*) from storage.objects where bucket_id = 'previews' and name not like %s", [f"{w.b}/%"]) == 0
    assert w.after["stranger"] == []


def test_the_signed_out_key_reads_nothing(world):
    w = world
    assert not w.after["anon"]
    with acting(w.conn, ANON) as s:
        out = s.run("select name from storage.objects where bucket_id = 'previews' and name = %s", [f"{w.a}/v1.mp4"])
        assert (not out.ok) or out.rows == []


def test_the_platform_admin_keeps_access_to_every_preview(world):
    w = world
    assert set(A_OBJECTS(w) + B_OBJECTS(w)) <= set(w.after["operator"])


def test_previews_stay_unwritable_for_signed_in_users(world):
    w = world
    for who in (w.sc.alice.actor, w.sc.bob.actor, w.sc.stranger, w.sc.operator):
        with acting(w.conn, who) as s:
            ins = s.run("insert into storage.objects (bucket_id, name) values ('previews', %s)", [f"{w.a}/mine-{uuid.uuid4().hex[:6]}.mp4"])
            assert not ins.ok, who.name
            up = s.run("update storage.objects set created_at = now() where bucket_id = 'previews'")
            assert (not up.ok) or up.rowcount == 0, who.name
            dele = s.run("delete from storage.objects where bucket_id = 'previews'")
            assert (not dele.ok) or dele.rowcount == 0, who.name
    with as_superuser(w.conn, commit=False) as s:
        assert set(A_OBJECTS(w) + B_OBJECTS(w)) <= set(names(s, "previews"))


# ── the other buckets are untouched ─────────────────────────────────────────

def test_voice_previews_stay_shared_for_signed_in_users_and_closed_to_anon(world):
    w = world
    for who in (w.sc.alice.actor, w.sc.bob.actor, w.sc.stranger):
        with acting(w.conn, who) as s:
            assert names(s, "voice-previews", "voice-%") == ["voice-a.mp3", "voice-b.mp3"], who.name
    with acting(w.conn, ANON) as s:
        out = s.run("select name from storage.objects where bucket_id = 'voice-previews'")
        assert (not out.ok) or out.rows == []


def test_only_previews_read_changed_and_the_drift_is_gone(world):
    w = world
    before = {p[0]: p for p in w.policies_before_fix}
    after = {p[0]: p for p in w.policies_after_first}
    assert DRIFT in before and DRIFT not in after
    assert set(before) - set(after) == {DRIFT}
    assert set(after) - set(before) == set()
    for name in after:
        if name != "previews_read":
            assert after[name] == before[name], name  # voice_previews_read, avatars_* ... byte for byte
    assert [n for n in after if n.startswith("avatars_")] == [
        "avatars_delete_own", "avatars_insert_own", "avatars_select_own", "avatars_update_own"]
    assert after["voice_previews_read"][1:3] == ("SELECT", "{authenticated}")
    pr = after["previews_read"]
    assert pr[1:3] == ("SELECT", "{authenticated}") and pr[4] is None
    assert "accessible_channel_ids" in pr[3] and "is_platform_admin" in pr[3] and "'previews'" in pr[3]


def test_the_exact_name_drop_is_silent_and_the_migration_created_no_other_policy(world):
    w = world
    # The exact-name drop ran first, so the catalog lookup had nothing left to report here.
    assert not any(m.startswith("0098: dropping policy ") for m in w.notices_first)


def test_a_second_apply_changes_nothing(world):
    w = world
    assert w.policies_after_second == w.policies_after_first
    assert w.after["alice"] == A_OBJECTS(w) and w.after["bob"] == B_OBJECTS(w)


def test_no_policy_for_anon_or_public_exists_on_previews(world):
    w = world
    for name, cmd, roles, qual, check in w.policies_after_second:
        if "'previews'" in (qual or "") + (check or ""):
            assert roles == "{authenticated}", name


# ── a differently named broad policy ────────────────────────────────────────

def test_other_broad_previews_policies_are_dropped_and_the_rest_survive(world):
    w = world
    with as_superuser(w.conn, commit=False) as s:
        # Drift of every shape the dashboard can produce.
        create_policy(s, DRIFT, "for select to authenticated using (bucket_id = 'previews')")
        create_policy(s, "Allow read 1abc_0", "for select using (bucket_id = 'previews')")
        create_policy(s, "Allow any 2xyz_1", "for select to authenticated using (bucket_id = ANY (ARRAY['previews'::text, 'x']))")
        create_policy(s, "check only 3", "for all to authenticated using (auth.uid() is not null) with check (bucket_id = 'previews')")
        create_policy(s, "all 4", "for all to authenticated using (bucket_id = 'previews') with check (bucket_id = 'previews')")
        create_policy(s, "Brace 6", "for select to authenticated using (bucket_id = ANY ('{previews,x}'))")
        create_policy(s, "Mixed 5", "for select to authenticated using (bucket_id = 'previews' or bucket_id = 'avatars')")
        # What must survive.
        create_policy(s, "scoped extra", "for select to authenticated using (bucket_id = 'previews' and "
                                         "(storage.foldername(name))[1] in (select public.accessible_channel_ids('viewer')))")
        create_policy(s, "admin only", "for select to authenticated using (bucket_id = 'previews' and (select public.is_platform_admin()))")
        create_policy(s, "avatars wide", "for select to authenticated using (bucket_id = 'avatars')")
        create_policy(s, "other bucket", "for select to authenticated using (bucket_id = 'publish-staging')")
        create_policy(s, "voice wide", "for select to anon using (bucket_id = 'voice-previews')")
        create_policy(s, "previews insert", "for insert to authenticated with check (bucket_id = 'previews')")
        create_policy(s, "previews update", "for update to authenticated using (bucket_id = 'previews')")
        create_policy(s, "mfa guard", "as restrictive for select to authenticated using (bucket_id <> 'previews' or auth.uid() is not null)")
        assert offenders(s) == ["Allow any 2xyz_1", "Allow read 1abc_0", "Brace 6", "Mixed 5", "all 4", "check only 3", DRIFT]

        w.notices.clear()
        s.conn.execute(migration_sql())
        s.conn.execute(migration_sql())
        after = {r[0] for r in s.rows("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'")}
        assert offenders(s) == []
        gone = {"Allow read 1abc_0", "Allow any 2xyz_1", "Brace 6", "check only 3", "all 4", "Mixed 5", DRIFT}
        assert not (gone & after), gone & after
        kept = {"scoped extra", "admin only", "avatars wide", "other bucket", "voice wide",
                "previews insert", "previews update", "mfa guard", "previews_read", "voice_previews_read"}
        assert kept <= after, kept - after
        dropped_notes = sorted(m for m in w.notices if m.startswith("0098: dropping policy "))
        assert len(dropped_notes) == 6  # DRIFT went by name; the six others by the catalog lookup
        assert all(m.endswith(" on storage.objects (names bucket previews, no tenant scoping)") for m in dropped_notes)
        # Reads are tenant-scoped again with all of that planted.
        for who, expect in ((w.sc.alice.actor, A_OBJECTS(w)), (w.sc.bob.actor, B_OBJECTS(w))):
            with acting(w.conn, who) as as_who:
                assert names(as_who, "previews") == expect, who.name


def test_a_broad_policy_with_the_scoped_name_is_replaced_by_the_scoped_one(world):
    w = world
    with as_superuser(w.conn, commit=False) as s:
        s.conn.execute("drop policy previews_read on storage.objects")
        create_policy(s, "previews_read", "for select to authenticated using (bucket_id = 'previews')")
        assert offenders(s) == ["previews_read"]  # same name: the catalog test sees it, the DO block skips the name
        s.conn.execute(migration_sql())
        assert offenders(s) == []
        assert "accessible_channel_ids" in s.value("select qual from pg_policies where schemaname = 'storage' "
                                                   "and policyname = 'previews_read'")


def test_a_missing_scoped_rule_is_put_back_so_the_owner_can_read_again(world):
    w = world
    with as_superuser(w.conn, commit=False) as s:
        s.conn.execute("drop policy previews_read on storage.objects")
        with acting(w.conn, w.sc.alice.actor) as as_alice:
            assert names(as_alice, "previews") == []  # no policy, no rows: the drop left the owner locked out
        s.conn.execute(migration_sql())
        with acting(w.conn, w.sc.alice.actor) as as_alice:
            assert names(as_alice, "previews") == A_OBJECTS(w)
        with acting(w.conn, w.sc.bob.actor) as as_bob:
            assert names(as_bob, "previews") == B_OBJECTS(w)


def test_a_restrictive_policy_that_names_previews_is_never_dropped(world):
    w = world
    with as_superuser(w.conn, commit=False) as s:
        create_policy(s, "mfa guard", "as restrictive for select to authenticated using (bucket_id <> 'previews' or auth.uid() is not null)")
        create_policy(s, "mfa all", "as restrictive for all to authenticated using (bucket_id = 'previews' and auth.uid() is not null)")
        assert offenders(s) == []  # the heuristic (and so the migration) skips RESTRICTIVE
        s.conn.execute(migration_sql())
        assert {"mfa guard", "mfa all"} <= {r[0] for r in s.rows(POLICIES_NAMES)}
        # They are not in this repo, so the allowlist verify still lists them for a human to read.
        assert strays(s) == ["mfa all", "mfa guard"]


# Documented limitations: forms the heuristic does NOT drop. Each one leaves a
# live leak after the migration (the scoped previews_read does not remove other
# permissive policies), which is why the owner's primary check is the strict
# allowlist query, and why these are pinned here: if step 2 ever learns one of
# them, move it to the dropped cases above.
SURVIVORS = {
    "not-equal": "for select to authenticated using (bucket_id <> 'avatars')",
    "like": "for select to authenticated using (bucket_id like 'prev%')",
    "regex": "for select to authenticated using (bucket_id ~ '^prev')",
    "concat": "for select to authenticated using (bucket_id = 'prev' || 'iews')",
    "subselect": "for select to authenticated using (bucket_id in (select id from storage.buckets where public is not true))",
    "no bucket test": "for select to authenticated using (auth.uid() is not null)",
    "or scoped fn": "for select to authenticated using (bucket_id = 'previews' or (storage.foldername(name))[1] in "
                    "(select public.accessible_channel_ids('viewer')))",
    "or-first scoped fn": "for select to authenticated using ((select public.is_platform_admin()) or true or bucket_id = 'previews')",
    "and admin or true": "for select to authenticated using (bucket_id = 'previews' and ((select public.is_platform_admin()) or true))",
}


@pytest.mark.parametrize("label", sorted(SURVIVORS))
def test_documented_limitation_the_heuristic_keeps_this_form_but_the_allowlist_catches_it(world, label):
    w = world
    name = f"survivor {label}"
    with as_superuser(w.conn, commit=False) as s:
        create_policy(s, name, SURVIVORS[label])
        s.conn.execute(migration_sql())
        s.conn.execute(migration_sql())
        assert name in {r[0] for r in s.rows(POLICIES_NAMES)}, "the migration now drops this form: move it to the dropped cases"
        assert name not in offenders(s)
        assert strays(s) == [name]  # the primary verify sees it
        # and the scoped rule is back next to it
        assert "previews_read" in {r[0] for r in s.rows(POLICIES_NAMES)}


# ── statement by statement ──────────────────────────────────────────────────

def test_the_migration_is_a_guard_and_four_statements_and_each_runs_alone(world):
    w = world
    parts = statements(migration_sql())
    assert len(parts) == 5, [p.splitlines()[0] for p in parts]
    guard, exact, dynamic = parts[0], parts[1], parts[2]
    assert exact == f'drop policy if exists "{DRIFT}" on storage.objects;'
    assert parts[3] == "drop policy if exists previews_read on storage.objects;"
    assert parts[4].startswith("create policy previews_read on storage.objects")
    # Each alone, from the drifted state: exact drop only.
    with as_superuser(w.conn, commit=False) as s:
        create_policy(s, DRIFT, "for select to authenticated using (bucket_id = 'previews')")
        s.conn.execute(exact)
        s.conn.execute(exact)
        assert DRIFT not in [r[0] for r in s.rows(POLICIES)]
    # The dynamic block alone, a differently named policy and none of the rest.
    with as_superuser(w.conn, commit=False) as s:
        create_policy(s, "Allow read 1abc_0", "for select to authenticated using (bucket_id = 'previews')")
        s.conn.execute(dynamic)
        s.conn.execute(dynamic)
        assert offenders(s) == []
        assert "previews_read" in [r[0] for r in s.rows(POLICIES)]
    # The re-assert alone: the scoped rule comes back after someone removed it.
    with as_superuser(w.conn, commit=False) as s:
        s.conn.execute("drop policy previews_read on storage.objects")
        for _ in range(2):
            for stmt in parts[3:]:
                s.conn.execute(stmt)
        assert "accessible_channel_ids" in s.value("select qual from pg_policies where schemaname = 'storage' and policyname = 'previews_read'")
    # The guard alone is harmless.
    with as_superuser(w.conn, commit=False) as s:
        s.conn.execute(guard)


def test_the_catalog_test_itself_would_see_a_reintroduced_policy(world):
    w = world
    with as_superuser(w.conn, commit=False) as s:
        assert offenders(s) == []
        create_policy(s, "Allow read 9zz_0", "for select to authenticated using (bucket_id = 'previews')")
        assert offenders(s) == ["Allow read 9zz_0"]


# ── the repo's own migrations, all applied ─────────────────────────────────

def test_after_all_migrations_no_policy_reaches_previews_without_tenant_scoping(conn):
    """The catalog check: whichever migration comes later, none may leave a
    SELECT/ALL policy that names the previews bucket without calling
    accessible_channel_ids() / is_platform_admin() in the same expression, and
    none may read storage.objects without naming a bucket at all."""
    with as_superuser(conn, commit=False) as s:
        assert [r[0] for r in s.rows(OFFENDERS)] == []
        assert [r[0] for r in s.rows(NO_BUCKET)] == []
        assert strays(s) == []  # the strict allowlist: nothing but the repo's own policies
        assert s.rows(NON_OBJECTS) == []
        scoped = s.rows("select policyname, roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects' "
                        "and qual like '%''previews''%'")
    assert scoped == [("previews_read", "{authenticated}")]


def test_the_lab_has_the_migration_applied_so_the_scoped_rule_is_the_only_previews_reader(conn):
    assert (MIGRATIONS / MIGRATION).exists()
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from pg_policies where schemaname = 'storage' and policyname = %s", [DRIFT]) == 0


def test_the_review_link_policy_is_anon_select_only_and_limited_to_the_read_operations(conn):
    """0101's one anon policy on storage.objects: a SELECT policy also serves sign, list and info, so it must carry the
    operation limit. Pinned exactly (a loosened or `... or true` form fails here); the behaviour is attacked in
    test_sec_review_links.py."""
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select policyname, cmd, roles::text, permissive, qual, with_check from pg_policies "
                      "where schemaname = 'storage' and tablename = 'objects' and roles::text like '%anon%' "
                      # 0117's four RESTRICTIVE closers for the voice-samples bucket name anon too: they only ever narrow
                      "and policyname not like 'voice\\_samples\\_closed\\_%'")
    assert rows == [("previews_review_link_read", "SELECT", "{anon}", "PERMISSIVE",
                     "(review_link_allows(bucket_id, name) AND storage.allow_any_operation("
                     "ARRAY['object.get_authenticated'::text, 'object.get_authenticated_info'::text]))", None)]
