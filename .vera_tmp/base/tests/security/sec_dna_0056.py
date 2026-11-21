"""Security-lab contract for migration 0056 (Channel DNA).

Kept in its own module, like sec_style_0047. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_dna_0056; sec_dna_0056.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after 0047's seed (it needs a kit and a
    character per tenant):
        sec_dna_0056.seed(conn, sc)

The seed writes each tenant's DNA the way production does: set_channel_dna()
in the member's own session. The named attacks are in test_sec_channel_dna.py.
"""

from __future__ import annotations

SET_DNA = "select public.set_channel_dna(%s, %s, %s::uuid[], %s, %s, %s, %s, %s)"

#: A premade-looking voice id (20 letters and digits). Not a secret.
VOICE = "AbCdEfGhIjKlMnOpQrSt"


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER, Org

    tables.update({
        # Read by whoever may see the channel; written only by set_channel_dna.
        "channel_dna_characters": Org(),
    })
    functions.update({
        "set_channel_dna": USER,
    })


def seed(conn, sc) -> None:
    from sec_db import acting
    from sec_style_0047 import CHARACTER, KIT

    for t in sc.tenants():
        with acting(conn, t.actor, commit=True) as s:
            s.value(SET_DNA, [t.channel, KIT[t.key], [CHARACTER[t.key]], VOICE, "uz", "shorts", None,
                              f"calm, curious, {t.key}"])
