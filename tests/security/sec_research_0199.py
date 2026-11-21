"""Security-lab contract for migration 0199 (channel research: own channel, competitors, topic channels, comment themes).

Every table is closed (RLS on, no policy, no grant, the service key included): the readers and writers below are the only way in or
out, and each resolves the organization from the channel row. The named attacks are in test_sec_research.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        "research_competitors": Service(),
        "research_channel_cache": Service(),
        "research_video_cache": Service(),
        "research_topic_results": Service(),
        "research_own_analytics": Service(),
        "research_requests": Service(),
    })
    functions.update({
        # A member's own session: each checks the channel's organization and the role itself.
        "research_own_channel": USER,
        "research_competitors_view": USER,
        "research_topic_channels": USER,
        "research_comment_themes": USER,
        "research_request_refresh": USER,
        "research_add_competitor": USER,
        "research_remove_competitor": USER,
        # The queue worker (service key).
        "research_claim_request": SERVICE,
        "research_finish_request": SERVICE,
        "research_store_channels": SERVICE,
        "research_store_videos": SERVICE,
        "research_resolve_competitor": SERVICE,
        "research_store_topic": SERVICE,
        "research_store_own": SERVICE,
        "research_purge_stale": SERVICE,
        # Internal helpers, called only inside the functions above (they run as the owner).
        "research_error_words": SERVICE,
        "research_channel_access": SERVICE,
        "research_topic_norm": SERVICE,
        "research_parse_ref": SERVICE,
        "research_remedy": SERVICE,
        "research_answer": SERVICE,
        "research_last_request": SERVICE,
        "research_channel_json": SERVICE,
        "research_videos_json": SERVICE,
        "research_stopwords": SERVICE,
        "research_min_interval": SERVICE,
        "research_clean": SERVICE,
    })
