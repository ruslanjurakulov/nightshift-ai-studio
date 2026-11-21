#!/bin/bash
# Full Python suite on the base copy and the branch copy (same OS, same files except this change).
pkill -f "unittest discover" 2>/dev/null
for d in base branch; do
  cd "/mnt/d/vera/wt/google-geo-and-size-pricing-v2/.vera_tmp/$d" || exit 1
  /opt/vera-py/bin/python -m unittest discover -s tests > "/tmp/ut_$d.log" 2>&1
  echo "$d: $(tail -1 /tmp/ut_$d.log)"
  grep -E '^(FAIL|ERROR):' "/tmp/ut_$d.log" | sort > "/tmp/ut_$d.fails"
done
echo "only on branch:"; comm -13 /tmp/ut_base.fails /tmp/ut_branch.fails
echo "only on base:"; comm -23 /tmp/ut_base.fails /tmp/ut_branch.fails
echo "common: $(comm -12 /tmp/ut_base.fails /tmp/ut_branch.fails | wc -l)"
