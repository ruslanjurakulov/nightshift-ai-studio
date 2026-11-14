"""Security-lab contract for migration 0163 (a concept-thumbnail channel's run is priced with its generated images).

Wired in like the other per-migration files, at the bottom of sec_expectations.py:
    import sec_concept_thumbnail_holds_0163; sec_concept_thumbnail_holds_0163.extend(TABLES, FUNCTIONS)

No table. One new function name, concept_thumbnail_credits, internal: called only inside series_episode_price(integer, text) and
oauth_create_video(), granted to no API role. The two-argument series_episode_price shares 0120's name, already SERVICE. The three
bodies 0163 replaces keep 0120's and 0094's declarations (quote_series_episode / start_series_episode USER, oauth_create_video API).
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        "concept_thumbnail_credits": SERVICE,
    })
