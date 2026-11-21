import collections
import sys
sys.path.insert(0, __file__.rsplit("\\", 1)[0])
from vdiff import load  # noqa: E402

b, br = load("base"), load("branch")
for title, s in (("NEW", br[2] - b[2]), ("FIXED", b[2] - br[2])):
    c = collections.Counter(f for f, _ in s)
    print(title, sum(c.values()))
    for f, n in c.most_common():
        print("  ", n, f)
