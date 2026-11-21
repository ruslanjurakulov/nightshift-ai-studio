"""Two LF copies of the repository for an apples-to-apples vitest run: base = HEAD (== origin/main), branch = base + this worktree's changes."""
import io
import shutil
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".vera_tmp"


def git(*a):
    return subprocess.run(["git", *a], cwd=ROOT, check=True, capture_output=True).stdout


tar_bytes = git("archive", "--format=tar", "HEAD")
for name in ("base", "branch"):
    d = OUT / name
    if d.exists():
        shutil.rmtree(d)
    d.mkdir()
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as t:
        t.extractall(d, filter="data")
changed = git("diff", "--name-only", "HEAD").decode().split()
new = [f for f in git("ls-files", "--others", "--exclude-standard").decode().split() if not f.startswith(".vera_tmp/")]
deleted = git("diff", "--name-only", "--diff-filter=D", "HEAD").decode().split()
for f in changed + new:
    if f in deleted:
        (OUT / "branch" / f).unlink(missing_ok=True)
        continue
    dst = OUT / "branch" / f
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes((ROOT / f).read_bytes().replace(b"\r\n", b"\n"))
print("copied", len(changed), "changed and", len(new), "new files")
