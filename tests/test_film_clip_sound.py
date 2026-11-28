"""S2: a film shot's own sound in the master (modules/film_timeline.py, modules/film_mix.py, modules/film_assembly.py).

The evidence and the design are docs/studio/S2_CLIP_AUDIO.md; its section 7.6 lists what a fix must pin, and the
classes below follow that list (with Atlas's 28 Nov decisions: the ambience is ducked under every voice, a film
that cannot be normalised linearly ships in loudnorm's dynamic mode, labelled, and a single-price model is asked
for no sound outside a dialogue scene). What would break if these failed: a film whose shots carry sound shipped
without it (rule 4), a silent file passed off as "used" (rule 5), the owner's 30-shot reels refused as
``too_many_audio_clips``, the music ducked under a wordless reel, a dialogue line buried under the music, a
lip-synced take's original voice played under its new lines, a narrated film's approved cut quietly changed, a
master louder or quieter than its target without a word, or sound bought from a vendor that the film never plays.

Fixtures are synthetic: every source is a tone of its own (ambience 1000 Hz, in-clip dialogue 2000 Hz, narration
300 Hz, music 120 Hz) so the master can be read source by source with a narrow band-pass, as the measurement tool
does. No provider is called. The ffmpeg tests skip where ffmpeg is not installed."""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import film_assembly as fa
from modules import film_mix as fm
from modules import film_orchestrator as fo
from modules import film_timeline as ft
from modules import model_registry as mr
from modules import timeline as tl
from tests.test_film_assembly import DiskFilm, ENV, FakeMedia, fake_mix, fake_store_file
from tests.test_film_timeline import MUSIC, NARRATION, Film, a_track, refused, v_clips

FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")

#: Film() (three narrated scenes, cross-fades, music, burned captions) and Film(narration=False, captions="none")
#: as main cut them before a shot could play its own sound (the same pins vera/film-clip-audio used).
NARRATED_SHA = "bef198cc600b7fd96a5f70709d46db03d9b878ccd5c08bb21e20593ed51bc817"
SILENT_SHA = "54d01663d1d50fae4d193b6f18bfa885bc84db1141c6ee6acc3c92d96b40a44e"

AMB_HZ, DIALOGUE_HZ, NARRATION_HZ, MUSIC_HZ = 1000, 2000, 300, 120


def bought(f: Film, scenes=None, has_audio=True) -> Film:
    """The takes of the given scenes (all by default) bought with the priced sound option, their files probed."""
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


def role(f: Film, scene: int, sound_role: str, has_audio=True) -> Film:
    f.scenes[scene]["sound_role"] = sound_role
    for t in f.takes:
        if t["scene_id"] == f.scenes[scene]["id"] and has_audio is not None:
            f.assets[t["result_asset_id"]]["has_audio"] = has_audio
    return f


def statuses(cut):
    return [s["clip_sound"] for p in cut.plan["scenes"] for s in p["shots"]]


# ── the cut (pure) ───────────────────────────────────────────────────────────

class NoClipSoundKeepsTheCut(unittest.TestCase):
    """7.6 #9: a film with no clip sound is the document and the hash it was."""

    def test_a_narrated_film_keeps_its_approved_hash(self):
        cut = Film().build()
        self.assertEqual(cut.sha256, NARRATED_SHA)
        self.assertIsNone(cut.sound)
        self.assertFalse(any("audio" in c for c in v_clips(cut)))

    def test_a_film_whose_takes_bought_no_sound_keeps_its_hash_whatever_the_files_carry(self):
        f = Film(narration=False, captions="none")
        for a in f.assets.values():
            if a["kind"] == "video":
                a["has_audio"] = True     # a single-price model's file with sound: not played by default
        for t in f.takes:
            t["params"] = {"audio": False} if t["shot_index"] == 1 else {}
        cut = f.build()
        self.assertEqual(cut.sha256, SILENT_SHA)
        self.assertIsNone(cut.plan["audio"]["clip_sound"])
        self.assertEqual(set(statuses(cut)), {"muted"})

    def test_the_document_never_marks_a_clip_audio_true(self):
        # audio: true on a V clip makes the editor duck the music under the whole film (S2 section 4.1).
        cut = role(role(Film(), 0, "dialogue"), 1, "ambience").build()
        self.assertIsNotNone(cut.sound)
        self.assertFalse(any("audio" in c for c in v_clips(cut)))


class TheGateAndTheCutAgree(unittest.TestCase):
    """0236 sells clip sound only once the switch says the cut keeps it; this cut must, or the switch would sell dropped sound."""

    def test_this_cut_keeps_bought_sound_so_the_switch_may_be_turned_on(self):
        self.assertIs(ft.CLIP_SOUND_IN_CUT, True)
        cut = bought(Film(), scenes={0}).build()
        self.assertTrue(cut.sound["stem"])
        self.assertEqual({s["clip_sound"] for s in cut.plan["scenes"][0]["shots"]}, {"used"})

    def test_the_migration_refuses_by_the_same_word_and_defaults_off(self):
        sql = (Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "0236_film_clip_sound_gate.sql").read_text()
        self.assertIn("'reason', 'clip_sound_not_kept'", sql)
        self.assertIn("add column if not exists clip_sound_kept boolean not null default false", sql)
        self.assertIn("CLIP_SOUND_IN_CUT", sql)


class Roles(unittest.TestCase):
    def test_a_take_bought_with_sound_defaults_to_ambience(self):
        cut = bought(Film(), scenes={1}).build()
        self.assertEqual([p["sound_role"] for p in cut.plan["scenes"]], ["muted", "ambience", "muted"])
        self.assertEqual([p["sound_role_source"] for p in cut.plan["scenes"]], ["default"] * 3)
        self.assertEqual({x["role"] for x in cut.sound["stem"]}, {"ambience"})

    def test_a_scene_marked_dialogue_is_dialogue(self):
        cut = role(Film(), 2, "dialogue").build()
        self.assertEqual(cut.plan["scenes"][2]["sound_role"], "dialogue")
        self.assertEqual(cut.plan["scenes"][2]["sound_role_source"], "chosen")
        self.assertEqual({x["role"] for x in cut.sound["stem"]}, {"dialogue"})

    def test_an_unknown_role_is_refused_by_name(self):
        f = Film()
        f.scenes[0]["sound_role"] = "loud"
        refused(self, f, "invalid_scene", scene=1)


class NoSilentMute(unittest.TestCase):
    """7.6 #2 and rule 4: a shot whose sound the film needs is never rendered silent."""

    def test_a_muted_scene_whose_file_has_no_sound_is_cut_without_error_and_says_so(self):
        f = Film()
        for a in f.assets.values():
            if a["kind"] == "video":
                a["has_audio"] = False
        cut = f.build()
        self.assertEqual(set(statuses(cut)), {"no sound in the file"})
        self.assertIsNone(cut.sound)

    def test_a_shot_bought_with_sound_whose_file_has_none_is_refused(self):
        e = refused(self, bought(Film(), scenes={0}, has_audio=False), "clip_without_sound", scene=1)
        self.assertIn("re-shoot", e.detail)

    def test_a_shot_bought_with_sound_is_refused_even_in_a_scene_muted_since(self):
        # The purchase is missing whatever the person does with it now: a paid-for thing that did not arrive.
        f = role(bought(Film(), scenes={0}, has_audio=False), 0, "muted", has_audio=None)
        refused(self, f, "clip_without_sound", scene=1)

    def test_an_ambience_or_dialogue_scene_whose_file_has_no_sound_is_refused_with_the_fix(self):
        for r in ("ambience", "dialogue"):
            e = refused(self, role(Film(), 1, r, has_audio=False), "clip_without_sound", scene=2)
            self.assertIn("muted", e.detail)

    def test_a_file_never_probed_is_refused_rather_than_going_silent(self):
        e = refused(self, role(Film(), 0, "ambience", has_audio=None), "asset_unprobed", scene=1)
        self.assertIn("sound track", e.detail)

    def test_an_unused_take_without_sound_does_not_block_the_film(self):
        f = bought(Film(scenes=1, shots=3, seconds=10, shot_s=12.0, transition="cut", music_s=0, narration=False,
                        captions="none"))
        unused = [t for t in f.takes if t["shot_index"] > 1]
        for t in unused:
            f.assets[t["result_asset_id"]]["has_audio"] = False
        cut = f.build()
        self.assertEqual(set(cut.plan["scenes"][0]["unused_take_ids"]), {t["id"] for t in unused})


class PlanSaysWhatItDid(unittest.TestCase):
    """7.6 #12: per shot, used / no sound in the file / muted / lip-synced, and never "used" for a silent file."""

    def test_each_status_is_reported(self):
        f = Film(scenes=4)
        role(f, 0, "ambience")
        role(f, 1, "muted")
        f.assets[f.take(2, 1)["result_asset_id"]]["has_audio"] = False
        f.assets[f.take(2, 2)["result_asset_id"]]["has_audio"] = False
        role(f, 3, "dialogue")
        f.assets[f.take(3, 2)["result_asset_id"]]["provenance"] = {"lipsync_of_asset_id": "x"}
        cut = f.build()
        per = [[s["clip_sound"] for s in p["shots"]] for p in cut.plan["scenes"]]
        self.assertEqual(per[0], ["used", "used"])
        self.assertEqual(per[1], ["muted", "muted"])
        self.assertEqual(per[2], ["no sound in the file", "no sound in the file"])
        self.assertEqual(per[3], ["used", "lip-synced"])
        self.assertTrue(set(statuses(cut)) <= set(ft.CLIP_SOUND_STATUSES))

    def test_a_muted_shot_bought_with_sound_says_it_was_paid_for(self):
        cut = role(bought(Film(), scenes={0}), 0, "muted").build()
        shots = cut.plan["scenes"][0]["shots"]
        self.assertEqual({(s["clip_sound"], s["sound_paid"]) for s in shots}, {("muted", True)})


class LipSync(unittest.TestCase):
    """7.6 #7 (S6): a lip-synced take's own sound is never in the stem."""

    def test_a_lip_synced_take_is_left_out_of_the_stem(self):
        f = role(Film(scenes=2), 0, "dialogue")
        f.assets[f.take(0, 1)["result_asset_id"]]["provenance"] = '{"lipsync_of_asset_id": "abc"}'
        f.assets[f.take(0, 1)["result_asset_id"]].pop("has_audio")     # not even probed: it is never read
        cut = f.build()
        self.assertEqual([x["clip"] for x in cut.sound["stem"]], ["v01_2"])


class Muting(unittest.TestCase):
    """7.6 #8: a muted scene contributes silence, and the mute is part of the cut's hash."""

    def test_muting_a_scene_changes_the_hash_and_empties_its_part_of_the_stem(self):
        on = role(role(Film(), 0, "ambience"), 1, "ambience").build()
        off = role(role(Film(), 0, "ambience"), 1, "muted").build()
        self.assertNotEqual(on.sha256, off.sha256)
        self.assertEqual(on.doc, off.doc)       # the picture and the beds are the same: only the sound differs
        self.assertFalse(any(x["clip"].startswith("v02") for x in off.sound["stem"]))
        self.assertEqual(off.sha256, ft.cut_hash(off.doc, off.sound))

    def test_a_role_change_between_dialogue_and_ambience_is_a_different_cut(self):
        a = role(Film(), 0, "ambience").build()
        d = role(Film(), 0, "dialogue").build()
        self.assertNotEqual(a.sha256, d.sha256)


class OneInput(unittest.TestCase):
    """7.6 #3: clip sound is ONE input, however many shots carry it."""

    def test_a_30_shot_film_with_clip_sound_is_not_refused(self):
        f = bought(Film(scenes=30, seconds=3, shots=1, shot_s=4.0, clock="film", captions="none"))
        for sc in f.scenes:
            sc["narration"] = "words"
        cut = f.build()
        self.assertEqual(len(cut.sound["stem"]), 30)
        nar, music = a_track(cut, "narration"), a_track(cut, "music")
        self.assertEqual(cut.plan["audio"]["clips"], len(nar["clips"]) + len(music["clips"]) + 1)
        self.assertLessEqual(cut.plan["audio"]["clips"], ft.MAX_SOUND_CLIPS)

    def test_36_sounding_shots_no_longer_hit_the_ceiling(self):
        # vera/film-clip-audio refused this as 36 sound inputs; it is one stem now.
        f = bought(Film(scenes=12, seconds=20, shots=3, shot_s=8.0, transition="cut", music_s=0, narration=False,
                        captions="none"))
        cut = f.build()
        self.assertEqual((len(cut.sound["stem"]), cut.plan["audio"]["clips"]), (36, 1))


class Ducks(unittest.TestCase):
    """7.6 #5 and #6, as spans: speech is the narration and the dialogue regions, never every clip that sounds."""

    def film(self):
        # scene 1 narrated over ambience, scene 2 wordless ambience, scene 3 dialogue: 10 s each.
        f = Film(scenes=3, shots=1, shot_s=11.0, transition="cut", captions="none", clock="film")
        f.scenes[1]["narration"] = f.scenes[2]["narration"] = ""
        f.segments = f.segments[:1]
        f.cues = []
        role(f, 0, "ambience")
        role(f, 1, "ambience")
        role(f, 2, "dialogue")
        return f

    def test_music_ducks_under_the_narration_and_the_dialogue_region_only(self):
        cut = self.film().build()
        lead, tail = ft.NARRATION_LEAD_S, ft.NARRATION_TAIL_S
        self.assertEqual(cut.sound["music_duck_spans"], [[lead, lead + 9.0], [20 + lead, 30 - tail]])
        self.assertEqual(cut.sound["music_duck_db"], -ft.DUCK_DB_DEFAULT)
        self.assertEqual(a_track(cut, "music")["duck"], {"amount_db": 12.0})

    def test_ambience_ducks_under_every_voice_and_dialogue_only_under_the_narration(self):
        cut = self.film().build()
        self.assertEqual(cut.sound["ambience_duck_spans"], cut.sound["music_duck_spans"])
        self.assertEqual(cut.sound["dialogue_duck_spans"], [[ft.NARRATION_LEAD_S, ft.NARRATION_LEAD_S + 9.0]])
        self.assertEqual((cut.sound["ambience_duck_db"], cut.sound["dialogue_duck_db"]), (12.0, 12.0))

    def test_a_dialogue_only_film_still_ducks_its_music(self):
        f = role(Film(narration=False, captions="none"), 0, "dialogue")
        cut = f.build()
        self.assertEqual(a_track(cut, "music")["duck"], {"amount_db": 12.0})
        self.assertEqual(len(cut.sound["music_duck_spans"]), 1)

    def test_an_ambience_only_film_does_not_duck_its_music(self):
        cut = role(Film(narration=False, captions="none"), 0, "ambience").build()
        self.assertNotIn("duck", a_track(cut, "music"))
        self.assertEqual(cut.sound["music_duck_spans"], [])


# ── the stem's chains (pure) ─────────────────────────────────────────────────

def resolver_for(f: Film, root="/media"):
    def resolve(aid):
        a = f.assets.get(aid)
        if a is None:
            return None
        return tl.ResolvedAsset(aid, a["kind"], f"{root}/{aid}", a["duration_s"],
                                a.get("has_audio", False) if a["kind"] == "video" else None)
    return resolve


class StemChains(unittest.TestCase):
    """7.6 #4: cross-fades are acrossfade, not doubled; a sounding shot beside a silent one fades under it."""

    def test_crossfaded_sounding_shots_are_joined_once(self):
        f = Film(scenes=3, shots=1, shot_s=11.0, narration=False, captions="none", music_s=0)
        for i in range(3):
            role(f, i, "ambience")
        cut = f.build()
        tracks = fm.stem_tracks(cut.doc, cut.sound, resolver_for(f))
        self.assertEqual([t.crossfade_s for t in tracks], [0.0, ft.CROSSFADE_S, ft.CROSSFADE_S])
        argv = fm.stem_command("ffmpeg", tracks, cut.length_s, "/tmp/stem.wav")
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertEqual(graph.count("acrossfade"), 2)
        self.assertEqual(argv.count("-i"), 3)
        self.assertIn("amix=inputs=2", graph)       # one cross-faded run and the silent bed

    def test_a_sounding_shot_next_to_a_muted_one_fades_in_under_it(self):
        f = role(Film(scenes=2, shots=1, shot_s=11.0, narration=False, captions="none", music_s=0), 1, "ambience")
        cut = f.build()
        (t,) = fm.stem_tracks(cut.doc, cut.sound, resolver_for(f))
        self.assertEqual((t.crossfade_s, t.fade_in_s), (0.0, ft.CROSSFADE_S))

    def test_a_stem_file_that_lost_its_sound_since_the_cut_is_refused(self):
        f = role(Film(scenes=2, narration=False, captions="none", music_s=0), 0, "ambience")
        cut = f.build()
        for a in f.assets.values():
            a["has_audio"] = False
        with self.assertRaises(fm.MixFailed) as cm:
            fm.stem_tracks(cut.doc, cut.sound, resolver_for(f))
        self.assertEqual(cm.exception.reason, "clip_without_sound")

    def test_each_shot_is_ducked_under_its_own_spans(self):
        f = Ducks().film()
        cut = f.build()
        amb1, amb2, dlg = fm.stem_tracks(cut.doc, cut.sound, resolver_for(f))
        self.assertEqual(amb1.duck_spans, ((0.25, 9.25),))           # under the narration
        self.assertEqual(amb2.duck_spans, ((0.25, 9.25), (20.25, 29.75)))   # the next scene's lines reach it
        self.assertEqual(dlg.duck_spans, ())                          # its own lines are never ducked


# ── the mix, measured (ffmpeg) ───────────────────────────────────────────────

def ff(*args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args], check=True, timeout=120)


def rms_db(path, start, end, hz):
    band = f"bandpass=f={hz}:width_type=q:width=8,bandpass=f={hz}:width_type=q:width=8"
    out = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af",
                          f"atrim=start={start}:end={end},asetpts=PTS-STARTPTS,{band},"
                          "astats=measure_perchannel=none:measure_overall=RMS_level", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=120)
    m = re.findall(r"RMS level dB:\s+(-?(?:\d+(?:\.\d+)?|inf))", out.stderr)
    return None if not m or m[-1] == "-inf" else float(m[-1])


def ebur128(path):
    out = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af",
                          "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True, timeout=120).stderr
    s = out[out.rfind("Summary:"):]
    i = float(re.search(r"\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS", s).group(1))
    p = float(re.search(r"True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS", s).group(1))
    return i, p


class SoundFilm:
    """Scenes of 3 s on disk, one 4 s shot each; ``kinds`` per scene: ``narrated`` (ambience under narration),
    ``wordless`` (ambience alone), ``dialogue`` (ambience and lines in the clip), ``silent`` (narrated over a file
    with no sound stream). The picture is tiny: the mix never decodes it."""

    S = 3

    def __init__(self, root: Path, kinds, music=True, narration_amp=0.25, loud_quiet=False):
        self.root = root
        self.f = Film(scenes=len(kinds), seconds=self.S, shots=1, shot_s=self.S + 1.0, resolution="720p",
                      captions="none", clock="film", music_s=(len(kinds) * self.S + 10) if music else 0)
        self.kinds = kinds
        f = self.f
        f.cues = []
        f.segments = []
        for i, (k, sc) in enumerate(zip(kinds, f.scenes)):
            sc["narration"] = "words" if k in ("narrated", "silent") else ""
            aid = f.take(i, 1)["result_asset_id"]
            if k in ("narrated", "wordless"):
                sc["sound_role"] = "ambience"
            elif k == "dialogue":
                sc["sound_role"] = "dialogue"
            f.assets[aid]["has_audio"] = k != "silent"
            if k in ("narrated", "silent"):
                f.segments.append({"scene_id": sc["id"], "start_s": i * self.S + 0.25, "end_s": i * self.S + 2.25})
        self.paths = {}
        clip_s = self.S + 1
        pic = ["-f", "lavfi", "-i", f"color=c=0x303030:s=64x36:r=30:d={clip_s}"]
        enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
        files = {"ambience": root / "amb.mp4", "dialogue": root / "dlg.mp4", "silent": root / "silent.mp4"}
        amb = f"0.125*sin(2*PI*{AMB_HZ}*t)"
        ff(*pic, "-f", "lavfi", "-i", f"aevalsrc=exprs='{amb}|{amb}':s=44100:d={clip_s}", *enc,
           "-c:a", "aac", "-b:a", "128k", "-shortest", str(files["ambience"]))
        expr = f"0.125*sin(2*PI*{AMB_HZ}*t)+0.2*sin(2*PI*{DIALOGUE_HZ}*t)*between(t,0.25,2.25)"
        ff(*pic, "-f", "lavfi", "-i", f"aevalsrc=exprs='{expr}|{expr}':s=44100:d={clip_s}", *enc,
           "-c:a", "aac", "-b:a", "128k", "-shortest", str(files["dialogue"]))
        ff(*pic, *enc, "-an", str(files["silent"]))
        for i, k in enumerate(kinds):
            self.paths[f.take(i, 1)["result_asset_id"]] = files["silent" if k == "silent" else
                                                                  "dialogue" if k == "dialogue" else "ambience"]
        film_s = len(kinds) * self.S
        # loud_quiet: every other narrated scene 15 dB down (inside loudnorm's relative gate): a range no
        # linear gain can bring inside LRA 11.
        windows = "+".join(f"{1 if not loud_quiet or i % 2 == 0 else 0.18}*between(t,{i * self.S + 0.25},"
                           f"{i * self.S + 2.25})" for i, k in enumerate(kinds) if k in ("narrated", "silent")) or "0"
        nar = root / "narration.wav"
        ff("-f", "lavfi", "-i", f"aevalsrc=exprs='{narration_amp}*sin(2*PI*{NARRATION_HZ}*t)*({windows})'"
           f":s=44100:d={film_s + 1}", "-c:a", "pcm_s16le", str(nar))
        f.assets[NARRATION] = {"kind": "audio", "duration_s": float(film_s + 1)}
        self.paths[NARRATION] = nar
        if music:
            mus = root / "music.wav"
            ff("-f", "lavfi", "-i", f"aevalsrc=exprs='0.25*sin(2*PI*{MUSIC_HZ}*t)|0.25*sin(2*PI*{MUSIC_HZ}*t)'"
               f":s=44100:d={film_s + 10}", "-c:a", "pcm_s16le", str(mus))
            self.paths[MUSIC] = mus

    def cut(self):
        return self.f.build()

    def resolver(self):
        def resolve(aid):
            a = self.f.assets.get(aid)
            if a is None or self.paths.get(aid) is None:
                return None
            return tl.ResolvedAsset(aid, a["kind"], str(self.paths[aid]), a["duration_s"],
                                    a.get("has_audio") if a["kind"] == "video" else None)
        return resolve

    def master(self, work: Path):
        cut = self.cut()
        work.mkdir(exist_ok=True)
        mixed = fm.master(tl.load(cut.doc), cut, self.resolver(), ffmpeg=FFMPEG, workdir=str(work), timeout_s=300)
        return cut, mixed

    def window(self, i):
        # The middle of the scene's speech window, clear of the cross-fades and the duck's ramps.
        return i * self.S + 0.75, i * self.S + 1.95


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg is not installed")
class MixMeasured(unittest.TestCase):
    """7.6 #1, #5, #6 and #10, read off the mastered file band by band."""

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp())
        cls.film = SoundFilm(cls.root, ["narrated", "wordless", "dialogue", "silent", "narrated", "wordless"])
        cls.cut, cls.mixed = cls.film.master(cls.root / "work")
        (cls.track,) = cls.mixed.tracks
        cls.wav = cls.track.path

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def level(self, scene, hz):
        a, b = self.film.window(scene)
        return rms_db(self.wav, a, b, hz)

    def test_the_shots_sound_reaches_the_master_not_the_floor(self):
        # Today's master had the clip tone at -68.9 LUFS, the noise floor, against -21.1 in the source.
        self.assertGreater(self.level(1, AMB_HZ), -40)
        self.assertGreater(self.level(2, DIALOGUE_HZ), -40)

    def test_a_file_without_sound_adds_silence_and_nothing_is_invented(self):
        self.assertLess(self.level(3, AMB_HZ), -60)

    def test_music_is_lowered_12_db_under_speech_and_not_under_a_wordless_scene(self):
        free = self.level(1, MUSIC_HZ)
        self.assertAlmostEqual(free - self.level(0, MUSIC_HZ), 12.0, delta=0.6)   # under the narration
        self.assertAlmostEqual(free - self.level(2, MUSIC_HZ), 12.0, delta=0.6)   # under the dialogue's lines

    def test_ambience_is_lowered_under_the_narration_and_a_dialogue_shot_is_not(self):
        free = self.level(1, AMB_HZ)
        self.assertAlmostEqual(free - self.level(0, AMB_HZ), 12.0, delta=0.6)
        # The dialogue clip's own ambience plays at the level a wordless scene's does: its lines are in it.
        self.assertAlmostEqual(self.level(2, AMB_HZ), free, delta=1.0)

    def test_the_master_is_on_target_linear_and_under_the_true_peak_ceiling(self):
        loud = self.mixed.loudness
        self.assertEqual((loud["mode"], loud["status"]), ("linear", "linear"), loud)
        i, tp = ebur128(self.wav)
        self.assertAlmostEqual(i, ft.MASTER_LUFS, delta=0.5)
        self.assertLessEqual(tp, ft.MASTER_TRUE_PEAK_DB + 0.1)
        self.assertEqual(set(loud["measured"]), {"I", "TP", "LRA", "thresh"})

    def test_the_final_pass_gets_one_file_and_the_premaster_one_stem(self):
        self.assertEqual(self.mixed.stem_shots, 5)
        nar, music = a_track(self.cut, "narration"), a_track(self.cut, "music")
        self.assertEqual(self.mixed.premaster_inputs, len(nar["clips"]) + len(music["clips"]) + 1)
        self.assertAlmostEqual(self.track.duration_s, self.cut.length_s)


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg is not installed")
class DynamicIsLabelled(unittest.TestCase):
    """7.6 #10 as Atlas decided it: a film a linear gain cannot normalise ships in loudnorm's dynamic mode, labelled."""

    def test_a_wide_range_narration_film_is_normalised_dynamically_and_says_so(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        film = SoundFilm(root, ["silent"] * 8, music=False, loud_quiet=True)
        _cut, mixed = film.master(root / "work")
        loud = mixed.loudness
        self.assertGreater(loud["measured"]["LRA"], ft.MASTER_LRA)
        self.assertEqual((loud["mode"], loud["status"]), ("dynamic", "dynamic (linear not possible)"))
        self.assertIn("dynamic (linear not possible)", fa.loudness_note(loud))
        self.assertIn(f"range {loud['measured']['LRA']:g} LU", fa.loudness_note(loud))


class LoudnessReport(unittest.TestCase):
    def test_the_pass_two_json_is_read_from_the_tail(self):
        tail = 'noise\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-20.10",\n\t"normalization_type" : "dynamic"\n}\nend'
        self.assertEqual(fm.loudnorm_report(tail)["normalization_type"], "dynamic")
        self.assertEqual(fm.loudnorm_report("nothing here"), {})

    def test_the_targets_are_the_named_constants(self):
        argv = fm.measure_command("ffmpeg", "/x.wav")
        af = argv[argv.index("-af") + 1]
        self.assertIn(f"I={ft.MASTER_LUFS:g}:TP={ft.MASTER_TRUE_PEAK_DB:g}:LRA={ft.MASTER_LRA:g}", af)
        argv = fm.apply_command("ffmpeg", "/x.wav", {"I": -20, "TP": -5, "LRA": 4, "thresh": -30, "offset": 0.1}, "/y")
        self.assertIn("linear=true", argv[argv.index("-af") + 1])


# ── the assembly ─────────────────────────────────────────────────────────────

class Assembly(unittest.TestCase):
    """7.6 #11 and the record a person reads."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def film(self, kind="ambience"):
        f = DiskFilm(self.root, render_files=False)
        for aid in f.assets:
            f._place(aid).write_bytes(b"\0")
        for sc in f.scenes:
            sc["narration"] = ""
            sc["sound_role"] = kind
        return f

    def run_it(self, f, *, has_audio=lambda p, m: True, out_has_audio=True, loudness=None):
        db = f.db()
        self.rendered = []

        def render(norm, resolver, out, timings=None, **kw):
            self.rendered.append(kw)
            timings.mode, timings.intermediate = "sequential", "fast"
            Path(out).write_bytes(b"\0" * 64)
            return out
        self.mix = fake_mix(loudness)
        deps = fa.Deps(env=ENV, render=render, probe=lambda p: fa.Probed(6.0, 1280, 720, out_has_audio),
                       store_file=fake_store_file(db, self.root), has_audio=has_audio, free_mb=lambda p: 1e9,
                       mix=self.mix)
        tools = fa.ml.Tools(ffprobe="ffprobe", ffmpeg="ffmpeg")
        out = fa.assemble_segment(db.seg, worker_id="w-1", store=db, media=FakeMedia(db), media_root=self.root,
                                  tools=tools, deps=deps)
        return db, out

    def test_a_film_whose_only_sound_is_its_shots_must_come_out_with_sound(self):
        _db, out = self.run_it(self.film(), out_has_audio=False)
        self.assertEqual((out.ok, out.reason), (False, "output_mismatch"), out)

    def test_every_shown_shot_is_probed_and_a_silent_one_is_refused_before_rendering(self):
        _db, out = self.run_it(self.film(), has_audio=lambda p, m: False)
        self.assertEqual((out.ok, out.reason), (False, "clip_without_sound"), out)
        self.assertEqual(self.rendered, [], "nothing is rendered for a film that would lose its sound")

    def test_the_mastered_sound_is_what_the_final_pass_muxes(self):
        _db, out = self.run_it(self.film())
        self.assertTrue(out.ok, out)
        self.assertEqual(len(self.mix.calls), 1)
        self.assertEqual(self.rendered[0]["audio"], ())
        self.assertIsNotNone(self.mix.calls[0].sound)

    def test_a_dynamic_loudness_is_recorded_on_the_film_and_named_in_the_outcome(self):
        dyn = {"target": {"I": -14.0, "TP": -1.0, "LRA": 11.0}, "measured": {"I": -18.2, "TP": -3.0, "LRA": 14.0,
                                                                            "thresh": -29.0},
               "mode": "dynamic", "status": "dynamic (linear not possible)", "result": {"I": -14.1, "TP": -1.2, "LRA": 9.0}}
        db, out = self.run_it(self.film(), loudness=dyn)
        self.assertTrue(out.ok, out)
        self.assertEqual(out.loudness, dyn)
        self.assertIn("loudness: dynamic (linear not possible) (measured -18.2 LUFS, true peak -3 dBTP, range 14 LU)",
                      out.detail)
        prov = db.asset_rows[out.asset_id]["provenance"]
        self.assertEqual(prov["sound"]["master_loudness"]["status"], "dynamic (linear not possible)")

    def test_a_mix_that_fails_fails_the_film_by_name_at_zero(self):
        f = self.film()
        db = f.db()

        def broken(*a, **k):
            raise fm.MixFailed("sound_mix_failed", "the film's sound could not be mixed (premaster stopped): retry")
        deps = fa.Deps(env=ENV, render=lambda *a, **k: self.fail("rendered"), store_file=fake_store_file(db, self.root),
                       has_audio=lambda p, m: True, free_mb=lambda p: 1e9, mix=broken)
        out = fa.assemble_segment(db.seg, worker_id="w-1", store=db, media=FakeMedia(db), media_root=self.root,
                                  tools=fa.ml.Tools(ffprobe="ffprobe", ffmpeg="ffmpeg"), deps=deps)
        self.assertEqual((out.ok, out.reason, out.recorded), (False, "sound_mix_failed", True))
        self.assertEqual(db.seg["assembly"]["charged_credits"], 0.0)


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg is not installed")
class AssemblyRendered(unittest.TestCase):
    """7.6 #1 end to end: the real mix and the real editor render, the shots' tone read off the mp4."""

    def test_a_film_of_sounding_shots_renders_their_sound_and_records_its_loudness(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        f = DiskFilm(root, scenes=2, seconds=3)
        for i, sc in enumerate(f.scenes):
            sc["sound_role"] = "ambience"
        for t in f.takes:
            if t["kind"] == "clip":     # the clips get a 1000 Hz sound track
                p = fa.ml.asset_file(root, fa.ml.canonical_id(t["result_asset_id"]), "original")
                tmp = p.with_suffix(".tmp.mp4")
                ff("-i", str(p), "-f", "lavfi", "-i", f"sine=f={AMB_HZ}:sample_rate=48000:d=4", "-c:v", "copy",
                   "-c:a", "aac", "-shortest", "-f", "mp4", str(tmp))
                tmp.replace(p)
        db = f.db()
        out = fa.assemble_segment(db.seg, worker_id="w-1", store=db, media=FakeMedia(db), media_root=root,
                                  tools=fa.ml.Tools(ffprobe=FFPROBE, ffmpeg=FFMPEG), deps=fa.Deps(env=ENV))
        self.assertTrue(out.ok, (out.reason, out.detail))
        path = fa.ml.asset_file(root, out.asset_id, "original")
        self.assertGreater(rms_db(path, 0.5, 2.5, AMB_HZ), -45)
        self.assertIn(out.loudness["mode"], ("linear", "dynamic"))
        self.assertEqual(db.asset_rows[out.asset_id]["provenance"]["sound"]["clip_stem_shots"], 2)


# ── not buying sound the film will not play ──────────────────────────────────

class NoUnusedSound(unittest.TestCase):
    """Atlas, 28 Nov: a single-price model is asked for no sound outside a dialogue scene; a priced one is untouched."""

    def request(self, model, params=None):
        e = mr.get(model)
        cap = "i2v" if "i2v" in e.capabilities else "t2v"
        return cw.GenerationRequest(job_id="j", org_id="o", capability=cap, model=model, params=dict(params or {}))

    def test_a_single_price_model_with_a_sound_switch_is_asked_for_none(self):
        for model in ("ltx-2.5-pro", "seedance-2.0", "vidu-q3-pro", "grok-imagine-video-1.5"):
            out = fo.without_unused_sound(self.request(model), ca.resolve(model, env={}), {"sound_role": None})
            self.assertIs(out.params.get("audio"), False, model)

    def test_a_dialogue_scene_keeps_the_vendors_sound(self):
        out = fo.without_unused_sound(self.request("ltx-2.5-pro"), ca.resolve("ltx-2.5-pro", env={}),
                                      {"sound_role": "dialogue"})
        self.assertNotIn("audio", out.params)

    def test_a_priced_sound_choice_is_never_changed(self):
        for model, choice in (("kling-v3", True), ("seedance-1.5-pro", False)):
            out = fo.without_unused_sound(self.request(model, {"audio": choice}), ca.resolve(model, env={}), {})
            self.assertIs(out.params["audio"], choice, model)

    def test_a_model_without_a_switch_or_without_sound_is_sent_nothing(self):
        # Gemini Omni's soundtrack is always on and H3 has no flag; a silent model may refuse the field.
        for model in ("gemini-omni-1.1-flash", "minimax-h3", "veo-3.1", "kling-v2.6", "runway-gen4.5"):
            out = fo.without_unused_sound(self.request(model), ca.resolve(model, env={}), {})
            self.assertNotIn("audio", out.params, model)


if __name__ == "__main__":
    unittest.main()
