#!/usr/bin/env python3
"""Turn DB-IP's free "IP to Country Lite" CSV into the compact table the web process reads (docs/GEO_BLOCK.md).

    python3 tools/geoip_build.py dbip-country-lite-YYYY-MM.csv.gz command-center/data/geoip/country.bin.gz \
        --month YYYY-MM --source-md5 <the MD5SUM db-ip.com prints for that month's CSV>

WHY A CONVERSION. DB-IP keeps only the current and the previous month on its download server, so a Docker build that
fetched a pinned monthly URL would start failing about two months later. The table is therefore committed, and in a form
that is half the size of the CSV (2.2 MB against 4.6 MB gzipped) and needs no parsing at runtime: the web process gunzips
it once and binary-searches typed arrays.

WHAT CHANGES (CC BY 4.0 asks us to say): the format only. Every range and every country code of the source is kept, in
the source's order; nothing is merged, dropped or corrected. The source's MD5 is checked before anything is written
(db-ip.com prints it next to the download), and the manifest beside the table records the month, the URL, the MD5 and
the sha256 of what was written.

THE FORMAT (all integers big-endian), "NSG1":
    4 bytes   b"NSG1"
    u32       n4   number of IPv4 ranges
    u32       n6   number of IPv6 ranges
    u16       nc   number of country codes
    nc x 2    the codes, ASCII (index 0.. in first-seen order; "ZZ" is DB-IP's "unknown")
    n4 x u32  the first address of each IPv4 range, ascending
    n4 x u8   the code index of each IPv4 range
    n6 x 16   the first address of each IPv6 range, ascending
    n6 x u8   the code index of each IPv6 range
The ranges of each family must cover the whole address space with no gap or overlap (DB-IP's do; this tool refuses a file
whose do not), so a lookup is "the last range that starts at or before the address". command-center/lib/geo/table.ts reads
it; tests/test_geoip_build.py and command-center/tests/geo-block.test.ts share one fixture so the two cannot drift apart.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import ipaddress
import json
import struct
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

MAGIC = b"NSG1"
SOURCE_URL = "https://download.db-ip.com/free/dbip-country-lite-{month}.csv.gz"
LICENCE = "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); attribution: IP Geolocation by DB-IP (https://db-ip.com)"


class GeoTableError(ValueError):
    pass


def parse_rows(lines: Iterable[str]) -> Tuple[List[Tuple[int, int, str]], List[Tuple[int, int, str]]]:
    v4: List[Tuple[int, int, str]] = []
    v6: List[Tuple[int, int, str]] = []
    for n, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split(",")
        if len(parts) != 3:
            raise GeoTableError(f"line {n}: expected first,last,country")
        first, last, code = parts
        if len(code) != 2 or not code.isascii() or not code.isupper() or not code.isalpha():
            raise GeoTableError(f"line {n}: country {code!r} is not two letters")
        try:
            a, b = ipaddress.ip_address(first), ipaddress.ip_address(last)
        except ValueError as e:
            raise GeoTableError(f"line {n}: {e}") from None
        if a.version != b.version or int(b) < int(a):
            raise GeoTableError(f"line {n}: not a range")
        (v4 if a.version == 4 else v6).append((int(a), int(b), code))
    return v4, v6


def _check_cover(rows: List[Tuple[int, int, str]], top: int, family: str) -> None:
    if not rows:
        raise GeoTableError(f"no {family} ranges")
    if rows[0][0] != 0 or rows[-1][1] != top:
        raise GeoTableError(f"the {family} ranges do not cover the whole address space")
    for (_, prev_last, _), (first, _, _) in zip(rows, rows[1:]):
        if first != prev_last + 1:
            raise GeoTableError(f"the {family} ranges have a gap or an overlap at {first:#x}")


def build_table(lines: Iterable[str]) -> bytes:
    v4, v6 = parse_rows(lines)
    _check_cover(v4, 2**32 - 1, "IPv4")
    _check_cover(v6, 2**128 - 1, "IPv6")
    codes: dict = {}
    for _, _, c in v4 + v6:
        codes.setdefault(c, len(codes))
    if len(codes) > 255:
        raise GeoTableError("more than 255 country codes")
    out = bytearray(MAGIC)
    out += struct.pack(">IIH", len(v4), len(v6), len(codes))
    for c in codes:
        out += c.encode("ascii")
    for first, _, _ in v4:
        out += struct.pack(">I", first)
    out += bytes(codes[c] for _, _, c in v4)
    for first, _, _ in v6:
        out += first.to_bytes(16, "big")
    out += bytes(codes[c] for _, _, c in v6)
    return bytes(out)


def gzip_stable(data: bytes) -> bytes:
    """Byte-identical output for the same input (no file name, mtime 0), so a rebuild of the same month is no diff."""
    return gzip.compress(data, compresslevel=9, mtime=0)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("source", type=Path, help="dbip-country-lite-YYYY-MM.csv.gz as downloaded")
    ap.add_argument("out", type=Path, help="the table to write (country.bin.gz)")
    ap.add_argument("--month", required=True, help="YYYY-MM of the source")
    ap.add_argument("--source-md5", required=True, help="the MD5SUM db-ip.com prints for the uncompressed CSV")
    args = ap.parse_args(argv)
    text = gzip.decompress(args.source.read_bytes())
    got = hashlib.md5(text).hexdigest()
    if got != args.source_md5.lower():
        print(f"the source's MD5 is {got}, not {args.source_md5}: download it again", file=sys.stderr)
        return 1
    table = gzip_stable(build_table(text.decode("ascii").splitlines()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(table)
    manifest = {
        "source": "DB-IP IP to Country Lite",
        "month": args.month,
        "url": SOURCE_URL.format(month=args.month),
        "source_csv_md5": got,
        "source_gz_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
        "table": args.out.name,
        "table_sha256": hashlib.sha256(table).hexdigest(),
        "licence": LICENCE,
        "changes": "format only: every range and code of the source, in its order (tools/geoip_build.py)",
    }
    args.out.with_name("manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out} ({len(table)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
