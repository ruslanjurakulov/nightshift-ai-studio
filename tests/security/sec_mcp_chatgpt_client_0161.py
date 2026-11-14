"""Security-lab contract for migration 0161 (ChatGPT keeps the client it registered).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_mcp_chatgpt_client_0161; sec_mcp_chatgpt_client_0161.extend(TABLES, FUNCTIONS)

No new table. One new function, internal (no API role may call it): oauth_chatgpt_callbacks_only, which tells the collector
(oauth_gc) that a registration's every redirect URI is one of ChatGPT's own callbacks. oauth_gc keeps its 0093 declaration
(internal, no API role). The named attacks are in test_sec_mcp_chatgpt_client.py, in a scratch database of its own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        # Read only by the collector: immutable, internal.
        "oauth_chatgpt_callbacks_only": SERVICE,
    })
