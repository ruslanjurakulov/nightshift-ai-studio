"""Video ops: change a library video by a prompt (``video_edit``), change its
shape without cropping it (``video_reframe``) or take its background out
(``video_remove_bg``) — migration 0100.

UNVERIFIED, AND NOT A VENDOR'S API. None of the vendors this repository has
integrated documents these three as an API this code could call, and writing
one vendor's endpoint from memory would pass off a guess as a fact. So this
adapter speaks the repository's own GENERIC async dialect — the one
:class:`modules.video_providers.GenericAsyncVideoClient` already speaks for text
to video: a JSON submit that answers a task id, a poll at a query path that
answers a status and a result URL, the same task-id keys, status words and URL
keys. What is different is that nothing is assumed about WHERE:

* no host, no path and no model are built in. The operator sets them in the
  worker's environment (``VIDEO_OPS_BASE_URL`` https only, ``VIDEO_OPS_SUBMIT_PATH``,
  ``VIDEO_OPS_QUERY_PATH`` with ``{id}``, ``VIDEO_OPS_API_KEY``) and the real vendor
  model in the registry entry (whose ``vendor_model`` ships as a placeholder this
  adapter refuses). Until all of them are set the adapter answers ``not_configured``
  BEFORE any call, and the job fails with nothing charged;
* the request body is ours: ``{model, operation, video, [prompt], [aspect_ratio]}``
  with the library video as an inline data URI (at most 25 MB; never a URL of ours,
  so nothing of the organization is exposed to fetch). A vendor whose API differs
  needs a dialect written from its documentation and probed, exactly like every other
  adapter; the registry entries stay gated until then.

Money never rides on this file's guesses: the price is the database's, the hold is
released on every failure, and a model only becomes sellable after the owner clears
its terms gate, a probe succeeds against the real provider and a price is set.

Keys ride in headers only; a result URL is downloaded without them; a task id is
validated before it is put into a URL. Nothing here logs a prompt, a video or a body.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import List, Mapping, Optional, Sequence

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_UNAVAILABLE,
    EXPAND_ASPECTS,
    FAILED,
    PENDING,
    SUCCEEDED,
    VIDEO_EDIT,
    VIDEO_REFRAME,
    VIDEO_REMOVE_BG,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    is_url,
)

#: The registry entry's vendor_model until the operator names the real one.
PLACEHOLDER_MODEL = "operator-configured"
#: What the generic dialect calls each op in the request.
OPERATIONS = {VIDEO_EDIT: "edit", VIDEO_REFRAME: "reframe", VIDEO_REMOVE_BG: "remove_background"}
#: The longest few words a video edit takes (migration 0100's limit).
MAX_PROMPT = 500

# The generic dialect of modules/video_providers.GenericAsyncVideoClient (VideoProviderConfig's
# defaults and its success / failure words); tests/test_video_ai_ops.py pins them equal.
TASK_ID_KEYS = ("id", "task_id", "taskId", "job_id", "jobId")
STATUS_KEYS = ("status", "state", "task_status")
URL_KEYS = ("url", "video_url", "videoUrl", "download_url", "downloadUrl", "output_url")
SUCCESS_WORDS = frozenset({"success", "succeeded", "succeed", "finished", "done", "complete", "completed", "ready"})
FAILURE_WORDS = frozenset({"fail", "failed", "error", "canceled", "cancelled", "rejected", "expired"})
WRAPPERS = ("data", "result", "job", "resp", "response")

_SAFE_ID = re.compile(r"(?!.*\.\.)[A-Za-z0-9_./:-]{1,256}")
_PATH = re.compile(r"^/[A-Za-z0-9._~/{}-]{0,200}$")
_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska"}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


def unwrap(payload) -> dict:
    """Flatten one common nesting level so an id or URL is found wrapped or not."""
    if not isinstance(payload, dict):
        return {}
    merged = dict(payload)
    for key in WRAPPERS:
        inner = payload.get(key)
        if isinstance(inner, dict):
            merged = {**inner, **merged}
    return merged


def first(d: Mapping, keys: Sequence[str]):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return None


class GenericVideoOpsAdapter(HttpAdapter):
    """The generic async dialect for the three video ops. UNVERIFIED (module docstring)."""

    key = "video.generic_ops"
    key_env = ("VIDEO_OPS_API_KEY",)
    base_url_env = "VIDEO_OPS_BASE_URL"
    #: No host of ours or anyone's: the operator names it (https only).
    default_base_url = ""
    capabilities = (VIDEO_EDIT, VIDEO_REFRAME, VIDEO_REMOVE_BG)
    submit_path_env = "VIDEO_OPS_SUBMIT_PATH"
    query_path_env = "VIDEO_OPS_QUERY_PATH"
    timeout = 120
    #: The video travels inline in the JSON body (base64 grows it by a third).
    MAX_BYTES = 25 * 1024 * 1024

    # -- configuration --------------------------------------------------------
    def _path(self, env_name: str) -> str:
        v = (self._env.get(env_name) or "").strip()
        return v if _PATH.fullmatch(v) else ""

    def submit_path(self) -> str:
        return self._path(self.submit_path_env)

    def query_path(self) -> str:
        p = self._path(self.query_path_env)
        return p if "{id}" in p else ""

    def configured(self) -> bool:
        return bool(self.api_key() and self.base_url and self.submit_path() and self.query_path())

    def require_key(self) -> None:
        if not self.configured():
            # Before any call: nothing reached anyone.
            raise AdapterError(
                E_NOT_CONFIGURED,
                f"this worker has no video-ops provider (set {self.key_env[0]}, {self.base_url_env} to an https URL, "
                f"{self.submit_path_env} and {self.query_path_env} with {{id}})",
                not_accepted=True)

    # -- request validation ---------------------------------------------------
    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        cap = request.capability
        if cap not in self.capabilities:
            return out
        if entry.vendor_model_for(cap) == PLACEHOLDER_MODEL:
            out.append("the registry entry still has the placeholder vendor model: name the real one first")
        if request.input_images:
            out.append(f"{cap} takes a video, not a picture")
        if len(request.input_media) != 1:
            out.append(f"{cap} takes exactly one video")
        for p in request.input_media[:1]:
            path = Path(str(p))
            if is_url(str(p)):
                out.append("the video must be a file from the library, not an https URL")
            elif path.suffix.lower() not in _TYPES:
                out.append("this provider takes MP4, MOV, WebM or MKV video")
            elif path.is_file() and path.stat().st_size > self.MAX_BYTES:
                out.append(f"{cap} takes videos of at most 25 MB")
        words = (request.prompt or "").strip()
        if cap == VIDEO_EDIT:
            if not _CONTROL.sub(" ", words).strip():
                out.append("video_edit needs the words for what to change")
            if len(words) > MAX_PROMPT:
                out.append(f"the words for video_edit are at most {MAX_PROMPT} characters")
        elif words:
            out.append(f"{cap} takes no words")
        if cap == VIDEO_REFRAME:
            if request.aspect_ratio not in EXPAND_ASPECTS:
                out.append(f"video_reframe needs one of the shapes {', '.join(EXPAND_ASPECTS)}")
        elif request.aspect_ratio:
            out.append(f"{cap} keeps the video's own shape: no aspect ratio")
        if request.duration_s is not None or request.resolution or request.scale or request.upscale_target:
            out.append(f"{cap} takes no length, size or factor: the video is the whole input")
        return out

    # -- the generic dialect --------------------------------------------------
    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        cap = request.capability
        if cap not in OPERATIONS or len(request.input_media) != 1 or is_url(str(request.input_media[0])):
            raise AdapterError(E_BAD_REQUEST, f"{cap} edits one video file from the library")
        if vendor_model == PLACEHOLDER_MODEL:
            raise AdapterError(E_NOT_CONFIGURED, "the registry entry still has the placeholder vendor model",
                               not_accepted=True)
        path = Path(str(request.input_media[0]))
        mime = _TYPES.get(path.suffix.lower())
        if not mime or path.stat().st_size > self.MAX_BYTES:
            raise AdapterError(E_BAD_REQUEST, "this provider takes MP4, MOV, WebM or MKV video of at most 25 MB")
        words = _CONTROL.sub(" ", request.prompt or "").strip()[:MAX_PROMPT]
        if cap == VIDEO_EDIT and not words:
            raise AdapterError(E_BAD_REQUEST, "video_edit was asked without what to change")
        if cap == VIDEO_REFRAME and request.aspect_ratio not in EXPAND_ASPECTS:
            raise AdapterError(E_BAD_REQUEST, "video_reframe needs one of the offered shapes")
        body = {"model": vendor_model, "operation": OPERATIONS[cap],
                "video": f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"}
        if cap == VIDEO_EDIT:
            body["prompt"] = words
        if cap == VIDEO_REFRAME:
            body["aspect_ratio"] = request.aspect_ratio
        data = self.post(f"{self.base_url}{self.submit_path()}", body, what=cap)
        task_id = first(unwrap(data), TASK_ID_KEYS)
        if task_id in (None, ""):
            raise AdapterError(E_BAD_RESPONSE, "accepted the request but returned no task id")
        return ProviderTask(self.key, vendor_model, self._safe_id(task_id))

    @staticmethod
    def _safe_id(task_id) -> str:
        tid = str(task_id or "")
        if not _SAFE_ID.fullmatch(tid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        return tid

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        data = self.get(f"{self.base_url}{self.query_path().replace('{id}', self._safe_id(task.task_id))}")
        flat = unwrap(data)
        status = str(first(flat, STATUS_KEYS) or "").strip().lower()
        url = first(flat, URL_KEYS)
        if url is not None and (not status or status in SUCCESS_WORDS):
            if not is_url(str(url)):
                raise AdapterError(E_BAD_RESPONSE, "the result URL is not https")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))])
        if status in SUCCESS_WORDS:
            raise AdapterError(E_BAD_RESPONSE, "succeeded without a result URL")
        if status in FAILURE_WORDS:
            text = self.message(first(flat, ("error", "message", "reason")) or status)
            code = E_POLICY if any(w in text.lower() for w in ("safety", "policy", "moderat", "sensitive")) else E_UNAVAILABLE
            return PollResult(FAILED, error=AdapterError(code, text or "the provider reported the task failed"))
        return PollResult(PENDING)


ADAPTERS = (GenericVideoOpsAdapter,)

__all__ = [a.__name__ for a in ADAPTERS] + ["ADAPTERS"]
