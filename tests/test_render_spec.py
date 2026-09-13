"""Declarative render spec + ffmpeg command builder (roadmap #49).

Pure and offline: the spec round-trips through a dict, validation names real
problems, the concat-demuxer list is well-formed (last file repeated, colour
placeholders skipped, quotes escaped), and the ffmpeg argument list carries the
expected inputs/flags. Executing ffmpeg is the backend's job, not tested here."""

import unittest

from modules import render_spec as rs


def _spec(**kw):
    base = dict(
        output_path="/out/final.mp4",
        segments=[rs.Segment(duration=2.0, path="/m/a.mp4"), rs.Segment(duration=3.0, path="/m/b.mp4")],
        audio_path="/m/voice.wav",
    )
    base.update(kw)
    return rs.RenderSpec(**base)


class SpecModelTestCase(unittest.TestCase):
    def test_total_duration(self):
        self.assertEqual(_spec().total_duration, 5.0)

    def test_round_trips_through_dict(self):
        spec = _spec(subtitle_path="/m/subs.srt", fps=24)
        back = rs.RenderSpec.from_dict(spec.to_dict())
        self.assertEqual(back.to_dict(), spec.to_dict())
        self.assertEqual(back.fps, 24)
        self.assertEqual(len(back.segments), 2)


class ValidateTestCase(unittest.TestCase):
    def test_clean_spec_has_no_problems(self):
        self.assertEqual(rs.validate(_spec()), [])

    def test_flags_empty_segments_and_output(self):
        problems = rs.validate(rs.RenderSpec(output_path="", segments=[]))
        self.assertTrue(any("output_path" in p for p in problems))
        self.assertTrue(any("no segments" in p for p in problems))

    def test_flags_bad_duration_and_missing_path(self):
        spec = rs.RenderSpec(
            output_path="/o.mp4",
            segments=[rs.Segment(duration=0.0, path="/a.mp4"),
                      rs.Segment(duration=2.0, path=None, kind=rs.KIND_VIDEO)],
        )
        problems = rs.validate(spec)
        self.assertTrue(any("non-positive duration" in p for p in problems))
        self.assertTrue(any("no path" in p for p in problems))

    def test_color_placeholder_needs_no_path(self):
        spec = rs.RenderSpec(
            output_path="/o.mp4",
            segments=[rs.Segment(duration=2.0, path=None, kind=rs.KIND_COLOR)],
        )
        self.assertEqual(rs.validate(spec), [])


class ConcatListTestCase(unittest.TestCase):
    def test_pairs_and_repeats_last_file(self):
        lines = rs.concat_list_lines(_spec())
        self.assertEqual(lines[0], "file '/m/a.mp4'")
        self.assertEqual(lines[1], "duration 2.000")
        # last file repeated (concat demuxer ignores the final duration otherwise)
        self.assertEqual(lines[-1], "file '/m/b.mp4'")
        self.assertEqual(lines.count("file '/m/b.mp4'"), 2)

    def test_skips_colour_placeholders(self):
        spec = rs.RenderSpec(
            output_path="/o.mp4",
            segments=[rs.Segment(2.0, None, rs.KIND_COLOR), rs.Segment(2.0, "/m/a.mp4")],
        )
        lines = rs.concat_list_lines(spec)
        self.assertTrue(all("color" not in ln.lower() for ln in lines))
        self.assertIn("file '/m/a.mp4'", lines)

    def test_escapes_single_quotes(self):
        spec = rs.RenderSpec(output_path="/o.mp4", segments=[rs.Segment(2.0, "/m/it's a.mp4")])
        lines = rs.concat_list_lines(spec)
        self.assertIn(r"'\''", lines[0])


class FfmpegCommandTestCase(unittest.TestCase):
    def test_video_only_command(self):
        spec = rs.RenderSpec(output_path="/o.mp4", segments=[rs.Segment(2.0, "/m/a.mp4")], fps=25)
        cmd = rs.build_ffmpeg_command(spec, "/tmp/list.txt")
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("concat", cmd)
        self.assertIn("/tmp/list.txt", cmd)
        self.assertIn("libx264", cmd)
        self.assertIn("25", cmd)  # fps
        self.assertEqual(cmd[-1], "/o.mp4")
        self.assertNotIn("-c:a", cmd)  # no audio → no audio codec

    def test_audio_and_subtitles(self):
        spec = _spec(subtitle_path="/m/subs.srt")
        cmd = rs.build_ffmpeg_command(spec, "/tmp/list.txt")
        self.assertIn("/m/voice.wav", cmd)
        self.assertIn("aac", cmd)
        self.assertIn("-shortest", cmd)
        vf = cmd[cmd.index("-vf") + 1]
        self.assertIn("subtitles=", vf)
        self.assertEqual(cmd[-1], "/out/final.mp4")


if __name__ == "__main__":
    unittest.main()
