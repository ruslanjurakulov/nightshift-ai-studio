"""Style kits and @characters (migrations 0047 / 0048) in a creative job's
provider request — the pure half the creative worker calls.

A job may name one of its organization's style kits (``params.style_kit_id``)
and its prompt may mention the organization's characters by ``@name``. The
database checked the kit when the job was priced; right before the paid call
the worker asks again (``creative_job_style``, for the job it holds, in the
JOB's organization) and gets each kit / character with its description and
its usable reference images. This module turns that answer into the request:

* the answer is checked once more in code: every kit, character and
  reference must carry the job's organization, the kit must be the one the
  job names, and a character must be one the prompt actually mentions. An
  answer that breaks any of it is refused whole — another organization's
  file is never sent, not even alongside the right ones;
* descriptions are appended to the prompt between clear markers; the prompt
  the person typed is kept as typed (an unknown ``@name`` stays as it is);
* reference images go only to an adapter that declares it takes them for the
  capability (``HttpAdapter.reference_capabilities``), only as many as the
  model's registry entry allows beside the job's own source picture;
* a kit or character that would contribute nothing (no description, and the
  model takes none of its pictures) fails the job rather than being quietly
  dropped (CLAUDE.md #4) — as does a prompt the descriptions make longer than
  the model accepts.

Nothing here logs; messages name no path, no prompt text and no other
organization's id.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

#: Capabilities a look can steer (0048 creative_params_problem: style_kit_id).
STYLE_CAPABILITIES = frozenset({"t2i", "t2v", "edit", "i2v"})
#: At most this many distinct @names are looked up per prompt (0048 does the same).
MAX_MENTIONS = 16
#: '@' not preceded by a letter, digit, '_' or '@' (so me@site.io is not a
#: mention), 2-32 name characters, not followed by another. The SQL in 0048
#: creative_job_style uses the same pattern; tests pin that they agree.
MENTION_RE = re.compile(r"(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_NAME_RE = re.compile(r"^[a-z0-9_]{2,32}$")

GUIDE_START = "[Style guide]"
GUIDE_END = "[End of style guide]"


class StyleProblem(Exception):
    """The style cannot be applied; the message is safe to store and show."""


@dataclass(frozen=True)
class StyleRef:
    asset_id: str
    mime: str
    variants: Tuple[str, ...]


@dataclass(frozen=True)
class StyleOwner:
    """A kit (``name`` None) or a character, with its references in order."""
    id: str
    name: Optional[str]
    description: str
    references: Tuple[StyleRef, ...]


@dataclass(frozen=True)
class StyleInputs:
    kit: Optional[StyleOwner]
    characters: Tuple[StyleOwner, ...]

    @property
    def empty(self) -> bool:
        return self.kit is None and not self.characters


@dataclass(frozen=True)
class StyleSupport:
    """What the job's model can take: reference pictures beside the job's own
    inputs (0 = none), and the longest prompt (None = not known here)."""
    reference_slots: int = 0
    max_prompt_chars: Optional[int] = None


def mentions(prompt: str) -> List[str]:
    """The distinct @names in ``prompt``, lower-cased, in order of first mention."""
    out: List[str] = []
    for m in MENTION_RE.finditer(prompt or ""):
        name = m.group(1).lower()
        if name not in out:
            out.append(name)
            if len(out) >= MAX_MENTIONS:
                break
    return out


def wants_style(capability: str, params: Mapping[str, Any]) -> bool:
    """Whether the job asks for anything this module resolves."""
    if capability not in STYLE_CAPABILITIES:
        return False
    return bool(params.get("style_kit_id")) or bool(mentions(str(params.get("prompt") or "")))


def prompt_units(text: str) -> int:
    """Length as the registry counts it (UTF-16 code units, model_registry.prompt_units)."""
    return len((text or "").encode("utf-16-le")) // 2


def _uuid(v: Any) -> Optional[str]:
    s = str(v or "").lower()
    return s if _UUID_RE.match(s) else None


def _refs(raw: Any, org_id: str) -> Tuple[StyleRef, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise StyleProblem("the style answer could not be read")
    out = []
    for r in raw:
        if not isinstance(r, Mapping):
            raise StyleProblem("the style answer could not be read")
        aid = _uuid(r.get("asset_id"))
        if aid is None:
            raise StyleProblem("the style answer could not be read")
        if _uuid(r.get("org_id")) != org_id:
            raise StyleProblem("a reference picture is not this organization's")
        variants = r.get("variants") or []
        out.append(StyleRef(aid, str(r.get("mime") or ""),
                            tuple(str(v) for v in variants) if isinstance(variants, list) else ()))
    return tuple(out)


def _description(v: Any) -> str:
    return v if isinstance(v, str) else ""


def parse_answer(info: Mapping[str, Any], *, org_id: str, kit_id: Optional[str], prompt: str) -> StyleInputs:
    """``creative_job_style``'s answer, checked against the job (module doc).
    Raises :class:`StyleProblem` on anything that is not exactly the job's
    own organization's kit and mentioned characters."""
    org = _uuid(org_id)
    if org is None or _uuid(info.get("org_id")) != org:
        raise StyleProblem("the style answer is not for this job's organization")
    want_kit = _uuid(kit_id) if kit_id else None
    if kit_id and want_kit is None:
        raise StyleProblem("the style kit id is not valid")

    kit = None
    raw_kit = info.get("kit")
    if want_kit:
        if not isinstance(raw_kit, Mapping):
            raise StyleProblem("the style kit is no longer in this organization")
        if _uuid(raw_kit.get("id")) != want_kit or _uuid(raw_kit.get("org_id")) != org:
            raise StyleProblem("the style answer names another kit")
        kit = StyleOwner(want_kit, None, _description(raw_kit.get("description")), _refs(raw_kit.get("references"), org))
    elif raw_kit is not None:
        raise StyleProblem("the style answer names a kit the job did not ask for")

    asked = mentions(prompt)
    raw_chars = info.get("characters") or []
    if not isinstance(raw_chars, list):
        raise StyleProblem("the style answer could not be read")
    chars: Dict[str, StyleOwner] = {}
    for c in raw_chars:
        if not isinstance(c, Mapping):
            raise StyleProblem("the style answer could not be read")
        cid = _uuid(c.get("id"))
        name = str(c.get("name") or "")
        if cid is None or not _NAME_RE.match(name):
            raise StyleProblem("the style answer could not be read")
        if _uuid(c.get("org_id")) != org:
            raise StyleProblem("a character is not this organization's")
        if name not in asked:
            raise StyleProblem("the style answer names a character the prompt does not mention")
        if name in chars:
            raise StyleProblem("the style answer names a character twice")
        chars[name] = StyleOwner(cid, name, _description(c.get("description")), _refs(c.get("references"), org))
    # In the order the prompt mentions them.
    ordered = tuple(chars[n] for n in asked if n in chars)
    return StyleInputs(kit, ordered)


def pick_references(inputs: StyleInputs, slots: int) -> List[Tuple[StyleOwner, StyleRef]]:
    """Up to ``slots`` references, taken in turns — each character (in order of
    mention) and then the kit gives its first picture before anyone gives a
    second — so a small model still sees every subject at least once."""
    if slots <= 0:
        return []
    groups = [o for o in (*inputs.characters, *((inputs.kit,) if inputs.kit else ())) if o.references]
    out: List[Tuple[StyleOwner, StyleRef]] = []
    seen = set()
    depth = 0
    while len(out) < slots and any(depth < len(g.references) for g in groups):
        for g in groups:
            if depth < len(g.references) and len(out) < slots:
                ref = g.references[depth]
                if ref.asset_id not in seen:  # a picture shared by two owners goes once
                    seen.add(ref.asset_id)
                    out.append((g, ref))
        depth += 1
    return out


def _flat(text: str) -> str:
    # One line per entry keeps the markers unambiguous whatever was typed.
    return " ".join((text or "").split())


def compose_prompt(prompt: str, inputs: StyleInputs, picked: Sequence[Tuple[StyleOwner, StyleRef]]) -> str:
    """The prompt as typed, then the style guide: the kit's look and each
    mentioned character's description, between markers. An owner without a
    description but with pictures sent is pointed at its pictures."""
    if inputs.empty:
        return prompt
    with_pictures = {o.id for o, _ in picked}
    lines = []
    if inputs.kit is not None:
        desc = _flat(inputs.kit.description)
        if desc:
            lines.append(f"Look: {desc}")
        elif inputs.kit.id in with_pictures:
            lines.append("Look: match the style of the reference pictures")
    for c in inputs.characters:
        desc = _flat(c.description)
        if desc:
            lines.append(f"@{c.name}: {desc}")
        elif c.id in with_pictures:
            lines.append(f"@{c.name}: as shown in the reference pictures")
    if not lines:
        return prompt
    guide = "\n".join([GUIDE_START, *lines, GUIDE_END])
    base = (prompt or "").rstrip()
    return f"{base}\n\n{guide}" if base.strip() else guide


def unusable(inputs: StyleInputs, picked: Sequence[Tuple[StyleOwner, StyleRef]]) -> List[str]:
    """What was asked for but would reach the provider as nothing at all."""
    with_pictures = {o.id for o, _ in picked}
    out = []
    if inputs.kit is not None and not _flat(inputs.kit.description) and inputs.kit.id not in with_pictures:
        out.append("the style kit")
    for c in inputs.characters:
        if not _flat(c.description) and c.id not in with_pictures:
            out.append(f"@{c.name}")
    return out


def summary(inputs: StyleInputs, picked: Sequence[Tuple[StyleOwner, StyleRef]]) -> Dict[str, Any]:
    """What the job's result records about the style it used — counts, never text."""
    return {"style_kit": inputs.kit is not None, "characters": len(inputs.characters),
            "references": len(picked)}
