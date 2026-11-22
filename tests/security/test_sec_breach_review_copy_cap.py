"""Breach lab: the film review copy's bitrate cap (S4_GAPS.md G2; media_library.proxy_command(maxrate_kbps),
store_generated(proxy_maxrate_kbps), film_assembly.review_maxrate_kbps and _check_master).

No database: every value here reaches ffmpeg's argv or a failure detail, never a row. Every test pins an attack the code
refused already (none was a hole against a39a99d). The encode test needs ffmpeg and is skipped without it.

The worst case for a constant-quality encode is footage that does not compress: per-pixel noise. Uncapped, a 20 s 1080p
noise master gave a 36.0 MB proxy (about 14.4 Mb/s, so a 10-minute film would be ~1 GB); under the 600 s cap (504 kb/s)
the same master gave 1.58 MB and a 120 s 480p noise master held 507.8 kb/s against a VBV bound of 512.4. A film's
clips are AI or uploaded footage a workspace chooses, so this is what an adversarial workspace can feed the proxy.
"""

from __future__ import annotations

import math
import shutil
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest

from modules import film_assembly as fa
from modules import media_library as ml

AID = "11111111-2222-4333-8444-555555555555"


def _vbv(argv):
    return [argv[i + 1] for i, x in enumerate(argv) if x in ("-maxrate", "-bufsize")]


@pytest.mark.parametrize("cap", [0, -1, True, False, 1.5, float("nan"), float("inf"), "500", "500k -i x", b"500",
                                 Decimal(500), [500]])
def test_a_cap_that_is_not_a_positive_int_never_reaches_argv(cap):
    # "-maxrate 0k" is no cap to x264, and a string would let the caller choose the argument's text.
    with pytest.raises(ValueError):
        ml.proxy_command("ffmpeg", Path("in"), Path("out"), "video/mp4", cap)


def test_no_cap_is_the_command_every_other_caller_always_got():
    argv = ml.proxy_command("ffmpeg", Path("in"), Path("out"), "video/mp4")
    assert "-maxrate" not in argv and "-bufsize" not in argv
    assert argv == ml.proxy_command("ffmpeg", Path("in"), Path("out"), "video/mp4", None)


def test_the_cap_is_two_argv_values_never_a_split_argument():
    argv = ml.proxy_command("ffmpeg", Path("in"), Path("out"), "video/mp4", 504)
    assert _vbv(argv) == ["504k", "1008k"]
    # The decoder's frame cap and the file-only protocol whitelist are still in front of the input.
    assert argv.index("-max_pixels") < argv.index("-i") and argv[argv.index("-protocol_whitelist") + 1] == "file"


@pytest.mark.parametrize("length", [float("nan"), float("inf"), float("-inf"), 0, -0.0, -600, "nan", "inf", "1e999"])
def test_a_length_that_is_not_positive_and_finite_gives_no_cap(length):
    with pytest.raises(ValueError):
        fa.review_maxrate_kbps(length)


@pytest.mark.parametrize("length", [1e-300, 5e-324, 1e-9, 0.04, 1, 10, 139, 180, 599.99, 600, 601, 1e308])
def test_every_finite_length_gives_a_cap_inside_the_clamp_or_refuses(length):
    # A subnormal length makes the division inf: refused by name (ValueError), never an OverflowError from
    # math.floor. Unreachable, because the cut's length was probed against the rendered file before this runs, but
    # it must never become a cap outside the clamp.
    try:
        cap = fa.review_maxrate_kbps(length)
    except ValueError:
        return
    assert isinstance(cap, int) and not isinstance(cap, bool)
    assert fa.REVIEW_MIN_VIDEO_KBPS <= cap <= fa.REVIEW_MAX_VIDEO_KBPS
    ml.proxy_command("ffmpeg", Path("in"), Path("out"), "video/mp4", cap)  # and proxy_command accepts what it gives


def test_the_longest_film_s_cap_bounds_the_copy_under_the_object_ceiling():
    cap = fa.review_maxrate_kbps(600)
    kb = cap * 600 + 2 * cap + fa.REVIEW_AUDIO_KBPS * 600
    assert kb * 1000 / 8 + 500_000 < fa.REVIEW_COPY_MAX_BYTES


def _oversized_proxy(root: Path) -> None:
    p = ml.asset_file(root, AID, "proxy")
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        f.truncate(fa.REVIEW_COPY_MAX_BYTES + 1)


@pytest.mark.parametrize("review_copy", [None, 504, "504", ["video_maxrate_kbps"], {}, {"video_maxrate_kbps": None},
                                         {"video_maxrate_kbps": 0}, {"video_maxrate_kbps": "lies"},
                                         {"video_maxrate_kbps": {"nested": [1]}}, {"video_maxrate_kbps": "x" * 5000}])
def test_a_crafted_review_copy_key_still_fails_by_name(tmp_path, review_copy):
    # provenance is service-written only (register_asset is granted to service_role alone, and 0038's check keeps it a
    # jsonb object), so a crafted value is not a workspace's to plant; still, no value may crash the check or let an
    # oversized copy pass.
    _oversized_proxy(tmp_path)
    row = {"source": "generated", "duration_s": 600, "variants": ["proxy"], "provenance": {"review_copy": review_copy}}
    with pytest.raises(fa.AssemblyFailed) as e:
        fa._check_master(row, tmp_path, AID, 600.0)
    assert e.value.reason == "review_copy_too_large"
    assert "retry" not in e.value.detail and "shorten" not in e.value.detail


def test_the_variant_failure_line_names_the_asset_and_exit_only(caplog):
    with caplog.at_level("WARNING"):
        ml._variant_failed("proxy", AID, 222)
        ml._variant_failed("proxy", AID, ml.REFUSED_EXIT)
    text = " ".join(r.getMessage() for r in caplog.records)
    assert AID in text and "/" not in text.replace("b/s", "")  # no path, no command line, no key (rule 1)


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="needs ffmpeg and ffprobe")
def test_incompressible_footage_stays_under_the_cap(tmp_path):
    secs = 30
    src = tmp_path / "noise.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "nullsrc=s=854x480:r=30,geq=random(1)*255:random(1)*255:random(1)*255",
                    "-f", "lavfi", "-i", f"anoisesrc=d={secs}:c=white", "-t", str(secs),
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", str(src)], check=True, timeout=600)
    cap = fa.review_maxrate_kbps(600)  # the tightest cap any film gets
    dst = tmp_path / "proxy.mp4"
    code = ml.run_tool(ml.proxy_command("ffmpeg", src, dst, "video/mp4", cap), lambda: None, timeout_s=600,
                       frame_px=854 * 480)
    assert code == 0
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate",
                          "-of", "csv=p=0", str(dst)], capture_output=True, text=True, check=True).stdout.strip()
    video_kbps = int(out) / 1000
    assert math.isfinite(video_kbps)
    assert video_kbps * secs <= cap * secs + 2 * cap, f"{video_kbps:.1f} kb/s over {secs} s against a {cap} kb/s cap"
