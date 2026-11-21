import subprocess
import sys
from pathlib import Path

C = Path(__file__).resolve().parent / "branch" / "command-center"
MUTS = {
    "no Google rows in BLOCKED_COUNTRIES": ("lib/geo/blocked.ts", "  ...Object.fromEntries(GOOGLE_MODELS.map((m) => [m, GOOGLE_BLOCKED])),\n", ""),
    "unknown allowed for Google": ("lib/geo/blocked.ts", "new Set(GOOGLE_MODELS);", "new Set<string>();"),
    "jobs route sends no claim": ("app/api/creative/jobs/route.ts",
                                  "createGeneration(session.db, input, geoClaimHeaders([input.model], request.headers, session.userId))",
                                  "createGeneration(session.db, input)"),
    "advance sends no claim": ("app/api/workflows/runs/[id]/advance/route.ts", "advanceRun(session.db, id, claim)", "advanceRun(session.db, id)"),
}
for name, (f, old, new) in MUTS.items():
    p = C / f
    orig = p.read_text(encoding="utf-8")
    assert orig.count(old) == 1, name
    p.write_text(orig.replace(old, new), encoding="utf-8")
    try:
        r = subprocess.run("npx vitest run tests/geo-google.test.ts", cwd=C, shell=True, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        line = [l for l in (r.stdout + r.stderr).splitlines() if "Tests " in l]
        print(name, "->", line[-1].strip() if line else "no summary (import/compile failure)")
    finally:
        p.write_text(orig, encoding="utf-8")
