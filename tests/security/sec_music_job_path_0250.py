"""Security-lab contract for migration 0250 (sellable_models knows `music`, the last closed capability list on the job path that did
not).

Wired in at the bottom of sec_expectations.py. 0250 adds no table and no function: it replaces sellable_models (0192's body) with
`music` added to its list, and keeps 0192's grants. Restated here so that a later file which widened the grant to anon, or closed it
to members (the Studio's model list is a member's read), fails this contract by name. Attacked in
tests/security/test_sec_music_job_path_0250.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        "sellable_models": USER,
        # Restated, not new: the pricing functions a sellable music model is quoted through stay internal (0228's contract).
        "creative_price": SERVICE,
    })
