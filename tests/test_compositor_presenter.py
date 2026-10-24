"""A presenter that was asked for is never quietly dropped by the render (CLAUDE.md #4).

With the fal presenter the intro and the outro are separate clips. The compositor used
to leave out each one it could not open or place, with only a log line, so one failing
shipped a half-presenter video — a downgrade of something the operator paid for. The
render now stops with ``AvatarUnavailable`` (the exception main.py already stops on), and
main records it as ``avatar.failed``. With no presenter requested nothing changes.

Fake clips only: ``VideoFileClip`` is patched, no file is decoded.
"""

import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules.avatar import AvatarUnavailable, PresenterSegment
from modules.compositor import Compositor

TOTAL = 60.0


def _fake_clip(duration=10.0, fail_on=None):
    """A reader whose fluent chain returns itself, or raises at ``fail_on``."""
    clip = MagicMock(name="reader")
    clip.duration = duration
    chain = MagicMock(name="positioned")
    for step in ("without_audio", "resize", "set_position", "set_start", "set_duration"):
        getattr(chain, step).return_value = chain
    clip.subclip.return_value = chain
    if fail_on == "subclip":
        clip.subclip.side_effect = ValueError("cannot place")
    clip.positioned = chain
    return clip


class PresenterMustBeWhole(unittest.TestCase):
    def setUp(self):
        self.comp = Compositor.__new__(Compositor)
        self.comp._readers = {}
        self.comp.width, self.comp.height = 1280, 720
        self.intro = PresenterSegment(path=Path("presenter_intro.mp4"), start=0.0, seconds=8.0)
        self.outro = PresenterSegment(path=Path("presenter_outro.mp4"), start=50.0, seconds=8.0)

    def build(self, presenter, clips):
        """Run with VideoFileClip returning each of ``clips`` in order (an exception instance raises)."""
        with patch("modules.compositor.VideoFileClip", side_effect=clips):
            return self.comp._build_presenter_clips(presenter, TOTAL)

    def test_both_usable_segments_are_placed(self):
        a, b = _fake_clip(), _fake_clip()
        out = self.build([self.intro, self.outro], [a, b])
        self.assertEqual(out, [a.positioned, b.positioned])

    def test_a_single_clip_presenter_is_placed(self):
        a = _fake_clip(duration=TOTAL)
        self.assertEqual(self.build(Path("presenter.mp4"), [a]), [a.positioned])

    def test_an_outro_that_will_not_open_stops_the_render_and_names_it(self):
        # The half-presenter video: intro fine, outro unreadable. This used to return one clip.
        with self.assertRaises(AvatarUnavailable) as cm:
            self.build([self.intro, self.outro], [_fake_clip(), OSError("moov atom not found")])
        self.assertIn("presenter_outro.mp4", str(cm.exception))
        self.assertNotIn("presenter_intro.mp4", str(cm.exception))
        self.assertIn("1 of 2", str(cm.exception))

    def test_an_intro_that_will_not_open_stops_the_render(self):
        with self.assertRaises(AvatarUnavailable):
            self.build([self.intro, self.outro], [OSError("corrupt"), _fake_clip()])

    def test_a_clip_that_opens_but_cannot_be_placed_stops_the_render(self):
        with self.assertRaises(AvatarUnavailable) as cm:
            self.build([self.intro, self.outro], [_fake_clip(), _fake_clip(fail_on="subclip")])
        self.assertIn("presenter_outro.mp4", str(cm.exception))

    def test_a_segment_that_starts_after_the_video_ends_stops_the_render(self):
        late = PresenterSegment(path=Path("presenter_outro.mp4"), start=TOTAL + 1, seconds=8.0)
        with self.assertRaises(AvatarUnavailable):
            self.build([self.intro, late], [_fake_clip(), _fake_clip()])

    def test_a_single_clip_presenter_that_fails_stops_the_render(self):
        with self.assertRaises(AvatarUnavailable):
            self.build(Path("presenter.mp4"), [OSError("corrupt")])

    def test_a_presenter_with_no_clips_at_all_stops_the_render(self):
        # Requested but nothing to show is the same downgrade: zero of zero is not "whole".
        with self.assertRaises(AvatarUnavailable):
            self.build([], [])

    def test_the_readers_that_did_open_are_registered_for_the_closing_finally(self):
        with self.assertRaises(AvatarUnavailable):
            self.build([self.intro, self.outro], [_fake_clip(), OSError("x")])
        self.assertEqual(list(self.comp._readers), [Path("presenter_intro.mp4")])


class NoPresenterIsUntouched(unittest.TestCase):
    """Drives Compositor.render itself with the moviepy classes and the heavy builders
    patched, so what is pinned is what the render does, not how its source is spelled."""

    def _render(self, presenter_path):
        comp = Compositor.__new__(Compositor)
        comp._readers, comp._text_clips = {}, {}
        comp.slug, comp.width, comp.height = "t", 1280, 720
        comp.out_dir = Path("out-not-written")
        subtitles = [MagicMock(name="subtitle")]
        presenter = [MagicMock(name="presenter")]
        script = MagicMock(sections=[])  # no sections: the black-background path, no clip pool
        with patch("modules.compositor.AudioFileClip") as audio_cls, \
                patch("modules.compositor.ColorClip"), \
                patch("modules.compositor.concatenate_videoclips") as concat, \
                patch("modules.compositor.CompositeVideoClip") as composite, \
                patch.object(comp, "_build_subtitle_clips", return_value=subtitles), \
                patch.object(comp, "_build_presenter_clips", return_value=presenter) as build:
            audio_cls.return_value.duration = TOTAL
            comp.render(script, Path("a.wav"), [], [], [], [], presenter_path=presenter_path)
        return build, concat.return_value.set_duration.return_value, composite, subtitles, presenter

    def test_no_presenter_never_builds_presenter_clips_and_the_layers_are_unchanged(self):
        build, bg, composite, subtitles, _ = self._render(None)
        build.assert_not_called()
        self.assertEqual(composite.call_args.args[0], [bg] + subtitles)

    def test_a_requested_presenter_is_built_once_and_sits_between_footage_and_subtitles(self):
        build, bg, composite, subtitles, presenter = self._render(Path("presenter.mp4"))
        build.assert_called_once_with(Path("presenter.mp4"), TOTAL)
        self.assertEqual(composite.call_args.args[0], [bg] + presenter + subtitles)

    def test_no_presenter_means_no_segments_to_demand(self):
        from modules.avatar import presenter_segments
        self.assertEqual(presenter_segments(None), [])


class MainRecordsTheStop(unittest.TestCase):
    def test_an_unavailable_presenter_in_the_render_is_recorded_then_reraised(self):
        import main
        with patch.object(main.events, "emit") as emit:
            with self.assertRaises(AvatarUnavailable):
                with main._presenter_stop_recorded("chan"):
                    raise AvatarUnavailable("outro would not place")
        emit.assert_called_once()
        self.assertEqual(emit.call_args.args[0], main.events.AVATAR_FAILED)
        self.assertEqual(emit.call_args.kwargs["status"], main.events.STATUS_FAILED)
        self.assertEqual(emit.call_args.kwargs["channel_id"], "chan")
        self.assertIn("outro would not place", emit.call_args.kwargs["metadata"]["error"])
        self.assertEqual(emit.call_args.kwargs["metadata"]["stage"], "render")

    def test_other_render_errors_are_not_called_presenter_failures(self):
        import main
        with patch.object(main.events, "emit") as emit:
            with self.assertRaises(RuntimeError):
                with main._presenter_stop_recorded("chan"):
                    raise RuntimeError("encoder died")
        emit.assert_not_called()

    def test_a_clean_render_emits_nothing(self):
        import main
        with patch.object(main.events, "emit") as emit:
            with main._presenter_stop_recorded("chan"):
                pass
        emit.assert_not_called()

    def test_the_render_call_in_run_is_inside_it(self):
        text = (Path(__file__).resolve().parent.parent / "main.py").read_text()
        self.assertIn('with MemorySampler("render"), _presenter_stop_recorded(channel_id):\n'
                      "        render_result = render_dispatch.render_video(", text)


if __name__ == "__main__":
    unittest.main()
