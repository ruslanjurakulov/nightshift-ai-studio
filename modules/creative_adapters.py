"""The creative worker's adapter resolver: registry model id -> an adapter of
the capability layer, in the shape :mod:`modules.creative_worker` calls.

    NIGHTSHIFT_CREATIVE_ADAPTERS=modules.creative_adapters:resolve

The two halves were built separately: the worker knows jobs (``submit`` a
:class:`~modules.creative_worker.GenerationRequest`, ``poll`` a task id into a
job folder), the capability layer knows vendors (``CapabilityRequest``,
``ProviderTask``, ``PollResult``, ``fetch``). This module is only the seam:

* EXACT: the job's ``requested_model`` is looked up in
  ``schemas/model_registry.json`` and its own adapter is built — never another
  model's, never a fallback;
* a capability the model's adapter cannot serve (``remove_bg`` today: no
  wired vendor documents it) fails with ``capability_not_supported`` BEFORE
  any call, so the worker releases the hold — there is no fake result;
* the request is checked by the adapter and the registry entry
  (``problems``) before the paid call: a refusal is ``bad_request``, free;
* input images are the local files the worker resolved from the media
  library (``GenerationRequest.input_files``) — never a URL from a job row;
  for the voice tools (0050) that one file is a recording and goes to the
  adapter as ``input_media``, never as a picture; so is the video a video
  upscale (0052) starts from; for ``describe`` (0055) it is the one picture
  read, and the answer comes back as one text output; for ``captions``
  (0072) it is the one recording, and the answer is one JSON output (the
  words and their times) the worker cleans and stores as a caption track;
* an i2v's end frame (0052, ``GenerationRequest.end_file``) goes as
  ``end_image`` only to a model whose registry entry has ``end_frame`` — a
  model that would drop it fails the job before any call instead of
  delivering a clip that ends somewhere else;
* style / character reference pictures (0048,
  ``GenerationRequest.reference_files``) follow them only for a capability
  the adapter lists in ``reference_capabilities``, and only as many as the
  registry entry's ``inputs.image_refs_max`` leaves (``style_support``);
* synchronous vendors (the image APIs) finish inside ``submit``: their
  outputs are kept in this process under a ``sync:<uuid>`` task id and
  written out by the first ``poll``. A worker that restarts in between has
  lost them; that job fails (``output_lost``) and its hold is released — the
  platform may have paid, the customer does not.

Keys stay in the adapters (worker env only); nothing here logs a prompt, a
key or a vendor body.
"""

from __future__ import annotations

import hashlib
import threading
import uuid
from pathlib import Path
from typing import Dict, List, Mapping, Optional

from modules import model_registry
from modules.creative_style import StyleSupport
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    FAILED,
    FILE_INPUT,
    MEDIA_INPUT,
    PENDING,
    VIDEO_INPUT,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    Output,
    PollResult,
    ProviderTask,
)
from modules.creative_worker import (
    FAILED as JOB_FAILED,
    PENDING as JOB_PENDING,
    SUCCEEDED as JOB_SUCCEEDED,
    GenerationRequest,
    ProviderPoll,
    ProviderUsage,
)

SYNC_PREFIX = "sync:"
#: Finished synchronous outputs kept for their first poll (a few per thread).
MAX_SYNC_HELD = 64


class CreativeAdapterError(Exception):
    """A refusal the worker stores as the job's error: ``code`` + ``message``."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _int(v) -> Optional[int]:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and float(v).is_integer() else None


def _str(v) -> Optional[str]:
    return v if isinstance(v, str) and v else None


def capability_request(request: GenerationRequest) -> CapabilityRequest:
    """The job's validated params (0036/0046) in the capability layer's terms."""
    p: Mapping = request.params or {}
    # A recording (0050) or a video (0052): a file, never a picture.
    recording = request.capability in FILE_INPUT
    return CapabilityRequest(
        capability=request.capability,
        # The worker's prompt when it appended a style guide (0048), else the stored one.
        prompt=request.prompt if request.prompt is not None else str(p.get("prompt") or ""),
        negative_prompt=str(p.get("negative_prompt") or ""),
        aspect_ratio=_str(p.get("aspect_ratio")),
        resolution=_str(p.get("resolution")),
        duration_s=_int(p.get("duration_s")),
        voice_id=_str(p.get("voice_id")),
        scale=_int(p.get("factor")),
        # An opaque per-organization id for the vendors that ask for one.
        end_user=hashlib.sha256(f"nightshift-org:{request.org_id}".encode()).hexdigest()[:32],
        input_images=() if recording else tuple(str(f) for f in (*request.input_files, *request.reference_files)),
        input_media=tuple(str(f) for f in request.input_files) if recording else (),
        target_language=_str(p.get("target_language")),
        end_image=str(request.end_file) if request.end_file is not None else None,
        upscale_target=_str(p.get("target_resolution")),
        # describe (0055): the language the description is written in.
        output_language=_str(p.get("language")) if request.capability == "describe" else None,
        # captions (0072): the language spoken in the recording (absent = detected).
        spoken_language=_str(p.get("language")) if request.capability == "captions" else None,
    )


class RegistryAdapter:
    """One registry model's adapter, as the creative worker calls it."""

    def __init__(self, entry, adapter, *, sync_store: Optional[Dict[str, List[Output]]] = None,
                 lock: Optional[threading.Lock] = None):
        self.entry = entry
        self.adapter = adapter
        self._held = sync_store if sync_store is not None else _SYNC_HELD
        self._lock = lock or _SYNC_LOCK

    def _vendor_model(self, capability: str) -> str:
        return self.entry.vendor_model_for(capability)

    def style_support(self, request: GenerationRequest) -> StyleSupport:
        """How many reference pictures this model takes for the job beside its
        own inputs (0 unless the adapter declares references for the
        capability), and its longest prompt."""
        cap = request.capability
        slots = 0
        if cap in getattr(self.adapter, "reference_capabilities", ()):
            slots = max(0, self.entry.image_refs_max - len(request.input_files))
        return StyleSupport(reference_slots=slots, max_prompt_chars=self.entry.max_prompt_chars)

    def submit(self, request: GenerationRequest) -> str:
        cap = request.capability
        if cap not in self.adapter.capabilities or cap not in self.entry.capabilities:
            raise CreativeAdapterError(
                "capability_not_supported",
                f"{self.entry.id} cannot do {cap} on this deployment; nothing was charged")
        # A reference must never reach an adapter that would drop it or read
        # it as something else (a first frame): the worker asks style_support
        # first, and this holds even if it did not.
        if request.reference_files and (
                cap not in getattr(self.adapter, "reference_capabilities", ())
                or len(request.input_files) + len(request.reference_files) > self.entry.image_refs_max):
            raise CreativeAdapterError("bad_request", f"{self.entry.id} cannot take these reference pictures")
        # The job asked for an end frame: it is sent, or nothing is.
        if request.params.get("end_asset_id") and (request.end_file is None or not self.entry.end_frame):
            raise CreativeAdapterError("bad_request", f"{self.entry.id} cannot end this clip on the chosen picture")
        req = capability_request(request)
        problems = self.adapter.problems(req, self.entry)
        if problems:
            raise CreativeAdapterError("bad_request", "; ".join(problems)[:500])
        task: ProviderTask = self.adapter.submit(req, self._vendor_model(cap))
        if task.task_id:
            return str(task.task_id)
        if not task.outputs:
            raise CreativeAdapterError("bad_response", "the provider answered without a task or an output")
        key = SYNC_PREFIX + uuid.uuid4().hex
        with self._lock:
            while len(self._held) >= MAX_SYNC_HELD:
                self._held.pop(next(iter(self._held)))
            self._held[key] = list(task.outputs)
        return key

    def poll(self, task_id: str, request: GenerationRequest, out_dir: Path) -> ProviderPoll:
        cap = request.capability
        if task_id.startswith(SYNC_PREFIX):
            with self._lock:
                outputs = self._held.get(task_id)
            if outputs is None:
                return ProviderPoll(JOB_FAILED, error_code="output_lost",
                                    error="the worker restarted before it stored the provider's result")
            result = PollResult(SUCCEEDED, outputs)
        else:
            result = self.adapter.poll(ProviderTask(self.adapter.key, self._vendor_model(cap), task_id))
        if result.state == PENDING:
            return ProviderPoll(JOB_PENDING)
        if result.state == FAILED:
            err = result.error or AdapterError("bad_response", "the provider failed the task without a reason")
            return ProviderPoll(JOB_FAILED, error_code=err.code, error=err.message)
        # A failed download raises (retried by the worker with the same task);
        # held synchronous outputs are dropped only once they are on disk.
        files = self.adapter.fetch(result, out_dir, stem="output")
        if task_id.startswith(SYNC_PREFIX):
            with self._lock:
                self._held.pop(task_id, None)
        return ProviderPoll(JOB_SUCCEEDED, files=list(files), usage=self.usage(request, len(files)))

    def usage(self, request: GenerationRequest, n_files: int) -> ProviderUsage:
        """What the provider charged in its own unit (0037). USD stays None:
        the registry's prices are unconfirmed, and unknown is never 0."""
        unit = self.entry.raw.get("pricing", {}).get("unit")
        p = request.params or {}
        if request.capability in MEDIA_INPUT or request.capability in VIDEO_INPUT:
            # The recording's (or video's) seconds, as the database measured and priced them.
            qty = request.quantity if unit == "second" else None
        else:
            qty = {"second": _int(p.get("duration_s")),
                   "character": len(str(p.get("prompt") or "")),
                   "image": n_files,
                   # One call per job (a description): the provider bills its
                   # tokens, which this platform does not measure, so USD stays None.
                   "request": 1}.get(unit)
        return ProviderUsage(provider=self.entry.provider, vendor_model=self._vendor_model(request.capability),
                             unit=unit, quantity=float(qty) if qty is not None else None, route="exact")


_SYNC_HELD: Dict[str, List[Output]] = {}
_SYNC_LOCK = threading.Lock()


def resolve(model_id: str, *, env=None) -> Optional[RegistryAdapter]:
    """The adapter for ``model_id`` (registry file), or None when the file does
    not know it — the worker then fails the job with ``adapter_missing``."""
    entry = model_registry.get(str(model_id or ""))
    if entry is None:
        return None
    return RegistryAdapter(entry, build_adapter(entry.adapter, env=env))
