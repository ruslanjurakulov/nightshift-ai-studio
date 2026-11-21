"""The likeness policy switch, worker side: the same rule as command-center/lib/likeness-policy.ts.

WHY. The payment providers' terms (Paddle's Acceptable Use Policy, Dodo's Merchant Acceptance Policy) do not allow us to sell face swaps
of real people or a person's voice reproduced, and we told Dodo in writing (21 Nov 2026) that these are off in the paid product. The web
routes refuse them, but a job can still reach a worker through a door the web check does not cover (an RPC called directly, a job queued
before the switch went off). So the workers ask too: a job whose capability replaces a real person's face or voice is failed with
``feature_unavailable_policy`` through the worker's own fail path, which releases the whole hold. Nothing is charged, nothing is sent.

OFF unless ``NIGHTSHIFT_LIKENESS_FEATURES`` is exactly "on" (trimmed, any case): unset, empty, "1" or "true" can never sell it.
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

FLAG = "NIGHTSHIFT_LIKENESS_FEATURES"
#: The closed code a refused job ends with (the web routes answer the same word).
REFUSAL = "feature_unavailable_policy"
#: Character Studio's swap (0137) and the creative ``dub`` (re-voices real speakers in their own cloned voice).
LIKENESS_CAPABILITIES = frozenset({"video_character_swap", "dub"})


def allowed(env: Optional[Mapping[str, str]] = None) -> bool:
    source = os.environ if env is None else env
    return str(source.get(FLAG) or "").strip().lower() == "on"


def refused(capability: object, env: Optional[Mapping[str, str]] = None) -> bool:
    """True when a job of this capability must not run on this worker now."""
    return isinstance(capability, str) and capability in LIKENESS_CAPABILITIES and not allowed(env)
