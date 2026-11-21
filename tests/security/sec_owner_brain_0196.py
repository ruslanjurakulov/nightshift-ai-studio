"""Security-lab contract for migration 0196 (the owner's facts for Nightshift Brain: people and plans, system health).

Wired in at the bottom of sec_expectations.py, like sec_owner_costs_0184.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "owner_brain_people": USER,
        "owner_brain_health": USER,
    })
