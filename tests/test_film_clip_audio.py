"""A film whose shots speak their own lines (modules/film_timeline.py, modules/film_assembly.py).

A short film with dialogue has no narration take: the video model speaks the lines inside each clip
(command-center/lib/brain/logic.ts, voice "clip_audio"), and a take made that way carries
``params.audio: true`` (0171 copies the scene's ``clip_params.audio`` into it, and it was charged the
model's with-sound price). What would break if these failed: such a film rendered with every spoken
line silently removed (rule 4), a shot whose file has no sound track rendered as a silent clip, a film
with more sound inputs than the final pass can mix failing late in ffmpeg instead of early by name,
music at full level over the dialogue, two shots' sounds doubled at a cross-fade, a film that came out
of the render mute accepted, or a narrated film's cut (and so its approval hash) changed by any of it."""

import shutil
import tempfile
import unittest
from pathlib import Path

from modules import film_assembly as fa
from modules import film_timeline as ft
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests.test_film_assembly import DiskFilm, ENV, FakeMedia, fake_store_file
from tests.test_film_timeline import Film, a_track, refused, v_clips

#: Film() (three narrated scenes, cross-fades, music, burned captions) as HEAD cut it before shots could
#: play their own sound. Pinned so a change here can never move a narrated film's approval hash.
NARRATED_SHA = "bef198cc600b7fd96a5f70709d46db03d9b878ccd5c08bb21e20593ed51bc817"
#: Film(narration=False, captions="none"): the same for a film with no narration whose takes have no sound.
SILENT_SHA = "54d01663d1d50fae4d193b6f18bfa885bc84db1141c6ee6acc3c92d96b40a44e"


def speaking(f: Film, scenes=None, has_audio=True) -> Film:
    """Every take of the given scenes (all by default) made with its own sound, its file probed."""
    for i, sc in enumerate(f.scenes):
        if scenes is not None and i not in scenes:
            continue
        for t in f.takes:
            if t["scene_id"] == sc["id"]:
                t["params"] = {"audio": True}
                if has_audio is None:
                    f.assets[t["result_asset_id"]].pop("has_audio", None)
                else:
                    f.assets[t["result_asset_id"]]["has_audio"] = has_audio
    return f


def dialogue_film(**kw) -> Film:
    kw.setdefault("narration", False)
    kw.setdefault("captions", "none")
    return Film(**kw)


def resolver_for(f: Film):
    def resolve(aid):
        a = f.assets.get(aid)
        if a is None:
            return None
        return tl.ResolvedAsset(aid, a["kind"], f"/media/{aid}", a["duration_s"],
                                a.get("has_audio", False) if a["kind"] == "video" else None)
    return resolve


class ClipAudioCut(unittest.TestCase):
    def test_clip_audio_film_keeps_spoken_lines(self):
        cut = speaking(dialogue_film(music_s=0)).build()
        clips = v_clips(cut)
        self.assertTrue(clips)
        self.assertTrue(all(c.get("audio") is True for c in clips), clips)
        self.assertEqual(cut.plan["audio"]["clip_sound"]["clips"], len(clips))
        self.assertTrue(all(s["own_sound"] for p in cut.plan["scenes"] for s in p["shots"]))
        # And the editor actually mixes them: one sound per shot shown.
        spec = tr.to_render_spec(cut.doc, resolver_for(speaking(dialogue_film(music_s=0))), "/tmp/out.mp4")
        self.assertEqual(rs.validate(spec), [])
        self.assertEqual(len(spec.audio_tracks), len(clips))

    def test_only_the_shots_made_with_sound_play_it(self):
        f = speaking(dialogue_film(music_s=0), scenes={1})
        cut = f.build()
        by_scene = {p["number"]: {s["asset_id"] for s in p["shots"]} for p in cut.plan["scenes"]}
        for c in v_clips(cut):
            self.assertEqual(c.get("audio") is True, c["asset_id"] in by_scene[2], c)

    def test_narrated_film_keeps_clips_silent(self):
        cut = Film().build()
        self.assertFalse(any("audio" in c for c in v_clips(cut)))
        self.assertIsNone(cut.plan["audio"]["clip_sound"])

    def test_narrated_film_cut_and_hash_are_unchanged(self):
        # The same bytes HEAD produced before shots could speak: an approval of such a cut still applies.
        self.assertEqual(Film().build().sha256, NARRATED_SHA)

    def test_a_film_without_narration_or_sound_takes_is_cut_as_before(self):
        f = dialogue_film()
        for t in f.takes:      # a take that asked for silence, or never asked, is the silent clip it always was
            t["params"] = {"audio": False} if t["shot_index"] == 1 else {}
        cut = f.build()
        self.assertFalse(any("audio" in c for c in v_clips(cut)))
        self.assertEqual(cut.sha256, SILENT_SHA)

    def test_clip_audio_film_without_audio_stream_refuses(self):
        e = refused(self, speaking(dialogue_film(), has_audio=False), "clip_without_sound", scene=1)
        self.assertIn("re-shoot", e.detail)

    def test_clip_audio_shot_not_probed_refuses_rather_than_going_silent(self):
        e = refused(self, speaking(dialogue_film(), has_audio=None), "asset_unprobed", scene=1)
        self.assertIn("sound", e.detail)

    def test_an_unused_take_without_sound_does_not_block_the_film(self):
        f = speaking(dialogue_film(scenes=1, shots=3, seconds=10, shot_s=12.0, transition="cut", music_s=0))
        unused = [t for t in f.takes if t["shot_index"] > 1]
        for t in unused:
            f.assets[t["result_asset_id"]]["has_audio"] = False
        cut = f.build()
        self.assertEqual(set(cut.plan["scenes"][0]["unused_take_ids"]), {t["id"] for t in unused})


class SoundClipLimit(unittest.TestCase):
    def test_clip_audio_counts_toward_sound_clip_limit(self):
        # 12 scenes x 3 shots, all shown: 36 shots that play their sound, above the 32 the final pass mixes.
        f = speaking(dialogue_film(scenes=12, seconds=20, shots=3, shot_s=8.0, transition="cut", music_s=0))
        e = refused(self, f, "too_many_audio_clips")
        self.assertIn("36", e.detail)
        self.assertIn("shots", e.detail)

    def test_clip_sound_and_music_together_are_counted(self):
        # 30 speaking shots and three music tiles: 33 inputs, though neither alone is over.
        f = speaking(dialogue_film(scenes=10, seconds=20, shots=3, shot_s=8.0, transition="cut", music_s=70.0))
        refused(self, f, "too_many_audio_clips")
        f.film["music_asset_id"] = None
        cut = f.build()
        self.assertEqual(cut.plan["audio"]["clips"], 30)

    def test_the_pre_check_counts_what_the_editor_counts(self):
        cut = speaking(dialogue_film(scenes=10, seconds=20, shots=3, shot_s=8.0, transition="cut", music_s=0)).build()
        doc = cut.doc
        editor = sum(len(t["clips"]) for t in doc["tracks"] if t["kind"] == "A") + sum(
            1 for t in doc["tracks"] if t["kind"] == "V" for c in t["clips"] if c.get("audio") is True)
        self.assertEqual(cut.plan["audio"]["clips"], editor)
        self.assertLessEqual(editor, ft.MAX_SOUND_CLIPS)


class MusicUnderDialogue(unittest.TestCase):
    def test_music_ducks_under_clip_speech(self):
        f = speaking(dialogue_film(music_s=240.0))
        cut = f.build()
        music = a_track(cut, "music")
        self.assertEqual(music["duck"], {"amount_db": 12.0})
        self.assertEqual(cut.plan["audio"]["music"]["duck_db"], ft.DUCK_DB_DEFAULT)
        spec = tr.to_render_spec(cut.doc, resolver_for(f), "/tmp/out.mp4")
        music_tracks = [t for t in spec.audio_tracks if t.path == f"/media/{f.film['music_asset_id']}"]
        self.assertTrue(music_tracks)
        self.assertTrue(all(t.duck_db == 12.0 and t.duck_spans for t in music_tracks), music_tracks)

    def test_music_over_silent_shots_is_not_ducked(self):
        cut = dialogue_film(music_s=240.0).build()
        self.assertNotIn("duck", a_track(cut, "music"))


class CrossFades(unittest.TestCase):
    def test_crossfaded_clip_sound_is_joined_not_doubled(self):
        f = speaking(dialogue_film(scenes=3, transition="crossfade", music_s=0))
        cut = f.build()
        spec = tr.to_render_spec(cut.doc, resolver_for(f), "/tmp/out.mp4")
        self.assertEqual(rs.validate(spec), [])
        clips = v_clips(cut)
        sounds = list(spec.audio_tracks)
        self.assertEqual(len(sounds), len(clips))
        for clip, snd in zip(clips, sounds):
            if tl.crossfade_s(clip) > 0:
                # Joined to the outgoing shot's sound over the picture's own overlap: one sound fading into the other.
                self.assertEqual(snd.crossfade_s, ft.CROSSFADE_S, clip["id"])
                self.assertEqual(snd.fade_in_s, 0.0, clip["id"])
            else:
                self.assertEqual(snd.crossfade_s, 0.0, clip["id"])
        self.assertEqual(sum(1 for c in clips if tl.crossfade_s(c) > 0), 2)


class ClipAudioAssembly(unittest.TestCase):
    """The assembly probes each shot made with sound before the cut, and checks the output kept its sound."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def film(self):
        f = DiskFilm(self.root, render_files=False)
        for aid in f.assets:
            f._place(aid).write_bytes(b"\0")
        for sc in f.scenes:
            sc["narration"] = ""
        for t in f.takes:
            if t["kind"] == "clip":
                t["params"] = {"audio": True}
        return f

    def run_it(self, f, *, has_audio, out_has_audio=True):
        db = f.db()
        self.rendered = []

        def render(norm, resolver, out, timings=None, **kw):
            self.rendered.append(norm)
            timings.mode, timings.intermediate = "sequential", "fast"
            Path(out).write_bytes(b"\0" * 64)
            return out
        deps = fa.Deps(env=ENV, render=render, probe=lambda p: fa.Probed(6.0, 1280, 720, out_has_audio),
                       store_file=fake_store_file(db, self.root), has_audio=has_audio, free_mb=lambda p: 1e9)
        tools = fa.ml.Tools(ffprobe="ffprobe", ffmpeg="ffmpeg")
        return fa.assemble_segment(db.seg, worker_id="w-1", store=db, media=FakeMedia(db), media_root=self.root,
                                   tools=tools, deps=deps)

    def test_assembly_renders_clip_audio_shots_with_their_sound(self):
        out = self.run_it(self.film(), has_audio=lambda p, m: True)
        self.assertTrue(out.ok, out)
        clips = [c for t in self.rendered[0]["tracks"] if t["kind"] == "V" for c in t["clips"]]
        self.assertTrue(clips and all(c["audio"] is True for c in clips), clips)

    def test_assembly_refuses_a_clip_audio_shot_whose_file_has_no_sound(self):
        out = self.run_it(self.film(), has_audio=lambda p, m: False)
        self.assertEqual((out.ok, out.reason), (False, "clip_without_sound"), out)
        self.assertIn("re-shoot", out.detail)
        self.assertEqual(self.rendered, [], "nothing is rendered for a film that would lose its dialogue")

    def test_a_clip_audio_film_rendered_mute_is_refused(self):
        out = self.run_it(self.film(), has_audio=lambda p, m: True, out_has_audio=False)
        self.assertEqual((out.ok, out.reason), (False, "output_mismatch"), out)


if __name__ == "__main__":
    unittest.main()
