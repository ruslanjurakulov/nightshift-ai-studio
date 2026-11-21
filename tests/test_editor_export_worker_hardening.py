"""The paid editor export worker, hardened like the film assembly worker (Sentinel follow-up, two MEDIUM findings).

1. One work folder per ATTEMPT: a stale worker (lease expired) and the live one used ``.editor-exports/<export id>``
   together, so the stale one's wipe/cleanup deleted the live render.
2. No silent compact-encode fallback on a PAID export (CLAUDE.md rule 4): the export fails with a named reason, the
   database's finish_export (which releases the hold, migration 0132) is called, and no file is registered.
"""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from modules import editor_export, render_backend
from tests.test_editor_hires_export import EXPORT, Base, FakeStore, STORED
from tests.test_editor_export_paid_1080p import own
from tests.test_editor_hires_export import doc


class StaleAndLiveAttempts(Base):
    def test_two_attempts_of_one_export_never_share_a_work_folder_and_the_stale_one_cannot_delete_the_live_render(self):
        seen = {}

        def live_render(d, res, out, **kw):
            live_dir = Path(kw["workdir"])
            seen["live"] = live_dir
            marker = live_dir / "live-render.tmp"
            marker.write_bytes(b"half a render")
            Path(out).write_bytes(b"mp4")

            # The stale worker (its lease expired) picks up the same export id, renders and cleans up while the
            # live one is mid-render.
            def stale_render(d2, res2, out2, **kw2):
                seen["stale"] = Path(kw2["workdir"])
                Path(out2).write_bytes(b"mp4")
                return out2

            editor_export.run_export(
                own(doc(4.0)), store=FakeStore(), media_root=self.root, worker_id="stale",
                tools=editor_export.ml.Tools("ffprobe", "ffmpeg"), render=stale_render,
                store_file=mock.Mock(return_value={"id": STORED}), has_audio=lambda p, m: True, heartbeat_s=0.01)
            seen["live_file_survived"] = marker.is_file()
            return out

        status = editor_export.run_export(
            own(doc(4.0)), store=FakeStore(), media_root=self.root, worker_id="live",
            tools=editor_export.ml.Tools("ffprobe", "ffmpeg"), render=live_render,
            store_file=mock.Mock(return_value={"id": STORED}), has_audio=lambda p, m: True, heartbeat_s=0.01)

        self.assertEqual(status, "done")
        self.assertNotEqual(seen["live"], seen["stale"], "two attempts of one export id got the same work folder")
        self.assertTrue(seen["live_file_survived"], "the stale attempt's cleanup deleted the live attempt's files")
        self.assertFalse(any((self.root / editor_export.WORK_DIRNAME).glob("*")), "an attempt left its folder behind")


class PaidExportRefusesTheCompactEncode(Base):
    def _run(self, row, finish):
        store = FakeStore()
        store.finish_export = finish
        store_file = mock.Mock(return_value={"id": STORED})

        def render(d, res, out, *, ffmpeg, workdir, jobs, timeout_s, **kw):
            spec = render_backend.simple_spec(out, [(None, 1.0)])
            return render_backend.render(spec, ffmpeg="ffmpeg", workdir=workdir, jobs=1, timeout_s=timeout_s, **kw)

        def segment(ffmpeg, seg, out, w, h, fps, **kw):
            if tuple(kw.get("x264", ())) != render_backend.LEGACY_X264:
                raise render_backend.RenderBackendError("preferred encode failed")  # only the compact settings work
            Path(out).write_bytes(b"seg")

        def final(cmd, **kw):
            Path(cmd[-1]).write_bytes(b"mp4")

        with mock.patch.object(render_backend, "validate", return_value=[]), \
                mock.patch.object(render_backend, "_normalize_segment", side_effect=segment), \
                mock.patch.object(render_backend, "_run", side_effect=final):
            status = editor_export.run_export(
                row, store=store, media_root=self.root, worker_id="w1",
                tools=editor_export.ml.Tools("ffprobe", "ffmpeg"), render=render, store_file=store_file,
                has_audio=lambda p, m: True, heartbeat_s=0.01)
        return status, store_file

    def test_a_paid_export_whose_preferred_encode_fails_ends_failed_registers_no_file_and_releases_the_hold(self):
        finish = mock.Mock(return_value="failed")
        status, store_file = self._run(own(doc(4.0), quoted=1, duration_s=4), finish)
        self.assertEqual(status, "failed")
        store_file.assert_not_called()  # nothing registered in the library
        finish.assert_called_once_with(EXPORT, "w1", None, "render_failed")  # no asset, a named reason: the database releases

    def test_an_unpriced_export_keeps_the_pipelines_old_behaviour(self):
        finish = mock.Mock(return_value="done")
        status, store_file = self._run(own(doc(4.0)), finish)
        self.assertEqual(status, "done")
        store_file.assert_called_once()


class BackendStrictness(unittest.TestCase):
    def _spec(self, tmp):
        return render_backend.simple_spec(str(Path(tmp) / "o.mp4"), [(None, 1.0)])

    def test_strict_render_raises_instead_of_redoing_with_compact_settings(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(render_backend, "_normalize_segment", side_effect=render_backend.RenderBackendError("x")):
            with self.assertRaises(render_backend.CompactEncodeRefused):
                render_backend._normalize_all("ffmpeg", self._spec(tmp), Path(tmp), 1, render_backend.RenderTimings(),
                                              allow_compact=False)

    def test_strict_render_refuses_the_low_disk_compact_switch(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(render_backend, "intermediate_x264", return_value=render_backend.LEGACY_X264):
            with self.assertRaises(render_backend.CompactEncodeRefused):
                render_backend._normalize_all("ffmpeg", self._spec(tmp), Path(tmp), 1, render_backend.RenderTimings(),
                                              allow_compact=False)

    def test_default_render_still_falls_back_as_the_pipeline_always_did(self):
        import tempfile
        calls = []

        def segment(ffmpeg, seg, out, w, h, fps, **kw):
            calls.append(tuple(kw.get("x264", ())))
            if kw.get("x264") != render_backend.LEGACY_X264:
                raise render_backend.RenderBackendError("x")
            Path(out).write_bytes(b"seg")

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(render_backend, "_normalize_segment", side_effect=segment):
            render_backend._normalize_all("ffmpeg", self._spec(tmp), Path(tmp), 1, render_backend.RenderTimings())
        self.assertEqual(calls[-1], render_backend.LEGACY_X264)


if __name__ == "__main__":
    unittest.main()
