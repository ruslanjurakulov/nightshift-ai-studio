"""Bounded PostgREST ``in.(...)`` filters.

An id list goes into the request URL. A few thousand uuids make that URL longer than
the proxy in front of Supabase accepts, and the read or update then fails with a
status that says nothing about the real cause. Callers split the list here instead of
trusting that it stays short.
"""
from __future__ import annotations

from typing import Callable, Iterable, Iterator, List, Optional, Sequence

#: 100 uuids is ~3.7 kB of URL: well under the ~8 kB common proxy limit even with
#: the other query parameters beside it.
CHUNK_SIZE = 100


def chunk_ids(ids: Iterable, size: int = CHUNK_SIZE) -> List[List[str]]:
    """The ids as lists of at most ``size``, in order. Empty input gives no chunk at all,
    so a caller that loops over the result never issues a request for nothing."""
    if size < 1:
        raise ValueError("chunk size must be at least 1")
    flat = [str(i) for i in ids]
    return [flat[i:i + size] for i in range(0, len(flat), size)]


def in_filters(ids: Iterable, size: int = CHUNK_SIZE) -> Iterator[str]:
    """One ``in.(a,b,c)`` filter value per chunk."""
    for chunk in chunk_ids(ids, size):
        yield "in.(" + ",".join(chunk) + ")"


def select_in(ids: Iterable, read: Callable[[str], Optional[Sequence]], size: int = CHUNK_SIZE) -> list:
    """Call ``read(filter_value)`` once per chunk and concatenate the rows in chunk order
    (so rows keep the order of the ids when the caller sorts by them). No ids, no call.
    An exception from ``read`` propagates: a half-read list must not look complete."""
    rows: list = []
    for flt in in_filters(ids, size):
        rows.extend(read(flt) or [])
    return rows


def update_in(ids: Iterable, update: Callable[[str], bool], size: int = CHUNK_SIZE) -> bool:
    """Call ``update(filter_value)`` once per chunk; True only if every call said True.
    Every chunk is attempted even after a failure, so one bad chunk does not leave the
    rest of the ids untouched. No ids: False, because nothing was done."""
    results = [bool(update(flt)) for flt in in_filters(ids, size)]
    return bool(results) and all(results)
