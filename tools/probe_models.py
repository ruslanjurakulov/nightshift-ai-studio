"""Probe generative models: one cheapest real call per model, recorded in the DB.

A model is offered to users only after a real call through its adapter has
worked with the owner's key (CLAUDE.md, Definition of Done; migration 0035).
This is the admin-run tool that makes that call and records it:

    # what would be called, which keys are present — no network, no DB, no spend
    python tools/probe_models.py --dry-run --all

    # copy the reviewed registry file into the database (static facts only)
    python tools/probe_models.py --sync

    # probe two models for real and record the result (verified_at on success)
    python tools/probe_models.py --model veo-3.1-lite --model elevenlabs-flash-v2.5

    # the same for a public log (.github/workflows/probe_models.yml): one line
    # per model, "ok <id>", "failed <id> <error code>" or "skipped <id>"
    python tools/probe_models.py --sync --all --brief

Run it on the worker (the provider keys live in its env; docs/DEPLOY_AX42.md)
with SUPABASE_URL and SUPABASE_SERVICE_KEY set. Each probe is the registry
entry's ``probe`` request — the shortest, lowest-resolution call the model
takes — and it costs real money; the dry run shows what each would be.

Nothing it prints can hold a key: every line goes through a scrubber that
removes the value of every secret-named env var and every token-shaped string,
and adapters only ever report status codes and scrubbed vendor text.
A probe that succeeds does NOT put a model on sale: the owner still chooses
beta/ga, and the database still requires a price and cleared vendor terms.
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Iterable, List, Mapping, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import model_registry  # noqa: E402
from modules.capabilities import build_adapter  # noqa: E402
from modules.capabilities.base import (  # noqa: E402
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    SUCCEEDED,
    TTS,
    AdapterError,
    scrub,
)
from tools.queue_worker import secret_values  # noqa: E402

logger = logging.getLogger("probe_models")

VOICE_ENV = "ELEVENLABS_VOICE_ID"
DEFAULT_TIMEOUT_S = 900
POLL_EVERY_S = 10
#: File signatures a real output starts with; a 200 with an HTML error page is not an image.
_MAGIC = {".png": (b"\x89PNG",), ".jpg": (b"\xff\xd8",), ".webp": (b"RIFF",),
          ".mp4": (b"ftyp",), ".mp3": (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")}


class ScrubFilter(logging.Filter):
    """Rewrites every log record with secrets removed — the last line of
    defence if an exception text ever carries something it should not."""

    def __init__(self, secrets: Sequence[str]):
        super().__init__()
        self._secrets = list(secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = scrub(record.getMessage(), self._secrets)
        record.args = None
        return True


#: The only error words --brief prints: the adapters' typed codes and the
#: tool's own. Anything else reads "other" — vendor text never reaches a public log.
BRIEF_CODES = frozenset({
    E_NOT_CONFIGURED, E_AUTH, E_QUOTA, E_RATE_LIMITED, E_BAD_REQUEST, E_POLICY,
    E_NOT_FOUND, E_UNAVAILABLE, E_BAD_RESPONSE, "timeout"})


def setup_logging(env: Mapping[str, str], stream=None, *, brief: bool = False) -> ScrubFilter:
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    if brief:
        # A public log: only this tool's own lines, never a library's.
        handler.addFilter(lambda record: record.name == logger.name)
    filt = ScrubFilter(secret_values(env))
    handler.addFilter(filt)
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    # urllib3/requests debug lines name hosts and paths; keep them out.
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    return filt


# ── the database (PostgREST RPC with the service key) ──────────────────────
class RegistryDB:
    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        import requests  # noqa: PLC0415

        self.url = url.rstrip("/")
        self._key = service_key
        self._http = session or requests.Session()
        self._timeout = timeout

    def rpc(self, fn: str, payload: dict):
        headers = {"apikey": self._key, "Authorization": f"Bearer {self._key}",
                   "Content-Type": "application/json"}
        try:
            r = self._http.post(f"{self.url}/rest/v1/rpc/{fn}", json=payload, headers=headers,
                                timeout=self._timeout)
        except Exception as e:  # noqa: BLE001 — only the class name leaves this function
            raise RuntimeError(f"{fn}: could not reach the database ({type(e).__name__})") from None
        if r.status_code >= 300:
            hint = " — is migration 0035 applied?" if r.status_code in (404, 400) else ""
            raise RuntimeError(f"{fn}: HTTP {r.status_code}{hint}")
        return r.json()

    def sync(self, rows: List[dict]) -> int:
        return int(self.rpc("sync_model_registry", {"p_rows": rows}) or 0)

    def record(self, *, model: str, adapter: str, vendor_model: str, capability: str, ok: bool,
               error_code: Optional[str], error: Optional[str], latency_ms: int,
               output_bytes: Optional[int], probed_by: str) -> int:
        return int(self.rpc("record_model_probe", {
            "p_model": model, "p_adapter": adapter, "p_vendor_model": vendor_model,
            "p_capability": capability, "p_ok": ok, "p_error_code": error_code, "p_error": error,
            "p_latency_ms": latency_ms, "p_output_bytes": output_bytes, "p_probed_by": probed_by}))


# ── one probe ───────────────────────────────────────────────────────────────
class ProbeResult:
    def __init__(self, model: str, ok: bool, code: Optional[str] = None, message: str = "",
                 latency_ms: int = 0, output_bytes: Optional[int] = None, task_id: Optional[str] = None):
        self.model, self.ok, self.code, self.message = model, ok, code, message
        self.latency_ms, self.output_bytes, self.task_id = latency_ms, output_bytes, task_id


def probe_image(dest: Path) -> Path:
    """A plain generated frame for image-to-video probes: nothing of anyone's."""
    from PIL import Image  # noqa: PLC0415

    size = (1280, 720)
    horizontal = Image.linear_gradient("L").rotate(90).resize(size)
    vertical = Image.linear_gradient("L").resize(size)
    Image.merge("RGB", (horizontal, vertical, Image.new("L", size, 128))).save(dest, "PNG")
    return dest


def _looks_real(path: Path) -> bool:
    head = path.read_bytes()[:16]
    sigs = _MAGIC.get(path.suffix)
    if not sigs:
        return True
    return any(head.startswith(s) or s in head[:12] for s in sigs)


def run_probe(entry, *, env: Mapping[str, str], voice_id: Optional[str], workdir: Path,
              timeout_s: int = DEFAULT_TIMEOUT_S, poll_every_s: float = POLL_EVERY_S,
              session=None, sleep: Callable[[float], None] = time.sleep,
              clock: Callable[[], float] = time.monotonic) -> ProbeResult:
    """Make the entry's probe call and fetch its output. Never raises for a
    vendor failure: it becomes a typed ProbeResult."""
    adapter = build_adapter(entry.adapter, env=env, session=session)
    image = None
    if entry.raw["probe"].get("input_image") == "generated":
        image = str(probe_image(workdir / "probe_frame.png"))
    request = entry.probe_request(voice_id=voice_id, generated_image=image)
    started = clock()
    task = None
    try:
        if not adapter.configured():
            raise AdapterError(E_NOT_CONFIGURED, f"no key for {entry.adapter} on this machine")
        if request.capability == TTS and not voice_id:
            # Our setup, not the vendor's answer: never guess a voice (CLAUDE.md ceiling).
            raise AdapterError(E_NOT_CONFIGURED, f"set --voice-id or {VOICE_ENV} to a voice from the account")
        problems = adapter.problems(request, entry)
        if problems:
            return ProbeResult(entry.id, False, "bad_request", "; ".join(problems))
        task = adapter.submit(request, entry.vendor_model_for(request.capability))
        result = adapter.poll(task)
        while result.state not in (SUCCEEDED, FAILED):
            if clock() - started > timeout_s:
                return ProbeResult(entry.id, False, "timeout", f"no result after {timeout_s}s",
                                   int((clock() - started) * 1000), task_id=task.task_id)
            sleep(poll_every_s)
            result = adapter.poll(task)
        if result.state == FAILED:
            err = result.error or AdapterError(E_BAD_RESPONSE, "failed without a reason")
            return ProbeResult(entry.id, False, err.code, err.message,
                               int((clock() - started) * 1000), task_id=task.task_id)
        files = adapter.fetch(result, workdir, stem=entry.id)
        if not files or not all(_looks_real(f) for f in files):
            raise AdapterError(E_BAD_RESPONSE, "the output is not a media file")
        size = sum(f.stat().st_size for f in files)
        return ProbeResult(entry.id, True, latency_ms=int((clock() - started) * 1000),
                           output_bytes=size, task_id=task.task_id)
    except AdapterError as e:
        return ProbeResult(entry.id, False, e.code, e.message, int((clock() - started) * 1000),
                           task_id=task.task_id if task else None)


# ── CLI ─────────────────────────────────────────────────────────────────────
def select(entries: Iterable, ids: Sequence[str], capability: Optional[str], everything: bool) -> List:
    entries = list(entries)
    known = {e.id for e in entries}
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise SystemExit(f"unknown model id(s): {', '.join(unknown)}")
    chosen = [e for e in entries if everything or e.id in ids]
    return [e for e in chosen if capability is None or capability in e.capabilities]


def describe(entry, env: Mapping[str, str], voice_id: Optional[str]) -> str:
    adapter = build_adapter(entry.adapter, env=env)
    req = entry.probe_request(voice_id=voice_id, generated_image="<generated frame>")
    parts = [f"{entry.id:32} {entry.adapter:22} key={'yes' if adapter.configured() else 'NO'}",
             f"{req.capability} {entry.vendor_model_for(req.capability)}"]
    for k in ("aspect_ratio", "resolution", "image_size", "duration_s"):
        v = getattr(req, k)
        if v is not None:
            parts.append(f"{k}={v}")
    if entry.terms_gate:
        parts.append(f"terms_gate={entry.terms_gate}")
    if entry.doc_source != "vendor_sdk":
        parts.append(f"docs={entry.doc_source}")
    if req.capability == TTS and not voice_id:
        parts.append(f"(needs --voice-id or {VOICE_ENV})")
    return "  ".join(parts)


def main(argv: Optional[Sequence[str]] = None, *, env: Optional[Mapping[str, str]] = None,
         db: Optional[RegistryDB] = None, stream=None) -> int:
    env = dict(os.environ if env is None else env)
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", action="append", default=[], help="model id (repeatable)")
    ap.add_argument("--all", action="store_true", help="every model in the registry")
    ap.add_argument("--capability", help="only models with this capability")
    ap.add_argument("--dry-run", action="store_true", help="show what would be called; no network, no DB")
    ap.add_argument("--sync", action="store_true", help="copy the registry file into the database first")
    ap.add_argument("--voice-id", help=f"ElevenLabs voice for TTS probes (default: {VOICE_ENV})")
    ap.add_argument("--by", default=f"probe_models@{socket.gethostname()[:60]}",
                    help="who ran the probe (stored as verified_by)")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S, help="seconds to wait per async probe")
    ap.add_argument("--brief", action="store_true",
                    help="for a public log: per model only 'ok/failed/skipped <id>' and a typed error code")
    args = ap.parse_args(argv)
    setup_logging(env, stream, brief=args.brief)

    entries = select(model_registry.registry().values(), args.model, args.capability, args.all)
    if not entries and not args.sync:
        logger.info("nothing selected: pass --model ID, --all, or --sync")
        return 2
    voice = (args.voice_id or env.get(VOICE_ENV) or "").strip() or None

    if args.dry_run:
        for e in entries:
            logger.info(describe(e, env, voice))
        logger.info("dry run: nothing was called, nothing was recorded")
        return 0

    if db is None:
        url, key = env.get("SUPABASE_URL", "").strip(), env.get("SUPABASE_SERVICE_KEY", "").strip()
        if not url or not key:
            logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set: a probe that is not "
                         "recorded is money spent for nothing")
            return 2
        db = RegistryDB(url, key)

    try:
        if args.sync:
            n = db.sync(model_registry.sync_rows(list(model_registry.registry().values())))
            logger.info(f"synced {n} models into model_registry")
        failures = 0
        with tempfile.TemporaryDirectory(prefix="probe_models_") as tmp:
            for e in entries:
                work = Path(tmp) / e.id
                work.mkdir()
                res = run_probe(e, env=env, voice_id=voice, workdir=work, timeout_s=args.timeout)
                if res.code == E_NOT_CONFIGURED:
                    # Not a vendor answer: nothing was called, nothing to record.
                    logger.info(f"skipped {e.id}" if args.brief else f"SKIP {e.id}: {res.message}")
                    continue
                cap = e.raw["probe"]["capability"]
                db.record(model=e.id, adapter=e.adapter, vendor_model=e.vendor_model_for(cap),
                          capability=cap, ok=res.ok, error_code=res.code,
                          error=res.message or None, latency_ms=res.latency_ms,
                          output_bytes=res.output_bytes, probed_by=args.by[:120])
                if args.brief:
                    code = res.code if res.code in BRIEF_CODES else "other"
                    logger.info(f"ok {e.id}" if res.ok else f"failed {e.id} {code}")
                    failures += 0 if res.ok else 1
                elif res.ok:
                    logger.info(f"OK   {e.id}: {res.output_bytes} bytes in {res.latency_ms} ms")
                else:
                    failures += 1
                    tail = f" (vendor task {res.task_id} may still finish and bill)" if res.code == "timeout" else ""
                    logger.info(f"FAIL {e.id}: {res.code} — {res.message}{tail}")
        return 1 if failures else 0
    except RuntimeError as e:
        logger.error(str(e))
        return 1
    except Exception as e:  # noqa: BLE001
        if not args.brief:
            raise
        # A traceback could quote a URL or a vendor reply: the class name only.
        logger.error(f"stopped: {type(e).__name__}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
