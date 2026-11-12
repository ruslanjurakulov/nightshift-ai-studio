"""Migration 0135 (Character Studio): priced character swaps on a model the person chooses, the consent trail, the gallery's cards.

The table-by-table isolation tests already prove that Bob (org B) cannot read, change, delete, move or insert Alice's (org A) jobs and
consents, and that nobody reads the models or the settings. These prove the paths where the rule lives in plpgsql, a check or an index:

  * who may call which function: four for a signed-in member (each checks the role itself), four for the worker's key only, nine for nobody;
  * cross-organization: another organization's video, picture, consent, project or job is refused or reads as not found, and learns nothing;
  * consent: no swap without a consent of the same person, organization, model, video and pictures (in order), fresh and unused; the five
    declarations; the trail cannot be changed or deleted by anyone; the prompt's keyword screen; Seedance only for an own generated clip;
  * money at job_minimum = 30: the charge is the database's (the vendor's rate x whole seconds x credits_per_usd), the hold is raised to 30,
    a finish captures exactly the charge, every failure, a cancel and the stale sweeps release the hold, a replay holds nothing twice,
    a higher charge than the one confirmed is refused, a confirmed price that is not a number is refused, an empty account refuses first;
  * the caps: one job in flight per organization, the organization's day, the platform's day and its jobs in flight;
  * the worker: the vendor task is recorded before a finish is possible, one job is one task, a quiet worker's task is resumed (never
    submitted again), an output must be this job's own generated video;
  * races: concurrent presses hold once, concurrent cancels and claims never deadlock;
  * pins: a replay, a hand-changed body, the rollback (refuses while rows exist or a job is in flight, removes everything, 0135 applies again),
    and that 0135 touches no object it did not add.

Everything runs inside transactions that are rolled back, except the races (real concurrent transactions that clean up after themselves)
and the test that needs a database of its own. Nothing calls a vendor.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db
from sec_character_swap_0135 import (CANCEL, CONSENT, CONSENT_FN, DECLARATIONS, JOB, KLING, OUTPUT, PICTURE, PROMPT, QUOTE, REQUEST, SEEDANCE,
                                     VIDEO, WORKER, asset, output)
from sec_db import ANON, SERVICE, Outcome, as_superuser, user
from test_sec_series_tables import _dsn, become, denied, forbidden, not_found

MIGRATION = sec_db.MIGRATION_0135
ROLLBACK = sec_db.ROLLBACK_0135

CONTENT = ("character_swap_jobs", "character_swap_consents")
CLOSED = ("character_swap_models", "character_swap_settings")
GALLERY = ("character_swap_templates", "character_swap_template_samples")
MEMBER = {
    "quote_character_swap": "public.quote_character_swap(uuid,uuid,text)",
    "record_character_swap_consent": "public.record_character_swap_consent(uuid,text,uuid,uuid[],jsonb,text)",
    "request_character_swap": "public.request_character_swap(uuid,uuid,uuid,uuid[],text,text,text,uuid,numeric,text)",
    "cancel_character_swap": "public.cancel_character_swap(uuid)",
}
WORKER_FNS = {
    "claim_character_swap": "public.claim_character_swap(text)",
    "record_character_swap_task": "public.record_character_swap_task(uuid,text,text)",
    "finish_character_swap": "public.finish_character_swap(uuid,text,uuid)",
    "fail_character_swap": "public.fail_character_swap(uuid,text,text)",
}
INTERNAL = {
    "character_swap_prompt_patterns": "public.character_swap_prompt_patterns()",
    "character_swap_norm": "public.character_swap_norm(text)",
    "character_swap_prompt_problem": "public.character_swap_prompt_problem(text)",
    "character_swap_declarations_problem": "public.character_swap_declarations_problem(jsonb)",
    "character_swap_settings_guard": "public.character_swap_settings_guard()",
    "character_swap_settings_trail": "public.character_swap_settings_trail()",
    "character_swap_append_only": "public.character_swap_append_only()",
    "character_swap_charge": "public.character_swap_charge(text,text,numeric)",
    "character_swap_hold": "public.character_swap_hold(numeric)",
    "character_swap_input_problem": "public.character_swap_input_problem(uuid,text,uuid,uuid[])",
    "character_swap_end_locked": "public.character_swap_end_locked(uuid,text,text)",
    "character_swap_sweep": "public.character_swap_sweep(uuid)",
}
ALL = {**MEMBER, **WORKER_FNS, **INTERNAL}
INVOKERS = {"character_swap_prompt_patterns", "character_swap_norm", "character_swap_prompt_problem", "character_swap_declarations_problem",
            "character_swap_settings_guard", "character_swap_append_only"}
API_ROLES = ("anon", "authenticated", "service_role")


def migration_body() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def rollback_body() -> str:
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def call(s, query, params=None):
    """Like Session.run, and the DETAIL of a refusal beside it."""
    try:
        with s.conn.transaction():
            cur = s.conn.execute(query, params)
            rows = cur.fetchall() if cur.description else []
            return Outcome(True, cur.rowcount, rows), ""
    except psycopg.Error as e:
        return Outcome(False, sqlstate=e.sqlstate, error=str(e).strip().splitlines()[0]), (e.diag.message_detail or "")


def refused(out, state, word):
    return not out.ok and out.sqlstate == state and out.error == word


def key() -> str:
    return f"press-{uuid.uuid4().hex}"


def price(s, credits_per_usd, model=KLING):
    """The owner's edit, in the SQL editor."""
    become(s, None)
    s.rows("update public.character_swap_models set credits_per_usd = %s where model_id = %s returning 1", [credits_per_usd, model])


def settings(s, **numbers):
    become(s, None)
    for col, n in numbers.items():
        s.rows(f"update public.character_swap_settings set {col} = %s returning 1", [n])


def job_minimum(s, n):
    become(s, None)
    s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', %s, 0) "
           "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit returning 1", [n])


def counts(s):
    become(s, None)
    out = {t: s.value(f"select count(*) from public.{t}") for t in CONTENT}
    out["holds"] = s.value("select count(*) from public.credit_reservations")
    return out


class Org:
    """A fresh organization inside the test's transaction: an owner, an editor, a viewer, credits, a 10 s video and two pictures."""

    def __init__(self, s, credits=100, seconds=10):
        self.s = s
        self.id = str(uuid.uuid4())
        become(s, None)
        s.rows("insert into public.organizations (id, name, slug) values (%s, 'Swap lab', %s) returning 1", [self.id, f"swap-{self.id[:8]}"])
        self.owner = self._member("owner")
        self.ed = self._member("editor")
        self.viewer = self._member("viewer")
        if credits:
            become(s, None)
            s.value("select public.grant_credits(%s, %s, 'swap lab')", [self.id, credits])
        self.video = asset(s, self.id, "video", seconds=seconds)
        self.pics = [asset(s, self.id, "image"), asset(s, self.id, "image")]

    def _member(self, role):
        who = user(f"swap-{role}", f"swap-{role}-{uuid.uuid4().hex[:6]}@swap.test")
        become(self.s, None)
        self.s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
        self.s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [self.id, who.uid, who.email, role])
        return who

    def account(self):
        become(self.s, None)
        return self.s.rows("select balance, reserved from public.credit_accounts where org_id = %s", [self.id])[0]


def consent(s, org, *, who=None, model=KLING, video=None, pics=None, decl=None, version="v1"):
    become(s, who or org.ed)
    return s.run(CONSENT_FN, [org.id, model, video or org.video, pics if pics is not None else org.pics[:1],
                              json.dumps(DECLARATIONS if decl is None else decl), version])


def swap(s, org, *, who=None, model=KLING, video=None, pics=None, prompt=PROMPT, res="720p", consent_id=None, max_credits=1000, idem="",
         project=None):
    """Ask for a swap as ``who`` (the editor), with a fresh consent of the same inputs unless one is given."""
    video = video or org.video
    pics = pics if pics is not None else org.pics[:1]
    if consent_id is None:
        c = consent(s, org, who=who, model=model, video=video, pics=pics)
        assert c.ok, c
        consent_id = c.rows[0][0]["id"]
    become(s, who or org.ed)
    return s.run(REQUEST, [org.id, project, video, pics, prompt, model, res, consent_id, max_credits, key() if idem == "" else idem])


def started(s, org, **kw):
    out = swap(s, org, **kw)
    assert out.ok, out
    return out.rows[0][0]["id"]


def claim(s, worker=WORKER):
    become(s, SERVICE)
    return s.value("select public.claim_character_swap(%s)", [worker])


def task(s, jid, tid="task-1", worker=WORKER):
    become(s, SERVICE)
    return s.run("select public.record_character_swap_task(%s, %s, %s)", [jid, worker, tid])


def finish(s, jid, out_id, worker=WORKER):
    become(s, SERVICE)
    return s.run("select public.finish_character_swap(%s, %s, %s)", [jid, worker, out_id])


def fail(s, jid, code="vendor_failed", worker=WORKER):
    become(s, SERVICE)
    return s.run("select public.fail_character_swap(%s, %s, %s)", [jid, worker, code])


def job(s, jid, *cols):
    become(s, None)
    return s.rows(f"select {', '.join(cols)} from public.character_swap_jobs where id = %s", [jid])[0]


def held(s, jid):
    become(s, None)
    return s.rows("select status, amount, captured from public.credit_reservations where job_id = %s", [f"cs:{jid}"])


@pytest.fixture()
def w(conn, sc):
    """A rolled-back transaction: the scenario's tenants, and a fresh organization; Kling at 10 credits per USD, job_minimum 30, and
    nothing else in the queue (a committed race left nothing behind, and the seed's jobs are finished)."""
    with as_superuser(conn, commit=False) as su:
        world = type("World", (), {})()
        world.su, world.sc = su, sc
        world.alice, world.bob, world.stranger, world.operator = sc.alice.actor, sc.bob.actor, sc.stranger, sc.operator
        world.org_a, world.org_b = sc.alice.org, sc.bob.org
        su.conn.execute("update public.character_swap_jobs set status = 'failed', error_code = 'lab', finished_at = now() "
                        "where status in ('requested', 'running')")
        job_minimum(su, 30)
        world.org = Org(su)
        price(su, 10)
        yield world


# ═══ 1. who may call what ══════════════════════════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("name", sorted(ALL))
def test_each_function_is_executable_by_exactly_its_role(conn, name):
    want = (False, True, False) if name in MEMBER else (False, False, True) if name in WORKER_FNS else (False, False, False)
    with as_superuser(conn, commit=False) as s:
        got = tuple(s.value("select has_function_privilege(%s, %s, 'execute')", [r, ALL[name]]) for r in API_ROLES)
        public = s.value("select exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = %s::regprocedure and a.grantee = 0)", [ALL[name]])
        acl, config, definer = s.rows("select proacl::text, proconfig, prosecdef from pg_proc where oid = %s::regprocedure", [ALL[name]])[0]
    assert got == want, (name, got)
    assert public is False and acl is not None, f"{name}: PUBLIC (or the default ACL) holds EXECUTE"
    assert config == ["search_path=public, pg_temp"], (name, config)
    assert definer is (name not in INVOKERS), f"{name}: security definer = {definer}"


def test_the_helpers_and_the_workers_functions_are_not_callable_by_a_member_or_anon(conn, w):
    s = w.su
    calls = ["select public.character_swap_prompt_problem('x')", "select public.character_swap_charge('kling-4.0-omni-edit', '720p', 5)",
             f"select public.character_swap_end_locked('{JOB['a']}', 'failed', 'x')", "select public.character_swap_sweep(null)",
             f"select public.character_swap_input_problem('{w.org_a}', 'kling-4.0-omni-edit', '{VIDEO['a']}', null)",
             "select public.character_swap_hold(1)",
             "select public.claim_character_swap('w')", f"select public.record_character_swap_task('{JOB['a']}', 'w', 't')",
             f"select public.finish_character_swap('{JOB['a']}', 'w', '{OUTPUT['a']}')",
             f"select public.fail_character_swap('{JOB['a']}', 'w', 'x')"]
    before = counts(s)
    for who in (w.alice, w.org.owner, w.operator, ANON):
        become(s, who)
        for q in calls:
            assert denied(s.run(q)), (who.name, q)
    become(s, SERVICE)
    for q in calls[:6]:
        assert denied(s.run(q)), ("service", q)
    assert counts(s) == before


def test_anon_and_the_service_key_can_call_none_of_the_member_functions(conn, w):
    s = w.su
    o = w.org
    calls = [(QUOTE, [o.id, o.video, "720p"]), (CONSENT_FN, [o.id, KLING, o.video, o.pics[:1], json.dumps(DECLARATIONS), "v1"]),
             (REQUEST, [o.id, None, o.video, o.pics[:1], PROMPT, KLING, "720p", CONSENT["a"], 100, key()]), (CANCEL, [JOB["a"]])]
    before = counts(s)
    for who in (ANON, SERVICE):
        become(s, who)
        for q, p in calls:
            assert denied(s.run(q, p)), (who.name, q)
    assert counts(s) == before


UPDATE_COLUMN = {"character_swap_jobs": "updated_at", "character_swap_consents": "created_at", "character_swap_models": "updated_at",
                 "character_swap_settings": "updated_at", "character_swap_templates": "created_at", "character_swap_template_samples": "made_at"}


@pytest.mark.parametrize("table", CONTENT + CLOSED + GALLERY)
def test_no_api_role_can_write_a_table_directly(conn, w, table):
    s = w.su
    for who in (w.alice, w.org.ed, ANON, SERVICE):
        become(s, who)
        if not (table == "character_swap_template_samples" and who is SERVICE):
            col = UPDATE_COLUMN[table]
            assert denied(s.run(f"insert into public.{table} select * from public.{table} limit 1")), (who.name, "insert")
            assert denied(s.run(f"update public.{table} set {col} = {col}")), (who.name, "update")
        assert denied(s.run(f"delete from public.{table}")), (who.name, "delete")
        assert denied(s.run(f"truncate public.{table}")), (who.name, "truncate")


def test_the_samples_script_writes_a_sample_with_the_service_key_and_nothing_else(conn, w):
    s = w.su
    become(s, SERVICE)
    out = s.run("update public.character_swap_template_samples set made_at = now() where model_id = %s", [KLING])
    assert out.ok and out.rowcount == 1, out
    for t in CONTENT + CLOSED + ("character_swap_templates",):
        assert denied(s.run(f"insert into public.{t} select * from public.{t} limit 1")), t


def test_prices_and_caps_are_closed_and_members_read_only_their_own_rows_and_everyone_signed_in_reads_the_gallery(conn, w):
    s = w.su
    for who in (w.alice, w.org.owner, ANON, SERVICE):
        become(s, who)
        for t in CLOSED:
            assert denied(s.run(f"select * from public.{t}")), (who.name, t)
    become(s, w.alice)
    assert s.value("select count(*) from public.character_swap_jobs where id = %s", [JOB["b"]]) == 0
    assert s.value("select count(*) from public.character_swap_consents where id = %s", [CONSENT["b"]]) == 0
    assert s.value("select count(*) from public.character_swap_jobs where id = %s", [JOB["a"]]) == 1
    become(s, w.stranger)
    assert s.value("select count(*) from public.character_swap_templates") == 2
    assert s.value("select count(*) from public.character_swap_template_samples") == 1
    become(s, ANON)
    assert denied(s.run("select * from public.character_swap_templates"))
    become(s, None)
    s.rows("update public.character_swap_templates set active = false where slug = 'two-characters' returning 1")
    become(s, w.stranger)
    assert s.value("select count(*) from public.character_swap_templates") == 1
    assert s.value("select count(*) from public.character_swap_template_samples") == 0, "a hidden card's samples are hidden with it"


# ═══ 2. another organization ═══════════════════════════════════════════════════════════════════════════════════════════════

def test_another_organization_a_viewer_and_a_stranger_are_refused_and_learn_nothing(conn, w):
    s = w.su
    o = w.org
    before = counts(s)
    for who in (w.alice, w.stranger, o.viewer):
        become(s, who)
        assert forbidden(s.run(CONSENT_FN, [o.id, KLING, o.video, o.pics[:1], json.dumps(DECLARATIONS), "v1"])), who.name
        assert forbidden(s.run(REQUEST, [o.id, None, o.video, o.pics[:1], PROMPT, KLING, "720p", CONSENT["a"], 100, key()])), who.name
    for who in (w.alice, w.stranger):
        become(s, who)
        assert forbidden(s.run(QUOTE, [o.id, o.video, "720p"])), who.name
    become(s, o.viewer)
    assert s.run(QUOTE, [o.id, o.video, "720p"]).ok, "a viewer may see the price"
    # Bob cancels Alice's job, and a made-up one: the same not_found.
    become(s, w.bob)
    assert not_found(s.run(CANCEL, [JOB["a"]])) and not_found(s.run(CANCEL, [str(uuid.uuid4())]))
    become(s, o.viewer)
    assert not_found(s.run(CANCEL, [JOB["a"]]))
    assert counts(s) == before


def test_another_organizations_video_picture_project_or_consent_cannot_be_used(conn, w):
    s = w.su
    o = w.org
    other = Org(s)
    # Alice's own org, Alice's job's video: not this org's.
    assert refused(consent(s, o, video=other.video), "NS400", "input_unavailable")
    assert refused(consent(s, o, pics=[o.pics[0], other.pics[0]]), "NS400", "references_unavailable")
    become(s, o.ed)
    assert refused(s.run(QUOTE, [o.id, other.video, "720p"]), "NS400", "input_unavailable")
    # The other organization's consent, its editor's, or a consent of other inputs.
    c_other = consent(s, other).rows[0][0]["id"]
    assert refused(swap(s, o, consent_id=c_other), "NS409", "consent_required")
    c_mine_by_owner = consent(s, o, who=o.owner).rows[0][0]["id"]
    assert refused(swap(s, o, consent_id=c_mine_by_owner), "NS409", "consent_required"), "a consent is the person's own"
    become(s, None)
    proj = s.value("insert into public.editor_projects (org_id, title, doc) values (%s, 'other', '{}'::jsonb) returning id", [other.id])
    assert refused(swap(s, o, project=str(proj)), "NS400", "project_unavailable")


# ═══ 3. consent, the words, real people ════════════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("decl,word", [
    ({**DECLARATIONS, "no_minors": False}, "declarations_incomplete"),
    ({k: v for k, v in DECLARATIONS.items() if k != "performers_consented"}, "declarations_incomplete"),
    ({**DECLARATIONS, "extra": True}, "declarations_unknown"),
    ({**DECLARATIONS, "rights_to_video": "true"}, "declarations_incomplete"),
    ([], "declarations_shape"),
])
def test_all_five_declarations_and_nothing_else(conn, w, decl, word):
    assert refused(consent(w.su, w.org, decl=decl), "NS400", word)


def test_a_stale_consent_text_version_is_refused(conn, w):
    assert refused(consent(w.su, w.org, version="v0"), "NS409", "consent_version_stale")
    assert refused(consent(w.su, w.org, version="v2"), "NS409", "consent_version_stale")


def test_a_consent_covers_exactly_its_inputs_in_order_within_the_hour_and_once(conn, w):
    s = w.su
    o = w.org
    two = o.pics[:2]
    c = consent(s, o, pics=two).rows[0][0]["id"]
    assert refused(swap(s, o, pics=list(reversed(two)), consent_id=c, prompt=PROMPT + " And @Image 2."), "NS409", "consent_required")
    assert refused(swap(s, o, pics=two[:1], consent_id=c), "NS409", "consent_required")
    assert refused(swap(s, o, pics=two, consent_id=c, model=SEEDANCE, prompt=PROMPT + " And @Image 2."), "NS400", "needs_own_generated_clip")
    become(s, None)
    # An hour old: stale. Consents cannot be edited, so the clock is moved the only way the lab can: a consent made "earlier".
    s.conn.execute("set local session_replication_role = replica")
    assert not s.run("update public.character_swap_consents set created_at = now() - interval '2 hours' where id = %s", [c]).ok, \
        "the trail is append-only even for the database owner in replica mode"
    s.conn.execute("set local session_replication_role = origin")
    s.rows("insert into public.character_swap_consents (org_id, user_id, model_id, input_asset_id, reference_asset_ids, declarations, "
           "consent_text_version, created_at) values (%s, %s, %s, %s, %s::uuid[], %s::jsonb, 'v1', now() - interval '61 minutes') returning 1",
           [o.id, o.ed.uid, KLING, o.video, two, json.dumps(DECLARATIONS)])
    old = s.value("select id from public.character_swap_consents where org_id = %s and created_at < now() - interval '1 hour'", [o.id])
    assert refused(swap(s, o, pics=two, consent_id=str(old), prompt=PROMPT + " And @Image 2."), "NS409", "consent_required")
    jid = started(s, o, pics=two, consent_id=c, prompt=PROMPT + " And @Image 2.")
    fail_running(s, jid)
    assert refused(swap(s, o, pics=two, consent_id=c, prompt=PROMPT + " And @Image 2."), "NS409", "consent_required"), "used once"


def fail_running(s, jid):
    assert claim(s)["job_id"] == jid
    assert fail(s, jid).ok


def test_the_consent_trail_cannot_be_changed_or_deleted_by_anyone(conn, w):
    s = w.su
    become(s, None)
    for q in ("update public.character_swap_consents set consent_text_version = 'v9'", "delete from public.character_swap_consents",
              "truncate public.character_swap_consents"):
        out = s.run(q)
        assert refused(out, "42501", "the character swap consent trail is append-only"), (q, out)
    s.conn.execute("set local session_replication_role = replica")
    assert not s.run("delete from public.character_swap_consents").ok, "ENABLE ALWAYS: replica mode does not skip the trail's triggers"


def test_at_most_a_hundred_consents_per_organization_per_day(conn, w):
    s = w.su
    become(s, None)
    s.conn.execute("insert into public.character_swap_consents (org_id, user_id, model_id, input_asset_id, reference_asset_ids, declarations, "
                   "consent_text_version) select %s, %s, %s, %s, %s::uuid[], %s::jsonb, 'v1' from generate_series(1, 100)",
                   [w.org.id, w.org.ed.uid, KLING, w.org.video, w.org.pics[:1], json.dumps(DECLARATIONS)])
    assert refused(consent(s, w.org), "NS429", "consent_limit")


@pytest.mark.parametrize("prompt,word", [
    ("Replace the actor on the left with @Image 1", "prompt_real_person"),
    ("Make him look like a famous singer, @Image 1", "prompt_real_person"),
    ("Swap the kid with @Image 1", "prompt_real_person"),
    ("Deepfake the president with @Image 1", "prompt_real_person"),
    ("Замени АКТЁРА на @Image 1", "prompt_real_person"),
    ("Chap tomondagi mashhur odamni @Image 1 bilan almashtir", "prompt_real_person"),
    ("Replace the per\u200bson with @Image 1", "prompt_characters"),
    ("Replace the person with @Image 1\u202e", "prompt_characters"),
    ("Replace the person\twith @Image 1", "prompt_characters"),
    ("Replace the person with the cat", "prompt_needs_character"),
    ("   \n ", "prompt_length"),
    ("x" * 1990 + " @Image 1 xx", "prompt_length"),
])
def test_the_prompt_screen_refuses_real_people_minors_hidden_characters_and_no_character(conn, w, prompt, word):
    assert refused(swap(w.su, w.org, prompt=prompt), "NS400", word)


def test_the_python_screen_is_the_databases(conn):
    """modules/character_swap.prompt_problem answers what character_swap_prompt_problem answers, on a corpus of hits and near misses."""
    import sys
    sys.path.insert(0, str(sec_db.REPO))
    from modules.character_swap import prompt_problem
    corpus = [PROMPT, "Replace the woman on the right with @Image 2 and keep the dog", "Replace the actor with @Image 1",
              "the ACTRESS @image1", "Kidney beans @Image 1", "a kid @Image 1", "Teenage look @Image 1", "@Image 1 in the style of Tom",
              "Replace the person with the child in @Image 1", "Babysitter @Image 1", "baby @Image 1", "face swap @Image 1",
              "faceswap @Image 1", "look-alike @Image 1", "a lookalike @Image 1", "Замени певицу @Image 1", "дети @Image 1",
              "bolalar @Image 1", "bolajon @Image 1", "Prezident @Image 1", "real humans @Image 1", "realistic person @Image 1",
              "a\u00adb @Image 1", "a\U000e0041 @Image 1", "line\nbreak @Image 1", "cr\rbreak @Image 1", "no character", "", " ",
              "x" * 2001, "Ｆａｍｏｕｓ @Image 1", "ｆａｃｅ swap @Image 1", "school girl @Image 1", "schoolboys @Image 1"]
    with as_superuser(conn, commit=False) as s:
        got = s.value("select array_agg(public.character_swap_prompt_problem(x) order by o) from unnest(%s::text[]) with ordinality u(x, o)",
                      [corpus])
    for text, want in zip(corpus, got):
        assert prompt_problem(text) == want, (repr(text[:60]), want)


def test_seedance_takes_only_an_own_generated_bytedance_clip_of_the_last_thirty_days(conn, w):
    s = w.su
    o = w.org
    price(s, 10, SEEDANCE)
    assert refused(consent(s, o, model=SEEDANCE), "NS400", "needs_own_generated_clip"), "an upload may show real faces"
    other_vendor = asset(s, o.id, "video", source="generated", provenance={"provider": "kling"})
    assert refused(consent(s, o, model=SEEDANCE, video=other_vendor), "NS400", "needs_own_generated_clip")
    old = asset(s, o.id, "video", source="generated", provenance={"provider": "bytedance"})
    become(s, None)
    s.rows("update public.media_assets set created_at = now() - interval '31 days' where id = %s returning 1", [old])
    assert refused(consent(s, o, model=SEEDANCE, video=old), "NS400", "needs_own_generated_clip")
    # A consent made while the clip was young does not carry the request past its 30 days either.
    young = asset(s, o.id, "video", source="generated", provenance={"provider": "bytedance"})
    c = consent(s, o, model=SEEDANCE, video=young).rows[0][0]["id"]
    become(s, None)
    s.rows("update public.media_assets set created_at = now() - interval '31 days' where id = %s returning 1", [young])
    assert refused(swap(s, o, model=SEEDANCE, video=young, consent_id=c), "NS400", "needs_own_generated_clip")
    upload = asset(s, o.id, "video", source="pipeline", provenance={"provider": "bytedance"})
    assert refused(consent(s, o, model=SEEDANCE, video=upload), "NS400", "needs_own_generated_clip"), "a provenance that says so is not enough"
    own = asset(s, o.id, "video", source="generated", provenance={"provider": "bytedance"})
    # A consent declared for the other model does not cover this one.
    kling_consent = consent(s, o, model=KLING, video=own).rows[0][0]["id"]
    assert refused(swap(s, o, model=SEEDANCE, video=own, consent_id=kling_consent), "NS409", "consent_required")
    jid = started(s, o, model=SEEDANCE, video=own)
    assert job(s, jid, "model_id", "charge_credits") == (SEEDANCE, Decimal("27.6"))
    # The quote says so per model, before anything is asked.
    become(s, o.viewer)
    q = s.value(QUOTE, [o.id, o.video, "720p"])
    by = {m["model"]: m for m in q["models"]}
    assert by[SEEDANCE]["problem"] == "needs_own_generated_clip" and by[KLING]["problem"] is None


@pytest.mark.parametrize("seconds,model,word", [(2.5, KLING, "input_too_short"), (30.5, KLING, "input_too_long"),
                                                (3.5, SEEDANCE, "input_too_short"), (31, SEEDANCE, "input_too_long")])
def test_the_vendors_input_length_is_refused_before_anything_is_held(conn, w, seconds, model, word):
    s = w.su
    o = w.org
    v = asset(s, o.id, "video", seconds=seconds, source="generated", provenance={"provider": "bytedance"})
    before = counts(s)
    assert refused(consent(s, o, model=model, video=v), "NS400", word)
    assert counts(s) == before


def test_pictures_are_one_to_the_models_limit_distinct_live_images_of_the_organization(conn, w):
    s = w.su
    o = w.org
    eleven = [asset(s, o.id, "image") for _ in range(11)]
    assert refused(consent(s, o, pics=eleven), "NS400", "references_count"), "Kling takes 10"
    assert refused(consent(s, o, pics=[]), "NS400", "references_count")
    assert refused(consent(s, o, pics=[o.pics[0], o.pics[0]]), "NS400", "references_unavailable")
    assert refused(consent(s, o, pics=[o.video]), "NS400", "references_unavailable"), "a video is not a picture"
    gif = asset(s, o.id, "image", mime="image/gif")
    assert refused(consent(s, o, pics=[gif]), "NS400", "references_unavailable")
    become(s, None)
    s.rows("update public.media_assets set deleted_at = now() where id = %s returning 1", [o.pics[1]])
    assert refused(consent(s, o, pics=[o.pics[1]]), "NS400", "references_unavailable")
    assert consent(s, o, pics=eleven[:10]).ok


# ═══ 4. money ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_nothing_is_on_sale_as_shipped_and_the_quote_says_so_per_model(conn, w):
    s = w.su
    become(s, None)
    s.rows("update public.character_swap_models set credits_per_usd = null returning 1")
    become(s, w.org.viewer)
    q = s.value(QUOTE, [w.org.id, w.org.video, "1080p"])
    assert [(m["model"], m["on_sale"], m["credits"], m["hold"]) for m in q["models"]] == [(KLING, False, None, None), (SEEDANCE, False, None, None)]
    assert q["seconds"] == 10 and q["billed_seconds"] == 10
    assert refused(swap(w.su, w.org), "NS409", "not_on_sale")


def test_each_model_shows_its_own_charge_for_the_clip_length_and_resolution_and_the_hold_at_job_minimum(conn, w):
    """Kling 10 s: $1.88 (720p) / $2.82 (1080p); Seedance 10 s: $2.76 / $6.80. At 10 credits per USD and job_minimum 30."""
    s = w.su
    price(s, 10, SEEDANCE)
    become(s, w.org.viewer)
    for res, want in (("720p", {KLING: (18.8, 30), SEEDANCE: (27.6, 30)}), ("1080p", {KLING: (28.2, 30), SEEDANCE: (68, 68)})):
        q = s.value(QUOTE, [w.org.id, w.org.video, res])
        got = {m["model"]: (m["credits"], m["hold"]) for m in q["models"]}
        assert got == want, (res, got)


def test_a_fraction_of_a_second_is_billed_as_the_whole_second_and_rounded_up_to_the_cent(conn, w):
    s = w.su
    o = w.org
    v = asset(s, o.id, "video", seconds=Decimal("9.2"))
    price(s, Decimal("3.333"))
    become(s, o.viewer)
    m = s.value(QUOTE, [o.id, v, "720p"])["models"][0]
    assert m["credits"] == 6.27, "ceil(9.2) = 10 s x 0.188 x 3.333 = 6.2660 -> 6.27"
    jid = started(s, o, video=v, max_credits=Decimal("6.27"))
    assert job(s, jid, "input_seconds", "billed_seconds", "charge_credits", "hold_credits") == (Decimal("9.2"), 10, Decimal("6.27"), 30)


def test_a_request_holds_job_minimum_and_a_finish_captures_exactly_the_charge(conn, w):
    s = w.su
    o = w.org
    out = swap(s, o, max_credits=Decimal("18.8"))
    assert out.ok and out.rows[0][0]["credits"] == 18.8 and out.rows[0][0]["hold"] == 30, out
    jid = out.rows[0][0]["id"]
    assert o.account() == (100, 30) and held(s, jid) == [("open", 30, None)]
    assert claim(s)["job_id"] == jid
    assert refused(finish(s, jid, output(s, o.id, jid)), "NS409", "no_task_recorded"), "nothing is finished without a recorded vendor task"
    assert task(s, jid).ok
    got = finish(s, jid, output(s, o.id, jid))
    assert got.ok and got.rows[0][0]["charged"] == 18.8, got
    assert o.account() == (Decimal("81.2"), 0), "exactly 18.80 charged, the other 11.20 released in the same transaction"
    assert held(s, jid) == [("captured", 30, Decimal("18.8"))]
    assert job(s, jid, "status", "charged_credits") == ("ready", Decimal("18.8"))
    again = finish(s, jid, output(s, o.id, jid))
    assert again.ok and again.rows[0][0]["replayed"] is True and o.account() == (Decimal("81.2"), 0), "finishing twice charges once"


def test_the_confirmed_price_is_compared_with_the_charge_never_the_hold(conn, w):
    s = w.su
    assert swap(s, w.org, max_credits=Decimal("18.8")).ok, "18.80 confirmed is enough although 30 are held"
    become(s, None)
    s.rows("update public.character_swap_jobs set status = 'failed', error_code = 'lab', finished_at = now() where org_id = %s "
           "and status = 'requested' returning 1", [w.org.id])
    c = consent(s, w.org).rows[0][0]["id"]
    become(s, w.org.ed)
    out, detail = call(s, REQUEST, [w.org.id, None, w.org.video, w.org.pics[:1], PROMPT, KLING, "720p", c, Decimal("18.79"), key()])
    assert refused(out, "NS409", "price_changed") and detail == "charge=18.8", (out, detail)


@pytest.mark.parametrize("ceiling", [Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity"), Decimal(-1), Decimal("100000.01")])
def test_a_confirmed_price_that_is_not_a_number_in_range_is_refused_before_anything_is_written(conn, w, ceiling):
    s = w.su
    before = counts(s)
    assert refused(swap(s, w.org, max_credits=ceiling), "NS409", "price_changed")
    assert counts(s)["character_swap_jobs"] == before["character_swap_jobs"] and counts(s)["holds"] == before["holds"]


def test_a_request_without_a_confirmed_price_is_refused(conn, w):
    s = w.su
    before = counts(s)
    assert refused(swap(s, w.org, max_credits=None), "NS409", "price_changed"), "no ceiling is never 'any price'"
    assert counts(s)["character_swap_jobs"] == before["character_swap_jobs"] and w.org.account() == (100, 0)


def test_without_the_hold_available_the_refusal_names_the_hold_and_the_charge(conn, w):
    s = w.su
    poor = Org(s, credits=29)
    before = counts(s)
    c = consent(s, poor).rows[0][0]["id"]
    become(s, poor.ed)
    out, detail = call(s, REQUEST, [poor.id, None, poor.video, poor.pics[:1], PROMPT, KLING, "720p", c, 100, key()])
    assert refused(out, "NS402", "swap_hold_unavailable") and detail == "hold=30 charge=18.8", (out, detail)
    assert counts(s)["character_swap_jobs"] == before["character_swap_jobs"] and poor.account() == (29, 0)
    become(s, SERVICE)
    s.value("select public.grant_credits(%s, 1, 'lab')", [poor.id])
    assert swap(s, poor).ok, "30 available: it starts"


def test_every_failure_a_cancel_and_the_stale_sweeps_release_the_whole_hold(conn, w):
    s = w.su
    o = w.org
    # The worker's failure (a vendor refusal), after a task was recorded.
    a = started(s, o)
    claim(s)
    task(s, a)
    assert fail(s, a, "policy").ok and o.account() == (100, 0) and held(s, a)[0][0] == "released"
    assert job(s, a, "status", "error_code") == ("failed", "policy")
    # A cancel before any worker took it.
    b = started(s, o)
    assert o.account() == (100, 30)
    become(s, o.ed)
    assert s.value(CANCEL, [b])["status"] == "cancelled"
    assert o.account() == (100, 0) and job(s, b, "status", "error_code", "cancelled_by") == ("cancelled", "cancelled_by_user", uuid.UUID(o.ed.uid))
    # Nobody took it in 2 hours (the claim's sweep).
    c = started(s, o)
    become(s, None)
    s.rows("update public.character_swap_jobs set created_at = now() - interval '3 hours' where id = %s returning 1", [c])
    assert claim(s) is None
    assert job(s, c, "error_code") == ("expired",) and o.account() == (100, 0)
    # The worker went quiet BEFORE it recorded a task (the next request's sweep): worker_lost.
    d = started(s, o)
    claim(s)
    become(s, None)
    s.rows("update public.character_swap_jobs set claimed_at = now() - interval '20 minutes' where id = %s returning 1", [d])
    assert swap(s, o).ok
    assert job(s, d, "error_code") == ("worker_lost",)
    assert o.account() == (100, 30), "only the new job's hold is open"


def test_a_job_whose_hold_is_gone_or_whose_inputs_were_deleted_is_failed_by_the_claim(conn, w):
    s = w.su
    o = w.org
    a = started(s, o)
    become(s, SERVICE)
    s.value("select public.release_credits(%s)", [f"cs:{a}"])
    assert claim(s) is None and job(s, a, "error_code") == ("hold_missing",)
    b = started(s, o)
    become(s, None)
    s.rows("update public.media_assets set deleted_at = now() where id = %s returning 1", [o.pics[0]])
    assert claim(s) is None and job(s, b, "error_code") == ("input_unavailable",) and o.account() == (100, 0)


def test_the_same_press_is_the_same_job_and_the_same_key_with_other_inputs_is_a_conflict(conn, w):
    s = w.su
    o = w.org
    c = consent(s, o).rows[0][0]["id"]
    k = key()
    first = swap(s, o, consent_id=c, idem=k)
    again = swap(s, o, consent_id=c, idem=k)
    assert first.ok and again.ok and again.rows[0][0]["replayed"] is True and again.rows[0][0]["id"] == first.rows[0][0]["id"]
    assert o.account() == (100, 30), "held once"
    assert refused(swap(s, o, consent_id=c, idem=k, res="1080p"), "NS409", "idempotency_conflict")
    assert refused(swap(s, o, consent_id=c, idem=k, max_credits=999), "NS409", "idempotency_conflict")
    assert refused(swap(s, o, idem="short"), "NS400", "invalid_idempotency_key")


def test_a_free_model_holds_nothing_and_the_operators_organization_needs_a_platform_admin(conn, w):
    s = w.su
    price(s, 0)
    out = swap(s, w.org)
    assert out.ok and out.rows[0][0]["credits"] == 0 and out.rows[0][0]["hold"] == 0
    assert job(s, out.rows[0][0]["id"], "credit_ref") == (None,) and w.org.account() == (100, 0)
    become(s, None)
    exempt = s.value("select id from public.organizations where public.credits_exempt(id) limit 1")
    dana = w.sc.dana
    s.rows("update public.org_members set role = 'editor' where org_id = %s and user_id = %s returning 1", [exempt, dana.uid])
    become(s, dana)
    out, detail = call(s, REQUEST, [exempt, None, VIDEO["a"], [PICTURE["a"]], PROMPT, KLING, "720p", CONSENT["a"], 100, key()])
    assert forbidden(out) and "platform admin" in detail, (out, detail)


# ═══ 5. caps ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_one_job_in_flight_per_organization(conn, w):
    s = w.su
    started(s, w.org)
    assert refused(swap(s, w.org), "NS409", "job_in_progress")
    assert w.org.account() == (100, 30)


def test_the_organizations_day_failed_jobs_too_and_the_refusal_names_no_number(conn, w):
    s = w.su
    settings(s, org_daily_jobs=2)
    for _ in range(2):
        jid = started(s, w.org)
        become(s, w.org.ed)
        s.value(CANCEL, [jid])
    c = consent(s, w.org).rows[0][0]["id"]
    become(s, w.org.ed)
    out, detail = call(s, REQUEST, [w.org.id, None, w.org.video, w.org.pics[:1], PROMPT, KLING, "720p", c, 100, key()])
    assert refused(out, "NS429", "org_daily_limit") and detail == "", (out, detail)


def test_the_platforms_day_and_jobs_in_flight_and_the_refusal_names_no_number(conn, w):
    s = w.su
    other = Org(s)
    become(s, None)
    inflight = s.value("select count(*) from public.character_swap_jobs where status in ('requested', 'running')")
    settings(s, platform_in_flight=inflight + 1)
    started(s, w.org)
    assert refused(swap(s, other), "NS429", "platform_busy")
    settings(s, platform_in_flight=1000)
    become(s, None)
    total = s.value("select count(*) from public.character_swap_jobs where created_at > now() - interval '24 hours'")
    settings(s, platform_daily_jobs=total)
    assert refused(swap(s, other), "NS429", "platform_busy")
    assert other.account() == (100, 0), "a refused press holds nothing"


# ═══ 6. the worker ═════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_one_job_is_one_vendor_task_and_the_same_id_again_is_a_heartbeat(conn, w):
    s = w.su
    jid = started(s, w.org)
    claim(s)
    assert task(s, jid, "task-A").rows[0][0]["replayed"] is False
    become(s, None)
    s.rows("update public.character_swap_jobs set claimed_at = now() - interval '10 minutes' where id = %s returning 1", [jid])
    assert task(s, jid, "task-A").rows[0][0]["replayed"] is True
    assert job(s, jid, "claimed_at > now() - interval '1 minute'") == (True,), "the heartbeat moved claimed_at"
    assert refused(task(s, jid, "task-B"), "NS409", "task_already_recorded")
    assert refused(task(s, jid, "bad id/../x"), "NS400", "invalid_task_id")
    assert job(s, jid, "provider_task_id") == ("task-A",)


def test_a_quiet_worker_after_the_submit_is_resumed_by_the_next_claim_never_submitted_again(conn, w):
    s = w.su
    jid = started(s, w.org)
    claim(s, "worker-1")
    task(s, jid, "task-A", worker="worker-1")
    become(s, None)
    s.rows("update public.character_swap_jobs set claimed_at = now() - interval '20 minutes' where id = %s returning 1", [jid])
    got = claim(s, "worker-2")
    assert got["job_id"] == jid and got["resume"] is True and got["provider_task_id"] == "task-A", got
    assert job(s, jid, "status", "worker_id") == ("running", "worker-2")
    assert refused(task(s, jid, "task-A", worker="worker-1"), "42501", "this job belongs to another worker")
    assert finish(s, jid, output(s, w.org.id, jid), worker="worker-2").ok
    # After 6 hours from the submit the task is no longer polled: the job fails and the hold goes back.
    other = Org(s)
    j2 = started(s, other)
    claim(s, "worker-1")
    task(s, j2, "task-B", worker="worker-1")
    become(s, None)
    s.rows("update public.character_swap_jobs set claimed_at = now() - interval '20 minutes', submitted_at = now() - interval '7 hours' "
           "where id = %s returning 1", [j2])
    assert claim(s, "worker-2") is None
    assert job(s, j2, "status", "error_code") == ("failed", "worker_lost") and other.account() == (100, 0)


def test_only_the_worker_that_claimed_a_job_records_finishes_or_fails_it(conn, w):
    s = w.su
    jid = started(s, w.org)
    claim(s)
    for out in (task(s, jid, worker="other"), finish(s, jid, OUTPUT["a"], worker="other"), fail(s, jid, worker="other")):
        assert refused(out, "42501", "this job belongs to another worker"), out
    become(s, SERVICE)
    assert not_found(s.run("select public.finish_character_swap(%s, %s, %s)", [str(uuid.uuid4()), WORKER, OUTPUT["a"]]))


def test_an_output_must_be_this_jobs_own_generated_video(conn, w):
    s = w.su
    o = w.org
    jid = started(s, o)
    claim(s)
    task(s, jid)
    other = Org(s)
    bad = [output(s, other.id, jid), asset(s, o.id, "video", source="pipeline", provenance={"origin": "character_swap", "job_id": jid}),
           output(s, o.id, str(uuid.uuid4())), asset(s, o.id, "image", source="generated", provenance={"origin": "character_swap", "job_id": jid}),
           OUTPUT["a"], str(uuid.uuid4())]
    for b in bad:
        assert refused(finish(s, jid, b), "NS400", "invalid_output"), b
    assert job(s, jid, "status") == ("running",) and o.account() == (100, 30)


@pytest.mark.parametrize("code,stored", [("policy", "policy"), ("Vendor Said No!", "worker_error"), (None, "worker_error"), ("x" * 65, "worker_error")])
def test_a_failure_code_is_a_closed_word(conn, w, code, stored):
    s = w.su
    jid = started(s, w.org)
    claim(s)
    assert fail(s, jid, code).ok
    assert job(s, jid, "error_code") == (stored,)


def test_a_viewer_of_the_same_organization_cannot_cancel(conn, w):
    s = w.su
    jid = started(s, w.org)
    become(s, w.org.viewer)
    assert not_found(s.run(CANCEL, [jid])), "a viewer is told what a stranger is told"
    assert job(s, jid, "status") == ("requested",) and w.org.account() == (100, 30), "nothing changed, the hold is still open"


def test_a_running_job_cannot_be_cancelled_and_a_final_one_answers_as_it_is(conn, w):
    s = w.su
    jid = started(s, w.org)
    claim(s)
    become(s, w.org.ed)
    assert refused(s.run(CANCEL, [jid]), "NS409", "not_cancellable")
    fail(s, jid)
    become(s, w.org.ed)
    assert s.value(CANCEL, [jid]) == {"id": jid, "status": "failed", "replayed": True}


# ═══ 7. the settings rows ══════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_settings_rows_cannot_be_deleted_or_set_out_of_range_and_a_change_leaves_a_mark(conn, w):
    s = w.su
    become(s, None)
    for t in CLOSED:
        assert refused(s.run(f"delete from public.{t}"), "42501", f"{t} keeps its rows")
    assert refused(s.run("truncate public.character_swap_settings"), "42501", "character_swap_settings keeps its rows")
    # The models are referenced by every job: a truncate is refused by the foreign key before the guard is asked.
    assert not s.run("truncate public.character_swap_models").ok
    assert refused(s.run("update public.character_swap_models set model_id = 'x' where model_id = %s", [KLING]), "42501",
                   "a model id is never renamed")
    for bad in ("credits_per_usd = -1", "credits_per_usd = 10001", "usd_per_second_720p = 0", "input_seconds_max = 121",
                "references_max = 31", "real_people = 'anyone'", "source_url = 'http://x.test/'"):
        assert not s.run(f"update public.character_swap_models set {bad}").ok, bad
    for bad in ("org_daily_jobs = -1", "platform_daily_jobs = null", "platform_in_flight = 10001"):
        assert not s.run(f"update public.character_swap_settings set {bad}").ok, bad
    assert not s.run("insert into public.character_swap_settings (id) values (false)").ok
    marks = s.value("select count(*) from public.security_events where kind = 'character_swap.settings'")
    price(s, 12)
    row = s.rows("select severity, target, detail from public.security_events where kind = 'character_swap.settings' order by id desc limit 1")[0]
    assert row[0] == "warning" and row[1] == "character_swap_models" and row[2]["old"]["credits_per_usd"] == 10 and row[2]["new"]["credits_per_usd"] == 12
    price(s, 12)
    assert s.value("select count(*) from public.security_events where kind = 'character_swap.settings'") == marks + 1, "no change, no mark"
    settings(s, org_daily_jobs=3)
    assert s.value("select count(*) from public.security_events where kind = 'character_swap.settings'") == marks + 2


def test_the_seeded_vendor_rates_are_the_registrys(conn):
    import sys
    sys.path.insert(0, str(sec_db.REPO))
    reg = json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
    entries = {m["id"]: m for m in reg["models"]}
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select model_id, usd_per_second_720p, usd_per_second_1080p, input_seconds_min, input_seconds_max, references_max, "
                      "real_people, source_url from public.character_swap_models order by position")
    assert [r[0] for r in rows] == [KLING, SEEDANCE]
    for mid, p720, p1080, lo, hi, refs, people, src in rows:
        m = entries[mid]
        assert (float(p720), float(p1080)) == (m["pricing"]["variants"]["prices"]["720p"], m["pricing"]["variants"]["prices"]["1080p"]), mid
        sw = m["character_swap"]
        assert [lo, hi] == sw["input_seconds"] and refs == sw["reference_images_max"] and people == sw["real_people"], mid
        assert src == m["pricing"]["source_url"], mid


# ═══ 8. races ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

def _press(dsn, who, query, params, gate, results, i):
    try:
        with psycopg.connect(dsn) as c:
            if who is not None:
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
                c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
                c.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(who.role)))
            gate.wait(timeout=20)
            row = c.execute(query, params).fetchone()
            c.commit()
            results[i] = ("ok", row[0])
    except psycopg.Error as e:
        results[i] = (e.sqlstate, str(e).strip().splitlines()[0])


def _race(conn, calls):
    gate = threading.Barrier(len(calls))
    results = [None] * len(calls)
    threads = [threading.Thread(target=_press, args=(_dsn(conn), who, q, p, gate, results, i)) for i, (who, q, p) in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    return results


class RaceWorld:
    """Committed organizations for real concurrent transactions, each with a video, pictures and a consent per press; purged afterwards."""

    def __init__(self, conn, n=1):
        self.conn, self.orgs = conn, []
        with as_superuser(conn) as su:
            su.conn.execute("update public.character_swap_jobs set status = 'failed', error_code = 'lab', finished_at = now() "
                            "where status in ('requested', 'running')")
            # These transactions commit: job_minimum is put back as it was in purge(), so no other test of the lab sees ours.
            self.job_minimum = su.rows("select credits_per_unit, margin, note from public.credit_prices where unit = 'job_minimum'")
            job_minimum(su, 30)
            for _ in range(n):
                self.orgs.append(Org(su))
            price(su, 10)

    def consent(self, o):
        with as_superuser(self.conn) as su:
            return consent(su, o).rows[0][0]["id"]

    def purge(self):
        with as_superuser(self.conn) as su:
            su.conn.execute("set local session_replication_role = replica")
            # The consent trail's triggers are ENABLE ALWAYS: they are switched off for the purge alone, inside this transaction.
            su.conn.execute("alter table public.character_swap_consents disable trigger character_swap_consents_append_only")
            for o in self.orgs:
                for t in ("character_swap_jobs", "character_swap_consents", "credit_hold_lots", "credit_lot_moves", "credit_lots",
                          "credit_transactions", "credit_reservations", "credit_accounts", "media_assets", "org_members"):
                    if t == "credit_hold_lots":
                        su.conn.execute("delete from public.credit_hold_lots where job_id in (select job_id from public.credit_reservations where org_id = %s)", [o.id])
                    elif su.value("select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = %s and column_name = 'org_id')", [t]):
                        su.conn.execute(psycopg.sql.SQL("delete from public.{} where org_id = %s").format(psycopg.sql.Identifier(t)), [o.id])
                su.conn.execute("delete from public.organizations where id = %s", [o.id])
            su.conn.execute("alter table public.character_swap_consents enable always trigger character_swap_consents_append_only")
            su.rows("update public.character_swap_models set credits_per_usd = null returning 1")
            su.conn.execute("delete from public.credit_prices where unit = 'job_minimum'")
            for rate, margin, note in self.job_minimum:
                su.conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin, note) values ('job_minimum', %s, %s, %s)",
                                [rate, margin, note])


def test_concurrent_presses_of_one_organization_hold_once(conn, sc):
    race = RaceWorld(conn)
    o = race.orgs[0]
    try:
        c = race.consent(o)
        k = key()
        same = _race(conn, [(o.ed, REQUEST, [o.id, None, o.video, o.pics[:1], PROMPT, KLING, "720p", c, 100, k])] * 4)
        assert all(r[0] == "ok" for r in same), same
        assert sorted(r[1]["replayed"] for r in same) == [False, True, True, True]
        assert len({r[1]["id"] for r in same}) == 1
        diff = _race(conn, [(o.ed, REQUEST, [o.id, None, o.video, o.pics[:1], PROMPT, KLING, "720p", race.consent(o), 100, key()])
                            for _ in range(4)])
        assert all(r == ("NS409", "job_in_progress") for r in diff), diff
        with as_superuser(conn, commit=False) as s:
            assert s.value("select count(*) from public.character_swap_jobs where org_id = %s", [o.id]) == 1
            assert s.rows("select reserved from public.credit_accounts where org_id = %s", [o.id]) == [(30,)]
    finally:
        race.purge()


def test_concurrent_presses_of_many_organizations_cannot_pass_the_platform_cap(conn, sc):
    race = RaceWorld(conn, n=5)
    try:
        consents = [race.consent(o) for o in race.orgs]
        with as_superuser(conn) as s:
            inflight = s.value("select count(*) from public.character_swap_jobs where status in ('requested', 'running')")
            settings(s, platform_in_flight=inflight + 2)
        results = _race(conn, [(o.ed, REQUEST, [o.id, None, o.video, o.pics[:1], PROMPT, KLING, "720p", c, 100, key()])
                               for o, c in zip(race.orgs, consents)])
        ok = [r for r in results if r[0] == "ok"]
        busy = [r for r in results if r == ("NS429", "platform_busy")]
        assert len(ok) == 2 and len(busy) == 3, results
    finally:
        with as_superuser(conn) as s:
            settings(s, platform_in_flight=20)
        race.purge()


def test_a_cancel_racing_the_claim_never_deadlocks_and_ends_in_one_state(conn, sc):
    race = RaceWorld(conn)
    o = race.orgs[0]
    try:
        for _ in range(4):
            c = race.consent(o)
            with as_superuser(conn) as su:
                jid = started(su, o, consent_id=c)
            results = _race(conn, [(o.ed, CANCEL, [jid]), (SERVICE, "select public.claim_character_swap(%s)", [WORKER])])
            assert not any(r[0] in ("40P01", "55P03") for r in results), results
            with as_superuser(conn) as su:
                status = job(su, jid, "status")[0]
                assert status in ("cancelled", "running"), status
                assert (results[0][0] == "ok") or status == "running", results
                if status == "running":
                    assert fail(su, jid).ok
                assert o.account()[1] == 0, "nothing stays held"
    finally:
        race.purge()


# ═══ 9. the file ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

TABLES = list(CONTENT) + list(CLOSED) + list(GALLERY)


def fingerprint(s, ours: bool):
    become(s, None)
    names = list(ALL)
    pick = "= any (%s)" if ours else "<> all (%s)"
    return {
        "functions": s.rows(f"select p.oid::regprocedure::text, md5(p.prosrc), coalesce(p.proacl::text, ''), p.prosecdef, p.proconfig::text "
                            f"from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname {pick} order by 1", [names]),
        "tables": s.rows(f"select c.relname, coalesce(c.relacl::text, ''), c.relrowsecurity from pg_class c "
                         f"where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname {pick} order by 1", [TABLES]),
        "policies": s.rows(f"select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) from pg_policy p join pg_class c on c.oid = p.polrelid "
                           f"where c.relname {pick} order by 1, 2", [TABLES]),
        "triggers": s.rows(f"select c.relname, t.tgname, pg_get_triggerdef(t.oid), t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid "
                           f"where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname {pick} order by 1, 2", [TABLES]),
        "constraints": s.rows(f"select c.relname, k.conname, pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid = k.conrelid "
                              f"where c.relnamespace = 'public'::regnamespace and c.relname {pick} order by 1, 2", [TABLES]),
        "columns": s.rows(f"select table_name, column_name, data_type, is_nullable, coalesce(column_default, '') from information_schema.columns "
                          f"where table_schema = 'public' and table_name {pick} order by 1, ordinal_position", [TABLES]),
    }


def test_a_replay_changes_nothing_not_even_the_owners_price(conn, w):
    s = w.su
    settings(s, org_daily_jobs=7)
    before = (fingerprint(s, True), fingerprint(s, False), counts(s))
    s.conn.execute(migration_body())
    s.conn.execute(migration_body())
    assert (fingerprint(s, True), fingerprint(s, False), counts(s)) == before
    become(s, None)
    assert s.rows("select credits_per_usd from public.character_swap_models order by position") == [(10,), (None,)]
    assert s.rows("select org_daily_jobs, platform_daily_jobs, platform_in_flight from public.character_swap_settings") == [(7, 200, 20)]
    assert s.value("select count(*) from public.character_swap_templates") == 2


@pytest.mark.parametrize("name", ["request_character_swap", "finish_character_swap", "character_swap_charge", "character_swap_prompt_patterns"])
def test_the_file_refuses_a_function_of_its_name_that_somebody_changed_by_hand(conn, w, name):
    s = w.su
    become(s, None)
    definition = s.value("select pg_get_functiondef(%s::regprocedure)", [ALL[name]])
    marker = "begin" if "\nbegin" in definition else "select"
    s.conn.execute(definition.replace(marker, marker + " /* changed by hand */", 1))
    before = fingerprint(s, True)
    out = s.run(migration_body())
    assert not out.ok and "is not 0135's body" in out.error and name in out.error, out
    assert fingerprint(s, True) == before
    out = s.run(rollback_body())
    assert not out.ok and "rollback 0135" in out.error and "is not 0135's body" in out.error


def test_the_rollback_refuses_while_people_have_rows_or_a_job_is_in_flight(conn, w):
    s = w.su
    become(s, None)
    before = (fingerprint(s, True), counts(s))
    out = s.run(rollback_body())
    assert not out.ok and "the character studio tables hold" in out.error and "character_swap_rollback_delete_rows" in out.error, out
    started(s, w.org)
    become(s, None)
    s.conn.execute("set local nightshift.character_swap_rollback_delete_rows = 'yes'")
    out = s.run(rollback_body())
    assert not out.ok and "still requested or running" in out.error, out
    assert fingerprint(s, True) == before[0]


def test_the_rollback_removes_exactly_what_0135_added_and_0135_applies_again(conn, sc):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and len(re.findall(r"(?m)^commit;$", rollback)) == 1
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("update public.character_swap_jobs set status = 'failed', error_code = 'lab', finished_at = now() "
                        "where status in ('requested', 'running')")
        ours, others = fingerprint(su, True), fingerprint(su, False)
        assets = su.value("select count(*) from public.media_assets")
        sec_db.take_off_0135(su)
        assert all(v == [] for v in fingerprint(su, True).values())
        assert fingerprint(su, False) == others, "nothing that 0135 did not add was touched"
        assert su.value("select count(*) from public.media_assets") == assets, "the outputs stay in the library"
        su.conn.execute(rollback_body())
        sec_db.put_back_0135(su)
        assert fingerprint(su, True) == ours, "0135 applies again on top, to exactly what it was"
        assert su.rows("select credits_per_usd from public.character_swap_models") == [(None,), (None,)]


def test_0135_touches_no_object_it_did_not_add(conn, sc):
    admin = sec_db.admin_dsn()
    name = f"ns_swap_base_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0135_")])
        with psycopg.connect(dsn, autocommit=True) as c:
            s = sec_db.Session(c)
            assert all(v == [] for v in fingerprint(s, True).values())
            before = fingerprint(s, False)
            tables = s.value("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'")
            fns = s.value("select count(*) from pg_proc where pronamespace = 'public'::regnamespace")
            c.execute(migration_body())
            assert fingerprint(s, False) == before
            assert s.value("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'") == tables + 6
            assert s.value("select count(*) from pg_proc where pronamespace = 'public'::regnamespace") == fns + 20
    finally:
        sec_db.drop_database(admin, name)
