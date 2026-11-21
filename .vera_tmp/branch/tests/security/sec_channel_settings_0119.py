"""Security-lab contract for migration 0119 (a spend limit an editor cannot raise or remove; the card's settings written by one
atomic function). One hook wires it in, at the bottom of sec_expectations.py:

    import sec_channel_settings_0119; sec_channel_settings_0119.extend(TABLES, FUNCTIONS)

No table is added. The attacks are in test_sec_channel_settings.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import HELPER, USER

    functions.update({
        # Pure; asked by channels_config_guard(), which runs as the CALLER (the browser roles).
        "channel_spend_ceiling": HELPER,
        # Runs AS THE CALLER (security invoker): an editor of the channel's organization, through the table's own policy and the guard.
        "patch_channel_agent_config": USER,
    })
