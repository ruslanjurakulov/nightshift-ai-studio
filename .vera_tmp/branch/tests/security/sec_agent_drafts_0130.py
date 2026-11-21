"""Security-lab seed for migration 0130 (Agent Builder private drafts).

Alice and Bob each own one plan with two saved versions, written the only way a row can be written: by their own call of
save_agent_workflow_draft(). The stranger owns none (test_sec_isolation proves he reads nothing). The isolation tests then attack
real rows of both tables (agent_workflow_drafts, agent_workflow_draft_versions: Person() in sec_expectations), and
test_sec_agent_workflow_drafts.py attacks the two functions.
"""

from __future__ import annotations

import copy
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
    "positions": {"brand": {"x": 20, "y": 20}, "export": {"x": 2200, "y": 1600}},
}

SAVE = "select saved_id, saved_version from public.save_agent_workflow_draft(%s, %s, %s::jsonb)"


def document(**workflow) -> dict:
    d = copy.deepcopy(DOCUMENT)
    d["workflow"].update(workflow)
    return d


def seed(conn, sc) -> None:
    for t in (sc.alice, sc.bob):
        with acting(conn, t.actor, commit=True) as s:
            doc = document(name=f"Plan of {t.key.upper()}")
            draft_id, version = s.rows(SAVE, [None, None, json.dumps(doc)])[0]
            s.rows(SAVE, [draft_id, version, json.dumps(doc)])
            t.agent_draft = str(draft_id)
