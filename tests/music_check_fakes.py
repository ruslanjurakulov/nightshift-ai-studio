"""A stand-in for the music-check service (modules/vocal_check.py) in adapter tests that are not about it: it answers the
numbers of the run's instrumental negative N1 (docs/MEASUREMENT.md section 10), and records what it was sent."""

from __future__ import annotations

from typing import List, Optional

from modules import vocal_check

#: N1 of run 46132895972: plain solo piano.
INSTRUMENTAL = vocal_check.Signals(umx_share_above=0.0, panns_voice_max=0.032)


class FakeMusicCheck:
    def __init__(self, signals: Optional[vocal_check.Signals] = INSTRUMENTAL, *, error: Optional[Exception] = None,
                 not_ready: Optional[str] = None):
        self.signals, self.error, self.not_ready = signals, error, not_ready
        self.sent: List[bytes] = []
        self.ready_calls = 0

    def ready(self) -> None:
        self.ready_calls += 1
        if self.not_ready:
            raise vocal_check.MusicCheckNotReady(self.not_ready)

    def measure(self, audio: bytes, mime: str = "audio/mpeg") -> vocal_check.Signals:
        self.sent.append(bytes(audio))
        if self.error is not None:
            raise self.error
        return self.signals


def with_check(adapter, check: Optional[FakeMusicCheck] = None):
    """``adapter`` (a GoogleLyriaAdapter, or a RegistryAdapter around one) with ``check`` as its music check."""
    inner = getattr(adapter, "adapter", adapter)
    inner.music_check = check if check is not None else FakeMusicCheck()
    return adapter
