"""Write samples/ms_round_cases.json.gz: inputs and what Python's round(x, 3) gives for them (modules/timeline.py
``_ms``, and the database's editor_ms, migration 0136, which copies it). command-center/tests/editor-ms-round.test.ts
holds the editor's ``ms`` to the table bit for bit.

The inputs: the set tests/security/test_sec_editor_rendered_length.py gives the database (random values, every k/16,
k + 0.0005 and 60 m + 0.0005, with their neighbours one ulp up and down, and the edge values), every k/32 and k/1000
with their neighbours, log-uniform random values of both signs, and every value ``_ms`` is called with while the
renderer measures the 2,282 documents of that test's corpus. Run: ``python3 tools/ms_round_table.py``.
"""

import gzip
import json
import math
import random
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests" / "security"))

from modules import timeline as tl  # noqa: E402


def _next(x, up):
    bits = struct.unpack("<q", struct.pack("<d", x))[0]
    return struct.unpack("<d", struct.pack("<q", bits + (1 if (x >= 0) == up else -1)))[0]


def inputs():
    xs = []
    rng = random.Random(20261112 + 2)
    xs += [rng.uniform(-100, 2000) for _ in range(3000)] + [rng.uniform(0, 1) for _ in range(1000)]
    ties = [k / 16 for k in range(1, 4000)] + [k + 0.0005 for k in range(0, 200)] + [60 * m + 0.0005 for m in range(1, 31)]
    xs += ties + [_next(t, True) for t in ties] + [_next(t, False) for t in ties]
    xs += [0.0, -0.0, 1e-300, 5e-324, 2.0 ** 53, 123456789.0625, 0.0625, 0.1875, -0.0625, 1.0005, 2.675, 1e15 + 0.5]
    for k in range(-1000, 5000):
        for v in (k / 32, k / 1000, k / 16):
            xs += [v, _next(v, True), _next(v, False)]
    r2 = random.Random(7)
    for _ in range(8000):
        v = 10 ** r2.uniform(-7, 9)
        xs.append(v if r2.random() < 0.7 else -v)
    for _ in range(5000):
        xs.append(round(r2.uniform(-50, 3000), r2.choice([3, 4, 5, 6])) + r2.choice([0, 0.0005, -0.0005]))
    # every value the renderer rounds while measuring the database test's corpus
    import test_sec_editor_rendered_length as corpus  # noqa: E402  (imports sec_db; no database is opened)
    seen = []
    real = tl._ms
    tl._ms = lambda v: (seen.append(float(v)), real(v))[1]
    try:
        for d in corpus._corpus() + corpus._boundary_docs():
            tl.duration_s(tl.normalise(d))
            tl.validate(d)
    finally:
        tl._ms = real
    xs += seen
    out, keys = [], set()
    for x in xs:
        if not math.isfinite(x):
            continue
        k = struct.pack("<d", x)
        if k not in keys:
            keys.add(k)
            out.append(x)
    return out, len(set(struct.pack("<d", v) for v in seen))


if __name__ == "__main__":
    xs, from_corpus = inputs()
    ys = [round(x, 3) for x in xs]
    data = {"note": "x and Python's round(x, 3) for it; written by tools/ms_round_table.py", "from_corpus": from_corpus, "x": xs, "y": ys}
    path = ROOT / "samples" / "ms_round_cases.json.gz"
    path.write_bytes(gzip.compress(json.dumps(data).encode("utf-8"), 9, mtime=0))
    print(len(xs), "values,", from_corpus, "from the corpus,", path.stat().st_size, "bytes")
