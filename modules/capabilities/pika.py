"""Pika 2.5 and Pikaframes (Pika's own models on the Pika API): text-to-video, image-to-video and two-keyframe video.

Sources, all read 2026-10-25: ``dev.pika.art/llms.txt`` (the API overview), ``dev.pika.art/openapi.json`` (OpenAPI 3.1),
the operation pages ``dev.pika.art/llms/pika/pika-2.5/text-to-video``, ``.../pika-2.5/image-to-video`` and
``.../pikaframes/image-to-video``, the public catalogue ``api.dev.pika.art/catalog/apis`` (and its per-operation
``?expand=inputs`` records), the Terms of Service (``dev.pika.art/terms-of-service``, last updated 08/04/2026) and the
Acceptable Use Policy (``pika.art/acceptable-use-policy``, last updated 05/16/2025).

ONLY PIKA'S OWN MODELS. The same API resells 168 other operations of 23 other makers (Seedance, Kling, Veo, Wan, GPT,
...); none of them is here (the owner's rule is the maker's own API, never an aggregator), and ``SPECS`` below is the
whole list: any other model name is refused.

* A job is created with ``POST /v1/media/pika/<model>/<function>`` and answers a job object ``{"id", "status"}``;
  ``GET /v1/media/jobs/{id}`` answers ``status`` (queued | running | completed | failed), ``output.video.url`` when
  completed, ``error {code, message}`` and ``billing`` when failed. A submit the vendor rejects AFTER creating the
  job row (no balance, rate limit, an unpriceable combination) answers the failed job envelope.
* Authentication is ``X-API-Key``. The key is sent to the API host and nowhere else; no redirect is followed.
* A picture is a URL, never bytes: ``image`` / ``images`` must be ``^https?://``. A local file is first uploaded with
  ``POST /v1/media/uploads`` and its raw bytes (the OpenAPI document's "legacy CDN URL (raw request)" form, which answers
  ``{"url"}`` directly). The documented form is a presigned PUT to a storage host the pages do not name; this adapter does NOT
  follow a vendor-supplied upload URL. The hosted ``url`` it gets back is checked against Pika's two hosts before it is
  passed on. The upload is not a billable call (``billable=False``: it is not counted as a call that could have started
  something, so a proven refusal of the paid call that follows still stands), and a failure of it is reported as
  not accepted.
* EVERYTHING IS CHECKED BEFORE THE FIRST UPLOAD: both pictures are read and sniffed (``read_picture``) first, so a refused
  picture job sends nothing. A user's picture then sits on Pika's CDN, where Pika may use Inputs to train (ToS section 7): the
  adapter DELETEs every picture it uploaded (``DELETE /v1/media/uploads?url=``, the OpenAPI document: "purge it from the CDN"),
  best effort and never raising, to the API host only, with the key and no redirect, (a) at once when the upload or the paid call
  fails or its answer is lost, and (b) when a poll sees the job end (completed, failed, or a status this adapter does not know).
  The list of uploads of a running job is kept in memory: after a worker restart between submit and the end of the job
  those pictures are NOT deleted by us. Pika's own retention of the job's media and request (``DELETE /v1/media/jobs/{id}``) is not touched.

What is sent, and why: the price is per output second by resolution, so ``resolution`` and ``duration_s`` are required and
sent as given (the vendor's own resolution default is 1080p, the dearest tier). Pika 2.5 has no aspect ratio, seed is not
sent, and there is no audio flag (``audio_out`` is false: the pages name no sound). ``Idempotency-Key`` is not sent: a lost
submit answer is never retried, so there is nothing for it to protect.

Not wired, so nobody can reach them: image-to-video of 10 s, Pikaffects (image and video; the named effect needs a request field and a capability the
registry does not have), Pikaswaps and Pikadditions (video-to-video: a video must be uploaded by the presigned form, the
region mask / ROI / reference image have no request field, and ``video_edit`` is priced per source second while Pika charges
per request), the audio, merge, compose and caption operations, and every third-party model.

RESULT LINKS: the example is ``https://api.dev.pika.art/v1/files/video_....mp4`` and the pages show ``cdn.pika.art`` for
hosted media. ``RESULT_HOSTS`` is those two hosts, and ``checked_url`` accepts exactly them (a subdomain is refused). The pages do not say whether the files route needs the key; the key is
NEVER sent to it, so if a probe's download is refused with 401 / 403 the link fails closed with the spend note and a person
decides how to handle it. Nothing about how long a link or a job's media lives was found (``DELETE /v1/media/jobs/{id}`` exists
and is not called): store the clip at once.

BILLING: the pages say "Only successful generations are charged". That is Pika's claim, not verified here; a failed job's
message quotes the charge Pika's own job record reports, and says it is Pika's statement. Nothing here tells a person a failed
job was free.

TERMS: ``terms_gate: terms_review_required``. ToS section 7 requires "appropriate attribution in a manner reasonably visible
to end users, unless your Plan expressly permits white-labeling" (white-labeling of Pika's first-party models is enterprise-only);
the registry's ``attribution`` is that line. Section 7 also lets Pika "use anonymized or aggregated Content, including Inputs,
Outputs, and your interactions with the Service ... to train, improve, and develop its machine learning models", under a
perpetual licence.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    I2V,
    PENDING,
    SUCCEEDED,
    T2V,
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
from modules.capabilities.pictures import read_picture
from modules.capabilities.safe_fetch import UNCONFIRMED, SafeResultMixin, after_completion, checked_result_url, unconfirmed

logger = logging.getLogger(__name__)

#: The two Pika hosts the pages show: the API (result example) and the CDN (hosted inputs). Exact hosts, not ``pika.art``.
RESULT_HOSTS = ("api.dev.pika.art", "cdn.pika.art")
#: The statuses the OpenAPI document lists for a job (and no others): the first two are in flight.
_IN_FLIGHT = ("queued", "running")
#: How many running jobs' uploads / billing figures are kept in memory.
_KEEP = 64

_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
#: Said after any job Pika reports as failed. Its pages say only successful generations are charged: its claim.
SPEND_UNKNOWN = ("SPEND UNKNOWN: Pika's pages say only successful generations are charged (a vendor claim, unverified "
                 "here); check the Pika usage page before assuming nothing was spent")
#: ``error.code`` of a failed job (every operation page lists the same twelve) -> ours.
_ERRORS = {
    "invalid_input": E_BAD_REQUEST, "content_moderation": E_POLICY, "rate_limited": E_RATE_LIMITED,
    "insufficient_balance": E_QUOTA, "cycle_limit_exceeded": E_QUOTA, "membership_required": E_QUOTA,
    "provider_error": E_UNAVAILABLE, "provider_timeout": E_UNAVAILABLE, "provider_unavailable": E_UNAVAILABLE,
    "admission_suspended": E_UNAVAILABLE, "timed_out": E_UNAVAILABLE, "internal": E_UNAVAILABLE,
}
_RESOLUTIONS = ("720p", "1080p")
_PATHS = {("pika-2.5", T2V): "pika-2.5/text-to-video", ("pika-2.5", I2V): "pika-2.5/image-to-video",
          ("pikaframes", I2V): "pikaframes/image-to-video"}


class PikaVideoAdapter(SafeResultMixin, HttpAdapter):
    """Pika 2.5 (text-to-video, image-to-video) and Pikaframes (a first and a last picture)."""

    key = "video.pika"
    key_env = ("PIKA_API_KEY",)
    base_url_env = "PIKA_BASE_URL"
    default_base_url = "https://api.dev.pika.art"
    capabilities = (T2V, I2V)
    resolution_capabilities = (T2V, I2V)     # always sent
    end_frame_capabilities = (I2V,)          # Pikaframes: the last keyframe
    result_hosts = RESULT_HOSTS
    #: The key rides every call in a header: a 3xx is an error, never followed.
    follow_redirects = False
    timeout = 60
    #: Where a hosted (uploaded) picture may live; exact hosts, see ``_exact``.
    upload_hosts = RESULT_HOSTS
    #: The docs cap an uploaded image at 20 MB; a local one is sent as raw bytes.
    MAX_IMAGE_BYTES = 20 * 1024 * 1024
    #: vendor model -> what it serves. Durations: Pika 2.5 text-to-video is 5 s only; image-to-video takes 5 or 10 s but the
    #: catalogue prices 1080p at $0.09 per second for a 5 s clip and $0.06 for the generic tier, so only 5 s is offered (the price
    #: is then exact, not a guess between two). Pikaframes is ONE transition between two pictures, 1 to 5 s (the page says 1-10
    #: but "Multiple transitions are limited to 5 seconds each", and the cap for two pictures is not stated: the lower one).
    SPECS = {
        "pika-2.5": {"modes": ("t2v", "i2v"), "resolutions": _RESOLUTIONS,
                     "durations": {"t2v": (5,), "i2v": (5,)}},
        "pikaframes": {"modes": ("end",), "resolutions": _RESOLUTIONS, "durations": {"end": (1, 2, 3, 4, 5)}},
    }

    def __init__(self, **kw):
        super().__init__(**kw)
        #: job id -> the hosted pictures it was started with, deleted when the job ends (see the module note).
        self._uploads: Dict[str, List[str]] = {}
        #: job id -> (billing.state, billing.charge_micro_usd) as Pika's job record reported it; for ``probe_note``.
        self.billing_reported: Dict[str, Tuple[str, Optional[int]]] = {}
        #: Status words this adapter does not know, counted.
        self.unknown_statuses: Dict[str, int] = {}

    def auth_headers(self) -> Dict[str, str]:
        return {"X-API-Key": self.api_key()}

    @staticmethod
    def _exact(url: str, hosts, ports) -> str:
        """``url`` when it passes ``checked_result_url`` AND its host is one of ``hosts`` exactly (``checked_result_url`` also
        accepts a subdomain of a host; for Pika's two hosts that is not wanted)."""
        url = checked_result_url(url, hosts, ports)
        host = (urlsplit(url).hostname or "").lower()
        if host not in hosts:
            raise AdapterError(E_BAD_RESPONSE, f"the link is not on one of Pika's own hosts ({host!r}); it was not used")
        return url

    def checked_url(self, url) -> str:
        return self._exact(url, self.result_hosts, self.result_ports)

    def probe_note(self, task: ProviderTask) -> str:
        """What the probe prints beside OK: Pika's own billing figure for the job, to compare with the registry estimate."""
        seen = self.billing_reported.get(str(task.task_id or ""))
        if not seen:
            return "Pika reported no billing figure"
        state, charge = seen
        return f"billing reported by Pika: {state}" + (f", charge {charge} micro-USD" if charge is not None else "") + \
            " (compare with the registry estimate; micro-USD / 1,000,000 = dollars)"

    def _remember(self, store: dict, key: str, value) -> None:
        store[key] = value
        while len(store) > _KEEP:
            old = next(iter(store))
            evicted = store.pop(old)
            if store is self._uploads:
                self._delete_uploads(evicted)

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        # Never for a 5xx: a gateway can answer 502 / 503 / 504 in front of a Pika that already took the job, and a vendor word
        # ("provider_unavailable") must not turn that into a refusal. The status decides, so it stays unconfirmed.
        if status >= 500:
            return None
        return _ERRORS.get(str(dig(json_body(text), "error", "code") or ""))

    @staticmethod
    def _mode(request: CapabilityRequest) -> str:
        if request.capability == T2V:
            return "t2v"
        return "end" if request.end_image else "i2v"

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Pika model this adapter knows"]
        out: List[str] = []
        mode = self._mode(request)
        if vendor_model == "pikaframes":
            if request.capability != I2V or not request.end_image:
                out.append("Pikaframes needs a first and a last picture")
            mode = "end"
        elif mode == "end":
            out.append("Pika 2.5 takes one picture: a last frame belongs to Pikaframes")
        elif mode not in spec["modes"]:
            out.append(f"{vendor_model} has no {mode} here")
        if request.resolution not in spec["resolutions"]:
            out.append(f"resolution {request.resolution or '(none)'} is not offered by {vendor_model}: the price "
                       f"depends on it, so it is never defaulted")
        allowed = spec["durations"].get(mode, ())
        if isinstance(request.duration_s, bool) or request.duration_s not in allowed:
            out.append(f"duration {request.duration_s if request.duration_s is not None else '(none)'} s is not offered "
                       f"by {vendor_model} here ({', '.join(str(d) for d in allowed)}): the price is per second, so it "
                       f"is never defaulted")
        if request.aspect_ratio:
            out.append("Pika takes no aspect ratio: the shape follows the picture or the prompt")
        if request.capability == T2V:
            if not request.prompt.strip():
                out.append("prompt is empty")
            if request.input_images:
                out.append("a picture does not apply to text-to-video")
        else:
            if not request.input_images:
                out.append("i2v needs a first-frame picture")
            elif len(request.input_images) > 1:
                out.append("Pika takes one first-frame picture")
            if any(is_url(str(r)) for r in (*request.input_images, request.end_image) if r):
                out.append("a picture must be a local file, not an https URL: the worker hands over files, never links")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def _upload(self, mime: str, data: bytes) -> str:
        """Upload one checked picture (raw bytes, its real type) and return the hosted link Pika answers. Not a billable call; a
        failure is not accepted: nothing was sent that could have started a job."""
        try:
            answer = self._call("POST", f"{self.base_url}/v1/media/uploads", what="upload", data=data,
                                headers={"Content-Type": mime}, billable=False)
        except AdapterError as e:
            raise AdapterError(e.code, f"the upload failed: {e.message}", http_status=e.http_status, not_accepted=True) from None
        url = answer.get("url") if isinstance(answer, dict) else None
        try:
            return self._exact(url, self.upload_hosts, self.result_ports)
        except AdapterError:
            raise AdapterError(E_BAD_RESPONSE, "the upload failed: the answer carries no usable hosted picture link",
                               not_accepted=True) from None

    def _delete_uploads(self, urls) -> None:
        """Best effort, never raising: ask Pika to purge each picture it hosts for us. The key goes to the API host only (the
        link is only a query value), nothing is followed, and a failure is logged without the link."""
        for url in list(urls or ()):
            try:
                self._call("DELETE", f"{self.base_url}/v1/media/uploads", what="delete upload", params={"url": url}, raw=True,
                           timeout=20, billable=False)
            except Exception:  # noqa: BLE001 - cleanup must never turn a result into an error
                logger.warning("pika: could not delete an uploaded picture; it stays on Pika's CDN until Pika removes it")

    def _failed_job(self, data: dict) -> Optional[AdapterError]:
        """The failed job envelope a REJECTED submit answers (also under a 2xx): the vendor's own refusal, with its error code.
        One that reads as an outage (``provider_error``, ``internal``, a code we do not know) proves nothing about whether work
        was started, so it says so like any other lost answer."""
        if isinstance(data, dict) and str(data.get("status") or "").lower() == "failed":
            err = data.get("error") if isinstance(data.get("error"), dict) else {}
            code = _ERRORS.get(str(err.get("code") or ""), E_UNAVAILABLE)
            text = self.message(err.get("message") or err.get("code") or "the job failed")
            return AdapterError(code, f"{UNCONFIRMED}. {text}" if code == E_UNAVAILABLE else text)
        return None

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        mode = self._mode(request) if vendor_model != "pikaframes" else "end"
        cap = T2V if mode == "t2v" else I2V
        # EVERY picture is read and checked BEFORE the first upload: a refused picture job sends nothing at all.
        refs = [] if mode == "t2v" else [str(request.input_images[0])] + ([str(request.end_image)] if mode == "end" else [])
        pictures = [read_picture(r, max_bytes=self.MAX_IMAGE_BYTES, who="Pika") for r in refs]
        hosted: List[str] = []
        try:
            for mime, data in pictures:
                hosted.append(self._upload(mime, data))
            body: dict = {"resolution": request.resolution}
            prompt = request.prompt.strip()
            if prompt:
                body["prompt"] = prompt
            if request.negative_prompt.strip():
                body["negative_prompt"] = request.negative_prompt.strip()
            if mode == "end":
                body["images"] = hosted
                body["transition_duration_s"] = int(request.duration_s)
            else:
                body["duration_s"] = int(request.duration_s)
                if mode == "i2v":
                    body["image"] = hosted[0]
            data = self.submit_json(f"{self.base_url}/v1/media/pika/{_PATHS[(vendor_model, cap)]}", body)
            failed = self._failed_job(data)
            if failed:
                raise failed
            jid = data.get("id") if isinstance(data, dict) else None
            if not isinstance(jid, str) or not _ID.fullmatch(jid):
                # The vendor answered 2xx: a job probably exists, and it bills.
                raise unconfirmed("the answer carries no usable job id")
        except BaseException:
            # The paid call was refused, failed or its answer was lost (or an upload failed): the pictures must not stay on Pika's CDN.
            self._delete_uploads(hosted)
            raise
        if hosted:
            self._remember(self._uploads, jid, hosted)
        return ProviderTask(self.key, vendor_model, jid)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        jid = str(task.task_id or "")
        if not _ID.fullmatch(jid):
            raise AdapterError(E_NOT_FOUND, "job id has an unexpected shape")
        data = self.get(f"{self.base_url}/v1/media/jobs/{jid}")
        data = data if isinstance(data, dict) else {}
        raw_status = data.get("status")
        status = raw_status.lower() if isinstance(raw_status, str) else None
        if status in _IN_FLIGHT:
            return PollResult(PENDING)
        billing = data.get("billing") if isinstance(data.get("billing"), dict) else {}
        charge = billing.get("charge_micro_usd")
        charge = charge if isinstance(charge, int) and not isinstance(charge, bool) else None
        if isinstance(billing.get("state"), str):
            self._remember(self.billing_reported, jid, (billing["state"], charge if billing["state"] == "settled" else None))
        try:
            if status == "completed":
                url = dig(data, "output", "video", "url")
                if not isinstance(url, str) or not url:
                    # The vendor says the clip exists (and bills it): we just were not given the link.
                    raise after_completion(AdapterError(E_BAD_RESPONSE, "completed without output.video.url"))
                return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
            if status == "failed":
                err = data.get("error") if isinstance(data.get("error"), dict) else {}
                code = str(err.get("code") or "")
                text = self.message(err.get("message") or code or "the job failed")
                seen = (f" Pika's job record says billing {billing.get('state')} at {charge} micro-USD (its statement, "
                        f"unverified).") if billing.get("state") == "settled" and charge is not None else ""
                return PollResult(FAILED, error=AdapterError(_ERRORS.get(code, E_UNAVAILABLE),
                                                             f"{text}.{seen} {SPEND_UNKNOWN}"))
            # Anything else (canceled, expired, deleted, error, empty, not text) is a job that will not finish as listed: the
            # OpenAPI document names exactly four statuses, so an unknown word is a failure, not a job still running.
            if isinstance(raw_status, str):
                word = self.message(raw_status)[:40] or "(none)"
            else:
                word = "(none)" if raw_status is None else "(not text)"
            self.unknown_statuses[word] = self.unknown_statuses.get(word, 0) + 1
            logger.warning("pika: job status %r is not one of queued, running, completed, failed; treated as a failure", word)
            return PollResult(FAILED, error=AdapterError(
                E_UNAVAILABLE, f"Pika reported a job status this adapter does not know ({word}). {SPEND_UNKNOWN}"))
        finally:
            # The job has ended: the pictures it was started with are no longer needed on Pika's CDN.
            self._delete_uploads(self._uploads.pop(jid, ()))


ADAPTERS = (PikaVideoAdapter,)
