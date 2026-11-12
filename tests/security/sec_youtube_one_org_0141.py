"""Security-lab contract for migration 0141 (one YouTube channel is connected to at most one organization).

Wired in at the bottom of sec_expectations.py:

    import sec_youtube_one_org_0141; sec_youtube_one_org_0141.extend(TABLES, FUNCTIONS)

No new table. Three new functions; the two trigger functions (channel_token_refs_one_org, channels_youtube_one_org) are not in the
catalogue the lab checks (it leaves out functions returning `trigger`), and their grants are asserted by 0141's own end-state block and by
tests/security/test_sec_youtube_one_org.py. The check itself:

  youtube_channel_one_org_check   SERVICE: no API role may execute it (the trigger functions call it as their owner).
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({"youtube_channel_one_org_check": SERVICE})
