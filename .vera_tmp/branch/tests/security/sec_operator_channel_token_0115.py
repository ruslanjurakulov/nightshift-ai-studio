"""Security-lab contract for migration 0115 (the operator's own channels connect to YouTube from the Command Center).

Wired in at the bottom of sec_expectations.py:

    import sec_operator_channel_token_0115; sec_operator_channel_token_0115.extend(TABLES, FUNCTIONS)

No new table (channel_token_refs is 0022's). One new function:

  store_operator_channel_token   USER: a signed-in caller; the function itself requires a platform owner/admin AND a channel of the
                                 operator's own organization. anon and the service key may not call it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({"store_operator_channel_token": USER})
