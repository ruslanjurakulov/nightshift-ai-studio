"""Comment Fetcher — pulls top-level YouTube comments via the YouTube Data
API v3 (`commentThreads.list`) and shapes them for `comment_intelligence`.

OAuth
-----
Mirrors the OAuth pattern in `modules/youtube_uploader.py.YouTubeUploader._auth`
(same `YOUTUBE_TOKEN_FILE`, same refresh/`InstalledAppFlow` fallback) rather
than importing from it, to keep this module mergeable independently of any
change to that shared file — same reasoning `modules/analytics_client.py`
documents for its own duplicated `_auth()`. A follow-up PR can factor out a
shared `_auth()` helper once the parallel module PRs have landed.

Id shapes
---------
YouTube comment ids are long alphanumeric strings (e.g. "Ugw...AaABiZ4"), but
`comment_intelligence.classify_comments()` expects small sequential integer
ids per batch (its batching/retry-and-split logic keys off of them). So each
comment dict returned here carries BOTH:
  - "id": a sequential integer assigned per `fetch_comments()` call, starting
    at 0 — this is what `classify_comments()` reads.
  - "text": the comment's plain-text body — also read by `classify_comments()`.
  - "youtube_comment_id": the real YouTube comment id (string), kept so a
    caller can map a classification's `comment_id` back to the actual comment
    to reply to / moderate / store.

Untrusted input
----------------
Comment text is audience-controlled and untrusted. This module does no LLM
calls and never `eval`/`exec`s anything from it — it only fetches and shapes
data. Full comment bodies are not logged at INFO level; a truncated preview
(`text[:80]`) is used for DEBUG-level diagnostics only.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from config import YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES
from modules.channel_credentials import (
    client_secret_problem,
    legacy_token_path,
    materialize_token,
    require_interactive_consent_possible,
    token_path,
)

logger = logging.getLogger(__name__)

# Max top-level comments per commentThreads.list page, per the YouTube Data
# API v3 (1-100; 100 is the ceiling).
_MAX_PAGE_SIZE = 100

# API error reason (per the YouTube Data API's error payload
# error.errors[].reason) returned when comments are disabled on a video.
_COMMENTS_DISABLED_REASON = "commentsDisabled"


class CommentFetcher:
    """Fetches top-level comments for a video via the YouTube Data API v3."""

    def __init__(self, channel=None):
        """`channel` binds this fetcher to one channel's OAuth token, so a
        channel only ever reads comments on its own videos. None keeps the
        legacy single-channel token from config."""
        self.channel = channel
        self.token_file = self._resolve_token_file(channel)
        self.youtube = self._auth()

    @classmethod
    def from_service(cls, service) -> "CommentFetcher":
        """A fetcher over an already-authorised YouTube service (the comment
        inbox's worker resolves the channel's own token itself, in memory, and
        never writes it to a file). No token file, no consent flow."""
        self = cls.__new__(cls)
        self.channel = None
        self.token_file = None
        self.youtube = service
        return self

    @staticmethod
    def _resolve_token_file(channel) -> Path:
        if channel is None:
            return legacy_token_path()
        materialize_token(channel)
        return token_path(channel)

    def _auth(self):
        creds = None
        token_file = Path(self.token_file)

        if token_file.exists():
            creds = Credentials.from_authorized_user_file(str(token_file), YOUTUBE_SCOPES)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                # Existence is not enough: the workflows write this file with
                # `echo '<secret>' > client_secret.json`, so an unset secret
                # leaves an EMPTY file behind. Handing that to InstalledAppFlow
                # produced the bare JSONDecodeError every scheduled poll has
                # actually been failing with.
                problem = client_secret_problem()
                if problem:
                    raise FileNotFoundError(problem)
                # And on CI there is no browser to consent in, so say that
                # instead of blocking on run_local_server until the timeout.
                require_interactive_consent_possible(
                    token_file=token_file, required_scopes=YOUTUBE_SCOPES
                )
                flow = InstalledAppFlow.from_client_secrets_file(
                    YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES
                )
                creds = flow.run_local_server(port=0)
            token_file.write_text(creds.to_json())
            logger.info("Token saqlandi: %s", token_file)

        return build("youtube", "v3", credentials=creds)

    def fetch_comments(self, video_id: str, max_results: int = 100) -> list[dict]:
        """Fetches up to `max_results` top-level comments for `video_id`.

        Paginates via `nextPageToken` until either `max_results` is reached
        or the API has no more pages. Returns `[]` (never raises) when the
        video has no comments or has comments disabled.

        Each returned dict has:
            "id": sequential int (0, 1, 2, ...) — for `classify_comments()`.
            "text": plain-text comment body — for `classify_comments()`.
            "youtube_comment_id": the real YouTube comment id (str).
        """
        return self._fetch(video_id, max_results, rich=False)

    def fetch_inbox_comments(self, video_id: str, max_results: int = 100) -> list[dict]:
        """Like `fetch_comments`, plus what the comment inbox shows: each dict
        also carries "author" (the commenter's display name) and
        "published_at" (the comment's timestamp). All of it is audience-controlled
        and untrusted — the inbox cleans and bounds it again when storing."""
        return self._fetch(video_id, max_results, rich=True)

    def _fetch(self, video_id: str, max_results: int, *, rich: bool) -> list[dict]:
        if max_results <= 0:
            return []

        results: list[dict] = []
        next_page_token: str | None = None
        next_id = 0

        while len(results) < max_results:
            page_size = min(_MAX_PAGE_SIZE, max_results - len(results))
            request_kwargs = {
                "part": "snippet",
                "videoId": video_id,
                "maxResults": page_size,
                "textFormat": "plainText",
            }
            if next_page_token:
                request_kwargs["pageToken"] = next_page_token

            try:
                response = self.youtube.commentThreads().list(**request_kwargs).execute()
            except HttpError as e:
                if _is_comments_disabled(e):
                    logger.warning(
                        "Comments disabled (or unavailable) for video %s; returning [].",
                        video_id,
                    )
                    return []
                raise

            items = response.get("items", [])
            if not items:
                break

            for item in items:
                top_comment = item["snippet"]["topLevelComment"]
                snippet = top_comment["snippet"]
                text = snippet.get("textDisplay", "")
                logger.debug("Fetched comment %s: %r", top_comment["id"], text[:80])

                entry = {
                    "id": next_id,
                    "text": text,
                    "youtube_comment_id": top_comment["id"],
                }
                if rich:
                    entry["author"] = str(snippet.get("authorDisplayName") or "")
                    entry["published_at"] = str(snippet.get("publishedAt") or "")
                results.append(entry)
                next_id += 1

                if len(results) >= max_results:
                    break

            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        logger.info("Fetched %d comment(s) for video %s.", len(results), video_id)
        return results


def _is_comments_disabled(error: HttpError) -> bool:
    """True if `error` is the API's "comments are disabled for this video"
    response. Checks the structured `error.errors[].reason` field the
    YouTube Data API returns; falls back to a substring check on the raw
    error text if the payload isn't the expected shape.
    """
    try:
        content = error.content
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="ignore")
        data = json.loads(content)
        reasons = [
            e.get("reason", "")
            for e in data.get("error", {}).get("errors", [])
        ]
        if _COMMENTS_DISABLED_REASON in reasons:
            return True
        if data.get("error", {}).get("status") == "PERMISSION_DENIED" and any(
            "comment" in r.lower() for r in reasons
        ):
            return True
    except (ValueError, AttributeError, TypeError, KeyError):
        pass
    return _COMMENTS_DISABLED_REASON in str(error)
