import json
import sys
from pathlib import Path

T = Path(__file__).resolve().parent


def load(name):
    p = T / f"vitest-{name}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    fails = set()
    for f in d["testResults"]:
        rel = f["name"].replace("\\", "/").split("command-center/")[-1]
        if f.get("status") == "failed" and not f.get("assertionResults"):
            fails.add((rel, "<file failed: " + (f.get("message") or "")[:200] + ">"))
        for a in f.get("assertionResults", []):
            if a["status"] == "failed":
                fails.add((rel, a["fullName"]))
    return d["numTotalTests"], d["numFailedTests"], fails


b, br = (load("base"), load("branch")) if __name__ == "__main__" else (None, None)
if b and br:
    print("NEW FAILURES on branch:")
    for x in sorted(br[2] - b[2]):
        print("  ", x)
    print("FIXED on branch:")
    for x in sorted(b[2] - br[2]):
        print("  ", x)
    print("PRE-EXISTING:")
    for x in sorted(b[2] & br[2]):
        print("  ", x)
