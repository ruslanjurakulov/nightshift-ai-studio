"""Security-lab contract for migration 0081 (the comment inbox).

Kept in its own module, like sec_captions_0072. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_inbox_0081; sec_inbox_0081.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_inbox_0081.seed(conn, sc)

The seed writes each tenant's inbox the way production leaves one: comments
through the worker's own function (store_inbox_comments, service role), a
ready draft, and one comment whose reply was approved and posted. The draft,
intent, post and event rows are written by the database owner, as the scenario
does for creative_jobs: the request path holds credits, and the shared
scenario's balances and holds are asserted exactly by other tests. The named
attacks, which run the whole lifecycle in a scratch database of their own, are
in test_sec_comment_inbox.py.
"""

from __future__ import annotations

import json
from typing import Dict

#: Per tenant key ('a' / 'b'): ids the isolation tests aim at.
OPEN: Dict[str, str] = {}      # an open, classified comment (a draft is waiting on it)
REPLIED: Dict[str, str] = {}   # a comment whose approved reply was posted
DRAFT: Dict[str, str] = {}     # the ready draft of OPEN
INTENT: Dict[str, str] = {}
POST: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Channel

    tables.update({
        # Members read their organization's channels' rows; nobody inserts,
        # updates or deletes directly — the functions below are the only path.
        "inbox_comments": Channel(),
        "reply_drafts": Channel(),
        "reply_intents": Channel(),
        "reply_posts": Channel(),
        "inbox_events": Channel(),
    })
    functions.update({
        # The person's own session.
        "quote_reply_draft": USER,
        "request_reply_draft": USER,
        "edit_reply_draft": USER,
        "discard_reply_draft": USER,
        "approve_reply": USER,
        "retry_reply_post": USER,
        "dismiss_inbox_comment": USER,
        # The worker (service role).
        "store_inbox_comments": SERVICE,
        "inbox_comments_to_classify": SERVICE,
        "claim_reply_draft": SERVICE,
        "store_reply_draft": SERVICE,
        "fail_reply_draft": SERVICE,
        "expire_reply_drafts": SERVICE,
        "claim_reply_post": SERVICE,
        "mark_reply_submitting": SERVICE,
        "finish_reply_post": SERVICE,
        # Internal: called only inside the functions above; no API role.
        "inbox_clean_text": SERVICE,
        "inbox_url_like": SERVICE,
        "inbox_daily_cap": SERVICE,
        "inbox_channel_ready": SERVICE,
        "inbox_draft_block": SERVICE,
        "inbox_log": SERVICE,
        "reply_draft_price": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import SERVICE, acting, as_superuser

    for t in sc.tenants():
        k = t.key
        comments = [
            {"youtube_comment_id": f"UgxOpen{k}00001", "author": f"Viewer {k}", "text": f"Which camera did you use, {k}?",
             "published_at": "2026-09-30T10:00:00Z", "category": "question", "sentiment": "neutral", "flagged": False},
            {"youtube_comment_id": f"UgxDone{k}00001", "author": f"Fan {k}", "text": "Loved this one!",
             "published_at": "2026-09-30T11:00:00Z", "category": "praise", "sentiment": "positive", "flagged": False},
        ]
        with acting(conn, SERVICE, commit=True) as s:
            n = s.value("select public.store_inbox_comments(%s, %s, %s::jsonb)", [t.channel, t.video, json.dumps(comments)])
        if n != 2:
            raise AssertionError(f"seed: expected two new comments for {t.channel}, got {n}")
        with as_superuser(conn) as s:
            OPEN[k], REPLIED[k] = (str(s.value(
                "select id from public.inbox_comments where channel_id = %s and youtube_comment_id = %s",
                [t.channel, c["youtube_comment_id"]])) for c in comments)
            DRAFT[k] = str(s.value(
                "insert into public.reply_drafts (comment_id, channel_id, status, body, drafted_body, requested_by) "
                "values (%s, %s, 'ready', 'It was a compact mirrorless camera.', 'It was a compact mirrorless camera.', %s) "
                "returning id", [OPEN[k], t.channel, t.actor.uid]))
            done = str(s.value(
                "insert into public.reply_drafts (comment_id, channel_id, status, body, drafted_body, requested_by, finished_at) "
                "values (%s, %s, 'approved', 'Thank you!', 'Thank you!', %s, now()) returning id",
                [REPLIED[k], t.channel, t.actor.uid]))
            INTENT[k] = str(s.value(
                "insert into public.reply_intents (channel_id, comment_id, draft_id, video_id, youtube_comment_id, body, "
                "drafted_body, edited, approved_by, approved_by_email) "
                "values (%s, %s, %s, %s, %s, 'Thank you!', 'Thank you!', false, %s, %s) returning id",
                [t.channel, REPLIED[k], done, t.video, f"UgxDone{k}00001", t.actor.uid, t.actor.email]))
            POST[k] = str(s.value(
                "insert into public.reply_posts (intent_id, channel_id, comment_id, status, attempts, youtube_reply_id, "
                "quota_units, finished_at) values (%s, %s, %s, 'posted', 1, %s, 50, now()) returning id",
                [INTENT[k], t.channel, REPLIED[k], f"UgxReply{k}00001.1"]))
            s.rows("update public.inbox_comments set status = 'replied' where id = %s returning 1", [REPLIED[k]])
            s.value("select public.inbox_log(%s, %s, %s, 'reply_approved', '{}'::jsonb)",
                    [t.channel, REPLIED[k], done])
