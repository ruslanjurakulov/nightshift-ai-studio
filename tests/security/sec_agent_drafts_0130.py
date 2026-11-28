"""Security-lab seed for migration 0130 (Agent Builder private drafts).

Alice and Bob each own one plan with two saved versions. Since 0234 only a platform operator may call save_agent_workflow_draft(),
and Alice and Bob are customers, so their plans are written as the database owner, row for row what 0130's save writes: plans a
customer saved before 0234 was applied, which stay theirs and readable by them alone. The stranger owns none (test_sec_isolation
proves he reads nothing). The isolation tests then attack real rows of both tables (agent_workflow_drafts,
agent_workflow_draft_versions: Person() in sec_expectations), and test_sec_agent_workflow_drafts.py and
test_sec_agent_drafts_operator_only_0234.py attack the two functions.
"""

from __future__ import annotations

import copy
import json

from sec_db import as_superuser

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
    "positions": {"brand": {"x": 20, "y": 20}, "export": {"x": 2200, "y": 1600}},
}

SAVE = "select saved_id, saved_version from public.save_agent_workflow_draft(%s, %s, %s::jsonb)"


def document(**workflow) -> dict:
    d = copy.deepcopy(DOCUMENT)
    d["workflow"].update(workflow)
    return d


def seed(conn, sc) -> None:
    for t in (sc.alice, sc.bob):
        doc = json.dumps(document(name=f"Plan of {t.key.upper()}"))
        with as_superuser(conn) as s:
            draft_id = s.value("insert into public.agent_workflow_drafts (owner_id, name, current_version) values (%s, %s, 2) returning id",
                               [t.actor.uid, f"Plan of {t.key.upper()}"])
            for version in (1, 2):
                s.rows("insert into public.agent_workflow_draft_versions (draft_id, version, owner_id, document) "
                       "values (%s, %s, %s, %s::jsonb) returning 1", [draft_id, version, t.actor.uid, doc])
            t.agent_draft = str(draft_id)
