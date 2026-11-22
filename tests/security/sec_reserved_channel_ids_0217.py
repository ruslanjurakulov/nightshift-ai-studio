"""Security-lab contract for migration 0217 (a channel id may not be a page of the site's own: /privacy, /ru).

Kept in its own module, like sec_channel_lock_0086. One hook wires it in, at the bottom of sec_expectations.py.
No table is added; create_channel keeps 0086's entry (USER). The attacks are in test_sec_reserved_channel_ids_0217.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import HELPER

    functions.update({
        # The list behind the CHECK on channels.channel_id. A CHECK runs its function as the role writing the row, so a
        # signed-in editor renaming their channel must be able to execute it; it is a pure function of its argument and
        # anon, which writes no channel, gets nothing.
        "is_reserved_channel_id": HELPER,
    })
