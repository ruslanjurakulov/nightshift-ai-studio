"""Breach on 0176 (voice to video): the worker's first decode of a member's upload, held to the library's own rules.

modules/media_library.py and modules/ffmpeg_limits.py state the rule for "every ffmpeg that decodes member media": the demuxer
forced to the sniffed type, ``-protocol_whitelist file`` (so the file cannot make ffmpeg open other files or URLs), the
address-space and thread limits, and no secret in the child's environment (modules/voice_explainer.py trims the render's env
for the same reason). The voice video's ``decode_to_wav`` and ``audio_seconds`` run ffmpeg / ffprobe on the person's file with
none of that, and with no output length cap, so a recording whose header understates its length writes an unbounded WAV
before the length check can refuse it.

These are static checks of the argv and environment the adapter would run; nothing is decoded, no vendor is called.
They FAIL on 63423b2 by design and pass once the decode follows the library's rule.
"""
import shutil
import subprocess
from pathlib import Path
from unittest import mock

import pytest

from modules.capabilities import voice_video as vv
from modules import voice_explainer as ve

SECRET_ENV = {"ELEVENLABS_API_KEY": "lab-fake-key", "SUPABASE_SERVICE_ROLE_KEY": "lab-fake-service", "PATH": "/usr/bin"}


def _capture_decode(tmp_path: Path, **kw):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"], seen["kwargs"] = list(cmd), kwargs
        Path(cmd[-1]).write_bytes(b"\0" * 100)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    src = tmp_path / "source.mp3"
    src.write_bytes(b"\0" * 10)
    # Static argv checks: no ffmpeg runs, so the lab runner need not have one (it has none; CI run 44747681313 failed at the
    # adapter's own "ffmpeg is not on PATH" guard before any argv was built).
    with mock.patch.dict("os.environ", SECRET_ENV, clear=True), mock.patch.object(vv.subprocess, "run", fake_run), \
            mock.patch.object(vv.shutil, "which", lambda name: f"/usr/bin/{name}"):
        vv.decode_to_wav(src, tmp_path / "narration.wav", **kw)
    return seen


def test_without_ffmpeg_the_decode_refuses_as_not_configured_and_runs_nothing(tmp_path):
    ran = []
    src = tmp_path / "source.mp3"
    src.write_bytes(b"\0" * 10)
    with mock.patch.object(vv.subprocess, "run", lambda *a, **k: ran.append(a)), \
            mock.patch.object(vv.shutil, "which", lambda name: None):
        with pytest.raises(vv.AdapterError) as e:
            vv.decode_to_wav(src, tmp_path / "narration.wav")
    assert e.value.code == vv.E_NOT_CONFIGURED and ran == []


def test_the_decode_of_a_members_file_opens_no_protocol_but_file(tmp_path):
    cmd = _capture_decode(tmp_path)["cmd"]
    assert "-protocol_whitelist" in cmd and cmd[cmd.index("-protocol_whitelist") + 1] == "file", cmd


def test_the_decode_forces_the_demuxer_instead_of_probing_the_content(tmp_path):
    cmd = _capture_decode(tmp_path)["cmd"]
    i = cmd.index("-i")
    assert "-f" in cmd[:i], f"no forced input format before -i: {cmd}"


def test_the_decode_caps_the_output_length_so_a_lying_header_cannot_fill_the_disk(tmp_path):
    cmd = _capture_decode(tmp_path)["cmd"]
    assert "-t" in cmd, f"no -t cap on the decoded length: {cmd}"
    assert float(cmd[cmd.index("-t") + 1]) <= ve.MAX_SECONDS + 2 * vv.LENGTH_TOLERANCE_S


def test_the_decode_runs_under_the_member_media_limits(tmp_path):
    cmd = _capture_decode(tmp_path)["cmd"]
    # ffmpeg_limits.limited_argv starts with the interpreter trampoline that sets RLIMIT_AS, then execs ffmpeg.
    assert cmd[0] != "ffmpeg", f"ffmpeg started without ffmpeg_limits.limited_argv: {cmd}"


def test_no_provider_key_reaches_the_decode_of_a_members_file(tmp_path):
    env = _capture_decode(tmp_path)["kwargs"].get("env")
    assert env is not None, "the decode inherits the worker's whole environment, provider keys included"
    assert "ELEVENLABS_API_KEY" not in env and "SUPABASE_SERVICE_ROLE_KEY" not in env


def test_no_provider_key_reaches_the_length_probe(tmp_path):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0, "12.0\n", "")

    wav = tmp_path / "narration.wav"
    wav.write_bytes(b"\0" * 100)
    with mock.patch.dict("os.environ", SECRET_ENV, clear=True), mock.patch.object(ve.subprocess, "run", fake_run):
        ve.audio_seconds(wav)
    env = seen["kwargs"].get("env")
    assert env is not None and "ELEVENLABS_API_KEY" not in env


def test_the_decode_bounds_the_bytes_a_second_not_only_the_seconds(tmp_path):
    # Breach BR-VV-R1: -t caps seconds, but a header declaring 655 kHz in 7.1 made ~10 MB of WAV a second.
    cmd = _capture_decode(tmp_path)["cmd"]
    fmt = cmd[cmd.index("-af") + 1]
    assert fmt == vv.NARRATION_FORMAT and cmd.index("-af") > cmd.index("-i")
    rates = [int(r) for r in fmt.split("sample_rates=")[1].split(":")[0].split("|")]
    assert max(rates) == 48000 and fmt.endswith("channel_layouts=mono|stereo")


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs the real ffmpeg; the static check above still runs")
def test_a_tiny_flac_that_declares_a_huge_rate_decodes_within_a_stereo_48k_budget(tmp_path):
    src = tmp_path / "source.flac"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=655350:cl=7.1", "-t", "3", "-c:a", "flac",
                    str(src)], check=True)
    dst = tmp_path / "narration.wav"
    vv.decode_to_wav(src, dst)
    assert dst.stat().st_size / 3.0 <= 48000 * 2 * 2 * 1.05


def test_no_provider_key_reaches_the_frame_count_probe(tmp_path):
    # Breach BR-VV-R2: the join check's ffprobe inherited the worker's whole environment.
    seen = []

    def record(cmd, *_args, **kwargs):
        seen.append(kwargs.get("env"))
        raise OSError("lab: not started")

    with mock.patch.dict("os.environ", SECRET_ENV, clear=True), mock.patch.object(ve.subprocess, "run", record), \
            mock.patch.object(ve.subprocess, "Popen", record):
        assert ve._frame_count(tmp_path / "out.mp4") is None
    assert seen and all(env is not None and not set(env) & {"ELEVENLABS_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"}
                        for env in seen)
