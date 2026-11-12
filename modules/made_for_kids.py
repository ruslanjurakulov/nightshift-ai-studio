"""YouTube's "made for kids" declaration (``status.selfDeclaredMadeForKids``), decided once per video.

Why this exists: every upload used to send ``selfDeclaredMadeForKids: False``, while the product offers a "Kids story"
format (command-center/lib/home.ts), kids looks in the Style Library and kids channels. A video for children declared "not
made for kids" breaks YouTube's policy and COPPA, and the channel pays for it, not the bot. So the declaration is decided
here, from what the run really was, and every path that builds a YouTube ``status`` body takes it from here
(docs/MIGRATIONS.md "0140" lists them).

The rule (the owner's, PR "YouTube made for kids"):

* KIDS CONTENT is a video that comes from the kids format (the run asked for it: the Kids story card or the Create form's
  switch, ``--made-for-kids``), a series whose format names kids, a channel DNA style kit that is a kids look of the
  Style Library made for children only (KIDS_LIBRARY_STYLES), or a channel whose own default (``agent_config.made_for_kids``) is on.
* Kids content is declared made for kids. Anything else is declared what the channel's default says, which is off.
* A person may declare a kids video "not made for kids" only by confirming it in so many words
  (``set_video_made_for_kids`` with ``p_confirm_off``, migration 0140); the database refuses the combination otherwise.
  A kids video declared "not for kids" WITHOUT that confirmation is never sent: the publish gate blocks it
  (``made_for_kids_unconfirmed``), the cross-post refuses it, and the uploader raises rather than send it.

THE ANSWER (the owner's decision on PR #699): before a video is watchable, a PERSON answers "is this video made for kids?" on
its review page, as YouTube Studio asks before publishing. The decision above is the detection: it goes on the private upload
(``selfDeclaredMadeForKids`` is set at insert) and is shown to the person as a hint, never as a chosen answer. Approving needs the
answer (approve_video_publish refuses ``audience_unanswered``, migration 0140); the publish-when-approved write sends it and so
corrects YouTube when it differs; and no run uploads public or unlisted before it (``privacy_until_answered``, the publish gate's
``audience_unanswered``), so auto publish holds the video private until a person has answered.

Declaring made for kids turns off comments, personalised ads, notifications and some other features on that video
(YouTube's rule, not ours); that is why a person may switch it off, and why switching it off on kids content takes a
confirmation and is audited. Nothing here changes privacy, who may publish, or when.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Mapping, Optional

logger = logging.getLogger(__name__)

#: The run-level format id of the Kids story card (command-center/lib/home.ts HOME_FORMATS).
KIDS_FORMAT = "kids"

#: The Style Library looks that are made for children and nothing else (command-center/lib/styles/library.ts). An explicit
#: list, not the "kids" tag: that tag is a browsing filter meaning "good for kids", and it also sits on looks a travel film or
#: a history documentary uses (tilt-shift-miniature, oil-pastel, central-asian-miniature), whose videos must not lose their
#: comments for it (the owner's decision on PR #699). Ids only: the looks live in TypeScript. lib/madeForKids.ts holds the same
#: list and command-center/tests/made-for-kids.test.tsx fails when the two drift or a listed look loses its kids tag.
KIDS_LIBRARY_STYLES = frozenset({
    "cut-paper-collage",
    "claymation-set",
    "felt-and-wool",
    "gouache-storybook",
    "chalk-on-slate",
})

#: Words that make a series' free-text format (content_series.format, 0006) a kids format. Whole words only, so
#: "kidnapping" or "children's rights documentary" in another language does not match by accident of a substring.
_KIDS_WORDS = frozenset({"kids", "kid", "kids'", "children", "childrens", "bolalar", "детей", "детский", "детская",
                         "детские", "дети"})
_WORD = re.compile(r"[\w']+", re.UNICODE)

SOURCE_RUN = "run"
SOURCE_SERIES = "series"
SOURCE_STYLE = "style"
SOURCE_CHANNEL = "channel"
SOURCE_RECORDED = "recorded"

#: The publish gate's block, the cross-post's refusal word and the uploader's error all use this one word.
REFUSAL = "made_for_kids_unconfirmed"
#: The publish gate's block for a video that would be watchable before a person answered who it is for.
UNANSWERED = "audience_unanswered"
#: What a viewer can watch: going there needs a person's answer first.
WATCHABLE = ("public", "unlisted")


def privacy_until_answered(privacy, answered: bool = False):
    """The privacy an upload may have before a person has answered "is this made for kids?" (the owner's decision on PR #699:
    a person's explicit choice, asked as YouTube Studio asks, not an inferred default). Public and unlisted become private until
    then; the detection still goes on the private upload (``selfDeclaredMadeForKids`` is set at insert), the person answers on
    the review page, and the video goes public only through an approval, which needs the answer (approve_video_publish, 0140)."""
    if not answered and str(privacy or "").strip().lower() in WATCHABLE:
        return "private"
    return privacy


class MadeForKidsUnconfirmed(ValueError):
    """A kids video declared "not made for kids" without a person's confirmation. Never sent to YouTube."""


@dataclass(frozen=True)
class Decision:
    """What one video declares, and why.

    ``value`` is what ``selfDeclaredMadeForKids`` gets. ``kids_content`` says the video is kids content by one of the
    sources above (``sources`` names them). ``confirmed_off`` is true only when a person confirmed "not made for kids" on
    kids content."""

    value: bool
    kids_content: bool
    sources: tuple = ()
    confirmed_off: bool = False

    @property
    def refused(self) -> bool:
        """Kids content declared "not for kids" with nobody's confirmation: may not be sent."""
        return self.kids_content and not self.value and not self.confirmed_off

    def to_metadata(self) -> dict:
        return {"made_for_kids": self.value, "kids_content": self.kids_content, "sources": list(self.sources),
                "confirmed_off": self.confirmed_off}


def channel_default(channel) -> bool:
    """The channel's own default: ``agent_config.made_for_kids``. Only an explicit true is on (AgentConfig.from_dict)."""
    agent = getattr(channel, "agent", None)
    return getattr(agent, "made_for_kids", False) is True


def words_name_kids(text) -> bool:
    if not isinstance(text, str) or not text.strip():
        return False
    return any(w in _KIDS_WORDS for w in _WORD.findall(text.lower()))


def series_is_kids(series) -> bool:
    """A series whose format (free text, 0006) or content type names kids."""
    if series is None:
        return False
    return words_name_kids(getattr(series, "format", "")) or words_name_kids(getattr(series, "content_type", ""))


def style_is_kids(library_id) -> bool:
    return isinstance(library_id, str) and library_id.strip().lower() in KIDS_LIBRARY_STYLES


def decide(channel=None, *, series=None, run_made_for_kids: bool = False, style_library_id: str = "") -> Decision:
    """The declaration for the video a run is about to make. Kids content by any source is made for kids; a run cannot
    declare kids content "not for kids" (only a person can, per video, with a confirmation)."""
    sources = []
    if run_made_for_kids is True:
        sources.append(SOURCE_RUN)
    if series_is_kids(series):
        sources.append(SOURCE_SERIES)
    if style_is_kids(style_library_id):
        sources.append(SOURCE_STYLE)
    if channel_default(channel):
        sources.append(SOURCE_CHANNEL)
    kids = bool(sources)
    return Decision(value=kids, kids_content=kids, sources=tuple(sources))


def for_video(row: Optional[Mapping], channel=None) -> Decision:
    """The declaration for a video that already exists (a cross-post of it, making it public), from its ``videos`` row
    (migration 0140: made_for_kids, kids_content, made_for_kids_off_by) and the channel it goes to.

    A row without the columns (written before 0140, or a database without it) has nothing recorded: the video is then
    kids content only if the channel says so, and declared as the channel's default."""
    row = row if isinstance(row, Mapping) else {}
    sources = []
    if row.get("kids_content") is True:
        sources.append(SOURCE_RECORDED)
    if channel_default(channel):
        sources.append(SOURCE_CHANNEL)
    kids = bool(sources)
    recorded = row.get("made_for_kids")
    if isinstance(recorded, bool):
        confirmed = recorded is False and bool(row.get("made_for_kids_off_by"))
        return Decision(value=recorded, kids_content=kids, sources=tuple(sources), confirmed_off=confirmed)
    return Decision(value=kids, kids_content=kids, sources=tuple(sources))


def declared(made_for_kids, channel=None) -> bool:
    """What ``selfDeclaredMadeForKids`` is set to in a body. A ``Decision`` gives its value; a bare boolean is taken as
    it is; None (a caller that decided nothing) falls back to the channel's default, never to a constant False.

    Raises ``MadeForKidsUnconfirmed`` for a refused decision, and for a bare False on a channel whose default is made
    for kids: the last line before YouTube never sends "not for kids" for kids content nobody confirmed."""
    if isinstance(made_for_kids, Decision):
        if made_for_kids.refused:
            raise MadeForKidsUnconfirmed(
                "this video is kids content and nobody confirmed it is not made for kids: declare it made for kids, "
                "or confirm 'not made for kids' on the video's review page")
        return made_for_kids.value
    if isinstance(made_for_kids, bool):
        if made_for_kids is False and channel_default(channel):
            raise MadeForKidsUnconfirmed(
                "the channel is made for kids and this upload asked for 'not made for kids' without a decision behind it")
        return made_for_kids
    return channel_default(channel)


class MadeForKidsUnknown(RuntimeError):
    """The run names a look whose kids tag could not be read. The run stops before anything is spent: a guess here is a
    kids video declared "not for kids", or a documentary with its comments switched off."""


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def style_kit_library_id(ctx, sync=None) -> str:
    """The Style Library id of the channel DNA's style kit (``style_kits.library_id``, 0065), "" when the channel names no
    kit or the kit was made from pictures. Raises ``MadeForKidsUnknown`` when a kit is named and cannot be read."""
    kit = str(getattr(getattr(ctx, "dna", None), "style_kit_id", "") or "").lower()
    if not _UUID.match(kit):
        return ""
    org = str(getattr(ctx, "org_id", "") or "").lower()
    if sync is None:
        from modules.supabase_sync import SupabaseSync  # noqa: PLC0415

        sync = SupabaseSync()
    if not getattr(sync, "enabled", False) or not _UUID.match(org):
        raise MadeForKidsUnknown("the channel names a style kit, but this deployment cannot read style kits; set "
                                 "SUPABASE_URL and SUPABASE_SERVICE_KEY for the run, or clear the kit")
    from modules.supabase_sync import SupabaseReadError  # noqa: PLC0415

    try:
        rows = sync.select_strict("style_kits", {"select": "id,org_id,library_id", "id": f"eq.{kit}",
                                                 "org_id": f"eq.{org}"})
    except SupabaseReadError as e:
        raise MadeForKidsUnknown(f"the channel's style kit could not be read ({e.detail}); re-run, and if it repeats "
                                 "check the Supabase project is reachable") from None
    for row in rows or []:
        if isinstance(row, Mapping) and str(row.get("id") or "").lower() == kit:
            lib = row.get("library_id")
            return lib.strip().lower() if isinstance(lib, str) else ""
    # Not the organization's kit (or gone): Stage 0d refuses that when the run generates pictures; here it is no look.
    return ""
