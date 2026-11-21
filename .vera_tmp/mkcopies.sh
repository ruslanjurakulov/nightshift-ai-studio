#!/bin/bash
# Two LF copies of the repository for an apples-to-apples vitest run: base = HEAD (== origin/main), branch = base + this worktree's changes.
set -e
cd /d/vera/wt/google-geo-and-size-pricing-v2
rm -rf .vera_tmp/base .vera_tmp/branch
mkdir -p .vera_tmp/base .vera_tmp/branch
git archive --format=tar HEAD | tar -x -C .vera_tmp/base
git archive --format=tar HEAD | tar -x -C .vera_tmp/branch
# changed and new files, LF
for f in $(git diff --name-only HEAD) $(git ls-files --others --exclude-standard | grep -v '^.vera_tmp/'); do
  mkdir -p ".vera_tmp/branch/$(dirname "$f")"
  tr -d '\r' < "$f" > ".vera_tmp/branch/$f"
done
echo done
