"""Breach on 0187: edge cases of "every file a job sends is asked about" that a mismatch between the gate and the worker would open.

Each of these was tried as a way past rights_acknowledgement_subjects / reroute_creative_job / creative_job_style and HELD on 0187;
they are pinned so a later rewrite of either side (the SQL @name reader, modules/creative_style.MENTION_RE, the reroute requester)
cannot quietly reopen one:

  * an @NAME typed in capitals, and a style kit id typed in capitals, still name the lower-case character / the kit;
  * the 16-name limit cuts the gate and the worker at the same name: the 16th distinct @name is asked about, and a 17th is neither
    asked about NOR handed out by creative_job_style;
  * a failover asks the job's REQUESTER: another member's acknowledgement of the same photo does not let it through;
  * a foreign organization's style kit id adds no subject, and the worker's style read hands out none of its pictures.

Runs on test_sec_breach_rights_ack_bypass's lab (its own scratch database, it commits).
"""
import json
import uuid

import psycopg
import pytest

from modules import creative_style as cs
from test_sec_breach_rights_ack_bypass import ORG, UA, V1, asset, create, db  # noqa: F401  (db is the module fixture)

UB = str(uuid.UUID(int=0xB1EA2))     # Bob, an editor of ORG; he acknowledges what Alice does not
ORG2 = "aaaaaaaa-0000-0000-0000-0000000b1ea9"
UC = str(uuid.UUID(int=0xB1EA3))     # Carol, owner of ORG2


@pytest.fixture(scope="module")
def lab(db):  # noqa: F811
    db.su("insert into auth.users (id, email) values (%s, 'bob@breach.lab'), (%s, 'carol@breach.lab') on conflict do nothing",
          [UB, UC])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'bob@breach.lab', 'editor') "
          "on conflict do nothing", [ORG, UB])
    db.su("insert into public.organizations (id, name, slug) values (%s, 'Other', 'org-breach-other') on conflict do nothing", [ORG2])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'carol@breach.lab', 'owner') "
          "on conflict do nothing", [ORG2, UC])
    return db


def refused_for_ack(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    assert (e.value.sqlstate, str(e.value).splitlines()[0]) == ("NS400", "acknowledgement_required"), e.value
    return str(e.value)


def drain(db, job):
    db.act("service_role", None, "select public.finish_creative_job(%s,'breach-w',false,null,null,'test_drain','drained')", [job])


def test_an_at_name_in_capitals_is_still_the_character(lab):
    photo = asset(lab, ORG)
    lab.act("authenticated", UA, "select public.save_character(%s, null, 'porter', 'character', 'the porter', %s::uuid[])",
            [ORG, [photo]])
    assert cs.mentions("hello @PORTER!") == ["porter"]
    refused_for_ack(lambda: create(lab, {"prompt": "hello @PORTER!"}, "img-refs-ack", cap="t2i"))


def test_a_style_kit_id_in_capitals_is_still_the_kit(lab):
    photos = [asset(lab, ORG) for _ in range(3)]
    kit = str(lab.act("authenticated", UA, "select public.save_style_kit(%s, null, 'caps', 'a face', %s::uuid[])",
                      [ORG, photos])[0][0])
    refused_for_ack(lambda: create(lab, {"prompt": "a portrait", "style_kit_id": kit.upper()}, "img-refs-ack", cap="t2i"))


def test_the_sixteen_name_limit_cuts_the_gate_and_the_worker_at_the_same_name(lab):
    photo = asset(lab, ORG)
    lab.act("authenticated", UA, "select public.save_character(%s, null, 'courier', 'character', 'the courier', %s::uuid[])",
            [ORG, [photo]])
    fillers = " ".join(f"@zz{i:02d}" for i in range(15))
    # The 16th distinct name: asked about.
    refused_for_ack(lambda: create(lab, {"prompt": f"{fillers} @courier"}, "img-refs-ack", cap="t2i"))
    # The 17th: not asked about, and then the worker must not hand its pictures out either.
    prompt = f"{fillers} @zz99 @courier"
    assert "courier" not in cs.mentions(prompt)
    job = create(lab, {"prompt": prompt}, "img-refs-ack", cap="t2i")["job"]["id"]
    claimed = lab.act("service_role", None, "select id::text from public.claim_creative_job('breach-w')")
    assert claimed and claimed[0][0] == job, claimed
    style = lab.act("service_role", None, "select public.creative_job_style(%s, 'breach-w')", [job])[0][0]
    drain(lab, job)
    handed = [r["asset_id"] for c in (style.get("characters") or []) for r in c.get("references") or []]
    assert photo not in handed, style


def test_a_failover_asks_the_requester_not_another_member_who_acknowledged(lab):
    photo = asset(lab, ORG)
    lab.act("authenticated", UB, "select public.acknowledge_rights('likeness_photo', %s, %s, 'en')", [V1, photo])
    params = {"duration_s": 4, "source_asset_id": photo}
    route = lab.su("select public.route_model('i2v', %s::jsonb, 'auto', %s, 'web')", [json.dumps(params), ORG])[0][0]
    assert route["model"] == "vid-first", route
    job = create(lab, params, "vid-first", mode="auto", maxc=route["credits"])["job"]   # Alice's job
    claimed = lab.act("service_role", None, "select id::text from public.claim_creative_job('breach-w')")
    assert claimed and claimed[0][0] == job["id"], claimed
    moved = lab.act("service_role", None, "select public.reroute_creative_job(%s, 'breach-w', 'unreachable')", [job["id"]])[0][0]
    drain(lab, job["id"])
    assert moved is None or moved.get("model") != "vid-needs-ack", moved


def test_another_organizations_style_kit_hands_out_nothing(lab):
    theirs = [asset(lab, ORG2) for _ in range(3)]
    kit = str(lab.act("authenticated", UC, "select public.save_style_kit(%s, null, 'theirs', 'their face', %s::uuid[])",
                      [ORG2, theirs])[0][0])
    try:
        out = create(lab, {"prompt": "a portrait", "style_kit_id": kit}, "img-refs-ack", cap="t2i")
    except psycopg.Error:
        return   # refused at create: nothing held, nothing sent
    job = out["job"]["id"]
    lab.act("service_role", None, "select public.claim_creative_job('breach-w')")
    style = lab.act("service_role", None, "select public.creative_job_style(%s, 'breach-w')", [job])[0][0]
    drain(lab, job)
    handed = [r["asset_id"] for r in ((style.get("kit") or {}).get("references") or [])]
    assert not (set(handed) & set(theirs)), style
