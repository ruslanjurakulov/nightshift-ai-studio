"""Old render specs render exactly as before the timeline extension.

Creative OS extended render_spec / render_backend for timelines (trim,
several audio tracks, text overlays, frame-exact segments). The pipeline's
own renders must not notice: every argv below was captured from the code on
main BEFORE that extension, and the current code must reproduce it byte for
byte — the final command, the concat list, the serialised dict, and every
segment normalisation command (both encoder settings)."""

import unittest
from pathlib import Path
from unittest import mock

from modules import render_backend as rb
from modules import render_spec as rs

S = rs.Segment

SPECS = {
    "video_only": lambda: rs.RenderSpec(output_path="/o.mp4", segments=[S(2.0, "/m/a.mp4")], fps=25),
    "audio_subs": lambda: rs.RenderSpec(
        output_path="/out/final.mp4", segments=[S(2.0, "/m/a.mp4"), S(3.0, "/m/b.mp4")],
        audio_path="/m/voice.wav", subtitle_path="/m/it's subs.ass"),
    "mixed": lambda: rb.simple_spec(
        "/o/x.mp4", [("/c.mp4", 1.25), (None, 0.5), ("/i.png", 2.0, "image")],
        audio_path="/a.mp3", width=1080, height=1920, fps=24),
}

#: Captured from main (before the extension) — do not regenerate from new code.
LEGACY = {
    "video_only": {
        "cmd": [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "/tmp/list.txt",
            "-r",
            "25",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "/o.mp4"
        ],
        "concat": [
            "file '/m/a.mp4'",
            "duration 2.000"
        ],
        "dict": {
            "output_path": "/o.mp4",
            "width": 1920,
            "height": 1080,
            "fps": 25,
            "segments": [
                {
                    "duration": 2.0,
                    "path": "/m/a.mp4",
                    "kind": "video"
                }
            ],
            "audio_path": None,
            "subtitle_path": None
        }
    },
    "audio_subs": {
        "cmd": [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "/tmp/list.txt",
            "-i",
            "/m/voice.wav",
            "-vf",
            "subtitles='/m/it'\\''s subs.ass'",
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "/out/final.mp4"
        ],
        "concat": [
            "file '/m/a.mp4'",
            "duration 2.000",
            "file '/m/b.mp4'",
            "duration 3.000"
        ],
        "dict": {
            "output_path": "/out/final.mp4",
            "width": 1920,
            "height": 1080,
            "fps": 30,
            "segments": [
                {
                    "duration": 2.0,
                    "path": "/m/a.mp4",
                    "kind": "video"
                },
                {
                    "duration": 3.0,
                    "path": "/m/b.mp4",
                    "kind": "video"
                }
            ],
            "audio_path": "/m/voice.wav",
            "subtitle_path": "/m/it's subs.ass"
        }
    },
    "mixed": {
        "cmd": [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "/tmp/list.txt",
            "-i",
            "/a.mp3",
            "-r",
            "24",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "/o/x.mp4"
        ],
        "concat": [
            "file '/c.mp4'",
            "duration 1.250",
            "file '/i.png'",
            "duration 2.000"
        ],
        "dict": {
            "output_path": "/o/x.mp4",
            "width": 1080,
            "height": 1920,
            "fps": 24,
            "segments": [
                {
                    "duration": 1.25,
                    "path": "/c.mp4",
                    "kind": "video"
                },
                {
                    "duration": 0.5,
                    "path": None,
                    "kind": "color"
                },
                {
                    "duration": 2.0,
                    "path": "/i.png",
                    "kind": "image"
                }
            ],
            "audio_path": "/a.mp3",
            "subtitle_path": None
        }
    }
}

#: _normalize_segment's commands on main for (video, colour, image) x
#: (libx264 defaults, INTERMEDIATE_X264), 1080x1920 @ 24, seed "2:/i.png".
LEGACY_SEGMENTS = [
    [
        [
            "ffmpeg",
            "-y",
            "-stream_loop",
            "-1",
            "-i",
            "/c.mp4",
            "-t",
            "1.250",
            "-an",
            "-vf",
            "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "24",
            "/t/seg.mp4"
        ]
    ],
    [
        [
            "ffmpeg",
            "-y",
            "-stream_loop",
            "-1",
            "-i",
            "/c.mp4",
            "-t",
            "1.250",
            "-an",
            "-vf",
            "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=24",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "24",
            "/t/seg.mp4"
        ]
    ],
    [
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=1080x1920:r=24:d=0.500",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "24",
            "/t/seg.mp4"
        ]
    ],
    [
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=1080x1920:r=24:d=0.500",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "24",
            "/t/seg.mp4"
        ]
    ],
    [
        [
            "ffmpeg",
            "-y",
            "-i",
            "/i.png",
            "-t",
            "2.000",
            "-vf",
            "scale=1242:2208:force_original_aspect_ratio=increase:flags=lanczos,crop=1242:2208,loop=loop=-1:size=1,settb=1/24,setpts=N,zoompan=z='1.15*(1+0.12-0.12*min(1,on/48.000000))':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=24",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "24",
            "/t/seg.mp4"
        ]
    ],
    [
        [
            "ffmpeg",
            "-y",
            "-i",
            "/i.png",
            "-t",
            "2.000",
            "-vf",
            "scale=1242:2208:force_original_aspect_ratio=increase:flags=lanczos,crop=1242:2208,loop=loop=-1:size=1,settb=1/24,setpts=N,zoompan=z='1.15*(1+0.12-0.12*min(1,on/48.000000))':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=24",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "24",
            "/t/seg.mp4"
        ]
    ]
]

SEGMENTS = [S(1.25, "/c.mp4"), S(0.5, None, "color"), S(2.0, "/i.png", "image")]


class LegacyFinalCommandTestCase(unittest.TestCase):
    def test_final_command_concat_list_and_dict_are_unchanged(self):
        for name, make in SPECS.items():
            with self.subTest(spec=name):
                spec = make()
                self.assertFalse(spec.uses_timeline_features)
                self.assertEqual(rs.build_ffmpeg_command(spec, "/tmp/list.txt"), LEGACY[name]["cmd"])
                self.assertEqual(rs.concat_list_lines(spec), LEGACY[name]["concat"])
                self.assertEqual(spec.to_dict(), LEGACY[name]["dict"])
                # An old dict (no timeline keys) still loads to the same spec.
                self.assertEqual(rs.RenderSpec.from_dict(LEGACY[name]["dict"]).to_dict(),
                                 LEGACY[name]["dict"])


class LegacySegmentCommandTestCase(unittest.TestCase):
    def test_segment_normalisation_commands_are_unchanged(self):
        got = []
        for seg in SEGMENTS:
            for x264 in ((), rb.INTERMEDIATE_X264):
                calls = []
                with mock.patch.object(rb, "_run", side_effect=calls.append):
                    rb._normalize_segment("ffmpeg", seg, Path("/t/seg.mp4"), 1080, 1920, 24,
                                          seed="2:/i.png", x264=x264)
                got.append(calls)
        self.assertEqual(got, LEGACY_SEGMENTS)


if __name__ == "__main__":
    unittest.main()
