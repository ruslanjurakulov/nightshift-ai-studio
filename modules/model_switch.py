"""The owner's model switch, as the channel pipeline's queue worker sees it (migration 0124, docs/MODEL_SWITCH.md).

What it is for
--------------
The owner can switch a model or a whole provider OFF in the Command Center (a vendor balance ran out, a vendor is down). For the
Creative Studio the database refuses the model everywhere (creative_price, sellable_models, advance_creative_job). A channel-pipeline
run is different: its video and image providers are chosen by the PLATFORM (the worker's env, or the owner's own per-run choice), not by
the customer, and they are called by main.py, a child process that never asks the database. So the worker asks, once, BEFORE it opens
a hold or starts that process, and stops the run if the provider it would call is switched off. Nothing has been spent at that point.

What it does and does not do
----------------------------
* OFF by default. ``NIGHTSHIFT_MODEL_SWITCH`` must be ``on``; without it the worker does not even build the client. Even when it is on,
  the database answers ``enforced: false`` until the owner puts the switches in force, and then nothing is blocked.
* It honours PROVIDER switches only. A pipeline run names a provider (``seedance``), not a registry model, and a provider can run
  several registry models, so a model-level switch cannot be matched to a run without guessing which model the run would call. A
  model-level switch therefore does NOT stop a channel run; the owner switches the provider for that (docs/MODEL_SWITCH.md says so).
* It never substitutes. A run whose provider is off ends as failed with the coded reason ``switched_off`` ("nothing was run, nothing was
  charged"); it is not sent to another provider, to stock footage, or to the same provider later. The hold is released like any run that
  failed before it started (the credit sweep, ``expire_credit_reservations``).
* A provider with no registry entry (``higgsfield``, ``leonardo``, ``fal``) has nothing the switch can say about it: it is not gated.
  Stock footage (``pexels``) is not a model.
* A run that has already started (main.py is running) is never touched: only the moment before the first spend is guarded, the same
  line the creative path draws between "not sent" and "sent".
* If the switch state cannot be read (network, migration 0124 not applied) the run goes on and the worker says so in its log: the
  switch only ever removes capacity, so an unreadable switch is "today's behaviour", never a stopped pipeline. The reason is not
  included in any message: a customer reads "temporarily unavailable", never "out of funds".

Stdlib only, plus ``requests`` imported lazily in the REST client, so the unit tests need no network.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import FrozenSet, List, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

FLAG = "NIGHTSHIFT_MODEL_SWITCH"

#: The coded reason a stopped run carries (modules/render_error.py, lib/runBackend.ts JOB_ERROR_CODES).
CODE = "switched_off"

#: Pipeline provider id -> registry provider id (schemas/model_registry.json ``provider``). tests/test_model_switch.py holds both ends
#: to the files: every value is a provider the registry has, and every key is a provider the workflow offers.
VIDEO_PROVIDERS = {
    "minimax": "minimax",
    "kling": "kling",
    "veo": "google",
    "seedance": "bytedance",
    "wan": "alibaba",
}
IMAGE_PROVIDERS = {
    "gpt-image": "openai",
    "nano-banana": "google",
    "flux": "bfl",
    "ideogram": "ideogram",
}

_TRUE = ("1", "true", "yes", "on")


def _on(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in _TRUE


def enabled(env: Mapping[str, str]) -> bool:
    """Is the worker's gate built at all? Only the literal on/1/true/yes; empty or anything else is off."""
    return _on(env.get(FLAG))


class SwitchUnavailable(RuntimeError):
    """The switch state could not be read (network, HTTP error, migration 0124 not applied). Never carries a key or a response body."""


@dataclass(frozen=True)
class SwitchState:
    enforced: bool
    providers: FrozenSet[str]
    models: FrozenSet[str]


@dataclass(frozen=True)
class Use:
    """One provider a run would call: what the pipeline calls it, and which registry provider that is."""

    kind: str          # "video" | "image"
    pipeline: str      # e.g. "seedance"
    provider: str      # e.g. "bytedance"


def parse_state(raw) -> SwitchState:
    """The database's document, or SwitchUnavailable. A malformed answer is not "nothing is off"."""
    if not isinstance(raw, dict) or not isinstance(raw.get("enforced"), bool):
        raise SwitchUnavailable("model_switch_state: unreadable answer")
    lists = []
    for key in ("providers", "models"):
        v = raw.get(key)
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise SwitchUnavailable("model_switch_state: unreadable answer")
        lists.append(frozenset(v))
    return SwitchState(enforced=raw["enforced"], providers=lists[0], models=lists[1])


class SwitchRest:
    """``model_switch_state()`` over PostgREST with the service key (the worker's, never the Command Center's). Failures carry the HTTP
    status only."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 10.0, session=None):
        import requests  # noqa: PLC0415 — keep imports light for the tests

        self.url = url.rstrip("/")
        self._key = service_key
        self._timeout = timeout
        self._http = session or requests.Session()

    def state(self) -> SwitchState:
        try:
            r = self._http.post(f"{self.url}/rest/v1/rpc/model_switch_state", json={},
                                headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                                         "Content-Type": "application/json"},
                                timeout=self._timeout)
        except Exception as e:  # noqa: BLE001
            raise SwitchUnavailable(f"model_switch_state: {type(e).__name__}") from None
        if r.status_code >= 300:
            raise SwitchUnavailable(f"model_switch_state: HTTP {r.status_code} (is migration 0124 applied?)")
        try:
            return parse_state(r.json())
        except ValueError:
            raise SwitchUnavailable("model_switch_state: unreadable answer") from None


def pipeline_uses(env: Mapping[str, str]) -> List[Use]:
    """The registry providers a run with this env (modules/run_request.build_run_env's answer) would call, from the same rules the
    pipeline applies: video generation is asked for by ``CHRONOS_ENABLE_VIDEO_GEN`` (a run's ``video_provider`` sets it) or, for MiniMax,
    by its own flag (modules/video_providers.requested); image generation by ``CHRONOS_ENABLE_IMAGE_GEN`` with a generator other than
    pexels; a scene regeneration names its provider in ``SCENE_REGEN_PROVIDER``. An id the registry has no provider for is not listed."""
    out: List[Use] = []
    seen: set = set()

    def add(kind: str, pipeline: str, table: Mapping[str, str]) -> None:
        provider = table.get(pipeline)
        if provider and (kind, pipeline) not in seen:
            seen.add((kind, pipeline))
            out.append(Use(kind, pipeline, provider))

    video = (env.get("CHRONOS_VIDEO_PROVIDER") or "").strip().lower() or "minimax"
    if _on(env.get("CHRONOS_ENABLE_VIDEO_GEN")) or (video == "minimax" and _on(env.get("CHRONOS_ENABLE_MINIMAX_BROLL"))):
        add("video", video, VIDEO_PROVIDERS)
    regen = (env.get("SCENE_REGEN_PROVIDER") or "").strip().lower()
    if regen:
        add("video", regen, VIDEO_PROVIDERS)
    image = (env.get("CHRONOS_IMAGE_PROVIDER") or "").strip().lower()
    if _on(env.get("CHRONOS_ENABLE_IMAGE_GEN")) and image and image != "pexels":
        add("image", image, IMAGE_PROVIDERS)
    return out


def blocked(uses: List[Use], state: SwitchState) -> Optional[Use]:
    """The first provider this run would call that the owner switched off, or None. Nothing is blocked while the switches are not in
    force."""
    if not state.enforced:
        return None
    for use in uses:
        if use.provider in state.providers:
            return use
    return None


def refusal_text(use: Use) -> str:
    """What the stopped run says. The pipeline's own name for the provider, never the owner's reason."""
    return (f"the {use.kind} provider {use.pipeline} is temporarily switched off by the platform, so this run was not started "
            "(nothing was run, nothing was charged)")


def check(switches, env: Mapping[str, str]) -> Tuple[Optional[Use], Optional[str]]:
    """(the provider that stops this run or None, a warning to log or None). ``switches`` None = the gate is not built = no check."""
    if switches is None:
        return None, None
    uses = pipeline_uses(env)
    if not uses:
        return None, None
    try:
        state = switches.state()
    except SwitchUnavailable as e:
        return None, f"model switch state unknown ({e}); the run goes on, as it did before the switch existed"
    return blocked(uses, state), None
