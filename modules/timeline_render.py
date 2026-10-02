"""Timeline → RenderSpec: render a studio timeline with the existing engine.

The Creative OS plan (§3.6) is explicit: a timeline is rendered by the ffmpeg
backend the pipeline already uses (``render_spec`` + ``render_backend``),
extended backwards-compatibly, not by a second renderer. This module is the
adapter: it validates and normalises a timeline (``modules/timeline.py``),
resolves its asset ids through the caller's resolver, and lays the result out
as a declarative :class:`~modules.render_spec.RenderSpec`.

How a timeline maps onto the spec:

* **Picture** — the one V track, on the frame grid (``round(t * fps)``): each
  clip becomes a segment (``in_s`` trim, ``fit``, fades from its own fades and
  ``dip_to_black`` transitions); every gap, and the tail up to the end of the
  timeline, becomes a black segment. ``frame_exact`` is on, so each segment is
  exactly its frames and the concatenation is exactly the timeline.
* **Speed** — a V clip's ``speed`` becomes the segment's (``setpts``): its
  slot on the frame grid is already the sped-up length, and the source range
  ``in_s``..``out_s`` fills it.
* **Cross-fade** — two V clips that overlap by a ``crossfade`` transition
  become: the first clip's own part, ONE segment of the overlap that holds
  both pictures (``Segment.xfade``; the backend blends them with ffmpeg
  ``xfade``), then the second clip's own part. Each piece is rendered over
  its whole clip and cut (``clip_s`` / ``offset_s``), so fades and a still's
  slow zoom carry on across the cut. The concatenation is still exactly the
  timeline's frames. When both clips play their own sound, the two sounds
  are joined with ``acrossfade`` (``AudioTrack.crossfade_s``); when only one
  does, it fades in or out across the overlap.
* **Sound** — a V clip with ``audio: true`` whose source has a sound track
  becomes an ``AudioTrack`` of that same file (same trim, start and speed,
  ``atempo`` keeping the pitch), first; then every A clip (trim, gain, fades,
  start). All are mixed and cut to the picture's length. A video clip without
  ``audio`` is silent, as before.
* **Ducking** — an A track with ``duck`` gets, on each of its clips, the
  speech spans that can touch it (V clips whose source is KNOWN to carry
  sound and play it, and every clip of an A track with ``role: "speech"``),
  merged across pauses too short for the music to come back up; the backend
  turns them into one ``volume`` envelope (``render_spec.duck_expression``).
  Speech that is not there (a silent source) ducks nothing, and a clip no
  speech can touch gets no envelope at all, so its argv is the one it had
  before ducking existed.
* **Text** — T clips in track order, then the captions on top, become text
  overlays burnt from one ASS file.

Pure and deterministic: the same document and the same resolver answers give
the same spec, and so the same ffmpeg argv (tests/test_timeline_render.py pins
a golden one).
"""

from __future__ import annotations

from dataclasses import replace
from typing import List, Optional, Union

from modules import timeline as tl
from modules.render_spec import (
    KIND_COLOR,
    KIND_IMAGE,
    KIND_VIDEO,
    AudioTrack,
    RenderSpec,
    Segment,
    TextOverlay,
)


def _frame(t: float, fps: int) -> int:
    return int(round(float(t) * fps))


def _crossfade_frames(clips: List[dict], fps: int) -> dict:
    """Clip index → how many frames of its head are its cross-fade from the
    clip before (on the frame grid: the previous clip's last frame minus this
    one's first). Validation keeps every cross-fade at least 0.2 s, so this is
    always several frames."""
    out = {}
    for i in range(1, len(clips)):
        if tl.crossfade_s(clips[i]) > 0:
            n = _frame(tl.clip_end_s(clips[i - 1]), fps) - _frame(clips[i]["start_s"], fps)
            if n >= 1:
                out[i] = n
    return out


def _picture(doc: dict, assets: dict, total_frames: int) -> List[Segment]:
    fps = doc["fps"]
    segments: List[Segment] = []

    def black(frames: int) -> None:
        segments.append(Segment(duration=frames / fps, path=None, kind=KIND_COLOR))

    cursor = 0
    for track in doc["tracks"]:
        if track["kind"] != tl.KIND_V:
            continue
        fades = tl.effective_fades(track)
        clips = track["clips"]  # normalised: sorted by start; only cross-fades overlap
        xin = _crossfade_frames(clips, fps)

        def piece(clip: dict, frames: int, *, full: int = 0, offset: int = 0,
                  seed: str = "") -> Segment:
            asset = assets[clip["asset_id"]]
            fade_in, fade_out = fades[clip["id"]]
            return Segment(
                duration=frames / fps,
                path=asset.path,
                kind=KIND_IMAGE if asset.kind == tl.ASSET_IMAGE else KIND_VIDEO,
                # A still has no time inside it: only video seeks.
                in_s=clip["in_s"] if asset.kind == tl.ASSET_VIDEO else 0.0,
                fit=clip["fit"],
                fade_in_s=fade_in,
                fade_out_s=fade_out,
                speed=clip["speed"] if asset.kind == tl.ASSET_VIDEO else 1.0,
                clip_s=full / fps if full else 0.0,
                offset_s=offset / fps,
                seed=seed,
            )

        for i, clip in enumerate(clips):
            start = _frame(clip["start_s"], fps)
            end = _frame(tl.clip_end_s(clip), fps)
            if end <= start:
                # Validation keeps a clip at least one frame long, but a clip
                # of ~1 frame can still fall between two frame boundaries:
                # there is no frame for it to be shown on.
                continue
            head, tail = xin.get(i, 0), xin.get(i + 1, 0)
            if not head and not tail:
                # No cross-fade touches this clip: exactly the segment a
                # timeline always rendered (older documents' argv is pinned).
                if start > cursor:
                    black(start - cursor)
                segments.append(piece(clip, end - start))
                cursor = end
                continue
            # A cross-faded clip is cut into its pieces on the frame grid: the
            # part only it shows, then the dissolve into the next clip as ONE
            # segment that holds both pictures (render_backend blends them
            # with xfade). Every piece is rendered over the whole clip — fades,
            # a still's slow zoom — and cut, so nothing restarts at a cut.
            full = end - start
            seed = f"clip:{clip['id']}"
            if not head and start > cursor:
                black(start - cursor)
            solo = full - head - tail
            if solo > 0:
                segments.append(piece(clip, solo, full=full, offset=head, seed=seed))
            if tail:
                nxt = clips[i + 1]
                n_full = _frame(tl.clip_end_s(nxt), fps) - _frame(nxt["start_s"], fps)
                incoming = piece(nxt, tail, full=n_full, seed=f"clip:{nxt['id']}")
                segments.append(replace(piece(clip, tail, full=full, offset=full - tail, seed=seed),
                                        xfade=incoming))
            cursor = end
    if cursor < total_frames:
        black(total_frames - cursor)
    return segments


def _sound(doc: dict, assets: dict) -> List[AudioTrack]:
    tracks: List[AudioTrack] = []
    for track in doc["tracks"]:
        if track["kind"] != tl.KIND_V:
            continue
        clips = track["clips"]

        def sounding(i: int) -> bool:
            # Only a source KNOWN to carry sound: an input with no audio
            # stream would make the whole mix fail, and a still has none.
            if not 0 <= i < len(clips):
                return False
            asset = assets[clips[i]["asset_id"]]
            return bool(clips[i]["audio"]) and asset.kind == tl.ASSET_VIDEO and asset.has_audio is True

        for i, clip in enumerate(clips):
            if not sounding(i):
                continue
            d_in = tl.crossfade_s(clip) if i > 0 else 0.0
            d_out = tl.crossfade_s(clips[i + 1]) if i + 1 < len(clips) else 0.0
            # Both clips sound: their sounds are joined with acrossfade. Only
            # one does: it fades in (or out) under the silent picture instead.
            joined = d_in > 0 and sounding(i - 1)
            tracks.append(AudioTrack(
                path=assets[clip["asset_id"]].path,
                duration_s=round(clip["out_s"] - clip["in_s"], 3),
                start_s=clip["start_s"],
                in_s=clip["in_s"],
                speed=clip["speed"],
                fade_in_s=d_in if d_in > 0 and not joined else 0.0,
                fade_out_s=d_out if d_out > 0 and not sounding(i + 1) else 0.0,
                crossfade_s=d_in if joined else 0.0,
            ))
    def speaks(clip: dict) -> bool:
        asset = assets[clip["asset_id"]]
        return asset.kind == tl.ASSET_VIDEO and asset.has_audio is True

    speech = tl.speech_spans(doc, speaks)
    for track in doc["tracks"]:
        if track["kind"] != tl.KIND_A:
            continue
        duck = track.get("duck")
        merged = (tl.merge_spans(speech, duck["attack_s"] + duck["release_s"])
                  if duck and speech else [])
        for clip in track["clips"]:
            extra = {}
            if merged:
                first, last = clip["start_s"], tl.clip_end_s(clip)
                near = tuple((a, b) for a, b in merged
                             if a - duck["attack_s"] < last and b + duck["release_s"] > first)
                if near:
                    extra = {"duck_db": duck["amount_db"], "duck_attack_s": duck["attack_s"],
                             "duck_release_s": duck["release_s"], "duck_spans": near}
            tracks.append(AudioTrack(
                path=assets[clip["asset_id"]].path,
                duration_s=round(clip["out_s"] - clip["in_s"], 3),
                start_s=clip["start_s"],
                in_s=clip["in_s"],
                gain_db=clip["gain_db"],
                fade_in_s=clip["fade_in_s"],
                fade_out_s=clip["fade_out_s"],
                **extra,
            ))
    return tracks


def _text(doc: dict) -> List[TextOverlay]:
    overlays: List[TextOverlay] = []
    for track in doc["tracks"]:
        if track["kind"] != tl.KIND_T:
            continue
        for c in track["clips"]:
            overlays.append(TextOverlay(
                start_s=c["start_s"], end_s=c["end_s"], text=c["text"], font=c["font"],
                size=c["size"], color=c["color"], outline_color=c["outline_color"],
                outline_width=c["outline_width"], bold=c["bold"], x=c["x"], y=c["y"],
                anchor=c["anchor"], fade_in_s=c["fade_in_s"], fade_out_s=c["fade_out_s"],
            ))
    captions = doc.get("captions")
    if captions:
        st = captions["style"]
        for cue in captions["cues"]:
            # Bottom-centre anchored at the style's height: a two-line caption
            # grows upward instead of running off the frame.
            overlays.append(TextOverlay(
                start_s=cue["start_s"], end_s=cue["end_s"], text=cue["text"], font=st["font"],
                size=st["size"], color=st["color"], outline_color=st["outline_color"],
                outline_width=st["outline_width"], bold=st["bold"], x=0.5, y=st["y"],
                anchor="bottom",
            ))
    return overlays


def to_render_spec(doc: Union[str, bytes, dict], resolver: tl.AssetResolver,
                   output_path: str) -> RenderSpec:
    """The RenderSpec for a timeline. Raises :class:`timeline.TimelineError`
    when the document is invalid or an asset cannot be used — before anything
    is rendered or spent."""
    norm = tl.load(doc)
    assets = tl.resolve_assets(norm, resolver)
    fps = norm["fps"]
    total_frames = _frame(tl.duration_s(norm), fps)
    if total_frames < 1:
        raise tl.TimelineError(["timeline: shorter than one frame — nothing to render"])
    return RenderSpec(
        output_path=str(output_path),
        width=norm["width"],
        height=norm["height"],
        fps=fps,
        segments=_picture(norm, assets, total_frames),
        frame_exact=True,
        audio_tracks=_sound(norm, assets),
        overlays=_text(norm),
    )


def render(doc: Union[str, bytes, dict], resolver: tl.AssetResolver, output_path: str, *,
           ffmpeg: Optional[str] = None, workdir: Optional[str] = None,
           jobs: Optional[int] = None, timeout_s: Optional[float] = None) -> str:
    """Render a timeline to ``output_path`` with the ffmpeg backend.
    ``timeout_s`` bounds the whole render's wall time (render_backend kills
    the ffmpeg running when it runs out and raises RenderTimeout)."""
    from modules import render_backend

    spec = to_render_spec(doc, resolver, output_path)
    if timeout_s is None:
        return render_backend.render(spec, ffmpeg=ffmpeg, workdir=workdir, jobs=jobs)
    return render_backend.render(spec, ffmpeg=ffmpeg, workdir=workdir, jobs=jobs,
                                 timeout_s=timeout_s)
