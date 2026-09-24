"""Stage 7: YouTube Auto-Uploader — YouTube Data API v3 with OAuth2.

Channel isolation (Phase 5)
---------------------------
An uploader instance is bound to exactly one channel for its whole life. Pass a
``ChannelContext`` and it authenticates with *that* channel's token and targets
*that* channel's YouTube id; pass nothing and it behaves precisely as the
single-channel uploader always has, reading ``config.py``.

The rule that matters is the negative one: a non-default channel NEVER falls
back to the ``YOUTUBE_CHANNEL_ID`` environment variable. Publishing Finance's
video to History's channel because a config field was blank would be worse than
failing, so a channel with no target of its own simply omits the field and
uploads to whatever channel its own token owns.

The publish gate is not implemented here and is not changed here: this module
uploads when it is called, exactly as before. Whether it *should* be called is
main.py's business, and main.py's behaviour is unchanged.

Captions and chapters
---------------------
Both are metadata the pipeline already computes and used to throw away: the
Whisper ``.srt`` that is burned into the picture was never offered to YouTube as
a caption track, and the audio mixer's section timeline — which knows to the
millisecond where every section starts — was never turned into chapters. Adding
them changes nothing about *whether* or *when* a video goes out; a private video
with captions is still a private video.

Both follow the same rule as the narrator voice: rather than ship something
plausible-but-wrong, ship nothing. A caption track is skipped when its language
cannot be named, and the chapter block is emitted only when it satisfies every
rule YouTube enforces (see ``build_chapters``).
"""

import json
import logging
import re
from pathlib import Path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from config import (
    SCRIPT_LANGUAGE,
    YOUTUBE_CATEGORY_ID,
    YOUTUBE_CHANNEL_ID,
    YOUTUBE_CLIENT_SECRET,
    YOUTUBE_PRIVACY,
    YOUTUBE_SCOPES,
)
from modules.channels import ChannelContext
from modules.channel_credentials import (
    client_secret_problem,
    legacy_token_path,
    materialize_token,
    require_interactive_consent_possible,
    token_path,
)
from modules.script_engine import Script

logger = logging.getLogger(__name__)

MAX_TAGS = 500

#: YouTube rejects a description longer than this — and rejects the upload with
#: it. The chapter block is what gets dropped if it does not fit, never the
#: description the script was written with.
MAX_DESCRIPTION = 5000

#: YouTube's own rules for chapters: the first must be at 0:00, there must be at
#: least three, and each must run at least ten seconds. Break one and YouTube
#: silently shows no chapters at all, so these are the conditions for emitting
#: the block in the first place.
MIN_CHAPTERS = 3
MIN_CHAPTER_SECONDS = 10.0

#: A chapter title is read at a glance under the scrubber, not studied.
MAX_CHAPTER_TITLE = 55

#: What a caption track is called in YouTube's caption list. Named for what it
#: is: a machine transcript of a machine narration, not a human proofread.
CAPTION_TRACK_NAME = "Auto (Whisper)"

#: Languages this project can label a caption track with. YouTube shows that
#: label to viewers and auto-translates from it, so a language this table does
#: not know means no caption track rather than one labelled as a language it is
#: not — the same standard audio_mixer.verify_voice applies to the narrator.
CAPTION_LANGUAGES = {
    "english": "en",
    "russian": "ru",
    "uzbek": "uz",
    "spanish": "es",
    "german": "de",
    "french": "fr",
    "italian": "it",
    "portuguese": "pt",
    "turkish": "tr",
    "arabic": "ar",
    "hindi": "hi",
}

#: A description line that opens with a timestamp. Gemini is asked for
#: "3 paragraphs + timestamps" (see script_engine.SCRIPT_SYSTEM_PROMPT) and
#: duly invents some, against a video that did not exist when it wrote them.
#: YouTube reads the FIRST valid list it finds, so leaving those in place would
#: hand viewers invented chapter marks in preference to measured ones.
TIMESTAMP_LINE = re.compile(r"^\s*(?:[-*\u2022]\s*)?\d{1,2}:\d{2}(?::\d{2})?\b")


#: The scope captions.insert needs. `youtube.upload` is not enough: YouTube
#: treats writing a caption track as editing the video, so it wants force-ssl —
#: which also permits deleting videos. That is a real trade for a caption track,
#: and it is the account owner's to make, so nothing here assumes it was made:
#: a token without this scope skips captions and says so once.
CAPTION_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl"


def caption_language(channel: Optional[ChannelContext]) -> Optional[str]:
    """The BCP-47 code to label this channel's caption track with, or None.

    A caption track carries a language that YouTube shows to viewers and
    machine-translates from. Guessing "en" for a channel narrating in Uzbek
    would put an English label on Uzbek words — the caption equivalent of
    narrating in the wrong voice — so an unrecognised language yields None and
    no track is uploaded.
    """
    agent = getattr(channel, "agent", None) if channel is not None else None
    language = (getattr(agent, "language", None) or SCRIPT_LANGUAGE or "").strip()
    if not language:
        return None
    # Already a code ("en", "en-US", "pt-BR") — take it as given.
    if re.fullmatch(r"[a-z]{2}(-[A-Za-z0-9]{2,8})?", language):
        return language
    return CAPTION_LANGUAGES.get(language.lower())


def _format_timestamp(seconds: float) -> str:
    """`0:00`, `12:34`, `1:02:03` — the forms YouTube parses as a chapter mark."""
    total = int(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _chapter_title(section, fallback_name: str) -> str:
    """What this chapter is called under the scrubber.

    The section's own opening sentence, because that is the only text in the
    project written for a viewer to read: section names like
    "open_loop_plant" are the script format's internal vocabulary and say
    nothing to somebody scrubbing through the video. The name is the fallback
    when a section has no narration to borrow from.
    """
    text = ""
    if section is not None:
        try:
            text = section.clean_narration()
        except Exception:  # a section shape we do not recognise
            text = ""
    sentence = re.split(r"(?<=[.!?])\s+", text.strip())[0] if text.strip() else ""
    title = " ".join(sentence.split()) or fallback_name.replace("_", " ").strip().title()
    title = title.rstrip(" .,;:—-")
    if len(title) > MAX_CHAPTER_TITLE:
        clipped = title[:MAX_CHAPTER_TITLE].rsplit(" ", 1)[0].rstrip(" .,;:—-")
        title = (clipped or title[:MAX_CHAPTER_TITLE]) + "\u2026"
    return title


def build_chapters(section_timeline: list[dict] | None, sections=None) -> list[str]:
    """Chapter lines for the description, or [] when they would be malformed.

    The timings are the audio mixer's own measurement of where each section
    landed (`AudioMixer.render_narration` returns them), so these mark real
    boundaries in the finished audio rather than the script's `duration_hint`
    guesses.

    YouTube enforces three rules and enforces them silently — break one and it
    shows no chapters at all, with nothing in the API response to say why:

      * the first mark must be at 0:00,
      * there must be at least three marks,
      * every chapter must run at least ten seconds, the last one included.

    So a section that runs under ten seconds, or starts under ten seconds after
    the last mark, does not get a mark of its own; it folds into the chapter
    already running, which is also what a viewer wants — a mark for a
    six-second section is a mark nobody can click. If what survives is fewer
    than three marks, this returns nothing at all rather than a list YouTube
    will ignore.
    """
    entries = list(section_timeline or [])
    if len(entries) < MIN_CHAPTERS:
        return []

    marks: list[tuple[float, float, str]] = []
    for i, entry in enumerate(entries):
        try:
            start = float(entry["start_ms"]) / 1000.0
            end = float(entry["end_ms"]) / 1000.0
        except (KeyError, TypeError, ValueError):
            # A timeline we cannot read is not one we can label honestly.
            return []
        if end < start:
            return []
        section = sections[i] if sections is not None and i < len(sections) else None
        name = str(entry.get("section") or getattr(section, "name", "") or f"part {i + 1}")
        marks.append((start, end, _chapter_title(section, name)))

    # The first chapter is pinned to 0:00 whatever the first section's start
    # says: nothing precedes it, and a first mark at 0:01 invalidates the list.
    kept: list[tuple[float, str]] = [(0.0, marks[0][2])]
    for start, end, title in marks[1:]:
        if end - start < MIN_CHAPTER_SECONDS:
            continue  # too short to be a chapter of its own
        if start - kept[-1][0] < MIN_CHAPTER_SECONDS:
            continue  # too close behind the mark before it
        kept.append((start, title))

    if len(kept) < MIN_CHAPTERS:
        return []

    # Measure what was actually built, against the end of the audio rather than
    # against the rules the loop above was written to satisfy. A timeline with
    # gaps or overlaps could still produce a short chapter here, and one short
    # chapter costs the whole list.
    bounds = [start for start, _ in kept] + [marks[-1][1]]
    if any(b - a < MIN_CHAPTER_SECONDS for a, b in zip(bounds, bounds[1:])):
        return []

    return [f"{_format_timestamp(start)} {title}" for start, title in kept]


def strip_timestamp_lines(description: str) -> str:
    """Remove lines that open with a timestamp.

    Gemini is told to write "3 paragraphs + timestamps" and writes timestamps
    for a video that did not exist yet, so they point at moments that are not
    there. YouTube reads the FIRST valid chapter list in a description, which
    means leaving them in would show the invented marks and ignore the measured
    ones. Prose that happens to open with a clock time ("12:30 that afternoon…")
    is lost too — a rare sentence, against a chapter list that is wrong every
    time.
    """
    kept = [line for line in (description or "").splitlines() if not TIMESTAMP_LINE.match(line)]
    return "\n".join(kept).strip()


def compose_description(description: str, chapters: list[str]) -> str:
    """The description as uploaded: the script's own text, with real chapters.

    Called only when a section timeline was supplied, i.e. when the caller knows
    the true timings. That is also why the invented timestamps are stripped even
    when no chapter block survives `build_chapters`: at that point we know the
    marks in the text are not the video's, and no chapters beats wrong ones.
    """
    base = strip_timestamp_lines(description)
    if not chapters:
        return base
    block = "\n".join(["Chapters:", *chapters])
    candidate = f"{base}\n\n{block}" if base else block
    if len(candidate) > MAX_DESCRIPTION:
        # The description the script was written with wins; the chapters are the
        # addition, so the addition is what goes.
        logger.warning("Chapters dropped: the description would exceed %d characters",
                       MAX_DESCRIPTION)
        return base
    return candidate


class YouTubeUploader:
    def __init__(self, channel: Optional[ChannelContext] = None):
        self.channel = channel
        self.token_file = self._resolve_token_file(channel)
        self.target_channel_id = self._resolve_target_channel(channel)
        self.service = self._auth()
        self._verify_channel()

    # -- channel binding ---------------------------------------------------

    @staticmethod
    def _resolve_token_file(channel: Optional[ChannelContext]) -> Path:
        """Which token this uploader authenticates with.

        No channel = the legacy path from config. With a channel, its token is
        first materialized from its env var if one is set (the same
        secret-to-file step the workflow already does for the single channel),
        then read from that channel's own path.
        """
        if channel is None:
            return legacy_token_path()
        materialize_token(channel)
        return token_path(channel)

    @staticmethod
    def _resolve_target_channel(channel: Optional[ChannelContext]) -> str:
        """Which YouTube channel the upload targets.

        A non-default channel uses ONLY its own configured id — never the
        process-wide YOUTUBE_CHANNEL_ID, which belongs to the default channel.
        An empty value means "don't set channelId", i.e. upload to the channel
        the token itself owns.
        """
        if channel is None:
            return YOUTUBE_CHANNEL_ID
        if channel.is_default:
            return channel.credential.youtube_channel_id or YOUTUBE_CHANNEL_ID
        return channel.credential.youtube_channel_id

    @property
    def _label(self) -> str:
        """Channel prefix for log lines and errors (brief §28)."""
        return f"[channel: {self.channel.channel_id}] " if self.channel else ""

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
                    raise FileNotFoundError(f"{self._label}{problem}")
                # And on CI there is no browser to consent in, so say that
                # instead of blocking on run_local_server until the timeout.
                require_interactive_consent_possible(
                    self._label, token_file, YOUTUBE_SCOPES
                )
                flow = InstalledAppFlow.from_client_secrets_file(
                    YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES
                )
                creds = flow.run_local_server(port=0)
            token_file.write_text(creds.to_json())
            logger.info("%sToken saqlandi: %s", self._label, token_file.name)

        return build("youtube", "v3", credentials=creds)

    def list_channels(self) -> list[dict]:
        """Returns all YouTube channels the authenticated user manages."""
        resp = self.service.channels().list(
            part="snippet,id",
            mine=True,
            maxResults=50,
        ).execute()
        channels = []
        for item in resp.get("items", []):
            channels.append({
                "id": item["id"],
                "name": item["snippet"]["title"],
                "url": f"https://www.youtube.com/channel/{item['id']}",
            })
        return channels

    def _verify_channel(self):
        """If a target channel is configured, confirm the token can reach it."""
        target = self.target_channel_id
        if not target:
            return
        channels = self.list_channels()
        ids = [c["id"] for c in channels]
        if target not in ids:
            names = "\n".join(f"  {c['id']} — {c['name']}" for c in channels)
            raise ValueError(
                f"{self._label}YouTube kanal ID='{target}' bu tokenda topilmadi.\n"
                f"Mavjud kanallar:\n{names}\n"
                "To'g'ri ID ni kanal sozlamasiga (yoki .env ga) yozing."
            )
        ch = next(c for c in channels if c["id"] == target)
        logger.info("%sKanal tasdiqlandi: %s (%s)", self._label, ch["name"], ch["id"])

    def _trim_tags(self, tags: list[str]) -> list[str]:
        """Keep tags, in order, while they fit YouTube's 500-character budget.

        YouTube counts the separating commas and wraps a tag that contains a
        space in quotes, which also count — so a multi-word tag costs two more
        than its length. Counting that keeps an upload from being rejected
        with invalidTags when the list sits right at the limit."""
        result, total = [], 0
        for tag in tags:
            cost = len(tag) + (2 if " " in tag else 0) + 1
            if total + cost > MAX_TAGS:
                break
            result.append(tag)
            total += cost
        return result

    def _insert_once(self, body: dict, video_path: Path, title: str, privacy: str) -> str:
        """One videos.insert, chunked and resumable. Returns the new video id;
        raises whatever the client raised."""
        media = MediaFileUpload(
            str(video_path),
            mimetype="video/mp4",
            resumable=True,
            chunksize=10 * 1024 * 1024,
        )

        logger.info("%sYuklanmoqda: '%s' [%s]...", self._label, title, privacy)
        request = self.service.videos().insert(
            part="snippet,status",
            body=body,
            media_body=media,
        )

        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                pct = int(status.progress() * 100)
                logger.info("Yuklash: %d%%", pct)
        return response["id"]

    def _insert_idempotent(self, body: dict, video_path: Path, title: str,
                           privacy: str, attempt) -> str:
        """videos.insert that never puts the same run on the channel twice.

        See modules/upload_idempotency.py. In short: a video id an earlier
        attempt of this run already got back is reused; an earlier insert that
        never reported back is looked up by the run marker first; an ambiguous
        failure now is reconciled by marker before at most one retry; a
        definitive failure is raised as-is and never retried; and when the
        lookup itself fails, nothing is retried at all."""
        from modules import upload_idempotency as ui

        target = self.target_channel_id or ""
        if attempt.video_id:
            exists = ui.video_exists(self.service, attempt.video_id)
            if exists:
                logger.info("%sThis run already uploaded %s — reusing it, not uploading again",
                            self._label, attempt.video_id)
                return attempt.video_id
            if exists is None:
                raise ui.UploadAmbiguousError(
                    f"{self._label}this run already uploaded {attempt.video_id}, but YouTube "
                    "could not be asked whether it still exists — not uploading a second copy")
            logger.warning("%sVideo %s from an earlier attempt is gone from YouTube — uploading anew",
                           self._label, attempt.video_id)
            attempt.forget_video()
        elif attempt.needs_lookup:
            found = ui.reconcile(self.service, attempt.marker, channel_id=target, delays=(0.0,))
            if found.video_id:
                logger.info("%sAn earlier attempt's upload landed as %s (marker %s) — reusing it",
                            self._label, found.video_id, attempt.marker)
                attempt.mark_uploaded(found.video_id)
                return found.video_id
            if not found.ok:
                raise ui.UploadAmbiguousError(
                    f"{self._label}an earlier upload attempt of this run never reported back and "
                    "the channel could not be checked for it — not uploading a possible duplicate")

        retries = 0
        had_ambiguous = False
        while True:
            attempt.mark_started()
            try:
                video_id = self._insert_once(body, video_path, title, privacy)
            except Exception as e:
                if not ui.is_ambiguous(e):
                    # Definitive: the video was not created. Raised as before,
                    # never retried. After an earlier ambiguous try in this
                    # process the record stays "started" so a later attempt
                    # still checks whether that one landed.
                    if not had_ambiguous:
                        attempt.mark_failed()
                    raise
                had_ambiguous = True
                logger.warning("%sUpload outcome unknown (%s: %s) — checking the channel for "
                               "marker %s before anything else", self._label,
                               type(e).__name__, e, attempt.marker)
                found = ui.reconcile(self.service, attempt.marker, channel_id=target)
                if found.video_id:
                    logger.info("%sThe upload did land as %s — reusing it, not uploading again",
                                self._label, found.video_id)
                    attempt.mark_uploaded(found.video_id)
                    return found.video_id
                if not found.ok:
                    raise ui.UploadAmbiguousError(
                        f"{self._label}upload outcome unknown and the channel could not be "
                        "checked — not retrying, to avoid a duplicate") from e
                if retries >= ui.MAX_AMBIGUOUS_RETRIES:
                    raise ui.UploadAmbiguousError(
                        f"{self._label}upload outcome unknown after {retries + 1} attempt(s) and "
                        "no video carries this run's marker yet — stopping; the next attempt "
                        "checks again before uploading") from e
                retries += 1
                logger.warning("%sNo video carries marker %s — retrying the upload once",
                               self._label, attempt.marker)
                continue
            attempt.mark_uploaded(video_id)
            return video_id

    def upload(
        self,
        video_path: Path,
        script: Script,
        thumbnail_path: Path | None = None,
        privacy: str | None = None,
        title_override: str | None = None,
        description_override: str | None = None,
        captions_path: Path | None = None,
        section_timeline: list[dict] | None = None,
        description_suffix: str | None = None,
        attempt=None,
    ) -> dict:
        """Upload one video.

        `title_override` ships the script's alternative title (the B arm of the
        A/B test). None keeps `script.title`, which is what every caller did
        before the experiment existed. `description_override` exists for the
        same reason on the description — a Short points at the long video it
        was cut from, which the script's own description cannot know about.

        `section_timeline` is the audio mixer's measurement of where each
        section starts; given it, the description ships real chapters instead of
        the ones Gemini imagined. `captions_path` is the .srt Whisper already
        wrote for the burnt-in subtitles, offered to YouTube as a caption track.
        Both are optional and both default to the behaviour every caller had
        before they existed.

        `description_suffix` is an extra block appended after the description and
        chapters — a "Watch next" link into another of the channel's videos (see
        modules/watch_next.py), the closest the Data API allows to an end screen,
        which it cannot set. Appended only if it fits under YouTube's limit and
        isn't already present; None keeps the description exactly as before.

        `attempt` (an ``upload_idempotency.UploadAttempt``) makes the upload
        idempotent for one run: its marker is added as the first tag, and an
        ambiguous failure is reconciled against the channel before any retry
        (see modules/upload_idempotency.py). None keeps the old single-shot
        upload exactly.

        Quota: videos.insert is ~1600 units of the 10,000/day; a caption track
        adds ~400. Chapters are description text and cost nothing. A marker
        lookup is ~3 units.
        """
        privacy = privacy or YOUTUBE_PRIVACY
        marker = getattr(attempt, "marker", "") or ""
        # The run marker goes first so trimming can never drop it.
        tags = self._trim_tags(([marker] if marker else [])
                               + [t for t in (script.tags or []) if t != marker])
        title = (title_override or script.title or "").strip() or script.title
        description = description_override if description_override is not None else script.description
        if section_timeline is not None:
            description = compose_description(
                description, build_chapters(section_timeline, script.sections)
            )
        if description_suffix:
            from modules import watch_next
            description = watch_next.append_watch_next(description, description_suffix)

        body = {
            "snippet": {
                "title": title,
                "description": description,
                "tags": tags,
                "categoryId": YOUTUBE_CATEGORY_ID,
                "defaultLanguage": "en",
            },
            "status": {
                "privacyStatus": privacy,
                "selfDeclaredMadeForKids": False,
            },
        }

        # Target specific channel if configured (Brand Account)
        if self.target_channel_id:
            body["snippet"]["channelId"] = self.target_channel_id

        if attempt is None:
            video_id = self._insert_once(body, video_path, title, privacy)
        else:
            video_id = self._insert_idempotent(body, video_path, title, privacy, attempt)
        video_url = f"https://www.youtube.com/watch?v={video_id}"
        logger.info("%sYuklandi: %s", self._label, video_url)

        # With an attempt record, a step an earlier attempt of this run already
        # finished for this same video is not repeated (a second caption track
        # would be a duplicate; the thumbnail is idempotent but costs quota).
        from modules.upload_idempotency import STEP_CAPTIONS, STEP_THUMBNAIL

        if (thumbnail_path and thumbnail_path.exists()
                and not (attempt is not None and attempt.step_done(STEP_THUMBNAIL))):
            try:
                self.service.thumbnails().set(
                    videoId=video_id,
                    media_body=MediaFileUpload(str(thumbnail_path), mimetype="image/jpeg"),
                ).execute()
                logger.info("Thumbnail qo'yildi.")
                if attempt is not None:
                    attempt.mark_step(STEP_THUMBNAIL)
            except Exception as e:
                logger.warning("Thumbnail xatosi: %s", e)

        if captions_path is not None and not (attempt is not None and attempt.step_done(STEP_CAPTIONS)):
            if self.upload_captions(video_id, captions_path) and attempt is not None:
                attempt.mark_step(STEP_CAPTIONS)

        return {"id": video_id, "url": video_url}

    # -- captions ----------------------------------------------------------

    def _granted_scopes(self) -> set[str]:
        """Scopes the stored token was actually granted.

        Read from the token file rather than from the credentials object,
        because `Credentials.from_authorized_user_file` sets `scopes` to what
        the caller *asked* for — checking that would only confirm that
        config.YOUTUBE_SCOPES contains what config.YOUTUBE_SCOPES contains.
        Only scope names are read; no token value is touched or logged.
        An unreadable file yields an empty set, which reads as "not granted".
        """
        try:
            data = json.loads(Path(self.token_file).read_text(encoding="utf-8"))
        except Exception:
            return set()
        if not isinstance(data, dict):
            return set()
        return {str(s) for s in (data.get("scopes") or [])}

    def upload_captions(self, video_id: str, captions_path: Path) -> bool:
        """Attach the Whisper .srt as a caption track. Never raises.

        The file is already written and already burnt into the picture; this
        just also hands it to YouTube, where it becomes searchable text, a
        translation source, and the captions a viewer can turn on over the
        burnt-in ones. It costs ~400 quota units against the day's 10,000.

        Everything here is a soft failure. The video is up by the time this
        runs, and no caption problem may turn a published video into a failed
        run — so each refusal below returns False after saying, once, exactly
        what would make it work.
        """
        path = Path(captions_path)
        if not path.exists() or path.stat().st_size == 0:
            # An empty .srt is what a transcription that found no words leaves
            # behind; uploading it would attach an empty caption track.
            logger.info("%sNo subtitles to upload (%s)", self._label, path.name)
            return False

        language = caption_language(self.channel)
        if language is None:
            logger.warning(
                "%sSubtitles not uploaded: this channel's language is not one this "
                "code can name a caption track with, and a track labelled with the "
                "wrong language is worse than none. Add it to "
                "youtube_uploader.CAPTION_LANGUAGES.",
                self._label,
            )
            return False

        granted = self._granted_scopes()
        if granted and CAPTION_SCOPE not in granted:
            logger.warning(
                "%sSubtitles not uploaded: this token was never granted %s, which "
                "YouTube requires to write a caption track. Add it to "
                "config.YOUTUBE_SCOPES and reconnect the channel with "
                "tools/connect_channel.py. The video itself is unaffected.",
                self._label, CAPTION_SCOPE,
            )
            return False

        try:
            self.service.captions().insert(
                part="snippet",
                body={
                    "snippet": {
                        "videoId": video_id,
                        "language": language,
                        "name": CAPTION_TRACK_NAME,
                        "isDraft": False,
                    }
                },
                media_body=MediaFileUpload(str(path), mimetype="application/octet-stream"),
            ).execute()
        except Exception as e:
            logger.warning("%sSubtitle track failed (%s: %s) — the video is published "
                           "and unaffected", self._label, type(e).__name__, e)
            return False

        logger.info("%sSubtitle track uploaded (%s, ~400 quota units)", self._label, language)
        return True
