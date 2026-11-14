"""Security-lab contract for migration 0174 (rights acknowledgement: a recorded, server-enforced "I take responsibility" step).

Kept in its own module, like sec_films_0166. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_rights_acknowledgement_0174; sec_rights_acknowledgement_0174.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_rights_acknowledgement_0174.seed(conn, sc)

The seed writes what production writes: each tenant's member acknowledges likeness_photo for the tenant's own library picture
through acknowledge_rights(), in the member's own session. The isolation suite then has one row per tenant to aim at. The named
attacks, which commit, run in a scratch database of their own: test_sec_rights_acknowledgement.py.
"""

from __future__ import annotations

from typing import Dict

#: Per tenant key ('a' / 'b'): the subject each tenant acknowledged.
SUBJECT: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org, Public

    tables.update({
        # Members read their organization's rows; nobody inserts, updates or deletes directly, the service key included:
        # acknowledge_rights() is the only write path, and a trigger refuses UPDATE / DELETE / TRUNCATE even for the owner.
        "rights_acknowledgements": Org(),
        # The closed list of kinds and their current text version: any signed-in user reads it, nobody writes it.
        "rights_acknowledgement_kinds": Public(),
    })
    functions.update({
        "acknowledge_rights": USER,
        "rights_acknowledgement_status": USER,
        # Internal: called only inside create_creative_job and the two above.
        "rights_acknowledgement_required": SERVICE,
        "rights_acknowledgement_missing": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import acting

    for t in sc.tenants():
        with acting(conn, t.actor, commit=True) as s:
            out = s.value("select public.acknowledge_rights('likeness_photo', 'likeness_photo.v1', %s)", [t.media_asset])
            SUBJECT[t.key] = out["acknowledgement"]["subject"]
