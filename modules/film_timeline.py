"""Film Studio P4a: a film's chosen takes → the editor's timeline document (pure).

A film is assembled by the editor's render path (``timeline_render`` → ``render_backend``) on the
media-worker, not by a renderer of its own (docs/FILM_STUDIO.md). This module is the only new piece of
that path: it turns a film's storyboard, the takes chosen for each scene, the narration take and its
per-scene segments, the music bed and the captions into a ``modules/timeline.py`` document, validated
by the same ``timeline.validate`` an editor save is, plus a plan that says what it decided and why.

Pure and deterministic: no database, no file, no clock, no randomness. The same input always gives
the same document, byte for byte, and the same ``sha256`` (``Cut.sha256``): a re-assembly with
nothing changed is the same cut, and an approval (migration 0112) of one cut can never silently apply
to another. Times are computed in whole milliseconds, so float noise never reaches the hash.

What it decides
---------------
* **Order.** Scenes by ``position`` (each position once); within a scene, shots 1..``shot_count``
  (shot 1 the ``clip`` take, 2-3 the ``extend`` takes) of the scene's ``current_version``. Of the
  takes of one shot, the ``completed`` one with the highest ``attempt``.
* **Length.** A scene lasts exactly its ``planned_seconds`` and the film exactly their sum: that is
  what P2 quotes the assembly minutes from, so the cut is never longer than what was priced. The
  shots fill the scene in order and the last one used is trimmed (``out_s``); a shot the scene does
  not reach is listed in the plan as unused, never dropped without a word. A last piece shorter
  than ``MIN_PIECE_S`` would be a flash, so its predecessor gives it the difference.
* **Transitions.** Between scenes: the scene's ``transition_in``, else the film's
  ``transition_default``. A cross-fade takes its overlap (``CROSSFADE_S``) out of the incoming
  scene's own footage and never lengthens the film; a dip to black needs no extra footage. Within a
  scene, and into a scene whose first frame is the previous scene's last (``first_frame =
  previous``), it is always a cut: the shots continue one picture, and blending a frame into itself
  is a stutter, not a transition. A shot that chains by last frame starts ``CHAIN_SKIP_S`` in, so the
  frame it was generated from (the previous shot's last) is not shown twice.
* **Continuity is checked, not assumed.** A shot 2-3, or a scene that continues the previous one,
  must start from exactly the last frame its predecessor's take produced
  (``first_frame_asset_id == result_last_frame_asset_id``). If the predecessor was re-shot since,
  the picture would jump at a cut that was meant to be seamless: refused (``continuity_broken``),
  with the scene to re-shoot named.
* **Sound.** One speech track: the narration take cut into one clip per narrated scene, starting
  ``NARRATION_LEAD_S`` into its scene, and joined back into one clip across scenes where the take
  already runs on the film's clock (``NARRATION_JOIN_S``). Every clip is an input of the final pass,
  and at 1080p the pass cannot mix more than ``MAX_SOUND_CLIPS`` of them under the export's limits
  (measured), so a 60-scene film needs its narration on the film's clock: P3's contract. A segment that does not fit its scene is refused, never sped
  up or cut off. One music track at ``music_gain_db``, ducked under the narration by ``-duck_db`` dB
  with the editor's duck envelope, tiled with short fades when the track is shorter than the film.
* **Loudness is the narration take's, corrected by a gain, never by a per-clip loudnorm.** The
  editor's ``loudnorm: true`` on each of up to 60 narration clips is the obvious way, and it does not
  render: measured, the final pass runs out of its 2 GiB address space at 32 clips with loudnorm
  (``Cannot allocate memory``), while 63 clips without it take 308 MB
  (docs/FILM_ASSEMBLY_MEASUREMENT.md). And one take normalised once sounds the same in every scene,
  where 60 short single-pass loudnorms each guess from a few seconds. So the target is
  ``NARRATION_LUFS`` integrated / ``NARRATION_TRUE_PEAK_DB`` true peak, the narration take carries
  its measured ``loudness_lufs`` and ``true_peak_db``, and the clips get the one gain that brings it
  to the target, as long as that keeps the true peak under the ceiling (else refused:
  ``narration_loudness``, the fix is to normalise the take). A take with no measurement is left as it
  is and the plan says "not measured", never "-16". The editor has no master loudness pass, and the
  plan says so rather than claiming one. The film's master gets one loudness pass of its own at
  assembly (``modules/film_mix.py``, see "A shot's own sound" below); the plan carries its targets.
* **A shot's own sound** (S2, docs/studio/S2_CLIP_AUDIO.md section 7). Every scene has a sound role,
  ``dialogue``, ``ambience`` or ``muted`` (``SOUND_ROLES``): the scene's ``sound_role`` when the plan or a
  person set one, otherwise ``ambience`` when a shown take was bought with the priced sound option
  (``params.audio`` true: kling-v3, seedance-1.5-pro; 0171 copies ``clip_params.audio`` into the take), and
  ``muted`` for everything else. So a film made before this, whose takes bought no sound, keeps its
  document and its hash, and a single-price model's sound (Veo, H3, LTX ...) is not played by default: a
  model that speaks may speak unasked words in a scene that has no lines (Atlas, 28 Nov; the orchestrator
  asks those models for no sound where the adapter can). The shots of a ``dialogue`` or ``ambience`` scene
  are premixed by the assembly into ONE stem (``Cut.sound``), so clip sound is one input against
  ``MAX_SOUND_CLIPS`` whatever the shot count (vera/film-clip-audio's one input per clip refused the
  owner's 30-shot reels as ``too_many_audio_clips``). A lip-synced take (``lipsync_of_asset_id`` in its
  file's provenance: S6 brings its lines in its own stem) is never in it. A shot whose scene needs its
  sound, or that was bought with sound, must be known to carry a sound track: none is
  ``clip_without_sound``, not probed is ``asset_unprobed``, never rendered silent (rule 4). Speech is
  explicit, not "every clip that sounds": the music ducks under the narration and the dialogue scenes'
  speech regions, the ambience under both, a dialogue shot under the narration only (its lines are in
  it), all with the editor's deterministic envelope. The document itself never marks a V clip
  ``audio: true`` (the editor would then duck the music under the whole film); what the stem is and how
  it ducks is ``Cut.sound``, hashed with the document whenever it exists.
* **Captions.** Cues are timed against the narration take and are moved onto the film clock by
  the segment they start in. Placed bottom-centre inside a safe area per aspect (``SAFE_AREAS``):
  above the bottom tenth on 16:9, above the bottom fifth on 9:16, where a phone's player draws its
  own controls and titles. Wrapped to the safe width at most ``MAX_CAPTION_LINES`` lines; a cue that
  needs more is refused, never shrunk or cut. ``captions_mode`` ``burn``/``both`` burns them in;
  ``sidecar``/``both`` gives the ``.srt`` text. The safe-area fractions are this module's
  conservative design values, not figures published by YouTube (unverified: Scout before relying
  on an exact pixel).

What it refuses (``FilmTimelineRefused.reason``; rule 4: no scene is dropped, no still or other take
is put in a missing one's place, and the sentence names the fix): ``no_scenes``, ``too_many_scenes``,
``invalid_film``, ``invalid_scene``, ``scene_not_shot``, ``missing_take``, ``take_failed``,
``take_without_result``, ``asset_unavailable``, ``asset_not_video``, ``asset_unprobed``,
``aspect_mismatch``, ``clip_without_sound``, ``scene_too_short``, ``continuity_broken``, ``continuity_trim``, ``narration_missing``,
``narration_segment_missing``, ``narration_too_long``, ``narration_outside_take``, ``narration_loudness``,
``music_unavailable``,
``captions_missing``, ``invalid_captions``, ``caption_outside_narration``, ``caption_too_long``, ``too_many_audio_clips``,
``film_too_long``, ``invalid_timeline``.

One document, not parts (measured: docs/FILM_ASSEMBLY_MEASUREMENT.md)
---------------------------------------------------------------------
The editor's path already renders a film one clip at a time and joins the pieces in one final pass, so
its memory does not grow with the film's length (10 and 15 minutes peaked within a few MB of each other)
and its time budget (``timeline.render_timeout_s``) grows with the length. Cutting the film into parts
rendered apart would save neither, and would make the sound differ at every join (the duck envelope and
the music fades are computed over the whole film). So a cut is one document; what a part would have
bounded, the work directory's size, is a check before the render (P4b), not a different document.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from modules import timeline as tl

#: Bumped when a rule here changes what document a film becomes, so the change shows in every hash.
FORMAT_VERSION = 1

MAX_SCENES = 60                     # 0166 film_scenes: up to 60
MAX_SHOTS = 3                       # 0166 film_scenes.shot_count 1-3
#: The longest film one cut may be: 10 minutes, the longest assembly measured at both 720p and 1080p through the
#: editor's path (docs/FILM_ASSEMBLY_MEASUREMENT.md; 15 minutes was measured at 720p only). 0166 lets a film target
#: up to 1200 s, but a length nobody has rendered is not offered; raise this after the media-worker has rendered one.
MAX_FILM_S = 600.0

#: (aspect, resolution) → frame. 768p is the short side of 768 with the long side rounded to even.
FRAMES: Dict[Tuple[str, str], Tuple[int, int]] = {
    ("16:9", "720p"): (1280, 720), ("16:9", "768p"): (1366, 768), ("16:9", "1080p"): (1920, 1080),
    ("9:16", "720p"): (720, 1280), ("9:16", "768p"): (768, 1366), ("9:16", "1080p"): (1080, 1920),
    ("1:1", "720p"): (720, 720), ("1:1", "768p"): (768, 768), ("1:1", "1080p"): (1080, 1080),
}
DEFAULT_RESOLUTION = "1080p"
FILM_FPS = (24, 25, 30)
DEFAULT_FPS = 30
#: How far a clip's shape may differ from the frame's before ``cover`` would crop away picture.
ASPECT_TOLERANCE = 0.02

TRANSITIONS = ("cut", "dip_to_black", "crossfade")
CROSSFADE_S = 0.5
DIP_S = 0.6
#: A chained shot's first frame is its predecessor's last; one source frame of 24-30 fps is skipped.
CHAIN_SKIP_S = 0.042
#: The shortest last piece a scene may end on when a cross-fade or a dip leads out of it.
MIN_PIECE_S = 1.0
#: How much of a scene's motion may be skipped at a seam that is meant to be seamless (3 frames at 30 fps).
SEAM_TOLERANCE_S = 0.1

NARRATION_LEAD_S = 0.25
NARRATION_TAIL_S = 0.25
#: The narration's loudness target: the editor's own numbers (render_spec.LOUDNORM_FILTER), reached by a
#: gain on the clips from the take's measured loudness (see "Loudness" above).
NARRATION_LUFS, NARRATION_TRUE_PEAK_DB = -16.0, -1.5
#: Within this of the target the take is used as it is: a gain that small is not worth a change.
NARRATION_LUFS_TOLERANCE = 1.0
#: Two neighbouring scenes' narration is one clip when the take runs on the film's clock across them (the
#: same offset from the file to the film) and the pause between them is at most this long: the music then
#: stays down through the pause instead of rising for a moment. P3 lays the narration out on the clock.
NARRATION_JOIN_S = 3.0
#: Sound clips (inputs of the final pass) a film may have. Measured at 1080p under the export's 2 GiB
#: address-space limit (docs/FILM_ASSEMBLY_MEASUREMENT.md): 32 mix in 15 s; 61-63 stall until the deadline
#: or crash (SIGSEGV), and pass at 3 GiB. The editor's own limit (timeline.MAX_AUDIO_CLIPS, 64) is
#: above what its renderer can do at 1080p, so a film is held to the measured number.
MAX_SOUND_CLIPS = 32
MUSIC_GAIN_DB_DEFAULT = -18.0
DUCK_DB_DEFAULT = -12.0
MUSIC_FADE_IN_S = 1.0
MUSIC_JOIN_FADE_S = 1.5
MUSIC_END_FADE_S = 3.0

#: This cut keeps a clip's own sound (S2): a take bought with the priced sound option plays it, through the clip stem. Migration 0236
#: refuses that option (``clip_sound_not_kept``) until ``film_studio_settings.clip_sound_kept`` is turned on, which the owner does
#: from the SQL editor only once a worker running this code is deployed (0236's header, "OWNER STEP"): a worker without it would
#: drop the sound it was paid for. Never False here: a cut that drops clip sound again needs that switch turned off first.
CLIP_SOUND_IN_CUT = True

#: A scene's own sound: its lines spoken in the clip, its ambience, or nothing (see "A shot's own sound").
SOUND_ROLES = ("dialogue", "ambience", "muted")
#: What the plan says about one shown shot's own sound. Never "used" for a file the probe found silent (rule 5).
CLIP_SOUND_STATUSES = ("used", "muted", "lip-synced", "no sound in the file")
#: How far the clip stem is lowered under speech: the editor's envelope, the same depth as the music's
#: default. Measured: exactly 12.0 dB, where a sidechain's depth followed the narration's level
#: (docs/studio/S2_CLIP_AUDIO.md section 4.2).
STEM_DUCK_DB = 12.0
#: The stem's level in the mix. 0 dB until a real clip's sound has been measured: no Kling, H3 or Veo file
#: with sound exists in this repo, so any other number would be a guess (S2 section 7.3).
STEM_GAIN_DB = 0.0
#: The master's loudness pass (modules/film_mix.py): integrated, true peak, range. PROVISIONAL: -14 LUFS is
#: the figure usually quoted for YouTube's playback normalisation and is not verified here (a Scout item),
#: and the owner has not answered S2's question 3 yet. They live here, once, so the answer is one edit.
MASTER_LUFS = -14.0
MASTER_TRUE_PEAK_DB = -1.0
MASTER_LRA = 11.0

CAPTION_MODES = ("sidecar", "burn", "both", "none")
MAX_CAPTION_LINES = 2
#: Average glyph width of DejaVu Sans Bold as a fraction of the font size (wrapping estimate; the
#: real width varies by letter, so it is the safe side of the average).
GLYPH_W = 0.56
#: Per aspect: the caption block's bottom edge (fraction of the height, from the top), the margin on
#: each side (fraction of the width; captions are centred, so the wider of the two sides counts) and
#: the size (fraction of the frame's shorter side). 9:16 keeps clear of the bottom fifth and of the
#: right-hand column where a phone player draws its buttons.
SAFE_AREAS: Dict[str, Dict[str, float]] = {
    "16:9": {"bottom": 0.90, "side": 0.10, "size": 0.050},
    "9:16": {"bottom": 0.78, "side": 0.15, "size": 0.050},
    "1:1": {"bottom": 0.88, "side": 0.10, "size": 0.050},
}

REASONS = ("no_scenes", "too_many_scenes", "invalid_film", "invalid_scene", "scene_not_shot", "missing_take",
           "take_failed", "take_without_result", "asset_unavailable", "asset_not_video", "asset_unprobed",
           "aspect_mismatch", "scene_too_short", "continuity_broken", "continuity_trim", "narration_missing",
           "narration_segment_missing", "narration_too_long", "narration_outside_take", "narration_loudness",
           "music_unavailable",
           "captions_missing", "invalid_captions", "caption_outside_narration", "caption_too_long", "too_many_audio_clips",
           "film_too_long", "invalid_timeline", "clip_without_sound")


class FilmTimelineRefused(ValueError):
    """The film cannot be assembled as it stands. ``reason`` is one of REASONS, ``scene`` the scene's
    1-based number when one scene is the cause, ``detail`` a sentence that names the fix."""

    def __init__(self, reason: str, detail: str, scene: Optional[int] = None):
        assert reason in REASONS, reason
        self.reason, self.detail, self.scene = reason, detail, scene
        super().__init__(f"{reason}: {detail}")


@dataclass(frozen=True)
class Cut:
    doc: dict                       # the timeline document (timeline.validate: no problems)
    sha256: str                     # of FORMAT_VERSION and the canonical JSON of doc
    length_s: float
    plan: dict                      # what was decided, per scene and for the sound and captions
    srt: Optional[str]              # the sidecar, when captions_mode is sidecar or both
    #: The clip-sound stem and the ducks around it (None: the film plays no shot's own sound). Part of the hash.
    sound: Optional[dict] = None


# ── small helpers ────────────────────────────────────────────────────────────

def _ms(seconds: Any) -> int:
    return int(round(float(seconds) * 1000))


def _s(ms: int) -> float:
    return round(ms / 1000.0, 3)


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _id(v: Any) -> Optional[str]:
    return str(v).lower() if v is not None else None


def canonical_json(doc: Any) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def cut_hash(doc: dict, sound: Optional[dict] = None) -> str:
    # A film without clip sound hashes exactly as before ``sound`` existed, so an approval of its cut (0112)
    # still names the same cut; with it, a change of a scene's role or a duck is a different cut.
    payload: Dict[str, Any] = {"format": FORMAT_VERSION, "doc": doc}
    if sound is not None:
        payload["sound"] = sound
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def frame_for(aspect: str, resolution: Optional[str]) -> Tuple[int, int]:
    key = (aspect, resolution or DEFAULT_RESOLUTION)
    if key not in FRAMES:
        raise FilmTimelineRefused("invalid_film", f"no frame for aspect {aspect!r} at {resolution!r}; "
                                  "use 16:9, 9:16 or 1:1 at 720p, 768p or 1080p")
    return FRAMES[key]


def caption_layout(aspect: str, width: int, height: int) -> dict:
    """Where captions go in this frame: the style the document carries and the wrap width."""
    area = SAFE_AREAS[aspect]
    size = int(round(area["size"] * min(width, height)))
    safe_w = width * (1 - 2 * area["side"])
    return {"y": area["bottom"], "size": size, "side": area["side"],
            "max_chars": max(8, int(safe_w // (size * GLYPH_W))), "max_lines": MAX_CAPTION_LINES}


def wrap_caption(text: str, max_chars: int) -> Optional[List[str]]:
    """Greedy word wrap; None when a line would still be too long or there are too many lines."""
    words = str(text).split()
    lines: List[str] = []
    for w in words:
        if len(w) > max_chars:
            return None
        if lines and len(lines[-1]) + 1 + len(w) <= max_chars:
            lines[-1] += " " + w
        else:
            lines.append(w)
    if not lines or len(lines) > MAX_CAPTION_LINES:
        return None
    return lines


def _srt_time(ms: int) -> str:
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms_ = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms_:03d}"


def srt_text(cues: Sequence[dict]) -> str:
    out = []
    for i, c in enumerate(cues, start=1):
        out += [str(i), f"{_srt_time(_ms(c['start_s']))} --> {_srt_time(_ms(c['end_s']))}", c["text"], ""]
    return "\n".join(out)


# ── choosing the takes ───────────────────────────────────────────────────────

def _scene_label(n: int) -> str:
    return f"scene {n}"


def _chosen_shots(scene: Mapping, n: int, takes: Sequence[Mapping]) -> List[Mapping]:
    """The completed take of each shot 1..shot_count of the scene's current version, or a refusal."""
    sid = _id(scene.get("id"))
    version = scene.get("current_version")
    if version is None:
        raise FilmTimelineRefused("scene_not_shot", f"{_scene_label(n)} has no chosen version yet: shoot it first", n)
    shots = []
    for idx in range(1, int(scene["shot_count"]) + 1):
        kind = "clip" if idx == 1 else "extend"
        mine = [t for t in takes if _id(t.get("scene_id")) == sid and t.get("kind") == kind
                and t.get("shot_index") == idx and t.get("version") == version]
        done = sorted((t for t in mine if t.get("status") == "completed"), key=lambda t: int(t.get("attempt") or 1))
        if not done:
            failed = [t for t in mine if t.get("status") == "failed"]
            if failed:
                code = failed[-1].get("error_code") or "unknown"
                raise FilmTimelineRefused("take_failed", f"{_scene_label(n)} shot {idx} failed ({code}): re-shoot it, "
                                          "or edit its prompt and re-shoot", n)
            raise FilmTimelineRefused("missing_take", f"{_scene_label(n)} shot {idx} has no finished take in "
                                      f"version {version}: wait for it or re-shoot it", n)
        take = done[-1]
        if not take.get("result_asset_id"):
            raise FilmTimelineRefused("take_without_result", f"{_scene_label(n)} shot {idx} finished without a video "
                                      "file: re-shoot it", n)
        shots.append(take)
    return shots


def _video(asset_id: str, assets: Mapping, n: int, idx: int, frame: Tuple[int, int]) -> Mapping:
    a = assets.get(asset_id)
    if a is None:
        raise FilmTimelineRefused("asset_unavailable", f"{_scene_label(n)} shot {idx}: its video is no longer in the "
                                  "library: re-shoot it", n)
    if a.get("kind") != "video":
        raise FilmTimelineRefused("asset_not_video", f"{_scene_label(n)} shot {idx}: its result is not a video", n)
    w, h, d = a.get("width"), a.get("height"), a.get("duration_s")
    if not (_num(w) and _num(h) and _num(d)) or w <= 0 or h <= 0 or d <= 0:
        raise FilmTimelineRefused("asset_unprobed", f"{_scene_label(n)} shot {idx}: the library has no size or length "
                                  "for its video yet: wait for the upload check to finish", n)
    if abs((w / h) / (frame[0] / frame[1]) - 1) > ASPECT_TOLERANCE:
        raise FilmTimelineRefused("aspect_mismatch", f"{_scene_label(n)} shot {idx} is {int(w)}x{int(h)}, the film is "
                                  f"{frame[0]}x{frame[1]}: filling the frame would crop it away; re-shoot it in the "
                                  "film's aspect", n)
    return a


def made_with_sound(take: Mapping) -> bool:
    """Was this take bought with its own sound? Only an explicit true: 0171 copies ``audio`` into a take's params
    only when the scene chose the priced sound option, and a take that never asked is the silent clip it always was."""
    p = take.get("params")
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except ValueError:
            p = None
    return isinstance(p, Mapping) and p.get("audio") is True


def _lip_synced(asset: Mapping) -> bool:
    """A take S6 re-made with lip-sync: its own sound stays out of the stem, S6's dialogue stem carries the lines.
    Read from an explicit field, never guessed from the model."""
    p = asset.get("provenance")
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except ValueError:
            p = None
    return isinstance(p, Mapping) and bool(p.get("lipsync_of_asset_id"))


def _scene_role(scene: Mapping, takes: Sequence[Mapping], n: int) -> Tuple[str, str]:
    """The scene's sound role and where it came from (``chosen`` or ``default``)."""
    role = scene.get("sound_role")
    if role is not None:
        if role not in SOUND_ROLES:
            raise FilmTimelineRefused("invalid_scene", f"{_scene_label(n)}: its sound must be one of "
                                      f"{', '.join(SOUND_ROLES)}", n)
        return role, "chosen"
    # A sound option a person paid for is played; nothing else is, by default (see "A shot's own sound").
    return ("ambience" if any(made_with_sound(t) for t in takes) else "muted"), "default"


def _check_sound(asset: Mapping, n: int, idx: int, role: str, bought: bool) -> None:
    """A shot whose sound the film needs plays it, or the film is refused: never the silent clip in its place."""
    has = asset.get("has_audio")
    why = "was bought with its own sound" if bought else f"is in a scene whose sound is {role}"
    if has is False:
        fix = "re-shoot the shot" if bought else "set the scene's sound to muted, or re-shoot it with sound"
        raise FilmTimelineRefused("clip_without_sound", f"{_scene_label(n)} shot {idx} {why}, but its video has no "
                                  f"sound track: {fix}", n)
    if has is not True:
        raise FilmTimelineRefused("asset_unprobed", f"{_scene_label(n)} shot {idx} {why}, and whether its video "
                                  "carries a sound track is not known yet: retry the assembly", n)


def _narration_gain(narration: Mapping) -> dict:
    """The gain that brings the narration take to the target, from what was measured on it."""
    lufs, peak = narration.get("loudness_lufs"), narration.get("true_peak_db")
    base = {"target_lufs": NARRATION_LUFS, "true_peak_ceiling_db": NARRATION_TRUE_PEAK_DB}
    if lufs is None:
        return {**base, "measured_lufs": None, "measured_true_peak_db": None, "status": "not measured", "gain_db": 0.0}
    if not _num(lufs) or (peak is not None and not _num(peak)):
        raise FilmTimelineRefused("narration_loudness", "the narration's loudness measurement is not a number: "
                                  "measure the narration again")
    gain = round(NARRATION_LUFS - float(lufs), 1)
    if abs(gain) <= NARRATION_LUFS_TOLERANCE:
        gain = 0.0
    if gain > 0 and (peak is None or float(peak) + gain > NARRATION_TRUE_PEAK_DB):
        room = "its true peak was not measured" if peak is None else f"its true peak is {float(peak):g} dB"
        raise FilmTimelineRefused("narration_loudness", f"the narration is {float(lufs):g} LUFS and needs +{gain:g} dB "
                                  f"to reach {NARRATION_LUFS:g}, but {room}: normalise the narration take (two-pass "
                                  "loudnorm) and generate it again")
    if gain < tl.GAIN_DB_MIN:
        raise FilmTimelineRefused("narration_loudness", f"the narration is {float(lufs):g} LUFS: normalise the "
                                  "narration take and generate it again")
    return {**base, "measured_lufs": float(lufs), "measured_true_peak_db": None if peak is None else float(peak),
            "status": "measured", "gain_db": gain}


# ── the plan ─────────────────────────────────────────────────────────────────

def build_cut(film: Mapping, scenes: Sequence[Mapping], takes: Sequence[Mapping], assets: Mapping[str, Mapping],
              narration: Optional[Mapping] = None, captions: Optional[Sequence[Mapping]] = None,
              *, fps: int = DEFAULT_FPS) -> Cut:
    """The film as one timeline document, or :class:`FilmTimelineRefused`.

    ``film``: ``aspect``, ``resolution``, ``transition_default``, ``captions_mode``, ``music_asset_id``,
    ``music_gain_db``, ``duck_db`` (as in 0166 ``films``). ``scenes``: ``id``, ``position``,
    ``planned_seconds``, ``shot_count``, ``first_frame``, ``transition_in``, ``current_version``,
    ``narration`` (the text; only whether it is empty matters here). ``takes``: rows of 0166
    ``film_takes``. ``assets``: asset id → ``kind``, ``duration_s``, ``width``, ``height`` from the
    library (``media_assets``). ``narration``: ``asset_id`` and ``segments`` [{``scene_id``,
    ``start_s``, ``end_s``}] in the narration file's time. ``captions``: [{``start_s``, ``end_s``,
    ``text``}] in the narration file's time."""
    assets = {_id(k): v for k, v in assets.items()}
    if fps not in FILM_FPS:
        raise FilmTimelineRefused("invalid_film", f"fps must be one of {list(FILM_FPS)}")
    aspect = film.get("aspect") or "16:9"
    if aspect not in SAFE_AREAS:
        raise FilmTimelineRefused("invalid_film", "aspect must be 16:9, 9:16 or 1:1")
    width, height = frame_for(aspect, film.get("resolution"))
    default_tr = film.get("transition_default") or "cut"
    mode = film.get("captions_mode") or "sidecar"
    if default_tr not in TRANSITIONS or mode not in CAPTION_MODES:
        raise FilmTimelineRefused("invalid_film", "transition_default or captions_mode is not one the film allows")

    if not scenes:
        raise FilmTimelineRefused("no_scenes", "the film has no scenes: add at least one")
    if len(scenes) > MAX_SCENES:
        raise FilmTimelineRefused("too_many_scenes", f"a film has at most {MAX_SCENES} scenes")
    positions = [s.get("position") for s in scenes]
    if any(not isinstance(p, int) or isinstance(p, bool) for p in positions) or len(set(positions)) != len(positions):
        raise FilmTimelineRefused("invalid_scene", "every scene needs its own position")
    ordered = sorted(scenes, key=lambda s: s["position"])
    for n, sc in enumerate(ordered, start=1):
        ps, sh = sc.get("planned_seconds"), sc.get("shot_count")
        if not (isinstance(ps, int) and not isinstance(ps, bool) and 3 <= ps <= 30) or sh not in (1, 2, 3):
            raise FilmTimelineRefused("invalid_scene", f"{_scene_label(n)}: planned_seconds 3-30 and 1-3 shots", n)
        if sc.get("transition_in") not in (None,) + TRANSITIONS:
            raise FilmTimelineRefused("invalid_scene", f"{_scene_label(n)}: unknown transition", n)
        if n == 1 and sc.get("first_frame") == "previous":
            raise FilmTimelineRefused("invalid_scene", "scene 1 cannot continue a previous scene", n)

    total_ms = sum(int(s["planned_seconds"]) * 1000 for s in ordered)
    if total_ms > _ms(MAX_FILM_S):
        raise FilmTimelineRefused("film_too_long", f"the film lasts {total_ms // 1000} s; at most {int(MAX_FILM_S)} s")

    # ── picture ──
    chosen = [_chosen_shots(sc, n, takes) for n, sc in enumerate(ordered, start=1)]
    continues = [n > 0 and sc.get("first_frame") == "previous" for n, sc in enumerate(ordered)]
    trans = ["cut" if (n == 0 or continues[n]) else (sc.get("transition_in") or default_tr)
             for n, sc in enumerate(ordered)]
    v_clips: List[dict] = []
    stem: List[dict] = []                       # the shown shots whose own sound goes into the clip stem
    dialogue_ms: List[Tuple[int, int]] = []     # the speech regions of the dialogue scenes that play
    scene_plans: List[dict] = []
    starts: List[int] = []
    cursor = 0
    for n, (sc, shots) in enumerate(zip(ordered, chosen), start=1):
        i = n - 1
        slot = int(sc["planned_seconds"]) * 1000
        if continues[i]:
            prev_last = chosen[i - 1][-1]
            if not prev_last.get("result_last_frame_asset_id") or \
                    _id(shots[0].get("first_frame_asset_id")) != _id(prev_last.get("result_last_frame_asset_id")):
                raise FilmTimelineRefused("continuity_broken", f"{_scene_label(n)} was meant to continue scene {n - 1}'s "
                                          f"last frame, but scene {n - 1} has changed since: re-shoot {_scene_label(n)}", n)
        tr = trans[i]
        head = _ms(CROSSFADE_S) if tr == "crossfade" else 0
        # The scene's shots are one continuous picture: [take, asset, in_ms, usable_ms, offset_ms, chained].
        pieces, offset = [], 0
        for idx, take in enumerate(shots, start=1):
            aid = _id(take["result_asset_id"])
            asset = _video(aid, assets, n, idx, (width, height))
            if idx > 1:
                prev = shots[idx - 2]
                if not prev.get("result_last_frame_asset_id") or \
                        _id(take.get("first_frame_asset_id")) != _id(prev.get("result_last_frame_asset_id")):
                    raise FilmTimelineRefused("continuity_broken", f"{_scene_label(n)} shot {idx} does not start from "
                                              f"shot {idx - 1}'s last frame (shot {idx - 1} was re-shot): re-shoot "
                                              f"shot {idx}", n)
            chained = idx > 1 or continues[i]
            in_ms = _ms(CHAIN_SKIP_S) if chained else 0
            usable = max(0, _ms(asset["duration_s"]) - in_ms)
            pieces.append([take, aid, in_ms, usable, offset, chained])
            offset += usable
        total, need = offset, slot + head
        if total < need:
            raise FilmTimelineRefused("scene_too_short", f"{_scene_label(n)} has {_s(total)} s of footage for "
                                      f"{_s(need)} s on screen: add a shot (extend) or lower its planned seconds", n)
        # Which window of that picture is shown. From its start, unless the next scene continues this one's last
        # frame: then up to its end, so that seam holds. When both seams must hold, only a few frames may give.
        keep_end = i + 1 < len(ordered) and continues[i + 1]
        x = total - need if keep_end else 0
        if keep_end and continues[i] and x > _ms(SEAM_TOLERANCE_S):
            raise FilmTimelineRefused("continuity_trim", f"{_scene_label(n)} continues scene {n - 1} and is continued by "
                                      f"scene {n + 1}, so neither end can be trimmed, but it has {_s(x)} s more footage "
                                      f"than its {slot // 1000} s: shoot its shots {_s(x)} s shorter in all, or stop "
                                      f"scene {n + 1} continuing it", n)
        out_tr = trans[i + 1] if i + 1 < len(ordered) else "cut"
        if not keep_end and out_tr != "cut":
            # The way out (a cross-fade's overlap, a dip's fade) needs a last piece of some length; a sliver of the
            # next shot cannot carry it. Show the window a little later instead, when the scene's start is free.
            last = next(p for p in reversed(pieces) if p[4] < need)
            short = _ms(MIN_PIECE_S) - (need - last[4])
            if short > 0 and last is not pieces[0]:
                if continues[i] or need + short > total:
                    raise FilmTimelineRefused("scene_too_short", f"{_scene_label(n)} ends {_s(need - last[4])} s into "
                                              f"its last shot, too little for the {out_tr.replace('_', ' ')} into scene "
                                              f"{n + 1}: add {_s(short)} s of footage or lower its planned seconds", n)
                x = short
        used = []
        for take, aid, in_ms, usable, off, chained in pieces:
            lo, hi = max(x, off), min(x + need, off + usable)
            if hi > lo:
                used.append((take, aid, in_ms + lo - off, hi - lo, chained))
        start = cursor - head
        shot_plans = []
        role, role_source = _scene_role(sc, [u[0] for u in used], n)
        speaks = False
        for k, (take, aid, in_ms, length, chained) in enumerate(used):
            clip = {"id": f"v{n:02d}_{k + 1}", "asset_id": aid, "start_s": _s(start), "in_s": _s(in_ms),
                    "out_s": _s(in_ms + length), "fit": "cover"}
            # Only a shot the cut shows is checked: an unused take's file plays no part in the film.
            asset, bought = assets[aid], made_with_sound(take)
            if _lip_synced(asset):
                status = "lip-synced"
            else:
                if role != "muted" or bought:
                    _check_sound(asset, n, take["shot_index"], role, bought)
                if role == "muted":
                    status = "no sound in the file" if asset.get("has_audio") is False else "muted"
                else:
                    status = "used"
                    stem.append({"clip": clip["id"], "role": role})
                    speaks = speaks or role == "dialogue"
            if k == 0 and tr == "crossfade":
                clip["transition"] = {"type": "crossfade", "duration_s": CROSSFADE_S}
            elif k == 0 and tr == "dip_to_black":
                clip["transition"] = {"type": "dip_to_black", "duration_s": DIP_S}
            v_clips.append(clip)
            # "sound_paid": the priced sound option was bought for this take; muting it later does not undo the
            # purchase (Atlas, 28 Nov: no refund logic), so the plan says so beside the status.
            shot_plans.append({"take_id": _id(take.get("id")), "shot_index": take["shot_index"], "asset_id": aid,
                               "start_s": _s(start), "in_s": _s(in_ms), "out_s": _s(in_ms + length),
                               "chained": chained, "clip_sound": status, "sound_paid": bought})
            start += length
        if speaks:
            # The lines fall inside the scene, clear of its lead and tail, as a narration segment does; S6's
            # lines[].start_s/end_s will narrow this once a scene carries them.
            dialogue_ms.append((cursor + _ms(NARRATION_LEAD_S), cursor + slot - _ms(NARRATION_TAIL_S)))
        shown = {id(u[0]) for u in used}
        scene_plans.append({"scene_id": _id(sc.get("id")), "number": n, "start_s": _s(cursor),
                            "end_s": _s(cursor + slot), "transition_in": tr, "shots": shot_plans,
                            "sound_role": role, "sound_role_source": role_source,
                            "trimmed_head_s": _s(x), "trimmed_tail_s": _s(total - x - need),
                            "unused_take_ids": [_id(p[0].get("id")) for p in pieces if id(p[0]) not in shown]})
        starts.append(cursor)
        cursor += slot

    # ── narration ──
    narrated = [bool(str(sc.get("narration") or "").strip()) for sc in ordered]
    a_tracks: List[dict] = []
    nar_clips: List[dict] = []
    placed: Dict[str, Tuple[int, int, int]] = {}     # scene id → (file start, file end, film start) in ms
    if narration is None:
        if any(narrated):
            n = narrated.index(True) + 1
            raise FilmTimelineRefused("narration_missing", f"{_scene_label(n)} has narration text but the film has no "
                                      "narration take: generate the narration first", n)
    else:
        naid = _id(narration.get("asset_id"))
        na = assets.get(naid)
        if na is None or na.get("kind") != "audio" or not _num(na.get("duration_s")):
            raise FilmTimelineRefused("narration_missing", "the narration file is not in the library: generate it again")
        file_ms = _ms(na["duration_s"])
        loud = _narration_gain(narration)
        segs = {}
        for seg in narration.get("segments") or []:
            if not (_num(seg.get("start_s")) and _num(seg.get("end_s"))) or seg["end_s"] <= seg["start_s"]:
                raise FilmTimelineRefused("narration_outside_take", "a narration segment ends before it starts")
            segs.setdefault(_id(seg.get("scene_id")), []).append(seg)
        for n, sc in enumerate(ordered, start=1):
            mine = segs.pop(_id(sc.get("id")), [])
            if not narrated[n - 1] and not mine:
                continue
            if len(mine) != 1:
                raise FilmTimelineRefused("narration_segment_missing", f"{_scene_label(n)} needs exactly one narration "
                                          f"segment, it has {len(mine)}: generate the narration again", n)
            a, b = _ms(mine[0]["start_s"]), _ms(mine[0]["end_s"])
            if a < 0 or b > file_ms:
                raise FilmTimelineRefused("narration_outside_take", f"{_scene_label(n)}'s narration segment is outside "
                                          "the narration file: generate the narration again", n)
            slot = int(sc["planned_seconds"]) * 1000
            if _ms(NARRATION_LEAD_S) + (b - a) + _ms(NARRATION_TAIL_S) > slot:
                fit = math.ceil((b - a + _ms(NARRATION_LEAD_S) + _ms(NARRATION_TAIL_S)) / 1000)
                raise FilmTimelineRefused("narration_too_long", f"{_scene_label(n)} narrates {_s(b - a)} s in a "
                                          f"{slot // 1000} s scene: raise its planned seconds to {fit} or shorten "
                                          "its narration", n)
            at = starts[n - 1] + _ms(NARRATION_LEAD_S)
            placed[_id(sc.get("id"))] = (a, b, at)
            if nar_clips and nar_clips[-1]["_offset"] == at - a and at - nar_clips[-1]["_end"] <= _ms(NARRATION_JOIN_S) \
                    and nar_clips[-1]["_scene"] == n - 1:
                # The take runs on the film's clock here: the previous scene's clip simply plays on.
                nar_clips[-1].update(out_s=_s(b), _end=at + b - a, _scene=n)
                continue
            clip = {"id": f"n{n:02d}", "asset_id": naid, "start_s": _s(at), "in_s": _s(a), "out_s": _s(b),
                    "_offset": at - a, "_end": at + b - a, "_scene": n}
            if loud["gain_db"]:
                clip["gain_db"] = loud["gain_db"]
            nar_clips.append(clip)
        nar_clips = [{k: v for k, v in c.items() if not k.startswith("_")} for c in nar_clips]
        if segs:
            raise FilmTimelineRefused("narration_segment_missing", "the narration has segments for scenes that are not "
                                      "in the film: generate the narration again")
        spans = sorted((a, b) for a, b, _at in placed.values())
        if any(spans[k][0] < spans[k - 1][1] for k in range(1, len(spans))):
            # Two scenes would speak the same words.
            raise FilmTimelineRefused("narration_outside_take", "two scenes' narration segments overlap in the "
                                      "narration file: generate the narration again")
        if nar_clips:
            a_tracks.append({"id": "narration", "kind": "A", "role": "speech", "clips": nar_clips})

    # ── music ──
    music_plan = None
    if film.get("music_asset_id"):
        maid = _id(film["music_asset_id"])
        ma = assets.get(maid)
        if ma is None or ma.get("kind") != "audio" or not _num(ma.get("duration_s")) or ma["duration_s"] <= 0:
            raise FilmTimelineRefused("music_unavailable", "the film's music is no longer in the library: choose "
                                      "another track or remove the music")
        gain = float(film["music_gain_db"]) if film.get("music_gain_db") is not None else MUSIC_GAIN_DB_DEFAULT
        duck = float(film["duck_db"]) if film.get("duck_db") is not None else DUCK_DB_DEFAULT
        m_ms = _ms(ma["duration_s"])
        tiles, at = [], 0
        while at < cursor:
            length = min(m_ms, cursor - at)
            last = at + length >= cursor
            fin = min(_ms(MUSIC_FADE_IN_S if at == 0 else MUSIC_JOIN_FADE_S), length // 3)
            fout = min(_ms(MUSIC_END_FADE_S if last else MUSIC_JOIN_FADE_S), length // 3)
            tiles.append({"id": f"m{len(tiles) + 1}", "asset_id": maid, "start_s": _s(at), "in_s": 0.0,
                          "out_s": _s(length), "gain_db": round(gain, 1), "fade_in_s": _s(fin), "fade_out_s": _s(fout)})
            at += length
        track = {"id": "music", "kind": "A", "role": "music", "clips": tiles}
        # Without clip sound this is the rule every film was cut by (its document unchanged); with a dialogue scene
        # the music also has speech to make room for where there is no narration.
        if duck < 0 and (nar_clips or (stem and dialogue_ms)):
            track["duck"] = {"amount_db": round(-duck, 1)}
        a_tracks.append(track)
        music_plan = {"asset_id": maid, "gain_db": round(gain, 1), "duck_db": round(duck, 1) if "duck" in track else 0.0,
                      "tiles": len(tiles), "attack_s": tl.DUCK_DEFAULTS["attack_s"],
                      "release_s": tl.DUCK_DEFAULTS["release_s"]}

    # The clip stem is one input of the mix, whatever the number of shots in it.
    n_audio = sum(len(t["clips"]) for t in a_tracks) + (1 if stem else 0)
    if n_audio > MAX_SOUND_CLIPS:
        raise FilmTimelineRefused("too_many_audio_clips", f"the film needs {n_audio} sound clips; at 1080p the "
                                  f"final pass mixes at most {MAX_SOUND_CLIPS} under the export's memory limit "
                                  "(measured): generate the narration on the film's clock so its scenes join into "
                                  "one clip, or choose a longer music track")

    # ── captions ──
    layout = caption_layout(aspect, width, height)
    film_cues: List[dict] = []
    wants = mode != "none" and bool(nar_clips)
    if wants:
        if not captions:
            raise FilmTimelineRefused("captions_missing", f"captions are set to {mode} but the film has no captions "
                                      "take: generate the captions, or set captions to none")
        order = sorted(placed.values())
        if any(not (isinstance(c, Mapping) and _num(c.get("start_s")) and _num(c.get("end_s"))
                    and isinstance(c.get("text"), str)) for c in captions):
            raise FilmTimelineRefused("invalid_captions", "a caption has no start, end or text: generate the captions again")
        for c in sorted(captions, key=lambda c: (_ms(c["start_s"]), _ms(c["end_s"]), str(c.get("text")))):
            cs, ce = _ms(c["start_s"]), _ms(c["end_s"])
            home = next((p for p in order if p[0] <= cs < p[1]), None)
            if home is None or ce <= cs:
                raise FilmTimelineRefused("caption_outside_narration", f"the caption at {_s(cs)} s of the narration "
                                          "is not inside any scene's narration: generate the captions again")
            a, b, at = home
            lines = wrap_caption(c.get("text") or "", layout["max_chars"])
            if lines is None:
                raise FilmTimelineRefused("caption_too_long", f"the caption at {_s(cs)} s of the narration does not "
                                          f"fit {MAX_CAPTION_LINES} lines of {layout['max_chars']} characters: split it")
            film_cues.append({"start_s": _s(at + cs - a), "end_s": _s(at + min(ce, b) - a), "text": "\n".join(lines)})
        # On the film clock (scenes need not narrate in file order), then numbered.
        film_cues.sort(key=lambda c: (_ms(c["start_s"]), _ms(c["end_s"]), c["text"]))
        film_cues = [{"id": f"c{i:04d}", **c} for i, c in enumerate(film_cues, start=1)]
        for i in range(1, len(film_cues)):           # two cues never share the screen
            if _ms(film_cues[i]["start_s"]) < _ms(film_cues[i - 1]["end_s"]):
                film_cues[i - 1]["end_s"] = film_cues[i]["start_s"]
                if _ms(film_cues[i - 1]["end_s"]) <= _ms(film_cues[i - 1]["start_s"]):
                    raise FilmTimelineRefused("caption_outside_narration", "two captions start at the same moment: "
                                              "generate the captions again")

    doc = {"version": tl.VERSION, "width": width, "height": height, "fps": fps,
           "tracks": [{"id": "picture", "kind": "V", "clips": v_clips}] + a_tracks}
    burn = wants and mode in ("burn", "both")
    if burn:
        doc["captions"] = {"style": {"size": layout["size"], "y": layout["y"], "bold": True,
                                     "outline_width": round(max(2.0, layout["size"] * 0.06), 1)},
                           "cues": film_cues}
    problems = tl.validate(doc)
    if problems:
        # A rule here and the editor's disagree: a bug, never a film to render anyway.
        raise FilmTimelineRefused("invalid_timeline", "; ".join(problems[:3]))
    length = tl.duration_s(tl.normalise(copy.deepcopy(doc)))
    if _ms(length) != cursor:
        raise FilmTimelineRefused("invalid_timeline", f"the document lasts {length} s, the scenes {_s(cursor)} s")

    # ── the clip stem's ducks ──
    sound = None
    clip_plan = None
    if stem:
        gap = _ms(tl.DUCK_DEFAULTS["attack_s"]) + _ms(tl.DUCK_DEFAULTS["release_s"])
        nar_ms = [(_ms(c["start_s"]), _ms(c["start_s"]) + _ms(c["out_s"]) - _ms(c["in_s"])) for c in nar_clips]

        def spans(ms: List[Tuple[int, int]]) -> List[List[float]]:
            return [[_s(a), _s(b)] for a, b in tl.merge_spans(sorted(ms), gap)]

        speech = spans(nar_ms + dialogue_ms)
        music_track = next((t for t in a_tracks if t["id"] == "music"), None)
        music_duck = (music_track or {}).get("duck")
        sound = {"stem": stem, "gain_db": STEM_GAIN_DB,
                 "attack_s": tl.DUCK_DEFAULTS["attack_s"], "release_s": tl.DUCK_DEFAULTS["release_s"],
                 # Atlas, 28 Nov: the ambience is ducked, never muted, under every voice the audience must hear.
                 "ambience_duck_db": STEM_DUCK_DB, "ambience_duck_spans": speech,
                 # A dialogue shot carries its own lines: it only makes room for the narration.
                 "dialogue_duck_db": STEM_DUCK_DB, "dialogue_duck_spans": spans(nar_ms),
                 "music_duck_db": music_duck["amount_db"] if music_duck else 0.0,
                 "music_duck_spans": speech if music_duck else []}
        clip_plan = {"shots": len(stem), "inputs": 1,
                     "dialogue_shots": sum(1 for x in stem if x["role"] == "dialogue"),
                     "ambience_shots": sum(1 for x in stem if x["role"] == "ambience"),
                     "gain_db": STEM_GAIN_DB, "duck_db": STEM_DUCK_DB,
                     "speech_spans": len(speech), "dialogue_regions": len(dialogue_ms)}
    has_sound = bool(stem) or any(t["clips"] for t in a_tracks)
    master = ({"target_lufs": MASTER_LUFS, "target_true_peak_db": MASTER_TRUE_PEAK_DB, "target_lra": MASTER_LRA,
               "method": "two-pass loudnorm on the whole mix, linear where it can be",
               "result": "measured at assembly and recorded on the film's file"}
              if has_sound else "no sound")

    plan = {
        "format": FORMAT_VERSION, "frame": {"width": width, "height": height, "fps": fps, "aspect": aspect},
        "length_s": _s(cursor), "scenes": scene_plans,
        "audio": {
            "narration": ({"asset_id": _id(narration.get("asset_id")), "clips": len(nar_clips),
                           "lead_s": NARRATION_LEAD_S, "loudness": loud} if nar_clips else None),
            "music": music_plan,
            "clip_sound": clip_plan,
            "master_loudness": master,
            "clips": n_audio, "max_clips": MAX_SOUND_CLIPS,
        },
        "captions": {"mode": mode if wants else "none", "cues": len(film_cues), "burned": burn,
                     "sidecar": wants and mode in ("sidecar", "both"), **({"layout": layout} if wants else {})},
    }
    srt = srt_text(film_cues) if wants and mode in ("sidecar", "both") else None
    return Cut(doc=doc, sha256=cut_hash(doc, sound), length_s=_s(cursor), plan=plan, srt=srt, sound=sound)


__all__ = ["CAPTION_MODES", "CHAIN_SKIP_S", "CLIP_SOUND_IN_CUT", "CLIP_SOUND_STATUSES", "CROSSFADE_S", "Cut", "DIP_S", "FORMAT_VERSION",
           "FRAMES", "FilmTimelineRefused", "MASTER_LRA", "MASTER_LUFS", "MASTER_TRUE_PEAK_DB", "MAX_FILM_S",
           "MAX_SCENES", "MAX_SOUND_CLIPS", "REASONS", "SAFE_AREAS", "SOUND_ROLES", "STEM_DUCK_DB", "STEM_GAIN_DB",
           "build_cut", "canonical_json", "caption_layout", "cut_hash", "frame_for", "made_with_sound", "srt_text",
           "wrap_caption"]
