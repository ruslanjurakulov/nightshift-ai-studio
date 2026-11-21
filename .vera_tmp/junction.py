import _winapi
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = str(ROOT / "command-center" / "node_modules")
for name in ("base", "branch"):
    dst = ROOT / ".vera_tmp" / name / "command-center" / "node_modules"
    if not dst.exists():
        _winapi.CreateJunction(src, str(dst))
    print(name, dst.exists())
