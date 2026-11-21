"""Engagement comment — the channel's own first comment on a freshly published
video, an on-topic question that invites replies.

A comment thread is the cheapest reliable engagement lever on YouTube: every
reply is a signal the algorithm reads, and a question the audience wants to
answer converts passive viewers into commenters. So right after a video
publishes, the channel posts one question as its own top-level comment.

An honest note on "pinned": the YouTube Data API v3 can *post* a comment
(`commentThreads.insert`) but has **no** endpoint to pin one. Pinning is a
manual one-tap action in YouTube Studio. This module posts the comment and
leaves it at the top of the thread for the creator to pin — it never claims to
have pinned anything it could not.

Design, matching the rest of the pipeline:

- **Best-effort, downstream of a live video.** This only runs after a video has
  actually published, so a failure here can never turn a successful run into a
  failed one — it is logged and the run proceeds.
- **Degrades cleanly without the scope.** Posting a comment needs the
  `youtube.force-ssl` scope (the same one captions need). A token without it
  skips the comment with a clear message rather than erroring.
- **No secrets, never raises.** Only the video id and the question text touch
  the API; any failure is swallowed and reported as None.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# commentThreads.insert edits public content, so YouTube wants force-ssl — the
# upload scope alone is not enough (mirrors youtube_uploader.CAPTION_SCOPE).
COMMENT_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl"

# A comment is capped at 10,000 characters by YouTube, but a question people
# actually answer is short. Kept well under that.
_MAX_LEN = 200

# Question templates. `{subject}` is filled from the topic. Each ends with a
# down-arrow so the call to action reads at a glance. Chosen deterministically
# by a hash of the topic, so the same video always gets the same question (a
# re-run is idempotent) while the channel's comments still vary video to video.
_TEMPLATES = (
    "What surprised you most about {subject}? 👇",
    "Do you think {subject} still matters today? Tell us below 👇",
    "What should we cover next about {subject}? Drop it in the comments 👇",
    "Which part of {subject} did you already know — and which was new? 👇",
    "If you could ask one question about {subject}, what would it be? 👇",
    "Where do you land on {subject}? Let us know in the comments 👇",
)

# When the topic is missing or unusable, a generic prompt still invites replies.
_FALLBACK = "What did you think of this video? Let us know in the comments 👇"


def _clean_subject(topic: str) -> str:
    """A trimmed topic suitable to drop into a sentence. Strips trailing
    punctuation and collapses whitespace; empty in → empty out."""
    subject = " ".join((topic or "").split()).strip().rstrip(".!?").strip()
    return subject


def craft_question(topic: str, title: str = "", hook: str = "") -> str:
    """Build the engagement question for a video. Deterministic in `topic`, so
    the same video always yields the same comment. `title`/`hook` are accepted
    for future tailoring; today the topic drives the question. Never empty, and
    capped at a length people actually read."""
    subject = _clean_subject(topic)
    if not subject:
        return _FALLBACK
    # Deterministic pick — stable across runs, varied across topics. Uses
    # Python's built-in hash on a stable string; we only need repeatability
    # within a process and rough spread, and the exact template is cosmetic.
    idx = sum(ord(c) for c in subject) % len(_TEMPLATES)
    question = _TEMPLATES[idx].format(subject=subject)
    if len(question) > _MAX_LEN:
        # A very long topic would blow the length; fall back rather than ship a
        # truncated, ungrammatical question.
        return _FALLBACK
    return question


def post_pinned_comment(
    service,
    video_id: str,
    text: str,
    granted_scopes: Optional[set] = None,
) -> Optional[str]:
    """Post `text` as a top-level comment on `video_id` from the authenticated
    channel. Returns the created comment-thread id, or None if it was skipped
    (missing scope / bad input) or failed. Never raises.

    Pass `granted_scopes` (from the uploader) to skip cleanly when the token
    lacks force-ssl, instead of surfacing a raw API error."""
    if not service or not video_id or not (text or "").strip():
        return None
    if granted_scopes is not None and COMMENT_SCOPE not in granted_scopes:
        logger.info(
            "Skipping engagement comment: token is missing the %s scope. Add it to "
            "config.YOUTUBE_SCOPES and reconnect the channel to enable comments.",
            COMMENT_SCOPE,
        )
        return None
    body = {
        "snippet": {
            "videoId": video_id,
            "topLevelComment": {"snippet": {"textOriginal": text.strip()}},
        }
    }
    try:
        resp = service.commentThreads().insert(part="snippet", body=body).execute()
        thread_id = resp.get("id") if isinstance(resp, dict) else None
        logger.info("Posted engagement comment on %s (thread %s)", video_id, thread_id)
        return thread_id
    except Exception as e:
        logger.warning("Could not post engagement comment on %s (%s: %s) — video is already live",
                       video_id, type(e).__name__, e)
        return None
