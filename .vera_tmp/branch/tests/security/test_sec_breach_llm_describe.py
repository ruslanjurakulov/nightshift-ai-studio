"""Breach: Claude / GPT describe adapters (modules/capabilities/describe_llm.py) and the planner's text providers
(modules/text_providers.py), attacked with fakes only: no vendor is called, every key is synthetic.

Open (FAILING until fixed):
  * BR-LLM-001  OpenAI answers a bad key with the key MASKED, not removed: "Incorrect API key provided:
    sk-proj-****...ZQ7w". The token patterns in base.scrub / queue_worker.scrub need 12 key characters in a row,
    so the masked form passes both, and the platform key's last four characters land in creative_jobs.error, which
    every member of the job's organization can SELECT (0036). CLAUDE.md rule 1: "not its prefix, not a
    redacted-looking fragment". Same text reaches TextProviderError's message in text_providers.
  * BR-LLM-002  text_providers.call catches only Timeout / ConnectionError. A key with an interior CR/LF (a bad
    paste into a GitHub secret: .strip() removes only the ends) makes requests raise InvalidHeader, whose message
    is the header VALUE, i.e. the whole key; it escapes uncaught into whatever logs the planner's exception. The
    capability adapters catch every RequestException and keep only its class name; this module does not.

Held (passing): the key rides only in the vendor's own header (no inherited x-goog-api-key), redirects are never
followed, an echoed full key is scrubbed, an https URL or a non-image path is refused before any call.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from modules import text_providers as tp  # noqa: E402
from modules.capabilities.base import AdapterError, CapabilityRequest  # noqa: E402
from modules.capabilities.describe_llm import AnthropicDescribeAdapter, OpenAIDescribeAdapter  # noqa: E402
from tools.queue_worker import scrub as worker_scrub, secret_values  # noqa: E402

OPENAI_KEY = "sk-proj-FAKEfakeFAKEfake0123456789labONLYZQ7w"
ANTHROPIC_KEY = "sk-ant-api03-FAKEfakeFAKEfake0123456789labONLYk9Px"
GEMINI_KEY = "AIzaFAKEfakeFAKEfake0123456789lab"
TAIL = OPENAI_KEY[-4:]


class _Resp:
    def __init__(self, status, body, headers=None):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)
        self.headers = headers or {}

    def json(self):
        return self._body


class _Session:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append((url, kw))
        return self.resp

    def post(self, url, **kw):
        self.calls.append((url, kw))
        return self.resp


def _masked_401():
    # The shape OpenAI documents for invalid_api_key: the key's start, stars, its last four characters.
    masked = OPENAI_KEY[:8] + "*" * 40 + TAIL
    return _Resp(401, {"error": {"message": f"Incorrect API key provided: {masked}. You can find your API key at "
                                            "https://platform.openai.com/account/api-keys.",
                                 "type": "invalid_request_error", "code": "invalid_api_key"}})


@pytest.fixture()
def picture(tmp_path):
    p = tmp_path / "lib.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    return str(p)


def _req(path):
    return CapabilityRequest(capability="describe", input_images=[path])


# ── open ────────────────────────────────────────────────────────────────────

def test_br_llm_001_openai_describe_job_error_keeps_no_fragment_of_the_platform_key(picture):
    env = {"OPENAI_API_KEY": OPENAI_KEY}
    adapter = OpenAIDescribeAdapter(env=env, session=_Session(_masked_401()))
    with pytest.raises(AdapterError) as exc:
        adapter.submit(_req(picture), "gpt-6-luna")
    # What creative_worker._fail stores on creative_jobs.error (member-readable): the adapter text, then the CLI scrubber.
    stored = worker_scrub(exc.value.message, secret_values(env))
    assert TAIL not in stored, f"the platform key's last four characters reach the job row: {stored!r}"


def test_br_llm_001_text_provider_error_keeps_no_fragment_of_the_key():
    with pytest.raises(tp.TextProviderError) as exc:
        tp.call("openai", "plan", env={"OPENAI_API_KEY": OPENAI_KEY}, session=_Session(_masked_401()))
    assert exc.value.code == tp.E_AUTH
    assert TAIL not in str(exc.value), f"key fragment in the planner's error: {exc.value}"


def test_br_llm_002_a_key_with_an_interior_newline_never_appears_in_the_raised_error():
    bad = "sk-ant-api03-FAKEfakeFAKE\nfake0123456789labONLY"   # what a two-line paste into a secret leaves
    try:
        tp.call("anthropic", "plan", env={"ANTHROPIC_API_KEY": bad})   # a real requests.Session: fails before any socket
    except tp.TextProviderError as e:
        assert "FAKEfakeFAKE" not in str(e)
        return
    except Exception as e:  # noqa: BLE001 - the attack is precisely an exception that is not TextProviderError
        pytest.fail(f"{type(e).__name__} escaped with the key in it: {'FAKEfakeFAKE' in str(e)}")
    pytest.fail("a malformed key was sent")


# ── held ────────────────────────────────────────────────────────────────────

def test_anthropic_describe_sends_its_key_only_as_x_api_key_and_never_follows_a_redirect(picture):
    s = _Session(_Resp(200, {"content": [{"type": "text", "text": "a red apple on a white table"}]}))
    env = {"ANTHROPIC_API_KEY": ANTHROPIC_KEY, "GEMINI_API_KEY": GEMINI_KEY, "OPENAI_API_KEY": OPENAI_KEY}
    AnthropicDescribeAdapter(env=env, session=s).submit(_req(picture), "claude-sonnet-5-5")
    url, kw = s.calls[0]
    assert url == "https://api.anthropic.com/v1/messages"
    h = {k.lower(): v for k, v in kw["headers"].items()}
    assert h["x-api-key"] == ANTHROPIC_KEY
    assert "x-goog-api-key" not in h and "authorization" not in h
    assert kw.get("allow_redirects") is False
    assert GEMINI_KEY not in json.dumps(kw.get("json")) and OPENAI_KEY not in json.dumps(kw.get("json"))


def test_openai_describe_sends_bearer_only_and_never_follows_a_redirect(picture):
    s = _Session(_Resp(200, {"output": [{"type": "message", "content": [{"type": "output_text", "text": "an apple"}]}]}))
    OpenAIDescribeAdapter(env={"OPENAI_API_KEY": OPENAI_KEY, "GEMINI_API_KEY": GEMINI_KEY}, session=s).submit(
        _req(picture), "gpt-6-luna")
    url, kw = s.calls[0]
    h = {k.lower(): v for k, v in kw["headers"].items()}
    assert url == "https://api.openai.com/v1/responses"
    assert h["authorization"] == f"Bearer {OPENAI_KEY}" and "x-goog-api-key" not in h
    assert kw.get("allow_redirects") is False


def test_base_url_cannot_be_pointed_elsewhere_by_env():
    env = {"ANTHROPIC_API_KEY": ANTHROPIC_KEY, "GEMINI_BASE_URL": "https://attacker.example", "": "https://x"}
    assert AnthropicDescribeAdapter(env=env).base_url == "https://api.anthropic.com/v1"
    assert OpenAIDescribeAdapter(env={**env, "OPENAI_API_KEY": OPENAI_KEY}).base_url == "https://api.openai.com/v1"


def test_a_full_key_echoed_by_the_vendor_is_scrubbed(picture):
    env = {"ANTHROPIC_API_KEY": ANTHROPIC_KEY}
    s = _Session(_Resp(401, {"type": "error", "error": {"type": "authentication_error", "message": f"bad key {ANTHROPIC_KEY}"}}))
    with pytest.raises(AdapterError) as exc:
        AnthropicDescribeAdapter(env=env, session=s).submit(_req(picture), "m")
    assert ANTHROPIC_KEY not in exc.value.message and "k9Px" not in exc.value.message


@pytest.mark.parametrize("adapter_cls,env", [
    (AnthropicDescribeAdapter, {"ANTHROPIC_API_KEY": ANTHROPIC_KEY}),
    (OpenAIDescribeAdapter, {"OPENAI_API_KEY": OPENAI_KEY}),
])
def test_a_url_picture_is_refused_before_any_call(adapter_cls, env):
    s = _Session(_Resp(200, {}))
    with pytest.raises(AdapterError):
        adapter_cls(env=env, session=s).submit(_req("https://169.254.169.254/latest/meta-data/x.png"), "m")
    assert s.calls == []


@pytest.mark.parametrize("path", ["../../../../etc/passwd", "/proc/self/environ", "/app/.env", "x.png/../../.env"])
def test_a_non_library_file_is_refused_by_problems(path):
    from modules.capabilities.image import GeminiDescribeAdapter  # the checks both adapters inherit
    adapter = AnthropicDescribeAdapter(env={"ANTHROPIC_API_KEY": ANTHROPIC_KEY})
    assert type(adapter).problems is GeminiDescribeAdapter.problems

    class _Entry:
        def problems(self, request):
            return []
    out = adapter.problems(_req(path), _Entry())
    assert any("JPEG, PNG or WebP" in p for p in out), out


def test_text_providers_never_follow_a_redirect():
    s = _Session(_Resp(200, {"content": [{"type": "text", "text": "ok"}]}))
    tp.call("anthropic", "p", env={"ANTHROPIC_API_KEY": ANTHROPIC_KEY}, session=s)
    assert s.calls[0][0] == tp.ANTHROPIC_URL and s.calls[0][1]["allow_redirects"] is False
