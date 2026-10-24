"""Provider interfaces — the seam that keeps Nightshift free of vendor lock-in.

STATUS: NOT WIRED. No production code imports this module; main.py, tools/,
the queue worker and the other modules call the concrete modules (AudioMixer,
YouTubeUploader, AnalyticsClient, research_topic, MediaFetcher and the image and
video provider routers) directly. Only tests/test_providers.py imports it. It is
kept on purpose as the documented target for a future provider swap (it is
described as the "shape-only seams" in docs/CREATIVE_OS_PLAN.md and named in
docs/ROADMAP_VIDEO_OS.md and config.py, modules/avatar.py,
modules/video_providers.py), not because anything depends on it. Treat the
adapters below as unproven against a real run: the tests use fakes. If you
migrate a call site behind these protocols, delete this paragraph.

Each capability the pipeline depends on (research, images, video clips, voice,
publishing, analytics) is expressed here as a small ``typing.Protocol``. The
concrete modules that exist today satisfy these shapes, and a future provider
(a different stock library, a different TTS, a different platform) only has to
match the shape to drop in — nothing in the pipeline needs to name the vendor.

Design notes
------------
* These are **structural** contracts (``@runtime_checkable`` Protocols), not a
  base class anyone must inherit. ``MediaFetcher`` already *is* an
  ``ImageProvider`` and a ``VideoProvider`` because it has the right methods —
  no adapter, no edit to that module. That is the point of using Protocols:
  the abstraction is additive and imposes nothing on the code it describes.
* This module holds NO API keys and makes NO network calls of its own. It is
  types plus thin adapters that delegate to the existing modules, importing
  them lazily: ``GeminiResearchProvider`` around ``research_topic``, and
  ``AudioMixerVoiceProvider`` / ``YouTubeUploaderPublishingProvider`` /
  ``AnalyticsClientAnalyticsProvider`` around ``AudioMixer``, ``YouTubeUploader``
  and ``AnalyticsClient`` (further down). They add no behaviour of their own.

Nothing here changes runtime behaviour, because nothing runs it (see STATUS).
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, Sequence, runtime_checkable


@runtime_checkable
class ResearchProvider(Protocol):
    """Turns a topic into a research brief (facts, angles, open questions)."""

    def research(self, topic: str, niche: str = "") -> object:
        ...


@runtime_checkable
class ImageProvider(Protocol):
    """Fetches still images matching keywords. Returns local file paths."""

    def fetch_images(self, keywords: Sequence[str], count: int = 8) -> list[Path]:
        ...


@runtime_checkable
class VideoProvider(Protocol):
    """Fetches b-roll video clips matching keywords. Returns local file paths."""

    def fetch_videos(self, keywords: Sequence[str], count: int = 10) -> list[Path]:
        ...


@runtime_checkable
class VoiceProvider(Protocol):
    """Synthesises narration audio for a script/text to a local file.

    The adapter over modules/audio_mixer.py is AudioMixerVoiceProvider below.
    """

    def synthesize(self, text: str, out_path: Path) -> Path:
        ...


@runtime_checkable
class PublishingProvider(Protocol):
    """Publishes a rendered video to a platform, returning at least an id/url.

    The adapter over modules/youtube_uploader.py is
    YouTubeUploaderPublishingProvider below.
    """

    def upload(self, video_path: Path, script: object, **kwargs) -> dict:
        ...


@runtime_checkable
class AnalyticsProvider(Protocol):
    """Reads back performance metrics for a published video.

    The adapter over modules/analytics_client.py is
    AnalyticsClientAnalyticsProvider below.
    """

    def fetch_metrics(self, video_id: str) -> dict:
        ...


class GeminiResearchProvider:
    """Real ResearchProvider backed by the existing research_topic() function.

    A thin, honest adapter: it gives the module-level function a class shape so
    it satisfies the ResearchProvider protocol. It adds no behaviour of its own
    and imports research_topic lazily so importing this module stays cheap.
    """

    def research(self, topic: str, niche: str = "history mysteries") -> object:
        from modules.research_engine import research_topic

        return research_topic(topic, niche)


def research_provider() -> ResearchProvider:
    """The default research provider. A factory so a future config can swap the
    implementation without call sites changing."""
    return GeminiResearchProvider()


# ---------------------------------------------------------------------------
# Concrete adapters over the existing capability modules.
#
# Each wraps a richer, stateful module (AudioMixer, YouTubeUploader,
# AnalyticsClient) behind the thin Protocol above. They import their module
# LAZILY and accept the wrapped object by injection, so importing this file
# stays cheap and a test can pass a fake without pulling edge_tts / pydub /
# the Google API client. They add no behaviour of their own — every call
# delegates to the real module, so the seam can never drift from what the
# pipeline actually does.
# ---------------------------------------------------------------------------


class AudioMixerVoiceProvider:
    """VoiceProvider over modules/audio_mixer.AudioMixer.

    Delegates one text to the mixer's real per-segment TTS — the same voice a
    production run uses, including the channel's ElevenLabs/Edge configuration.
    Narration only: the SFX/music bed is AudioMixer.build()'s job, a different
    concern from "synthesize this text", which is what the contract asks for.
    """

    def __init__(self, mixer=None, *, slug: str = "voice", channel=None, voice_role: str = "main"):
        self._mixer = mixer
        self._slug = slug
        self._channel = channel
        self._voice_role = voice_role

    def _get_mixer(self):
        if self._mixer is None:
            from modules.audio_mixer import AudioMixer

            self._mixer = AudioMixer(self._slug, channel=self._channel)
        return self._mixer

    def synthesize(self, text: str, out_path: Path) -> Path:
        return Path(self._get_mixer().synthesize_text(text, Path(out_path), voice_role=self._voice_role))


class YouTubeUploaderPublishingProvider:
    """PublishingProvider over modules/youtube_uploader.YouTubeUploader.

    Passes the video and script straight through to the real uploader; keyword
    arguments (thumbnail_path, privacy, title_override, captions_path,
    section_timeline, …) flow through unchanged, so nothing the uploader can do
    is hidden behind the seam.
    """

    def __init__(self, uploader=None, *, channel=None):
        self._uploader = uploader
        self._channel = channel

    def _get_uploader(self):
        if self._uploader is None:
            from modules.youtube_uploader import YouTubeUploader

            self._uploader = YouTubeUploader(self._channel)
        return self._uploader

    def upload(self, video_path: Path, script: object, **kwargs) -> dict:
        return self._get_uploader().upload(Path(video_path), script, **kwargs)


class AnalyticsClientAnalyticsProvider:
    """AnalyticsProvider over modules/analytics_client.AnalyticsClient.

    fetch_metrics reads the video's core metrics over a trailing window
    (default 28 days, ending today UTC). An absent metric stays absent — the
    underlying client returns {} rather than a guessed zero, and this adapter
    preserves that: a missing number must never become a fabricated one.
    """

    def __init__(self, client=None, *, channel=None, lookback_days: int = 28):
        self._client = client
        self._channel = channel
        self._lookback_days = lookback_days

    def _get_client(self):
        if self._client is None:
            from modules.analytics_client import AnalyticsClient

            self._client = AnalyticsClient(self._channel)
        return self._client

    def fetch_metrics(self, video_id: str) -> dict:
        from datetime import date, timedelta

        end = date.today()
        start = end - timedelta(days=max(1, self._lookback_days))
        return self._get_client().video_performance(
            video_id, start.isoformat(), end.isoformat()
        )


def voice_provider(channel=None, *, slug: str = "voice") -> VoiceProvider:
    """The default voice provider (a factory, so a future TTS can be swapped in
    without call sites changing)."""
    return AudioMixerVoiceProvider(slug=slug, channel=channel)


def publishing_provider(channel=None) -> PublishingProvider:
    """The default publishing provider."""
    return YouTubeUploaderPublishingProvider(channel=channel)


def analytics_provider(channel=None, *, lookback_days: int = 28) -> AnalyticsProvider:
    """The default analytics provider."""
    return AnalyticsClientAnalyticsProvider(channel=channel, lookback_days=lookback_days)
