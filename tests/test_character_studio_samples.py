"""tools/character_studio_samples.py makes a PAID vendor call, which the owner has not approved: it must do nothing by default, refuse a
run without the owner's approval of that very model, and write only paths 0137's sample row accepts. Nothing here reaches a network."""

import contextlib
import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools import character_studio_samples as cli

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "supabase" / "migrations" / "0137_character_studio.sql").read_text(encoding="utf-8")
ARGS = ["--card", "two-characters", "--model", "kling-4.0-omni-edit", "--video", "clip.mp4", "--image", "a.png",
        "--cdn-base", "https://cdn.example.com/character-samples"]


def run(argv, env=None):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), mock.patch.object(cli, "Storage", side_effect=AssertionError("no storage")), \
            mock.patch("requests.Session.request", side_effect=AssertionError("no network")):
        code = cli.main(argv, env=env or {})
    return code, out.getvalue()


class Samples(unittest.TestCase):
    def test_the_default_is_the_plan_with_the_vendor_price_and_nothing_else(self):
        code, out = run(ARGS)
        self.assertEqual(code, 0)
        self.assertIn("PAID", out)
        self.assertIn("plan only: nothing was uploaded, called or paid for", out)

    def test_a_run_needs_the_owners_approval_of_that_very_model(self):
        env = {"SUPABASE_URL": "https://db.example.com", "SUPABASE_SERVICE_KEY": "k"}
        for extra in ([], ["--approve-paid-call", "seedance-2.5-edit"], ["--approve-paid-call", "yes"]):
            code, out = run(ARGS + ["--run"] + extra, env)
            self.assertEqual(code, 2, extra)
            self.assertIn("refused", out)

    def test_a_refused_prompt_or_a_bad_cdn_base_stops_before_the_plan(self):
        self.assertEqual(run(ARGS + ["--prompt", "Replace the actor with @Image 1"])[0], 2)
        bad = list(ARGS)
        bad[-1] = "http://cdn.example.com"
        self.assertEqual(run(bad)[0], 2)

    def test_the_paths_are_what_0137_accepts(self):
        check = re.search(r"original_object ~ '([^']+)'", MIGRATION).group(1)
        web = re.search(r"check \(web_url ~ '([^']+)'", MIGRATION).group(1)
        for card in ("two-characters", "one-character"):
            for model in ("kling-4.0-omni-edit", "seedance-2.5-edit"):
                p = cli.object_paths(card, model)
                self.assertRegex(p["original"], check)
                self.assertRegex(f"https://cdn.example.com/character-samples/{p['web']}", web)
        for bad in (("../x", "kling-4.0-omni-edit"), ("two-characters", "kling-v3")):
            with self.assertRaises(ValueError):
                cli.object_paths(*bad)


if __name__ == "__main__":
    unittest.main()
