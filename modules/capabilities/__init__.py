"""Capability layer (docs/CREATIVE_OS_PLAN.md §3.3): one adapter per vendor API,
addressed by the ``adapter`` key a model's registry entry names.

    from modules.capabilities import adapter_class, build_adapter
    adapter = build_adapter("video.kling")          # reads keys from os.environ
"""

from __future__ import annotations

from typing import Dict, Mapping, Optional, Type

from modules.capabilities import audio, image, video
from modules.capabilities.base import HttpAdapter

#: adapter key → class. The registry's "adapter" values must all resolve here
#: (tests/test_model_registry.py pins that).
ADAPTERS: Dict[str, Type[HttpAdapter]] = {
    cls.key: cls for cls in (*image.ADAPTERS, *video.ADAPTERS, *audio.ADAPTERS)
}


def adapter_class(key: str) -> Optional[Type[HttpAdapter]]:
    return ADAPTERS.get(key)


def build_adapter(key: str, *, env: Optional[Mapping[str, str]] = None, session=None) -> HttpAdapter:
    cls = ADAPTERS.get(key)
    if cls is None:
        raise KeyError(f"unknown adapter {key!r}")
    return cls(env=env, session=session)
