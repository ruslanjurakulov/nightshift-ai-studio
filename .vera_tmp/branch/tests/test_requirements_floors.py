"""Dependency floors (BR-S-006): no requirements file admits a release with a
known advisory for the packages that handle untrusted input.

``requirements.txt`` has floors only (no lockfile), and ``Pillow>=10.0.0`` /
``requests>=2.31.0`` admitted releases with published CVEs: Pillow decodes user
uploads in the media worker, requests fetches provider responses. A resolver
that reuses a cache, or a constraint elsewhere, could land on one of them.

The minimums below are the first releases with no known advisory according to
``pip-audit`` on 2026-10-01. Raise them (never lower them) when a new advisory
lands.

Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = (ROOT / "requirements.txt", ROOT / "tests" / "security" / "requirements.txt")

MINIMUMS = {
    "pillow": (12, 3, 0),
    "requests": (2, 33, 0),
}

LINE = re.compile(r"^\s*([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*([^;#]*)")


def _version(text: str):
    parts = [int(x) for x in re.findall(r"\d+", text)[:3]]
    return tuple(parts + [0] * (3 - len(parts)))


def floors(path: Path):
    """{normalized name: (operator spec string)} for each requirement line."""
    out = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = LINE.match(line)
        if m:
            out[m.group(1).lower().replace("_", "-")] = m.group(2).strip()
    return out


def lowest_allowed(spec: str):
    """The lowest version a spec admits, from its `>=` or `==` clause; None if
    the spec has no lower bound (which admits every vulnerable release)."""
    for clause in (c.strip() for c in spec.split(",")):
        if clause.startswith(">=") or clause.startswith("=="):
            return _version(clause[2:])
    return None


class RequirementFloorsTest(unittest.TestCase):
    def test_floors_exclude_known_vulnerable_releases(self):
        checked = 0
        for path in FILES:
            reqs = floors(path)
            for name, minimum in MINIMUMS.items():
                if name not in reqs:
                    continue
                checked += 1
                with self.subTest(file=path.name, package=name):
                    low = lowest_allowed(reqs[name])
                    self.assertIsNotNone(low, f"{path}: {name} has no lower bound")
                    self.assertGreaterEqual(
                        low, minimum,
                        f"{path}: {name}{reqs[name]} admits a release with a known advisory; "
                        f"floor must be >= {'.'.join(map(str, minimum))}",
                    )
        # requirements.txt holds both; the lab file holds Pillow.
        self.assertGreaterEqual(checked, 3)

    def test_the_parser_sees_an_old_floor(self):
        # Positive control: the old floors would fail.
        self.assertLess(lowest_allowed(">=10.0.0"), MINIMUMS["pillow"])
        self.assertLess(lowest_allowed(">=2.31.0"), MINIMUMS["requests"])
        self.assertIsNone(lowest_allowed("<2"))
        self.assertEqual(lowest_allowed(">=0.20.0,<2"), (0, 20, 0))


if __name__ == "__main__":
    unittest.main()
