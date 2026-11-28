"""Character Studio adapters (migration 0137, docs/CHARACTER_STUDIO.md): swap the people in a video for the characters in pictures.

Two first-party APIs, both chosen by the person, both terms-gated in the registry (nothing is sold until the owner clears the
terms and sets a credit price in 0137's ``character_swap_models``):

* ``video.kling_omni`` — Kling 4.0 Omni, ``POST /omni-video/kling-4.0`` with the clip as ``base_video`` and each character as a
  ``refer_image``, ``settings.audio: "original"`` (the clip keeps its own sound). Polled with ``GET /tasks?task_ids=<id>``.
  Kling's 4.0 pages take a plain API key as ``Authorization: Bearer``; the legacy access-key/secret JWT is "only applicable to
  legacy version design standards", so a ``KLING_API_KEY`` written as ``<access>:<secret>`` is refused here as not configured.
* ``video.seedance2_edit`` — BytePlus ModelArk Seedance 2.5 in edit mode: the same task API as the 2.x adapter, with the clip as a
  ``reference_video``, each character as a ``reference_image`` and ``omni_reference_task_type: "edit"``. The output follows the
  input's length (``duration: -1``, ``ratio: "adaptive"``); 0137 prices the input's seconds, so the vendor's length rule is what is
  quoted. Seedance 2.x refuses real human faces unless the performer is a verified BytePlus asset: 0137 sells it only for the
  organization's own generated clips (the ModelArk 30-day rule), and the vendor's own refusal stays the last word (``policy``).

The person writes ``@Image 1`` ... ``@Image N`` for the characters and ``@Video 1`` for the clip (BytePlus's own spelling). The
Kling builder renames them to the ids it gives the items. Inputs reach both vendors as short-lived signed https links the worker
makes (modules/character_swap.py): neither vendor is sent a file from disk, and nothing on a job row is ever fetched.

Watermarks (docs/AI_DISCLOSURE.md, "Vendor watermarks and provenance"): neither builder sends a watermark field. Kling's optional mark
(``options.watermark_info``) and Seedance's (``watermark``) are off by default and no clause found requires them, so each maker's
default is what is made, and the file is stored as it arrives.

Both submit through ``SafeResultMixin.submit_json`` (an answer that never arrived is UNCONFIRMED SPEND, never a refusal), validate
task ids before they go into a URL, fetch the result only from the maker's own hosts with no redirect and a byte cap, and raise
``AdapterError`` with a closed code. The caller persists ``ProviderTask.task_id`` BEFORE polling (0137's
``record_character_swap_task``), so a crash polls the paid task instead of paying again.

Field names of Kling's 4.0 Omni items are from Kling's markdown API pages as read for the research note
(docs/CHARACTER_STUDIO.md, "Sources"); the request body is pinned by tests/test_character_swap_adapters.py, and the first probe
the owner approves confirms it against the live API before anything is sold.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    PENDING,
    SUCCEEDED,
    VIDEO_CHARACTER_SWAP,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    dig,
    is_url,
    json_body,
)
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, unconfirmed
from modules.capabilities.video import KlingAdapter, SeedanceV2Adapter, _SAFETY_ID, _failed

#: A character named in the words: ``@Image 3`` (any case, one or more spaces or none before the number).
IMAGE_REF = re.compile(r"@image\s*([0-9]{1,2})\b", re.IGNORECASE)
VIDEO_REF = re.compile(r"@video\s*1\b", re.IGNORECASE)
_TASK_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
RESOLUTIONS = ("720p", "1080p")


def reference_problems(prompt: str, n_images: int) -> List[str]:
    """Why the words do not name the pictures they were sent with. Every ``@Image n`` must be one of the pictures, and at least
    one must be named: a picture nobody names is a character the vendor may put anywhere (or nowhere)."""
    named = {int(m.group(1)) for m in IMAGE_REF.finditer(prompt or "")}
    out: List[str] = []
    if not named:
        out.append("the words name no character: write @Image 1 where it should appear")
    bad = sorted(n for n in named if n < 1 or n > n_images)
    if bad:
        out.append(f"the words name @Image {bad[0]}, but {n_images} picture(s) were given")
    return out


def _input_problems(request: CapabilityRequest, *, max_images: int) -> List[str]:
    out: List[str] = []
    if request.capability != VIDEO_CHARACTER_SWAP:
        return out
    if len(request.input_media) != 1:
        out.append("a character swap takes exactly one video")
    elif not is_url(str(request.input_media[0])):
        out.append("the video must be an https URL the vendor can fetch (a signed link)")
    if not 1 <= len(request.input_images) <= max_images:
        out.append(f"a character swap takes 1 to {max_images} pictures")
    elif not all(is_url(str(p)) for p in request.input_images):
        out.append("every picture must be an https URL the vendor can fetch (a signed link)")
    if request.resolution not in RESOLUTIONS:
        out.append(f"resolution {request.resolution or '(none)'} is not offered: the price depends on it, so it is never defaulted")
    if request.duration_s is not None:
        out.append("the length follows the video: a duration does not apply")
    if request.aspect_ratio is not None:
        out.append("the clip keeps its own shape: an aspect ratio does not apply")
    if request.audio is not None:
        out.append("the soundtrack rule is the model's own: an audio flag does not apply")
    out.extend(reference_problems(request.prompt, len(request.input_images)))
    return out


# ── Kling 4.0 Omni (kling.ai/document-api/api/video/4-0/omni-video) ─────────
class KlingOmniEditAdapter(SafeResultMixin, HttpAdapter):
    """``POST {base}/omni-video/{model}`` → ``data.task_id``; ``GET {base}/tasks?task_ids={id}`` → ``data[].status`` and
    ``data[].outputs[].url``. Kling's business codes are the legacy adapter's table (``KlingAdapter.code_for``)."""

    key = "video.kling_omni"
    key_env = ("KLING_API_KEY",)
    base_url_env = "KLING_BASE_URL"
    default_base_url = "https://api-singapore.klingai.com"
    capabilities = (VIDEO_CHARACTER_SWAP,)
    resolution_capabilities = (VIDEO_CHARACTER_SWAP,)
    #: The key rides in a header: a 3xx from the API host is refused, never followed.
    follow_redirects = False
    #: Kling's own CDN (the pages themselves are served from *.klingai.com). A host outside it fails closed.
    result_hosts = ("klingai.com",)
    MODELS = ("kling-4.0",)
    MAX_IMAGES = 10

    def api_key(self) -> str:
        key = (self._env.get("KLING_API_KEY") or "").strip()
        return key if key and ":" not in key else ""

    def secrets(self) -> List[str]:
        raw = (self._env.get("KLING_API_KEY") or "").strip()
        parts = [p.strip() for p in raw.split(":")] if raw else []
        return [s for s in (raw, *parts) if s] + super().secrets()

    def require_key(self) -> None:
        if not self.configured():
            raise AdapterError(E_NOT_CONFIGURED, "no Kling API key on this worker (set KLING_API_KEY to the console API key; an "
                                                 "access-key:secret pair is the legacy API's and Kling 4.0 does not take it)",
                               not_accepted=True)

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        return KlingAdapter.code_for(json_body(text).get("code"))

    def _check(self, data) -> object:
        if not isinstance(data, dict):
            raise AdapterError(E_BAD_RESPONSE, "the answer is not a JSON object")
        code = KlingAdapter.code_for(data.get("code"))
        if code:
            raise AdapterError(code, self.message(data.get("message") or "Kling error"))
        return data.get("data")

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        out = [] if vendor_model in self.MODELS else [f"{vendor_model!r} is not a Kling Omni model this adapter knows"]
        return out + _input_problems(request, max_images=self.MAX_IMAGES)

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        return super().problems(request, entry) + self._spec_problems(request, entry.vendor_model_for(request.capability))

    @staticmethod
    def kling_prompt(prompt: str) -> str:
        """Our ``@Image n`` / ``@Video 1`` as the ids this builder gives the items (``@image_n`` / ``@video_1``)."""
        text = IMAGE_REF.sub(lambda m: f"@image_{int(m.group(1))}", prompt.strip())
        return VIDEO_REF.sub("@video_1", text)

    def build_body(self, request: CapabilityRequest, *, external_id: Optional[str] = None) -> Dict:
        contents: List[Dict] = [{"type": "prompt", "text": self.kling_prompt(request.prompt)},
                                {"type": "base_video", "id": "video_1", "url": str(request.input_media[0])}]
        contents += [{"type": "refer_image", "id": f"image_{i}", "url": str(u)} for i, u in enumerate(request.input_images, start=1)]
        body: Dict = {"contents": contents,
                      # "original": the edited clip keeps the base video's own sound (Kling's own flag; nothing is re-mixed).
                      "settings": {"resolution": request.resolution, "audio": "original"}}
        if external_id and _TASK_ID.fullmatch(external_id):
            # Our job id: a task we never heard back about can be found on Kling's side by it.
            body["options"] = {"external_task_id": external_id}
        return body

    def submit(self, request: CapabilityRequest, vendor_model: str, *, external_id: Optional[str] = None) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        data = self._check(self.submit_json(f"{self.base_url}/omni-video/{vendor_model}",
                                            self.build_body(request, external_id=external_id)))
        tid = dig(data, "task_id") if isinstance(data, dict) else None
        if not isinstance(tid, str) or not _TASK_ID.fullmatch(tid):
            raise unconfirmed("the answer carries no usable task id")
        return ProviderTask(self.key, vendor_model, tid)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = str(task.task_id or "")
        if not _TASK_ID.fullmatch(tid):
            raise AdapterError(E_BAD_REQUEST, "task id has an unexpected shape")
        data = self._check(self.get(f"{self.base_url}/tasks", params={"task_ids": tid}))
        items = data if isinstance(data, list) else (dig(data, "tasks") if isinstance(data, dict) else None)
        item = next((x for x in (items or []) if isinstance(x, dict) and str(x.get("task_id") or "") == tid), None)
        if item is None:
            return PollResult(PENDING)
        status = str(item.get("status") or "").lower()
        if status == "succeeded":
            url = dig(item, "outputs", 0, "url")
            if not isinstance(url, str) or not url:
                raise after_completion(AdapterError(E_BAD_RESPONSE, "succeeded without an output URL"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
        if status == "failed":
            return _failed(self, item.get("status_msg") or item.get("message") or "task failed")
        return PollResult(PENDING, vendor_state=status)


# ── BytePlus Seedance 2.5, edit mode (docs.byteplus.com/en/docs/ModelArk/2607688) ─
class SeedanceEditAdapter(SeedanceV2Adapter):
    """The 2.x task API in edit mode. ``poll`` and the result fetch are the 2.x adapter's (ModelArk hosts, no redirect, capped)."""

    key = "video.seedance2_edit"
    capabilities = (VIDEO_CHARACTER_SWAP,)
    end_frame_capabilities = ()
    audio_capabilities = ()
    resolution_capabilities = (VIDEO_CHARACTER_SWAP,)
    EDIT_MODELS = ("dreamina-seedance-2-5-260628",)
    MAX_IMAGES = 30
    #: BytePlus: an edit prompt must say it edits ("edit the video", "replace", "remove", "modify"), or the task type is read wrong.
    EDIT_WORDS = re.compile(r"\b(edit|replace|remove|modify)", re.IGNORECASE)

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        out = [] if vendor_model in self.EDIT_MODELS else [f"{vendor_model!r} is not a Seedance model with an edit mode"]
        out += _input_problems(request, max_images=self.MAX_IMAGES)
        if not self.EDIT_WORDS.search(request.prompt or ""):
            out.append("Seedance reads an edit only from words that say so: use replace, edit, modify or remove")
        return out

    def build_body(self, request: CapabilityRequest, vendor_model: str) -> Dict:
        content: List[Dict] = [{"type": "text", "text": request.prompt.strip()},
                               {"type": "video_url", "video_url": {"url": str(request.input_media[0])}, "role": "reference_video"}]
        content += [{"type": "image_url", "image_url": {"url": str(u)}, "role": "reference_image"} for u in request.input_images]
        body: Dict = {"model": vendor_model, "content": content, "omni_reference_task_type": "edit",
                      "resolution": request.resolution, "ratio": "adaptive",
                      # The output follows the input's length: what 0137 quoted is the input's seconds.
                      "duration": -1,
                      # No new soundtrack is made (or billed); the picker tells the person this model does not keep the clip's sound.
                      "generate_audio": False,
                      "execution_expires_after": self.EXPIRES_AFTER_S}
        if request.end_user and _SAFETY_ID.fullmatch(request.end_user):
            body["safety_identifier"] = request.end_user
        return body

    def submit(self, request: CapabilityRequest, vendor_model: str, *, external_id: Optional[str] = None) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        data = self.submit_json(f"{self.base_url}/api/v3/contents/generations/tasks", self.build_body(request, vendor_model))
        tid = data.get("id") if isinstance(data, dict) else None
        if not isinstance(tid, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", tid):
            raise unconfirmed("the answer carries no usable task id")
        return ProviderTask(self.key, vendor_model, tid)


ADAPTERS: Sequence[type] = (KlingOmniEditAdapter, SeedanceEditAdapter)

__all__ = ["ADAPTERS", "IMAGE_REF", "KlingOmniEditAdapter", "SeedanceEditAdapter", "reference_problems"]
