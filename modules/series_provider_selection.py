"""Unwired provider selector for the existing series planner's generate callable.

The caller injects its existing Gemini callable as the unchanged default. OpenAI
and Claude are explicit, already-approved adapter registrations, not SDK clients
created here. Selection makes no inference call, reads no configuration and never
falls back. The original planner still owns prompt building, parsing and vetting.

This small seam is not the full AI Brain gateway, a capability qualification,
credential broker, model approval or cost permit. Nothing imports it in a worker.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import FrozenSet, Literal, Mapping, Optional, Protocol

Provider = Literal["gemini", "openai", "claude"]
PLANNING_CAPABILITY = "series_plan"


class PlanningGenerate(Protocol):
    def __call__(self, prompt: str, *, stage: str) -> str: ...


@dataclass(frozen=True)
class PlanningAdapter:
    provider: Provider
    model_ref: str
    generate: PlanningGenerate
    capabilities: FrozenSet[str] = frozenset()


class PlanningSelectionError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)  # Never include prompt, model output or caller data.


def select_series_generator(
    gemini_generate: PlanningGenerate,
    *,
    provider: Provider = "gemini",
    adapters: Optional[Mapping[str, PlanningAdapter]] = None,
) -> PlanningGenerate:
    """Return exactly one callable; no calls, retries or implicit substitution.

    The Gemini branch returns the supplied baseline object unchanged. External
    registrations must name their exact approved model/revision and declare the
    planning capability; declarations here are not proof of vendor support.
    The caller must qualify and authorize a real adapter before registering it.
    """
    if provider not in ("gemini", "openai", "claude"):
        raise PlanningSelectionError("model_unavailable")
    if provider == "gemini":
        if not callable(gemini_generate):
            raise PlanningSelectionError("model_unavailable")
        return gemini_generate
    adapter = (adapters or {}).get(provider)
    if not isinstance(adapter, PlanningAdapter) or adapter.provider != provider or not callable(adapter.generate):
        raise PlanningSelectionError("model_unavailable")
    if not isinstance(adapter.model_ref, str) or not adapter.model_ref.strip():
        raise PlanningSelectionError("model_unavailable")
    if PLANNING_CAPABILITY not in adapter.capabilities:
        raise PlanningSelectionError("policy_denied")
    return adapter.generate
