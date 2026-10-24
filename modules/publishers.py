"""The shape a platform takes when the worker cross-posts a finished video, and the
registry ``social_publish.process_request`` looks the platform up in.

Why this exists: ``process_request`` used to branch on the platform's name
(``if platform not in ("instagram", "tiktok", "youtube")``, then
``if platform == "instagram" ... else tiktok``), so a fourth platform meant
editing the middle of a function that decides what leaves this machine. Now the
function runs ONE sequence for every platform and the platform supplies the four
steps that differ. It changes no behaviour: ``tests/test_publisher_transcripts.py``
holds a recording of what the old code did, for all three platforms and every
refusal word each can reach, and the new code must reproduce it exactly.

The sequence (``social_publish.process_request``), and what each step is for:

1. look the platform up here. An unknown one is REFUSED (``unknown_platform``)
   before anything is read: there is no default publisher, and a word we do not
   recognise is never routed to the nearest platform (CLAUDE.md #4);
2. the gate and the approval, again, right before anything leaves this machine
   (``publish_request_refusal``; not a platform's business, so not in this file);
3. ``Publisher.connect``: refuse unless this request's account or channel may be
   used (token read and refreshed, or the target channel checked);
4. the master render is found (no silent fallback to the 480p review copy);
5. ``Publisher.check``: refuse what the platform cannot take, from the file itself;
6. the AI-disclosure decision is made, by ``modules/ai_disclosure.py`` and nowhere
   else (``social_publish._decide_disclosure``);
7. ``Publisher.compose``: the platform's words (caption or title/description) and
   ``PostSpec.ai_generated``, which is the decision's label and nothing more;
8. the row says ``processing`` with the caption that is about to be sent;
9. ``Publisher.publish``: the upload. THE ONE PLACE a platform's AI field is
   written: YouTube ``status.containsSyntheticMedia`` (through the uploader),
   Instagram ``is_ai_generated``, TikTok ``post_info.is_aigc``. Each is sent only
   when ``PostSpec.ai_generated`` is true; an absent field is the unlabelled post
   every video has always been;
10. the row says ``published`` with what the platform read back.

A refusal or a failure is a ``social_publish.PublishStop`` raised from any step:
the one error shape (status, reason word, our own short detail).

What this module deliberately does not hold: any platform's code, a token, a
network call. The three adapters stay in ``social_publish`` (their behaviour is
pinned there) and register themselves when that module is imported; a registry
read before that import is empty, which refuses everything, which is the safe
failure. Adding a platform is: write a ``Publisher``, ``register`` it, and add the
migration that lets ``publish_requests`` / ``social_accounts`` hold its name.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Tuple, runtime_checkable


@dataclass(frozen=True)
class PostSpec:
    """What one platform is about to be sent, composed by that platform's own ``Publisher.compose``."""

    #: Recorded in ``publish_requests.caption`` BEFORE the upload, so the row says what was sent.
    caption: str
    #: ``ai_disclosure.Decision.label``. The decision is made elsewhere; a publisher only maps this to its field.
    ai_generated: bool
    #: Recorded with the ``processing`` row when the platform's privacy is known before the upload (YouTube).
    privacy: Optional[str] = None
    #: Whatever else the same publisher's ``publish`` needs from its ``compose`` (opaque to everything else).
    payload: Any = None


@dataclass(frozen=True)
class PublishContext:
    """Everything one request hands a publisher. Built once per request by ``process_request``."""

    request: Mapping
    video: Mapping
    store: Any
    tokens: Any
    worker_id: str
    output_dir: Path
    http: Any
    env: Mapping[str, str]
    sleep: Callable[[float], None]
    heartbeat: Callable[[], None]
    probe_fn: Callable[[Path], Any]
    media_fn: Callable[[Path], Any]
    #: The YouTube adapter, or None on a worker with no YouTube setup (then a YouTube request fails clearly).
    youtube: Any = None


@runtime_checkable
class Publisher(Protocol):
    """One platform, for one request. Methods are called in the order of the module docstring, each at most once."""

    #: The registry key, and the value of ``publish_requests.platform``.
    platform: str

    def connect(self) -> None:
        """Raise ``PublishStop`` unless this request's account (or target channel) may be used."""

    def check(self, path: Path) -> None:
        """Raise ``PublishStop`` when the platform cannot take this file."""

    def compose(self, meta: Any, decision: Any) -> PostSpec:
        """The platform's words for ``meta`` (``social_captions.SourceMeta``) and the disclosure ``decision``."""

    def publish(self, path: Path, post: PostSpec) -> Mapping:
        """Upload ``path``. Returns ``result_id``, ``result_url`` and ``privacy`` (what the platform reported)."""

    def describe(self) -> str:
        """Where it went, in words, for the worker's log line (never a token)."""


PublisherFactory = Callable[[PublishContext], Publisher]

_FACTORIES: Dict[str, PublisherFactory] = {}


def register(platform: str, factory: PublisherFactory) -> None:
    """Claim ``platform`` for ``factory``. A second claim raises: replacing a publisher silently is how a
    request ends up on the wrong platform."""
    if not isinstance(platform, str) or not platform or platform != platform.strip().lower():
        raise ValueError(f"platform names are non-empty, lower-case words, not {platform!r}")
    if platform in _FACTORIES:
        raise ValueError(f"a publisher for {platform!r} is already registered")
    _FACTORIES[platform] = factory


def factory_for(platform: Any) -> Optional[PublisherFactory]:
    """The factory for exactly this platform word, or None. No normalising ("Instagram", " tiktok"), no default."""
    return _FACTORIES.get(platform) if isinstance(platform, str) else None


def platforms() -> Tuple[str, ...]:
    return tuple(sorted(_FACTORIES))


__all__ = ["PostSpec", "PublishContext", "Publisher", "PublisherFactory", "register", "factory_for", "platforms"]
