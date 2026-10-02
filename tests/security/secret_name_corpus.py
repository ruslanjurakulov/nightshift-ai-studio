"""Channel ids and references with the token-secret name each must normalise to.

One literal table, used twice and imported by neither implementation: the lab
asserts the SQL ``channel_secret_name`` (migration 0086) gives these answers, and
tests/test_breach_wave7_worker.py asserts Python's
``channel_credentials.secret_name_for`` does. The lab's CI job installs no
pipeline dependency, so it cannot import the Python module; the table is how the
two functions are pinned against each other (BR-L-080). ASCII keys only, and
only for ASCII is the pin exact: every channel id the database accepts, and every
reference it accepts, is ASCII. For non-ASCII text the two differ (Python's
full case mapping turns ß into SS, Postgres upper() does not); no id or reference
can carry such text, so nothing depends on it (BR-L-116).
"""

P = "CHRONOS_YT_TOKEN_"

EXPECTED = {
    "extinct-world": P + "EXTINCT_WORLD",
    "extinct-world-": P + "EXTINCT_WORLD",
    "extinct--world": P + "EXTINCT_WORLD",
    "extinct-world--": P + "EXTINCT_WORLD",
    "-extinct-world": P + "EXTINCT_WORLD",
    "Extinct World": P + "EXTINCT_WORLD",
    "extinct_world": P + "EXTINCT_WORLD",
    "EXTINCT.WORLD": P + "EXTINCT_WORLD",
    "a": P + "A",
    "ab": P + "AB",
    "a-b-c": P + "A_B_C",
    "a--b": P + "A_B",
    "a_-_b": P + "A_B",
    "  x  ": P + "X",
    "9lives": P + "9LIVES",
    "my.channel_1": P + "MY_CHANNEL_1",
    "x" * 60: P + "X" * 60,
    "": P,
    "---": P,
}
