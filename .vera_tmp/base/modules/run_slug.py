"""The name of a run's directory and checkpoint (BR-G-007).

``output/<slug>/`` holds a run's script, media, Video IR, held cut and
checkpoint, and until now ``<slug>`` was the topic alone. Two organizations that
ran one topic on one worker therefore shared a directory: the second run landed
in the first's folder under the first's checkpoint, and each could overwrite the
other's held cut.

The key now carries the channel:

* A channel of the operator's own organization keeps the topic slug
  (``legacy_slug``): every existing run, checkpoint, ``videos.slug`` and
  storyboard of the operator's keeps its name, and nothing needs migrating.
* A channel of any other organization gets ``<topic head>-<16 hex of the
  channel's own hash>`` (at most 50 characters, so every ``slug`` check in the
  database still accepts it). Two channels never share one, whatever the topic.
* Whoever the channel belongs to, a slug whose checkpoint already belongs to a
  DIFFERENT channel is never reused: the keyed form is taken instead (an
  operator channel running a topic another channel holds), and if even that is
  held by another channel the run stops before it spends (``RunDirectoryConflict``).

Existing runs of a customer organization (named by the topic alone) are found by
``candidates``, which lists the keyed form first and the legacy one second, and
the callers accept a legacy directory only when its checkpoint names this
channel. They are not renamed; a run that finishes or is cleared leaves nothing
behind, and a new run of the topic uses the keyed name.

Pure standard library: the pipeline's other modules import this without
pulling in the rest of it.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import List, Optional

#: Longest slug (the storyboards table accepts up to 50 characters).
MAX_LEN = 50
#: Hex characters of the channel hash in a keyed slug (64 bits).
TAG_LEN = 16


class RunDirectoryConflict(RuntimeError):
    """The run's directory belongs to another channel and so does the keyed one."""


def legacy_slug(topic: str) -> str:
    """The topic-only slug every run used before the channel was part of it
    (main.slugify, repeated so this module never imports main)."""
    return re.sub(r"[^a-z0-9]+", "-", str(topic).lower()).strip("-")[:MAX_LEN]


def channel_tag(channel_id: str) -> str:
    return hashlib.sha256(b"nightshift-run-key\0" + str(channel_id).encode("utf-8")).hexdigest()[:TAG_LEN]


def keyed_slug(topic: str, channel_id: str) -> str:
    head = legacy_slug(topic)[: MAX_LEN - 1 - TAG_LEN].strip("-")
    tag = channel_tag(channel_id)
    return f"{head}-{tag}" if head else tag


def run_slug(topic: str, channel_id: str, *, operators: bool) -> str:
    """The slug a NEW run of ``topic`` on ``channel_id`` is written under."""
    return legacy_slug(topic) if operators else keyed_slug(topic, channel_id)


def candidates(topic: str, channel_id: str, *, operators: Optional[bool] = None) -> List[str]:
    """Every slug a run of ``topic`` on ``channel_id`` may be found under, in
    the order to try them. ``operators`` unknown (None) lists both."""
    legacy = legacy_slug(topic)
    keyed = keyed_slug(topic, channel_id)
    if operators is True:
        out = [legacy, keyed]
    else:
        out = [keyed, legacy]
    seen: List[str] = []
    for slug in out:
        if slug and slug not in seen:
            seen.append(slug)
    return seen


def owner_of(slug: str, root: Optional[Path] = None) -> str:
    """The channel recorded on ``slug``'s checkpoint, '' when there is none."""
    from modules import run_checkpoint  # noqa: PLC0415 — imports config

    cp = run_checkpoint.load(slug, root)
    return (cp.channel_id or "") if cp is not None else ""


def resolve(topic: str, channel_id: str, *, operators: bool, root: Optional[Path] = None) -> str:
    """The slug a run of ``topic`` on ``channel_id`` uses on this disk: its
    own name, unless that directory is recorded as another channel's."""
    channel_id = str(channel_id)
    slug = run_slug(topic, channel_id, operators=operators)
    owner = owner_of(slug, root)
    if owner and owner != channel_id:
        keyed = keyed_slug(topic, channel_id)
        if keyed == slug or (owner_of(keyed, root) not in ("", channel_id)):
            raise RunDirectoryConflict(
                f"the run directory {slug!r} belongs to channel {owner!r}, not {channel_id!r}: "
                "nothing was started. Run the topic under another title, or remove that run's "
                "directory from the worker's output/ if it is finished.")
        return keyed
    return slug
