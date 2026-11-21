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
        # A channel's own uploads (private ones included): readable only through research_own_channel.
        "research_own_videos": Service(),
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
        "research_channel_confirmed": SERVICE,
        "research_draft_answer": SERVICE,
        "research_own_videos_json": SERVICE,
    })


def seed(conn, sc) -> None:
    """Each tenant's research as production leaves it: a competitor added the only way one can be (the member's own
    research_add_competitor, which also queues the resolution request), and the caches, topic result and analytics row the worker
    writes. The cache rows are written by the database owner (the worker's functions need a claimed request, and the shared
    scenario's queue is asserted elsewhere)."""
    from sec_db import acting, as_superuser

    for t in sc.tenants():
        with acting(conn, t.actor, commit=True) as s:
            out = s.value("select public.research_add_competitor(%s, %s)", [t.channel, f"@seeded-{t.key}"])
        assert out and out.get("ok"), out
    with as_superuser(conn) as s:
        for i, t in enumerate(sc.tenants()):
            yid = f"UCseed{t.key}" + "x" * 17
            s.rows("insert into public.research_channel_cache (youtube_channel_id, title, view_count) values (%s, %s, 1) "
                   "on conflict do nothing returning 1", [yid, f"Seed {t.key}"])
            s.rows("insert into public.research_video_cache (video_id, youtube_channel_id, title, view_count) values (%s, %s, 'v', 1) "
                   "on conflict do nothing returning 1", [f"seedvideo{i:02d}", yid])
            s.rows("insert into public.research_topic_results (org_id, topic_norm, youtube_channel_ids) values (%s, 'seed topic', %s) "
                   "on conflict do nothing returning 1", [t.org, [yid]])
            s.rows("insert into public.research_own_videos (channel_id, video_id, title, privacy_status) values (%s, %s, 'own', 'private') "
                   "on conflict do nothing returning 1", [t.channel, f"ownvideo{i:03d}"])
            s.rows("insert into public.research_own_analytics (channel_id, period_days, youtube_channel_id, views) values (%s, 28, %s, 1) "
                   "on conflict do nothing returning 1", [t.channel, yid])
