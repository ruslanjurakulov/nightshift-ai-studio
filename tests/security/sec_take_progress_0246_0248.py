"""Security-lab contract for migrations 0246 (a running take's vendor percent and status word, the assembly's percent) and 0248
(typical take durations). One hook wires it in, at the bottom of sec_expectations.py. The writers and the reader are attacked in
tests/security/test_sec_take_progress_0246_0248.py (against the money lab's database)."""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # The film worker's, the service role only; they write only for the worker that holds the segment.
        "film_take_progress": SERVICE,
        "film_segment_assembly_progress": SERVICE,
        # A signed-in member's read; it answers only a member of the film's organization (not_found otherwise).
        "film_take_typical_seconds": USER,
    })
