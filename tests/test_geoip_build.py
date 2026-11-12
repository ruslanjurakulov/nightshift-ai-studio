"""tools/geoip_build.py — DB-IP's country CSV into the table the web process reads (docs/GEO_BLOCK.md).

What would break without these: a range dropped or a code moved by the conversion (a country read as another one, so a model is
shown where its vendor forbids it, or hidden where it is allowed); a source with a gap read as "the previous country"; a rebuild of
the same month that is a different file; the committed table and its manifest disagreeing; and the Python writer and the
TypeScript reader drifting apart (both read command-center/tests/fixtures/geoip-fixture.*).
"""

import gzip
import hashlib
import importlib.util
import ipaddress
import json
import struct
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("geoip_build", ROOT / "tools" / "geoip_build.py")
gb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gb)

FIXTURES = ROOT / "command-center" / "tests" / "fixtures"
CSV = (FIXTURES / "geoip-fixture.csv").read_text(encoding="ascii")
DATA = ROOT / "command-center" / "data" / "geoip"


def read(table: bytes):
    """A second, independent reader of the format, for the round trip."""
    assert table[:4] == b"NSG1"
    n4, n6, nc = struct.unpack(">IIH", table[4:14])
    at = 14
    codes = [table[at + 2 * i: at + 2 * i + 2].decode() for i in range(nc)]
    at += 2 * nc
    v4 = list(struct.unpack(f">{n4}I", table[at: at + 4 * n4]))
    at += 4 * n4
    v4c = list(table[at: at + n4])
    at += n4
    v6 = [int.from_bytes(table[at + 16 * i: at + 16 * i + 16], "big") for i in range(n6)]
    at += 16 * n6
    v6c = list(table[at: at + n6])
    assert at + n6 == len(table)
    return codes, list(zip(v4, (codes[c] for c in v4c))), list(zip(v6, (codes[c] for c in v6c)))


class Build(unittest.TestCase):
    def test_every_range_and_code_survives_in_order(self):
        codes, v4, v6 = read(gb.build_table(CSV.splitlines()))
        want4, want6 = [], []
        for line in CSV.splitlines():
            first, _, code = line.split(",")
            a = ipaddress.ip_address(first)
            (want4 if a.version == 4 else want6).append((int(a), code))
        self.assertEqual(v4, want4)
        self.assertEqual(v6, want6)
        self.assertIn("ZZ", codes)

    def test_the_committed_fixture_is_what_the_tool_writes(self):
        # The TypeScript reader's test reads this file: the two implementations meet here.
        self.assertEqual((FIXTURES / "geoip-fixture.bin").read_bytes(), gb.build_table(CSV.splitlines()))

    def test_a_gap_an_overlap_or_a_partial_cover_is_refused(self):
        lines = CSV.splitlines()
        gap = [l for l in lines if not l.startswith("7.0.0.0,")]
        with self.assertRaisesRegex(gb.GeoTableError, "gap or an overlap"):
            gb.build_table(gap)
        overlap = [l.replace("8.0.0.0,", "7.255.0.0,") for l in lines]
        with self.assertRaisesRegex(gb.GeoTableError, "gap or an overlap"):
            gb.build_table(overlap)
        with self.assertRaisesRegex(gb.GeoTableError, "whole address space"):
            gb.build_table(lines[1:])
        with self.assertRaisesRegex(gb.GeoTableError, "two letters"):
            gb.build_table([lines[0].replace("ZZ", "Z1")] + lines[1:])
        with self.assertRaisesRegex(gb.GeoTableError, "not a range"):
            gb.build_table(["9.0.0.0,1.0.0.0,US"])

    def test_the_same_month_rebuilds_to_the_same_bytes(self):
        t = gb.build_table(CSV.splitlines())
        self.assertEqual(gb.gzip_stable(t), gb.gzip_stable(t))
        self.assertEqual(gzip.decompress(gb.gzip_stable(t)), t)

    def test_a_source_whose_md5_is_not_the_published_one_is_refused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src.csv.gz"
            src.write_bytes(gzip.compress(CSV.encode()))
            out = Path(d) / "out" / "country.bin.gz"
            self.assertEqual(gb.main([str(src), str(out), "--month", "2026-11", "--source-md5", "0" * 32]), 1)
            self.assertFalse(out.exists())
            self.assertEqual(gb.main([str(src), str(out), "--month", "2026-11", "--source-md5", hashlib.md5(CSV.encode()).hexdigest()]), 0)
            m = json.loads((out.parent / "manifest.json").read_text())
            self.assertEqual(m["table_sha256"], hashlib.sha256(out.read_bytes()).hexdigest())
            self.assertEqual(m["url"], "https://download.db-ip.com/free/dbip-country-lite-2026-11.csv.gz")


class Shipped(unittest.TestCase):
    def test_the_shipped_table_matches_its_manifest_and_reads(self):
        m = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
        table = (DATA / m["table"]).read_bytes()
        self.assertEqual(hashlib.sha256(table).hexdigest(), m["table_sha256"])
        self.assertIn("CC BY 4.0", m["licence"])
        self.assertIn("IP Geolocation by DB-IP", m["licence"])
        self.assertRegex(m["month"], r"^\d{4}-\d{2}$")
        codes, v4, v6 = read(gzip.decompress(table))
        self.assertEqual((v4[0][0], v6[0][0]), (0, 0))
        self.assertGreater(len(v4), 100000)
        self.assertGreater(len(v6), 100000)
        for c in ("IN", "UZ", "RU", "PK", "US"):
            self.assertIn(c, codes)
        # A few well-known blocks, as a smoke test of the conversion (not of DB-IP's accuracy).
        def country(ip):
            n = int(ipaddress.ip_address(ip))
            rows = v4 if "." in ip else v6
            lo, hi = 0, len(rows) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                lo, hi = (mid, hi) if rows[mid][0] <= n else (lo, mid - 1)
            return rows[lo][1]
        self.assertEqual(country("1.0.0.1"), "AU")
        self.assertEqual(country("0.1.2.3"), "ZZ")


if __name__ == "__main__":
    unittest.main()


class RegistryField(unittest.TestCase):
    """`blocked_countries` in schemas/model_registry.json: ISO codes, and only on a model the API never sells."""

    def setUp(self):
        from modules import model_registry as reg
        self.reg = reg
        self.doc = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        self.web_only = next(m for m in self.doc["models"] if m["api_exposure"] == "web_only")
        self.any = next(m for m in self.doc["models"] if m["api_exposure"] == "any")

    def test_a_web_only_model_takes_a_list_of_codes(self):
        self.web_only["blocked_countries"] = ["IN", "PK"]
        self.assertEqual(self.reg.validate(self.doc), [])

    def test_a_model_the_api_sells_cannot_be_blocked_by_country(self):
        self.any["blocked_countries"] = ["IN"]
        self.assertTrue(any("blocked_countries needs api_exposure web_only" in e for e in self.reg.validate(self.doc)))

    def test_codes_are_two_upper_case_letters_listed_once(self):
        for bad in (["in"], ["IND"], ["IN", "IN"], [], ["I1"]):
            self.web_only["blocked_countries"] = bad
            self.assertNotEqual(self.reg.validate(self.doc), [], bad)
