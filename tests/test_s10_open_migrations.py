"""0194 (OpenAI GPT Image) and 0195 (Describe on Claude / GPT) open a model only when it is priced above zero.

sellable_models lists a unit only when credits_per_unit > 0. A gate that accepted a zero row would open the model, then fail its
own end-state check with "on sale but sellable_models does not list it", which names the wrong fix (Lens, 2026-11-21).
"""

import pathlib
import re
import unittest

MIG = pathlib.Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def body(name):
    return next(MIG.glob(f"*_{name}.sql")).read_text(encoding="utf-8")


class PricedAboveZero(unittest.TestCase):
    def test_every_price_gate_needs_a_positive_price(self):
        for name in ("open_openai_image", "open_llm_describe"):
            text = body(name)
            gates = re.findall(r"from public\.credit_prices where [^)]*\)", text)
            self.assertTrue(gates, name)
            for g in gates:
                self.assertIn("credits_per_unit > 0", g, f"{name}: {g}")

    def test_neither_writes_a_price(self):
        for name in ("open_openai_image", "open_llm_describe"):
            code = "\n".join(l for l in body(name).splitlines() if not l.lstrip().startswith("--"))
            self.assertNotRegex(code, r"(?i)\b(insert into|update|delete from)\s+public\.credit_prices\b", name)


if __name__ == "__main__":
    unittest.main()
