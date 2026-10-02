"""Breach wave 7, lane G: what a LOW-ROLE member of an organization can rewrite on
their channel row, and what the worker later believes about it (BR-G-002,
BR-G-003; fixed by migration 0086).

The attacker is an editor (or any member who can write ``channels``) of an
ordinary customer organization. ``channels`` is the one table a browser writes
straight through PostgREST: the Channels page, the Approvals page and the
channel wizard. The row is also what the render worker reads as the channel's
configuration (``modules/channels.py`` ``_load_from_supabase``), so a column the
member can write is a column the worker obeys.

Held (a passing test): a viewer writes nothing; an editor's ordinary edits work;
an editor cannot move a channel to another organization.

Fixed (0086):

* BR-G-002  ``credential_ref`` decided WHICH secret the worker published with
  (``tools/list_channels.py`` turns ``credential_ref.ref`` into
  ``CHRONOS_YT_TOKEN_<REF>``). It, ``status``, ``channel_id`` and ``created_at``
  are no longer writable by the browser roles and INSERT is revoked: the
  definer functions ``create_channel`` / ``set_channel_credential`` /
  ``set_channel_status`` are the way in. The verification stamp is written for
  the operator's own channels (by its admin) or by a trusted server caller, and
  for a customer's channel by the Google sign-in (a trigger on
  ``channel_token_refs``). A taken channel id answers one fixed error. The
  worker half is in ``tests/test_breach_wave7_worker.py``.
* BR-G-003  the controls that stand between a render and the audience
  (``agent_config.publish_gate``, ``require_two_person_publish``,
  ``storyboard_review`` and ``auto_publish``) are an administrator's: a trigger
  refuses a change by anyone else. The product decision (editors used to be
  able to flip the two-person flag and storyboard review) is flagged in the PR.

Everything runs on the shared, rolled-back scenario (conftest ``conn`` / ``sc``).
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from pathlib import Path

import pytest

from psycopg import sql

from sec_db import SERVICE, acting, as_superuser, user

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"


@contextmanager
def org_members(conn, org, roles=("viewer", "editor", "admin")):
    """A rolled-back world in which org ``org`` also has one member per role."""
    members = {}
    with as_superuser(conn, commit=False) as su:
        for role in roles:
            who = user(f"w7-{role}", f"w7-{role}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                    [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [org, who.uid, who.email, role])
            members[role] = who
        yield su, members


def become(s, who):
    """Continue the same transaction as another API caller (acting() rolls
    everything back when it ends, so a read of the outcome must happen inside)."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def stored(s, channel, column):
    """The row as the database owner sees it, in the transaction the attack ran in."""
    s.conn.execute("reset role")
    return s.value(f"select {column} from public.channels where channel_id = %s", [channel])


CREATE = "select public.create_channel(%s, %s, %s, 'travel', %s::jsonb, '{}'::jsonb, %s::jsonb, %s)"
CONFIRM = "select public.set_channel_credential(%s, %s::jsonb, true)"


# ── held ────────────────────────────────────────────────────────────────────

def test_a_viewer_changes_nothing_on_a_channel_and_creates_none(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["viewer"]) as s:
            out = s.run("update public.channels set name = 'pwned', auto_publish = true where channel_id = %s",
                        [sc.alice.channel])
            assert out.ok and out.rowcount == 0, out
            out = s.run("insert into public.channels (channel_id, name, niche, org_id) "
                        "values ('w7-viewer-chan', 'x', 'n', %s)", [sc.alice.org])
            assert not out.ok and out.sqlstate == "42501", out
            out = s.run(CREATE, ["w7-viewer-chan", sc.alice.org, "x", "{}", None, False])
            assert not out.ok and out.sqlstate == "42501", out
            assert stored(s, sc.alice.channel, "name") != "pwned"


def test_an_editor_can_still_edit_the_ordinary_fields_of_their_channel(conn, sc):
    # The control that keeps the attacks below from being vacuous.
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            out = s.run("update public.channels set name = 'Renamed', niche = 'travel', "
                        "schedule_config = '{\"enabled\": true}'::jsonb, updated_at = 'now' where channel_id = %s",
                        [sc.alice.channel])
            assert out.ok and out.rowcount == 1, out
            assert stored(s, sc.alice.channel, "name") == "Renamed"


def test_an_editor_can_write_back_an_agent_config_they_read_whole(conn, sc):
    """The Voice, Cast and Schedule editors send the whole agent_config back
    with one key changed. The controls inside it are unchanged, so it passes."""
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, sc.alice.actor) as s:   # the owner sets a control
            assert s.run("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                         [json.dumps({"storyboard_review": True, "language": "English",
                                      "publish_gate": {"fact_check": True}}), sc.alice.channel]).ok
            become(s, m["editor"])
            whole = {"storyboard_review": True, "language": "Russian", "publish_gate": {"fact_check": True},
                     "tts_provider": "edge"}
            out = s.run("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                        [json.dumps(whole), sc.alice.channel])
            assert out.ok and out.rowcount == 1, out
            assert stored(s, sc.alice.channel, "agent_config")["language"] == "Russian"


def test_an_editor_cannot_move_a_channel_into_another_organization_or_write_there(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            out = s.run("update public.channels set org_id = %s where channel_id = %s", [sc.bob.org, sc.alice.channel])
            assert not out.ok and out.sqlstate == "42501", out
            out = s.run("update public.channels set name = 'x' where channel_id = %s", [sc.bob.channel])
            assert out.ok and out.rowcount == 0, out
            out = s.run(CREATE, ["w7-into-b", sc.bob.org, "x", "{}", None, False])
            assert not out.ok and out.sqlstate == "42501", out


# ── BR-G-002: the member names the secret the worker publishes with ──────────

OPERATORS_REF = "extinct-world"   # an operator channel's secret reference (CHRONOS_YT_TOKEN_EXTINCT_WORLD)


def test_BR_G_002_an_editor_cannot_aim_their_channel_at_another_credential(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            direct = s.run("update public.channels set credential_ref = coalesce(credential_ref, '{}'::jsonb) || %s::jsonb "
                           "where channel_id = %s", [json.dumps({"ref": OPERATORS_REF}), sc.alice.channel])
            assert not direct.ok and direct.sqlstate == "42501", direct
            # Through the function the reference is the channel's own id, whatever was sent.
            out = s.run("select public.set_channel_credential(%s, %s::jsonb)",
                        [sc.alice.channel, json.dumps({"provider": "youtube", "ref": OPERATORS_REF,
                                                       "youtube_channel_id": "UCmine", "youtube_title": "Mine"})])
            assert out.ok, out
            after = stored(s, sc.alice.channel, "credential_ref")
            assert after["ref"] == sc.alice.channel, f"the member re-pointed the channel at {OPERATORS_REF!r}: {after}"
            assert after["youtube_title"] == "Mine"


def test_BR_G_002_an_admin_of_a_customer_organization_cannot_either(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["admin"]) as s:
            direct = s.run("update public.channels set credential_ref = '{\"ref\": \"extinct-world\"}'::jsonb "
                           "where channel_id = %s", [sc.alice.channel])
            assert not direct.ok and direct.sqlstate == "42501", direct
            assert s.run("select public.set_channel_credential(%s, %s::jsonb)",
                         [sc.alice.channel, json.dumps({"ref": OPERATORS_REF})]).ok
            assert stored(s, sc.alice.channel, "credential_ref")["ref"] == sc.alice.channel


def test_BR_G_002_an_editor_cannot_make_up_a_channels_verification(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        forged = {"provider": "youtube", "ref": OPERATORS_REF, "verified_at": "2026-01-01T00:00:00Z",
                  "youtube_channel_id": "UCforgedforgedforgedforg"}
        with acting(conn, m["editor"]) as s:
            # Straight into the table: no INSERT privilege, and not with the stamp either.
            direct = s.run("insert into public.channels (channel_id, name, niche, org_id, credential_ref) "
                           "values ('w7-forged', 'x', 'n', %s, %s::jsonb)", [sc.alice.org, json.dumps(forged)])
            assert not direct.ok and direct.sqlstate == "42501", direct
            status = s.run("update public.channels set status = 'ACTIVE' where channel_id = %s", [sc.alice.channel])
            assert not status.ok and status.sqlstate == "42501", status
            # Through the functions: the stamp the member typed is never copied, and asking for one is refused.
            made = s.run(CREATE, ["w7-forged", sc.alice.org, "x", "{}", json.dumps(forged), False])
            assert made.ok, made
            assert "verified_at" not in stored(s, "w7-forged", "credential_ref")
            become(s, m["editor"])
            asked = s.run(CREATE, ["w7-forged-2", sc.alice.org, "x", "{}", json.dumps(forged), True])
            assert not asked.ok and asked.sqlstate == "42501", asked
            asked = s.run(CONFIRM, [sc.alice.channel, json.dumps(forged)])
            assert not asked.ok and asked.sqlstate == "42501", asked
            # An unconfirmed channel cannot be activated, by the function either.
            act = s.run("select public.set_channel_status('w7-forged', 'ACTIVE')")
            assert not act.ok and act.sqlstate == "23514", act
            assert stored(s, "w7-forged", "status") == "PAUSED"


def test_BR_G_002_the_operators_admin_confirms_the_operators_channel_and_may_name_its_reference(conn, sc):
    """Operator behaviour keeps working: the wizard's lookup is the operator's
    own, the stamp's time is the database's, and the reference is theirs to name."""
    with acting(conn, sc.operator) as s:
        made = s.run(CREATE, ["w7-op-chan", DEFAULT_ORG, "Operator channel", "{}",
                              json.dumps({"provider": "youtube", "ref": "w7-op-secret", "youtube_channel_id": "UCop",
                                          "youtube_title": "Op", "verified_at": "1999-01-01T00:00:00Z"}), True])
        assert made.ok, made
        ref = stored(s, "w7-op-chan", "credential_ref")
        assert ref["ref"] == "w7-op-secret" and ref["youtube_channel_id"] == "UCop"
        assert re.fullmatch(r"20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", ref["verified_at"]), ref
        assert ref["verified_at"] != "1999-01-01T00:00:00Z", "the caller's time was copied"
        become(s, sc.operator)
        assert s.run("select public.set_channel_status('w7-op-chan', 'ACTIVE')").ok
        assert stored(s, "w7-op-chan", "status") == "ACTIVE"
        become(s, sc.operator)
        bad = s.run("select public.set_channel_credential(%s, %s::jsonb)", ["w7-op-chan", json.dumps({"ref": "../x"})])
        assert not bad.ok and bad.sqlstate == "22023", bad


def test_BR_G_002_a_plain_member_of_the_operators_organization_cannot_name_a_reference(conn, sc):
    with acting(conn, sc.dana) as s:   # a viewer of the default organization
        out = s.run("select public.set_channel_credential('default', %s::jsonb)", [json.dumps({"ref": "x"})])
        assert not out.ok and out.sqlstate == "42501", out
    with org_members(conn, DEFAULT_ORG, roles=("editor",)) as (_su, m):
        with acting(conn, m["editor"]) as s:
            out = s.run("select public.set_channel_credential('default', %s::jsonb)", [json.dumps({"ref": "x"})])
            assert not out.ok and out.sqlstate == "42501", out
            made = s.run(CREATE, ["w7-op-ed", DEFAULT_ORG, "x", "{}", json.dumps({"ref": "extinct-world"}), False])
            assert made.ok, made
            assert stored(s, "w7-op-ed", "credential_ref")["ref"] == "w7-op-ed", "an editor named an environment secret"


def test_BR_G_002_the_service_role_can_confirm_any_channel(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run(CONFIRM, [sc.bob.channel, json.dumps({"youtube_channel_id": "UCsvc", "youtube_title": "Svc"})])
        assert out.ok, out
        ref = stored(s, sc.bob.channel, "credential_ref")
        assert ref["youtube_channel_id"] == "UCsvc" and ref["verified_at"] and ref["ref"] == sc.bob.channel


def test_BR_G_002_changing_the_youtube_channel_drops_the_stamp_and_pauses(conn, sc):
    with acting(conn, SERVICE) as s:
        assert s.run(CONFIRM, [sc.alice.channel, json.dumps({"youtube_channel_id": "UCone"})]).ok
        s.conn.execute("update public.channels set status = 'ACTIVE' where channel_id = %s", [sc.alice.channel])
        become(s, sc.alice.actor)
        out = s.run("select public.set_channel_credential(%s, %s::jsonb)",
                    [sc.alice.channel, json.dumps({"youtube_channel_id": "UCtwo"})])
        assert out.ok, out
        ref = stored(s, sc.alice.channel, "credential_ref")
        assert "verified_at" not in ref and ref["youtube_channel_id"] == "UCtwo"
        assert stored(s, sc.alice.channel, "status") == "PAUSED"


def test_BR_G_002_the_google_sign_in_confirms_a_customers_channel(conn, sc):
    """store_channel_token (0022) is the customer's confirmation: the connection
    the Command Center's callback recorded stamps the channel, once."""
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["admin"]) as s:
            assert s.run(CREATE, ["w7-connect", sc.alice.org, "x", "{}", None, False]).ok
            assert "verified_at" not in stored(s, "w7-connect", "credential_ref")
            become(s, m["admin"])
            out = s.run("select public.store_channel_token(%s, %s, %s::jsonb)",
                        ["w7-connect", "1//" + "x" * 40,
                         json.dumps({"youtube_channel_id": "UCgranted", "youtube_channel_title": "Granted",
                                     "scopes": []})])
            assert out.ok, out
            ref = stored(s, "w7-connect", "credential_ref")
            assert ref["youtube_channel_id"] == "UCgranted" and ref["youtube_title"] == "Granted"
            assert ref["ref"] == "w7-connect" and ref["verified_at"]
            first = ref["verified_at"]
            become(s, m["admin"])
            assert s.run("select public.store_channel_token(%s, %s, %s::jsonb)",
                         ["w7-connect", "1//" + "y" * 40,
                          json.dumps({"youtube_channel_id": "UCgranted", "scopes": []})]).ok
            assert stored(s, "w7-connect", "credential_ref")["verified_at"] == first, "a second connect re-stamped it"
            become(s, m["editor"])
            assert s.run("select public.set_channel_status('w7-connect', 'ACTIVE')").ok


def test_a_taken_channel_id_gets_one_fixed_answer_whoever_holds_it(conn, sc):
    """The id of another organization's channel (the operator's included) and
    the id of the caller's own answer with the same error: it does not say whose
    it is, and a raw duplicate key (with its detail) never reaches the member.
    A free id succeeds, so existence is still inferable by collision (see the PR
    note on namespacing ids)."""
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            other = s.run(CREATE, [sc.bob.channel, sc.alice.org, "x", "{}", None, False])
            operators = s.run(CREATE, ["default", sc.alice.org, "x", "{}", None, False])
            own = s.run(CREATE, [sc.alice.channel, sc.alice.org, "x", "{}", None, False])
            free = s.run(CREATE, ["w7-free-id", sc.alice.org, "x", "{}", None, False])
            raw = s.run("insert into public.channels (channel_id, name, niche, org_id) values (%s, 'x', 'n', %s)",
                        [sc.bob.channel, sc.alice.org])
    answers = {(o.ok, o.sqlstate, o.error) for o in (other, operators, own)}
    assert answers == {(False, "23505", "that channel id is not available")}, answers
    assert free.ok
    assert not raw.ok and raw.sqlstate == "42501", raw      # no raw INSERT, so no raw duplicate-key detail


def test_a_channel_id_must_be_a_slug(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        # Trailing and double hyphens normalise to another channel's secret name (BR-L-080).
        for bad in ("Has Caps", "-lead", "x", "a" * 40, "under_score", "", "a/b", "extinct-world-", "extinct--world",
                    "extinct-world--", "a-", "a--b"):
            out = s.run(CREATE, [bad, sc.alice.org, "x", "{}", None, False])
            assert not out.ok and out.sqlstate == "22023", (bad, out)


def test_a_new_channel_is_created_paused_with_the_organizations_id_and_no_stamp(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            assert s.run(CREATE, ["w7-new", sc.alice.org, "New", json.dumps({"language": "English"}), None, False]).ok
            s.conn.execute("reset role")
            row = s.rows("select status, org_id::text, credential_ref, auto_publish, agent_config ->> 'language' "
                         "from public.channels where channel_id = 'w7-new'").pop()
            assert tuple(row) == ("PAUSED", sc.alice.org, {}, False, "English"), row


def test_the_columns_a_browser_can_write_are_exactly_the_listed_ones(conn):
    """A column added later is writable by nobody until it is granted AND listed
    here: this is the pin that makes a new column a decision."""
    with as_superuser(conn, commit=False) as su:
        cols = {r[0] for r in su.rows("select column_name from information_schema.columns "
                                       "where table_schema = 'public' and table_name = 'channels'")}
        priv = "select has_column_privilege(%s, 'public.channels', %s, %s)"
        can_update = {c for c in cols if su.value(priv, ["authenticated", c, "UPDATE"])}
        can_insert = {c for c in cols if su.value(priv, ["authenticated", c, "INSERT"])}
        anon = {c for c in cols if su.value(priv, ["anon", c, "UPDATE"]) or su.value(priv, ["anon", c, "INSERT"])}
        service = su.value("select has_table_privilege('service_role', 'public.channels', 'INSERT, UPDATE')")
    assert can_update == {"name", "niche", "agent_config", "schedule_config", "updated_at", "org_id", "auto_publish",
                          "default_style_kit_id", "dna_format", "dna_aspect", "dna_tone"}, sorted(can_update)
    assert can_insert == set(), sorted(can_insert)
    assert anon == set(), sorted(anon)
    assert not ({"credential_ref", "status", "channel_id", "created_at"} & can_update)
    assert service, "the workers' service key still writes the table"


def test_the_control_list_is_one_list(conn):
    """The trigger repeats channel_admin_controls() inline (it must not call it as
    the browser role). The two lists must be the same four keys."""
    text = (REPO / "supabase" / "migrations" / "0086_channel_config_lock.sql").read_text()
    inline = re.search(r"controls constant text\[\] := array\[(.*?)\];", text, re.S).group(1)
    fn = re.search(r"channel_admin_controls\(\) returns text\[\].*?select array\[(.*?)\]::text\[\]", text, re.S).group(1)

    def norm(s):
        return sorted(re.findall(r"'([a-z_]+)'", s))

    assert norm(inline) == norm(fn) == ["auto_publish", "publish_gate", "require_two_person_publish", "storyboard_review"]
    with as_superuser(conn, commit=False) as su:
        assert sorted(su.value("select public.channel_admin_controls()")) == norm(fn)


# ── BR-G-003: the controls that hold a render are an administrator's ─────────

#: name -> (the owner sets it, the editor changes it, the agent_config key)
CONTROLS = {
    "publish_gate": ({"publish_gate": {"originality": True, "fact_check": True}},
                     {"publish_gate": {"originality": False, "fact_check": False}}, "publish_gate"),
    "two_person": ({"require_two_person_publish": True}, {"require_two_person_publish": False},
                   "require_two_person_publish"),
    "storyboard_review": ({"storyboard_review": True}, {"storyboard_review": False}, "storyboard_review"),
    "auto_publish_key": ({"auto_publish": False}, {"auto_publish": True}, "auto_publish"),
}

MERGE = ("update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || %s::jsonb "
         "where channel_id = %s")


@pytest.mark.parametrize("name", list(CONTROLS))
def test_BR_G_003_an_editor_cannot_switch_off_the_gate_or_the_second_person(conn, sc, name):
    on, off, key = CONTROLS[name]
    with org_members(conn, sc.alice.org) as (_su, m):
        # The organization's owner turned the control on (as the Approvals / Channels pages do).
        with acting(conn, sc.alice.actor) as s:
            out = s.run(MERGE, [json.dumps(on), sc.alice.channel])
            assert out.ok and out.rowcount == 1, out
            before = (stored(s, sc.alice.channel, "agent_config") or {}).get(key)
            assert before is not None, "the owner's setting did not take; the test would be vacuous"
            # Then an editor, in the same transaction.
            become(s, m["editor"])
            refused = s.run(MERGE, [json.dumps(off), sc.alice.channel])
            assert not refused.ok and refused.sqlstate == "42501", refused
            after = (stored(s, sc.alice.channel, "agent_config") or {}).get(key)
            assert after == before, f"an editor changed {key}: {before!r} -> {after!r}"
            # The same change by an administrator of the organization goes through.
            become(s, m["admin"])
            allowed = s.run(MERGE, [json.dumps(off), sc.alice.channel])
            assert allowed.ok and allowed.rowcount == 1, allowed
            assert (stored(s, sc.alice.channel, "agent_config") or {}).get(key) == off[key]


def test_BR_G_003_an_editor_cannot_turn_auto_publish_on_but_an_admin_can(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            assert stored(s, sc.alice.channel, "auto_publish") is False
            become(s, m["editor"])
            refused = s.run("update public.channels set auto_publish = true where channel_id = %s", [sc.alice.channel])
            assert not refused.ok and refused.sqlstate == "42501", refused
            assert stored(s, sc.alice.channel, "auto_publish") is False
            become(s, m["admin"])
            assert s.run("update public.channels set auto_publish = true where channel_id = %s", [sc.alice.channel]).rowcount == 1
            assert stored(s, sc.alice.channel, "auto_publish") is True


def test_BR_G_003_a_control_cannot_be_dodged_by_replacing_the_blob_or_deleting_the_key(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, sc.alice.actor) as s:
            assert s.run(MERGE, [json.dumps({"require_two_person_publish": True}), sc.alice.channel]).ok
            become(s, m["editor"])
            for attack in ("update public.channels set agent_config = '{}'::jsonb where channel_id = %s",
                           "update public.channels set agent_config = '[]'::jsonb where channel_id = %s",
                           "update public.channels set agent_config = agent_config - 'require_two_person_publish' "
                           "where channel_id = %s",
                           "update public.channels set agent_config = jsonb_set(agent_config, '{require_two_person_publish}', 'false') "
                           "where channel_id = %s"):
                out = s.run(attack, [sc.alice.channel])
                assert not out.ok and out.sqlstate == "42501", (attack, out)
            assert stored(s, sc.alice.channel, "agent_config")["require_two_person_publish"] is True


def test_BR_G_003_an_editor_cannot_create_a_channel_with_the_controls_set(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            for cfg in ({"publish_gate": {"originality": False}}, {"require_two_person_publish": False},
                        {"storyboard_review": True}, {"auto_publish": True}):
                out = s.run(CREATE, ["w7-ctrl", sc.alice.org, "x", json.dumps(cfg), None, False])
                assert not out.ok and out.sqlstate == "42501", (cfg, out)
            become(s, m["admin"])
            assert s.run(CREATE, ["w7-ctrl", sc.alice.org, "x", json.dumps({"storyboard_review": True}), None, False]).ok


def test_BR_G_003_the_service_role_still_writes_every_column(conn, sc):
    """The workers (pipeline, supabase_sync) write channels with the service key."""
    with acting(conn, SERVICE) as s:
        out = s.run("update public.channels set agent_config = agent_config || '{\"storyboard_review\": true}'::jsonb, "
                    "auto_publish = true, status = 'PAUSED', credential_ref = credential_ref || '{\"x\": 1}'::jsonb "
                    "where channel_id = %s", [sc.alice.channel])
        assert out.ok and out.rowcount == 1, out


# ── set_channel_status ───────────────────────────────────────────────────────

def test_status_pause_is_an_editors_activation_needs_a_confirmed_channel_and_a_viewer_does_neither(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, SERVICE) as s:
            assert s.run(CONFIRM, [sc.alice.channel, json.dumps({"youtube_channel_id": "UCone"})]).ok
            become(s, m["editor"])
            assert s.value("select public.set_channel_status(%s, 'active')", [sc.alice.channel]) == "ACTIVE"
            assert s.value("select public.set_channel_status(%s, 'PAUSED')", [sc.alice.channel]) == "PAUSED"
            bad = s.run("select public.set_channel_status(%s, 'DELETED')", [sc.alice.channel])
            assert not bad.ok and bad.sqlstate == "22023", bad
            become(s, m["viewer"])
            out = s.run("select public.set_channel_status(%s, 'PAUSED')", [sc.alice.channel])
            assert not out.ok and out.sqlstate == "42501", out
            become(s, sc.bob.actor)
            out = s.run("select public.set_channel_status(%s, 'PAUSED')", [sc.alice.channel])
            assert (out.ok, out.sqlstate, out.error) == (False, "42501", "channel not found or not yours"), out
            gone = s.run("select public.set_channel_status('no-such-channel', 'PAUSED')")
            assert (gone.ok, gone.sqlstate, gone.error) == (False, "42501", "channel not found or not yours")


# ── BR-L-080: two channels never share a token-secret name ───────────────────

CORPUS = ["extinct-world", "extinct-world-", "extinct--world", "-extinct-world", "Extinct World", "extinct_world",
          "EXTINCT.WORLD", "a", "ab", "a-b-c", "a--b", "a_-_b", "  x  ", "ü-ber", "x" * 60, "", "9lives", "my.channel_1"]


def test_BR_L_080_the_secret_name_is_the_same_function_in_sql_and_python(conn):
    import sys
    sys.path.insert(0, str(REPO))
    from modules.channel_credentials import secret_name_for

    with as_superuser(conn, commit=False) as su:
        for key in CORPUS:
            # (Non-ASCII letters: Python upper() and Postgres upper() both map to non-[A-Z0-9], which collapse.)
            assert su.value("select public.channel_secret_name(%s)", [key]) == secret_name_for(key), repr(key)


def test_BR_L_080_an_id_that_shares_a_secret_name_with_any_channel_is_refused(conn, sc):
    with acting(conn, sc.operator) as s:
        assert s.run(CREATE, ["w7-op-two", DEFAULT_ORG, "Op two", "{}",
                              json.dumps({"ref": "w7_op_secret.x"}), False]).ok
        become(s, sc.alice.actor)
        for taken in ("w7-op-two", "w7-op-secret-x", "chan-b", sc.alice.channel):
            out = s.run(CREATE, [taken, sc.alice.org, "x", "{}", None, False])
            assert (out.ok, out.sqlstate, out.error) == (False, "23505", "that channel id is not available"), (taken, out)
        # A different name is fine, and the slug rule stops the hyphen variants before they can collide.
        assert s.run(CREATE, ["w7-op-secret", sc.alice.org, "x", "{}", None, False]).ok
        for variant in ("w7-op-two-", "w7--op-two"):
            out = s.run(CREATE, [variant, sc.alice.org, "x", "{}", None, False])
            assert not out.ok and out.sqlstate == "22023", (variant, out)


# ── hardening: the confirmation goes with the connection ─────────────────────

def test_BR_L_081_activation_needs_a_live_connection_and_a_revoke_clears_the_stamp(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["admin"]) as s:
            assert s.run(CREATE, ["w7-live", sc.alice.org, "x", "{}", None, False]).ok
            # Confirmed by the platform but never connected: not activatable.
            become(s, SERVICE)
            assert s.run(CONFIRM, ["w7-live", json.dumps({"youtube_channel_id": "UClive"})]).ok
            become(s, m["editor"])
            out = s.run("select public.set_channel_status('w7-live', 'ACTIVE')")
            assert not out.ok and out.sqlstate == "23514", out
            # Connected: activatable.
            become(s, m["admin"])
            assert s.run("select public.store_channel_token(%s, %s, %s::jsonb)",
                         ["w7-live", "1//" + "z" * 40,
                          json.dumps({"youtube_channel_id": "UClive", "scopes": []})]).ok
            become(s, m["editor"])
            assert s.run("select public.set_channel_status('w7-live', 'ACTIVE')").ok
            assert stored(s, "w7-live", "status") == "ACTIVE"
            # Revoked: the stamp goes, the channel is paused, and it cannot be activated again.
            become(s, m["admin"])
            assert s.run("select public.revoke_channel_token('w7-live')").ok
            assert stored(s, "w7-live", "status") == "PAUSED"
            assert "verified_at" not in stored(s, "w7-live", "credential_ref")
            become(s, m["editor"])
            out = s.run("select public.set_channel_status('w7-live', 'ACTIVE')")
            assert not out.ok and out.sqlstate == "23514", out


def test_BR_L_081_the_operators_channels_are_not_held_to_a_connection(conn, sc):
    with acting(conn, sc.operator) as s:
        assert s.run(CREATE, ["w7-op-live", DEFAULT_ORG, "Op", "{}", json.dumps({"youtube_channel_id": "UCop"}), True]).ok
        assert s.run("select public.set_channel_status('w7-op-live', 'ACTIVE')").ok
