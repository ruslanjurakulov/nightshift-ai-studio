import re
import subprocess
import sys
from pathlib import Path

T = Path(__file__).resolve().parent
files = sys.argv[1:]
for name in ("base", "branch"):
    out = subprocess.run("npx vitest run " + " ".join(files), cwd=T / name / "command-center", shell=True,
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = out.stdout + "\n" + out.stderr
    clean = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in (out + "\n").splitlines()]
    fails = sorted(set(l.strip() for l in clean if "FAIL" in l and "tests/" in l))
    summary = [re.sub(r"\x1b\[[0-9;]*m", "", l).strip() for l in out.splitlines() if "Tests " in l or "Test Files" in l]
    print("==", name, summary)
    for f in fails:
        print("   ", f[:200])
