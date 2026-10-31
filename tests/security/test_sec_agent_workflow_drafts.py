"""Fail-closed owner RLS and RPC tests for Agent Builder draft storage.

Runs in existing ephemeral security lab DB only. No production credentials.
"""
from __future__ import annotations

import json
from sec_db import acting

DOCUMENT = {
    "format": "nightshift.agent-draft",
    "layoutVersion": 1,
    "workflow": {
        "version": 1, "name": "Owner's private ad draft",
        "nodes": [
            {"id": "brand", "type": "brand.input", "label": "Brand", "config": {}},
            {"id": "prompt", "type": "prompt.compose", "label": "Prompt", "config": {}},
            {"id": "image", "type": "image.generate", "label": "Image", "config": {}},
            {"id": "review", "type": "review.approval", "label": "Review", "config": {}},
            {"id": "export", "type": "asset.export", "label": "Export", "config": {}},
        ],
        "edges": [
            {"source": "brand", "target": "prompt"},
            {"source": "prompt", "target": "image"},
            {"source": "image", "target": "review"},
            {"source": "review", "target": "export"},
        ],
    },
    "positions": {},
}

def _save(session, draft_id=None, version=None, document=None):
    return session.run(
        "select saved_id, saved_version from public.save_agent_workflow_draft(%s,%s,%s::jsonb)",
        [draft_id, version, json.dumps(document if document is not None else DOCUMENT)],
    )

def test_agent_draft_tenant_boundary_and_history(conn, sc):
    # One rolled-back transaction: switch JWT identities exactly as PostgREST does.
    with acting(conn, sc.alice.actor) as session:
        first = _save(session)
        assert first.ok, first
        draft_id, version = first.rows[0]
        assert version == 1
        second = _save(session, draft_id, version)
        assert second.ok and second.rows[0][1] == 2, second
        stale = _save(session, draft_id, version)
        assert not stale.ok and stale.sqlstate == "40001", stale

        session.conn.execute(
            "select set_config('request.jwt.claims', %s, true)",
            [json.dumps(sc.bob.actor.claims())],
        )
        assert session.value(
            "select count(*) from public.agent_workflow_drafts where id=%s", [draft_id]
        ) == 0
        assert session.value(
            "select count(*) from public.agent_workflow_draft_versions where draft_id=%s", [draft_id]
        ) == 0
        denied = _save(session, draft_id, 2)
        assert not denied.ok and denied.sqlstate == "P0002", denied

        session.conn.execute(
            "select set_config('request.jwt.claims', %s, true)",
            [json.dumps(sc.alice.actor.claims())],
        )
        assert session.value(
            "select count(*) from public.agent_workflow_draft_versions where draft_id=%s", [draft_id]
        ) == 2

def test_agent_draft_rpc_rejects_inline_credentials_and_unknown_nodes(conn, sc):
    with acting(conn, sc.alice.actor) as session:
        bad = json.loads(json.dumps(DOCUMENT))
        bad["workflow"]["nodes"][2]["config"] = {"apiKey": "forbidden"}
        r = _save(session, document=bad)
        assert not r.ok and r.sqlstate == "22023", r
        bad = json.loads(json.dumps(DOCUMENT))
        bad["workflow"]["nodes"][2]["type"] = "shell.execute"
        r = _save(session, document=bad)
        assert not r.ok and r.sqlstate == "22023", r
        bad = json.loads(json.dumps(DOCUMENT))
        bad["workflow"]["edges"].append({"source": "image", "target": "export"})
        r = _save(session, document=bad)
        assert not r.ok and r.sqlstate == "22023", r

def test_agent_drafts_are_read_only_without_rpc(conn, sc):
    with acting(conn, sc.alice.actor) as session:
        assert not session.value(
            "select has_table_privilege('authenticated','public.agent_workflow_drafts','INSERT')"
        )
        assert not session.value(
            "select has_table_privilege('authenticated','public.agent_workflow_draft_versions','UPDATE')"
        )
