"""tools/geoip_build.py — DB-IP's country CSV into the table the web process reads (docs/GEO_BLOCK.md).

What would break without these: a range dropped or a code moved by the conversion (a country read as another one, so a model is
shown where its vendor forbids it, or hidden where it is allowed); a source with a gap read as "the previous country"; a rebuild of
the same month that is a different file; the committed table and its manifest disagreeing; and the Python writer and the
TypeScript reader drifting apart (both read command-center/tests/fixtures/geoip-fixture.*).
"""

import copy
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
    def test_the_table_and_its_manifest_are_in_the_repository_not_ignored(self):
        # The root .gitignore ignores every *.json: the manifest was once left out of the commit that way, and this file's other
        # test then failed only on a clean checkout. Git itself is asked, so an ignore rule cannot hide either file again.
        import subprocess
        try:
            inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=ROOT, capture_output=True, text=True)
        except FileNotFoundError:
            self.skipTest("git is not installed")
        if inside.returncode != 0:
            self.skipTest("not a git checkout")
        for name in ("country.bin.gz", "manifest.json"):
            rel = f"command-center/data/geoip/{name}"
            ignored = subprocess.run(["git", "check-ignore", "-q", "--no-index", rel], cwd=ROOT)
            self.assertNotEqual(ignored.returncode, 0, f"{rel} is ignored by a .gitignore rule")
            tracked = subprocess.run(["git", "ls-files", "--error-unmatch", rel], cwd=ROOT, capture_output=True)
            self.assertEqual(tracked.returncode, 0, f"{rel} is not committed")

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
        # The registry may hold no model the API sells (luma-ray-3.2 and seedance-1.5-pro became web_only on their terms),
        # so the "any" case is built from a copy rather than borrowed from the file.
        self.any = copy.deepcopy(self.web_only)
        self.any.update(api_exposure="any", terms_gate=None)

    def test_a_web_only_model_takes_a_list_of_codes(self):
        self.web_only["blocked_countries"] = ["IN", "PK"]
        self.web_only["terms_gate"] = "terms_review_required"
        self.assertEqual(self.reg.validate(self.doc), [])

    def test_a_country_list_with_no_terms_gate_needs_an_allow_list(self):
        # A deny-list alone lets a code on neither list through (EU, ZZ: BR-S6-04): 0238 keeps such a row off sale in the
        # database, and the file refuses it, so a sync can never write a row the database would refuse whole.
        self.web_only["blocked_countries"] = ["PK"]
        self.web_only["terms_gate"] = None
        self.web_only.pop("available_countries", None)
        mid = self.web_only["id"]
        self.assertIn(f"{mid}: blocked_countries needs available_countries (or a terms_gate) before the database lets it on sale (0238)",
                      self.reg.validate(self.doc))

    def test_a_country_list_with_an_allow_list_needs_no_terms_gate(self):
        # Since 0208 the database checks the country on every path and since 0230 it reads the allow-list: 0238 lets such a row on sale.
        self.web_only["blocked_countries"] = ["PK"]
        self.web_only["available_countries"] = ["UZ"]
        self.web_only["terms_gate"] = None
        self.assertEqual(self.reg.validate(self.doc), [])

    def test_an_empty_allow_list_is_not_an_allow_list(self):
        # The schema refuses it (minItems 1) before the cross-field rule is read; 0238's CHECK refuses it in the database too.
        self.web_only["blocked_countries"] = ["PK"]
        self.web_only["available_countries"] = []
        self.web_only["terms_gate"] = None
        self.assertNotEqual(self.reg.validate(self.doc), [])

    def test_every_model_in_the_file_with_a_country_list_is_kept_off_sale_or_carries_its_allow_list(self):
        listed = [m for m in self.doc["models"] if m.get("blocked_countries")]
        self.assertTrue(listed)
        for m in listed:
            # 0035's terms_before_sale keeps a gated row hidden; 0238's CHECK lets an ungated one on sale only with an allow-list.
            self.assertTrue(m.get("terms_gate") or m.get("available_countries"), m["id"])
        mig = (ROOT / "supabase" / "migrations" / "0238_country_list_sale_needs_allow_list.sql").read_text(encoding="utf-8")
        self.assertIn("add constraint model_registry_countries_before_sale", mig)

    def test_a_model_the_api_sells_cannot_be_blocked_by_country(self):
        self.any["blocked_countries"] = ["IN"]
        self.doc["models"] = [self.any if m is self.web_only else m for m in self.doc["models"]]
        self.assertTrue(any("blocked_countries needs api_exposure web_only" in e for e in self.reg.validate(self.doc)))

    def test_codes_are_two_upper_case_letters_listed_once(self):
        for bad in (["in"], ["IND"], ["IN", "IN"], [], ["I1"]):
            self.web_only["blocked_countries"] = bad
            self.assertNotEqual(self.reg.validate(self.doc), [], bad)
