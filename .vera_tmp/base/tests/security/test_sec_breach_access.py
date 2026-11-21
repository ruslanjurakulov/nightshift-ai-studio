"""Breach-B (data access and privilege) red-team battery for 0034–0058.

Who can read or change what: cross-org (BOLA/IDOR) through every RPC the recent
migrations added, the viewer/editor/owner/platform-admin boundary on each write
path, and a customer reaching operator-only data through direct RPC or REST
rather than the UI.

Every attack here was run against the lab and REFUSED, so each test asserts the
secure outcome and passes. A regression that opens one of these holes turns the
matching test red; a genuinely open hole would instead be an xfail(strict) with
a BR-B-NNN note in security-inbox. None was found: the tries/refusals are in
security-inbox/BR-B-SUMMARY.md.

Bob (org B) is the attacker and Alice (org A) the victim throughout, matching
test_sec_attacks.py; Dana is a viewer of the operator's default organization.
"""

from __future__ import annotations

import json
import uuid

import pytest

from sec_db import ANON, acting, as_superuser
from sec_scenario import DEFAULT_ORG
from sec_storyboard_0057 import STORYBOARD


# ── handles the attacks need, read once as the owner ─────────────────────────

@pytest.fixture(scope="module")
def ids(conn, sc):
    """Victim (org A) and attacker (org B) object ids, by the ground truth."""
    with as_superuser(conn, commit=False) as s:
        def one(q, p):
            r = s.rows(q, p)
            return str(r[0][0]) if r else None
        return {
            "a_kit": one("select id from public.style_kits where org_id=%s limit 1", [sc.alice.org]),
            "a_char": one("select id from public.characters where org_id=%s limit 1", [sc.alice.org]),
            "b_kit": one("select id from public.style_kits where org_id=%s limit 1", [sc.bob.org]),
            "b_char": one("select id from public.characters where org_id=%s limit 1", [sc.bob.org]),
            "a_folder": one("select id from public.media_folders where org_id=%s limit 1", [sc.alice.org]),
            "b_folder": one("select id from public.media_folders where org_id=%s limit 1", [sc.bob.org]),
            "a_project": one("select id from public.editor_projects where org_id=%s limit 1", [sc.alice.org]),
        }


def refused(out) -> bool:
    """Postgres said no (privilege / policy / trigger / not-found), or the write
    touched nothing."""
    return (not out.ok) or out.rowcount == 0


# ── 1. cross-org (BOLA/IDOR): every recent RPC refuses another org ───────────
# Bob holds a real account and real ids of his own; he passes Alice's ids. A
# function that only checked "is Bob a member of SOME org" rather than "does
# this child object belong to the org Bob named" would leak or corrupt org A.

def _attacks(sc, ids):
    a, b = sc.alice, sc.bob
    cases = {
        # 0056 Channel DNA — another org's channel, kit, or character.
        "dna_on_As_channel":
            ("select public.set_channel_dna(%s,null,null,null,null,null,null,null)", [a.channel]),
        "dna_with_As_kit":
            ("select public.set_channel_dna(%s,%s,null,null,null,null,null,null)", [b.channel, ids["a_kit"]]),
        "dna_with_As_character":
            ("select public.set_channel_dna(%s,null,%s,null,null,null,null,null)", [b.channel, [ids["a_char"]]]),
        # 0049/0051 media folders — move/upload across the org line.
        "move_As_asset_into_B_folder":
            ("select public.move_media_assets(%s,%s,%s)", [b.org, ids["b_folder"], [a.media_asset]]),
        "move_B_asset_into_As_folder":
            ("select public.move_media_assets(%s,%s,%s)", [b.org, ids["a_folder"], [b.media_asset]]),
        "move_with_As_org":
            ("select public.move_media_assets(%s,null,%s)", [a.org, [a.media_asset]]),
        "rename_As_folder":
            ("select public.save_media_folder(%s,%s,'pwned')", [b.org, ids["a_folder"]]),
        "delete_As_folder":
            ("select public.delete_media_folder(%s,%s)", [b.org, ids["a_folder"]]),
        "upload_into_As_folder":
            ("select public.request_upload(%s,'x.png','image/png',100,null,%s)", [b.org, ids["a_folder"]]),
        "upload_with_As_org":
            ("select public.request_upload(%s,'x.png','image/png',100,null,null)", [a.org]),
        # 0054 editor — another org's project, or a doc naming its files.
        "create_project_in_As_org":
            ("select public.create_editor_project(%s,'t',%s::jsonb)", [a.org, json.dumps({"version": 1, "tracks": []})]),
        "project_doc_names_As_asset":
            ("select public.create_editor_project(%s,'t',%s::jsonb)",
             [b.org, json.dumps({"version": 1, "tracks": [{"clips": [{"asset_id": str(a.media_asset)}]}]})]),
        "save_As_project":
            ("select public.save_editor_project(%s,1,'t',null)", [ids["a_project"]]),
        "export_As_project":
            ("select public.request_editor_export(%s,1)", [ids["a_project"]]),
        "delete_As_project":
            ("select public.delete_editor_project(%s)", [ids["a_project"]]),
        # 0057/0058 storyboards — edit/approve/reopen/inspect another org's.
        "save_edits_on_As_storyboard":
            ("select public.save_storyboard_edits(%s,0,%s::jsonb)",
             [STORYBOARD["a"], json.dumps([{"src": 1, "narration": "pwned", "visual": ""}])]),
        "approve_As_storyboard":
            ("select public.approve_storyboard_at(%s,0,1,'queue')", [STORYBOARD["a"]]),
        "reopen_As_storyboard":
            ("select public.reopen_storyboard(%s)", [STORYBOARD["a"]]),
        "reopen_check_As_storyboard":
            ("select public.storyboard_reopen_check(%s)", [STORYBOARD["a"]]),
        "discard_As_storyboard":
            ("select public.discard_storyboard(%s)", [STORYBOARD["a"]]),
    }
    return cases


@pytest.mark.parametrize("name", [
    "dna_on_As_channel", "dna_with_As_kit", "dna_with_As_character",
    "move_As_asset_into_B_folder", "move_B_asset_into_As_folder", "move_with_As_org",
    "rename_As_folder", "delete_As_folder", "upload_into_As_folder", "upload_with_As_org",
    "create_project_in_As_org", "project_doc_names_As_asset", "save_As_project",
    "export_As_project", "delete_As_project",
    "save_edits_on_As_storyboard", "approve_As_storyboard", "reopen_As_storyboard",
    "reopen_check_As_storyboard", "discard_As_storyboard",
])
def test_bob_cannot_reach_org_a_through_any_recent_rpc(conn, sc, ids, name):
    query, params = _attacks(sc, ids)[name]
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, params)
    assert not out.ok, f"{name}: Bob reached org A ({out!r})"
    # Another org's object reads as not-found/forbidden/invalid, never a leak
    # of whether it exists through a different error.
    assert out.sqlstate in ("42501", "P0002", "NS400"), f"{name}: unexpected sqlstate {out!r}"


def test_the_positive_controls_still_work_for_bob(conn, sc, ids):
    # The isolation above is not vacuous: Bob CAN do each of these inside org B.
    with acting(conn, sc.bob.actor) as s:
        dna = s.run("select public.set_channel_dna(%s,%s,%s,null,null,null,null,null)",
                    [sc.bob.channel, ids["b_kit"], [ids["b_char"]]])
        move = s.run("select public.move_media_assets(%s,%s,%s)",
                     [sc.bob.org, ids["b_folder"], [sc.bob.media_asset]])
        proj = s.run("select public.create_editor_project(%s,'mine',%s::jsonb)",
                     [sc.bob.org, json.dumps({"version": 1, "tracks": []})])
    assert dna.ok and move.ok and proj.ok, (dna, move, proj)


# ── 2. privilege: operator-only data stays out of a customer's reach ─────────

OPERATOR_ONLY_RPCS = [
    ("report_worker_status", "select public.report_worker_status('evil','media','running','x','lab')"),
    ("sync_model_registry", "select public.sync_model_registry('[]'::jsonb)"),
    ("record_model_probe", "select public.record_model_probe('m','image.openai','v','t2i',true,null,null,1,1,'x')"),
]


@pytest.mark.parametrize("name,query", OPERATOR_ONLY_RPCS, ids=[n for n, _ in OPERATOR_ONLY_RPCS])
def test_customer_cannot_call_operator_worker_functions(conn, sc, name, query):
    # These run the platform's own infrastructure. The browser calls them over
    # the anon key exactly like any RPC, so a missing guard here is not hidden
    # by the UI. Each must refuse a signed-in customer and anon alike.
    for who in (sc.bob.actor, ANON):
        with acting(conn, who) as s:
            out = s.run(query)
        assert not out.ok and out.sqlstate == "42501", f"{name} as {who.name}: {out!r}"


OPERATOR_TABLES = [
    ("credit_prices", "insert into public.credit_prices (unit, credits_per_unit) values ('model_evil_image', 1)"),
    ("credit_prices_update", "update public.credit_prices set credits_per_unit = 0 where unit = 'video_minute'"),
    ("model_registry", "update public.model_registry set availability = 'ga' where id is not null"),
    ("api_prices", "update public.api_prices set cents = 0 where unit is not null"),
    ("worker_status", "update public.worker_status set status = 'stopped' where worker_id is not null"),
    ("model_probe_runs", "delete from public.model_probe_runs where model_id is not null"),
]


@pytest.mark.parametrize("name,query", OPERATOR_TABLES, ids=[n for n, _ in OPERATOR_TABLES])
def test_customer_cannot_write_operator_price_or_registry_tables(conn, sc, name, query):
    # The /credits price editor and /models pages are operator-only. Their data
    # must refuse a direct REST write from a customer's session (RLS), not only
    # hide the button.
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query)
    assert (not out.ok) or out.rowcount == 0, f"{name}: a customer wrote operator data ({out!r})"


# ── 3. channel DNA: nothing a browser sends overwrites publish/auth settings ──

def test_set_channel_dna_leaves_publish_and_auth_config_untouched(conn, sc):
    # agent_config carries auto publish, the publish gate and the two-person
    # rule. A DNA write touches only the voice and language keys; a stale blob
    # from a browser can never clear a safety setting on the way through.
    # Everything runs in one rolled-back transaction as Bob (the owner of his
    # own org may update his channel): no leftover for the next test file.
    with acting(conn, sc.bob.actor) as s:
        s.run("update public.channels set agent_config = coalesce(agent_config,'{}'::jsonb) || "
              "'{\"auto_publish\": false, \"publish_gate\": {\"originality\": true}, "
              "\"require_two_person_publish\": true, \"youtube_channel_id\": \"UCkeep\"}'::jsonb "
              "where channel_id = %s", [sc.bob.channel])
        s.value("select public.set_channel_dna(%s,null,null,'AbCdEfGhIjKlMnOpQrSt','en',null,null,'calm')",
                [sc.bob.channel])
        cfg = s.value("select agent_config from public.channels where channel_id = %s", [sc.bob.channel])
    assert cfg["auto_publish"] is False
    assert cfg["publish_gate"] == {"originality": True}
    assert cfg["require_two_person_publish"] is True
    assert cfg["youtube_channel_id"] == "UCkeep"
    # The two DNA keys were merged in, not a wholesale rewrite.
    assert cfg["elevenlabs_voice_id"] == "AbCdEfGhIjKlMnOpQrSt" and cfg["language"] == "English"


def test_moving_a_channel_between_orgs_drops_the_old_orgs_dna_characters(conn, sc):
    # 0056: a channel carried into another organization must not drag the old
    # org's character ids with it — the new org would otherwise read foreign
    # ids out of channel_dna_characters. The channels_dna_org_moved trigger is
    # what enforces it; this exercises the trigger directly, in one rolled-back
    # superuser transaction (no path lets a customer move a channel anyway).
    with as_superuser(conn, commit=False) as s:
        a_char = s.value("select id from public.characters where org_id = %s limit 1", [sc.alice.org])
        s.run("insert into public.channel_dna_characters (channel_id, org_id, character_id, position) "
              "values (%s, %s, %s, 0)", [sc.alice.channel, sc.alice.org, a_char])
        before = s.value("select count(*) from public.channel_dna_characters where channel_id = %s",
                         [sc.alice.channel])
        assert before == 1, "control: the character row was seeded on Alice's channel"
        s.run("update public.channels set org_id = %s where channel_id = %s", [sc.bob.org, sc.alice.channel])
        left = s.rows("select org_id::text from public.channel_dna_characters where channel_id = %s",
                      [sc.alice.channel])
    assert left == [], f"the old org's DNA characters survived the move into org B: {left}"


# ── 4. the default (operator) organization is nobody else's write target ─────

def test_customer_cannot_act_on_the_operator_default_org_through_rpcs(conn, sc):
    # Bob names the operator's default org to the org-scoped RPCs. He is not a
    # member, so each refuses before it looks anything up.
    for query, params in [
        ("select public.create_editor_project(%s,'t',%s::jsonb)", [DEFAULT_ORG, json.dumps({"version": 1, "tracks": []})]),
        ("select public.move_media_assets(%s,null,%s)", [DEFAULT_ORG, [str(uuid.uuid4())]]),
        ("select public.request_upload(%s,'x.png','image/png',100,null,null)", [DEFAULT_ORG]),
        ("select public.save_media_folder(%s,null,'x')", [DEFAULT_ORG]),
    ]:
        with acting(conn, sc.bob.actor) as s:
            out = s.run(query, params)
        assert not out.ok and out.sqlstate == "42501", (query, out)
