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
* **Sound** — a V clip with ``audio: true`` whose source has a sound track
  becomes an ``AudioTrack`` of that same file (same trim, start and speed,
  ``atempo`` keeping the pitch), first; then every A clip (trim, gain, fades,
  start). All are mixed and cut to the picture's length. A video clip without
  ``audio`` is silent, as before.
* **Text** — T clips in track order, then the captions on top, become text
  overlays burnt from one ASS file.

Pure and deterministic: the same document and the same resolver answers give
the same spec, and so the same ffmpeg argv (tests/test_timeline_render.py pins
a golden one).
"""

from __future__ import annotations

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
        for clip in track["clips"]:  # normalised: sorted by start, no overlaps
            start = _frame(clip["start_s"], fps)
            end = _frame(tl.clip_end_s(clip), fps)
            if end <= start:
                # Validation keeps a clip at least one frame long, but a clip
                # of ~1 frame can still fall between two frame boundaries:
                # there is no frame for it to be shown on.
                continue
            if start > cursor:
                black(start - cursor)
            asset = assets[clip["asset_id"]]
            fade_in, fade_out = fades[clip["id"]]
            segments.append(Segment(
                duration=(end - start) / fps,
                path=asset.path,
                kind=KIND_IMAGE if asset.kind == tl.ASSET_IMAGE else KIND_VIDEO,
                # A still has no time inside it: only video seeks.
                in_s=clip["in_s"] if asset.kind == tl.ASSET_VIDEO else 0.0,
                fit=clip["fit"],
                fade_in_s=fade_in,
                fade_out_s=fade_out,
                speed=clip["speed"] if asset.kind == tl.ASSET_VIDEO else 1.0,
            ))
            cursor = end
    if cursor < total_frames:
        black(total_frames - cursor)
    return segments


def _sound(doc: dict, assets: dict) -> List[AudioTrack]:
    tracks: List[AudioTrack] = []
    for track in doc["tracks"]:
        if track["kind"] != tl.KIND_V:
            continue
        for clip in track["clips"]:
            asset = assets[clip["asset_id"]]
            # Only a source KNOWN to carry sound: an input with no audio
            # stream would make the whole mix fail, and a still has none.
            if not clip["audio"] or asset.kind != tl.ASSET_VIDEO or asset.has_audio is not True:
                continue
            tracks.append(AudioTrack(
                path=asset.path,
                duration_s=round(clip["out_s"] - clip["in_s"], 3),
                start_s=clip["start_s"],
                in_s=clip["in_s"],
                speed=clip["speed"],
            ))
    for track in doc["tracks"]:
        if track["kind"] != tl.KIND_A:
            continue
        for clip in track["clips"]:
            tracks.append(AudioTrack(
                path=assets[clip["asset_id"]].path,
                duration_s=round(clip["out_s"] - clip["in_s"], 3),
                start_s=clip["start_s"],
                in_s=clip["in_s"],
                gain_db=clip["gain_db"],
                fade_in_s=clip["fade_in_s"],
                fade_out_s=clip["fade_out_s"],
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
           jobs: Optional[int] = None) -> str:
    """Render a timeline to ``output_path`` with the ffmpeg backend."""
    from modules import render_backend

    spec = to_render_spec(doc, resolver, output_path)
    return render_backend.render(spec, ffmpeg=ffmpeg, workdir=workdir, jobs=jobs)
