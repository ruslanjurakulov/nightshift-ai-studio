"""Cost ledger — what each video actually consumed.

Why quantities, and only sometimes money
-----------------------------------------
Profit cannot be discussed without cost, and nothing in this project recorded
cost before: there was no column for it anywhere. This module fixes that, and it
does so by recording **quantities first**:

    gemini_input_tokens, gemini_output_tokens, tts_characters,
    render_seconds, pexels_requests, upload_bytes

Quantities are facts the pipeline observes. A dollar figure is not: unit prices
differ per vendor plan, change without notice, and are frequently wrong by the
time anyone reads them. So a price is applied **only** when the operator has
configured a rate for that unit (``CHRONOS_PRICE_*``). With no rate configured,
``estimated_usd`` is NULL and the Command Center says the rate is unset — which
is honest — rather than showing an invented number that would quietly become
"the cost" in someone's spreadsheet.

Guarantees
----------
Like ``event_log``, recording a cost must never break a video. Every method
swallows its own failures, and a ledger that cannot reach the store still lets
the pipeline finish.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Canonical unit names. These are the strings that reach the database, so they
# are part of the schema contract — add, don't rename.
GEMINI_INPUT_TOKENS = "gemini_input_tokens"
GEMINI_OUTPUT_TOKENS = "gemini_output_tokens"
TTS_CHARACTERS = "tts_characters"
RENDER_SECONDS = "render_seconds"
PEXELS_REQUESTS = "pexels_requests"
UPLOAD_BYTES = "upload_bytes"
#: Generated media, counted per item. `stage` names the provider that billed it
#: ("broll:<provider>" / "image:<provider>") so spend can be split per account.
VIDEO_GEN_CLIPS = "video_gen_clips"
IMAGE_GENERATIONS = "image_generations"

#: Env var per unit, e.g. CHRONOS_PRICE_GEMINI_INPUT_TOKENS=0.000000075
#: The value is USD *per single unit* — per token, per character, per second.
_PRICE_ENV_PREFIX = "CHRONOS_PRICE_"


def unit_price(unit: str) -> Optional[float]:
    """USD per one unit, or None when the operator has not configured a rate.

    None is a meaningful answer, not a failure: it means "we know the quantity,
    we do not claim to know the price". Callers must not substitute 0.
    """
    raw = os.getenv(_PRICE_ENV_PREFIX + unit.upper(), "").strip()
    if not raw:
        return None
    try:
        price = float(raw)
    except ValueError:
        logger.warning(
            "Ignoring %s%s=%r — not a number, so cost stays unpriced rather than wrong",
            _PRICE_ENV_PREFIX, unit.upper(), raw,
        )
        return None
    return price if price >= 0 else None


@dataclass
class CostEntry:
    """One measured quantity for one video."""

    unit: str
    quantity: float
    stage: str = ""
    estimated_usd: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "unit": self.unit,
            "quantity": self.quantity,
            "stage": self.stage,
            "estimated_usd": self.estimated_usd,
        }


@dataclass
class CostLedger:
    """Accumulates one run's costs, then writes them once.

    Held for the length of a pipeline run and flushed after upload, when the
    video_id is finally known. Entries recorded for a run that never publishes
    are still worth keeping — a failed render costs real money — so `flush`
    accepts a null video_id and records the run under its slug instead.
    """

    channel_id: str = "default"
    slug: str = ""
    entries: list = field(default_factory=list)

    def add(self, unit: str, quantity, stage: str = "") -> None:
        """Record one quantity. Never raises; a bad value is dropped with a
        warning rather than propagating into the pipeline."""
        try:
            amount = float(quantity)
        except (TypeError, ValueError):
            logger.warning("Ignoring non-numeric cost %s=%r", unit, quantity)
            return
        if amount < 0:
            logger.warning("Ignoring negative cost %s=%s", unit, amount)
            return
        price = unit_price(unit)
        self.entries.append(
            CostEntry(
                unit=unit,
                quantity=amount,
                stage=stage,
                # None when unpriced — deliberately not 0.0.
                estimated_usd=round(amount * price, 6) if price is not None else None,
            )
        )

    def add_gemini_usage(self, response, stage: str = "script") -> None:
        """Record token usage from a Gemini response, if it reported any.

        The SDK exposes `usage_metadata` on a successful response. When it is
        absent (an older SDK, a cached response, a mocked object in a test) the
        honest outcome is to record nothing — an invented token count would be
        worse than a gap.
        """
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            return
        prompt_tokens = getattr(usage, "prompt_token_count", None)
        output_tokens = getattr(usage, "candidates_token_count", None)
        if prompt_tokens:
            self.add(GEMINI_INPUT_TOKENS, prompt_tokens, stage)
        if output_tokens:
            self.add(GEMINI_OUTPUT_TOKENS, output_tokens, stage)

    def total_usd(self) -> Optional[float]:
        """Sum of the priced entries, or None when nothing is priced.

        Deliberately not a partial sum: adding up only the units that happen to
        have a rate would read as the run's cost while silently omitting the
        rest. Either every entry is priced or the total is unknown.
        """
        if not self.entries:
            return None
        if any(e.estimated_usd is None for e in self.entries):
            return None
        return round(sum(e.estimated_usd or 0.0 for e in self.entries), 6)

    def flush(self, store, video_id: Optional[str] = None) -> int:
        """Persist every entry. Returns how many rows were written (0 on any
        failure). Never raises."""
        if not self.entries:
            return 0
        recorded_at = datetime.now(timezone.utc).isoformat()
        written = 0
        for entry in self.entries:
            try:
                store.record_video_cost(
                    video_id=video_id or "",
                    channel_id=self.channel_id,
                    slug=self.slug,
                    unit=entry.unit,
                    quantity=entry.quantity,
                    stage=entry.stage,
                    estimated_usd=entry.estimated_usd,
                    recorded_at=recorded_at,
                )
                written += 1
            except Exception as e:
                logger.warning(
                    "Failed to record cost %s for %s (%s: %s)",
                    entry.unit, video_id or self.slug, type(e).__name__, e,
                )
        logger.info(
            "Cost ledger: %d/%d entr(ies) recorded for %s%s",
            written, len(self.entries), video_id or self.slug,
            f" (~${self.total_usd()})" if self.total_usd() is not None else " (unpriced)",
        )
        return written
