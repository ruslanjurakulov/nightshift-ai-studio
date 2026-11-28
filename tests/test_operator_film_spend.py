"""The film spend watch (``film:spend:*``): the paid test film's hard cap, watched from the vendor dollars themselves.

What would break, and which test says so:

* a film at or above NIGHTSHIFT_FILM_SPEND_WARN_USD / _STOP_USD reaching nobody, being announced twice, or the stop line
  not saying "stop the film by hand now (runbook step 6)" with the ladder and that unknown lines are left out;
* an unknown counted as 0 (rule 5): a finished take with no cost row, a cost row with no quantity, a model with no
  registry figure, a quantity in another unit. Each is an unknown line, the warning ``film:spend_unrecorded`` fires,
  and the known sum never grows by it;
* the dollars of an estimate (quantity x the registry's figure) called "recorded" or "measured", or a recorded
  usd_estimate ignored in favour of an estimate;
* a malformed threshold quietly becoming the default (it is a refusal naming the variable: the pass exits 2, the
  service does not start, /health says so);
* a source that cannot answer becoming an alert, or /health saying nothing;
* a full id, the service key, a prompt or a value of the environment reaching any output, in any language.
"""

from __future__ import annotations

import io
import os
import unittest
from contextlib import redirect_stdout
from datetime import timedelta
from decimal import Decimal
from unittest import mock

from modules.operator_bot import alerts, analysis, views
from modules.operator_bot.config import (
    FILM_SPEND_STOP_ENV, FILM_SPEND_WARN_ENV, FilmSpendConfigError, OperatorConfig, parse_film_spend_thresholds,
)
from modules.operator_bot.i18n import LANGUAGES
from modules.operator_bot.store import MemoryAlertStore
from tests.operator_bot_fakes import FakeHttp, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok, ts
from tools import film_spend as cli

ORG = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8"
FILM = "f11f2e3d-4c5b-4a69-8877-665544332211"
FILM2 = "a22a3b4c-5d6e-4f70-8899-aabbccddeeff"
KEY = "sk-live-abcdefghijklmnopqrstuvwxyz0123"
PROMPT = "PROMPT-TEXT a red fox at dawn"
CLIP = "vid-clip"            # priced: USD 0.05 a second
PICTURE = "openai-gpt-image-2.6-high"    # no registry figure


def seg(film=FILM, status="running", settled_minutes=None):
    return {"film_id": film, "org_id": ORG, "status": status, "created_at": ts(30), "claimed_at": ts(29),
            "heartbeat_at": ts(0.5), "updated_at": ts(0.5), "id": "5e65a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b",
            "settled_at": None if settled_minutes is None else ts(settled_minutes)}


def take(n, film=FILM, kind="clip", attempt=1, status="completed"):
    return {"id": f"take-{film[:4]}-{n}", "film_id": film, "org_id": ORG, "kind": kind, "attempt": attempt,
            "status": status, "created_at": ts(20 - n), "prompt_final": PROMPT}


def job(n, film=FILM, model=CLIP, routed=None):
    return {"id": f"job-{film[:4]}-{n}", "film_take_id": f"take-{film[:4]}-{n}", "requested_model": model,
            "routed_model": routed, "status": "completed", "finished_at": ts(30), "created_at": ts(40), "params": PROMPT}


def cost(n, film=FILM, quantity=None, unit="second", usd=None):
    return {"job_id": f"job-{film[:4]}-{n}", "quantity": quantity, "unit": unit, "usd_estimate": usd,
            "price_source": "PRICE-SOURCE-TEXT"}


FIGURES = [{"id": CLIP, "usd_per_unit": "0.05", "price_unit": "second"},
           {"id": PICTURE, "usd_per_unit": None, "price_unit": "image"}]


def tables_for(usd_seconds=(), extra_takes=(), extra_jobs=(), extra_costs=(), segments=None):
    """A film whose clips each record ``seconds`` of quantity (0.05 USD a second)."""
    takes, jobs, costs = [], [], []
    for i, seconds in enumerate(usd_seconds, 1):
        takes.append(take(i))
        jobs.append(job(i))
        costs.append(cost(i, quantity=seconds))
    return {"film_segments": segments if segments is not None else [seg()],
            "film_takes": takes + list(extra_takes), "creative_jobs": jobs + list(extra_jobs),
            "creative_job_costs": costs + list(extra_costs), "model_registry": list(FIGURES)}


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


def build(tables=None, fail=(), cfg=None):
    clock = Clock()
    t = healthy_tables(clock.now)
    t.update(tables or {})
    cfg = cfg or OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    ops, sync = make_ops(t, FakeHttp({**site_ok(), **github_ok()}), cfg, now=clock.now, fail=fail)
    ops._now = clock
    tg = FakeTelegram()
    engine = alerts.AlertEngine(ops, MemoryAlertStore(clock), make_control(tg), cfg, low_credits=15000)
    return engine, tg, ops, sync, clock


def spend_alerts(tables=None, fail=(), cfg=None, lang="en"):
    _e, _t, ops, _s, _c = build(tables, fail, cfg)
    return [a for a in alerts.detect(ops, 15000, lang) if a.key.startswith("film:spend")]


# ── the thresholds ───────────────────────────────────────────────────────────

class ThresholdConfigTestCase(unittest.TestCase):
    def test_unset_or_empty_is_6_and_8(self):
        self.assertEqual(parse_film_spend_thresholds({}), (Decimal(6), Decimal(8)))
        self.assertEqual(parse_film_spend_thresholds({FILM_SPEND_WARN_ENV: " ", FILM_SPEND_STOP_ENV: ""}),
                         (Decimal(6), Decimal(8)))

    def test_dollars_and_cents_are_read(self):
        self.assertEqual(parse_film_spend_thresholds({FILM_SPEND_WARN_ENV: "4.50", FILM_SPEND_STOP_ENV: "7"}),
                         (Decimal("4.50"), Decimal(7)))

    def test_a_malformed_line_is_a_refusal_naming_the_variable_never_a_default(self):
        for name in (FILM_SPEND_WARN_ENV, FILM_SPEND_STOP_ENV):
            for raw in ("abc", "-1", "0", "0.00", "1e3", "nan", "inf", "$6", "6,5", "6.505", "6 USD", "+6"):
                with self.subTest(name=name, raw=raw):
                    env = {FILM_SPEND_WARN_ENV: "1", FILM_SPEND_STOP_ENV: "9", name: raw}
                    with self.assertRaises(FilmSpendConfigError) as cm:
                        parse_film_spend_thresholds(env)
                    self.assertEqual(cm.exception.variable, name)
                    self.assertIn(name, str(cm.exception))
                    if raw not in ("0",):
                        self.assertNotIn(raw, str(cm.exception).replace(name, ""))   # the value is never echoed

    def test_a_warn_line_at_or_above_the_stop_line_is_refused(self):
        for warn, stop in (("8", "8"), ("9", "8")):
            with self.assertRaises(FilmSpendConfigError) as cm:
                parse_film_spend_thresholds({FILM_SPEND_WARN_ENV: warn, FILM_SPEND_STOP_ENV: stop})
            self.assertEqual((cm.exception.variable, cm.exception.reason), (FILM_SPEND_WARN_ENV, "not_below_stop"))

    def test_from_env_never_raises_but_records_the_refusal(self):
        cfg = OperatorConfig.from_env({FILM_SPEND_STOP_ENV: "eight"})
        self.assertIn(FILM_SPEND_STOP_ENV, cfg.film_spend_error)
        self.assertEqual(cfg.film_spend_refusal, (FILM_SPEND_STOP_ENV, "not_usd"))
        self.assertEqual(OperatorConfig.from_env({}).film_spend_error, "")

    def test_the_alert_pass_refuses_to_start_and_exits_2(self):
        from tools import run_operator_alerts as runner

        with mock.patch.dict(os.environ, {FILM_SPEND_WARN_ENV: "six", "SUPABASE_SERVICE_KEY": KEY}):
            with self.assertRaises(runner.ConfigRefused) as cm:
                runner.build_engine(make_control(FakeTelegram()), make_ops({})[1])
            self.assertIn(FILM_SPEND_WARN_ENV, str(cm.exception))
            control = mock.Mock(enabled=True)
            sync = mock.Mock(enabled=True)
            with mock.patch.object(runner, "TelegramControl", return_value=control), \
                    mock.patch.object(runner, "SupabaseSync", return_value=sync), \
                    self.assertLogs("run_operator_alerts", "ERROR") as logs:
                self.assertEqual(runner.main([]), runner.EXIT_REFUSED_CONFIG)
            self.assertIn(FILM_SPEND_WARN_ENV, "\n".join(logs.output))
            self.assertNotIn(KEY, "\n".join(logs.output))
            control.send.assert_not_called()

    def test_the_always_on_service_refuses_to_start(self):
        from tools import operator_bot_service as svc

        control = mock.Mock(enabled=True)
        with mock.patch.dict(os.environ, {FILM_SPEND_STOP_ENV: "-1"}), \
                mock.patch.object(svc, "TelegramControl", return_value=control), \
                mock.patch.object(svc.poll_tool, "build_bot", return_value=(mock.Mock(), mock.Mock(enabled=True))):
            self.assertEqual(svc.main([]), svc.EXIT_REFUSED)


# ── the arithmetic ───────────────────────────────────────────────────────────

class RollupTestCase(unittest.TestCase):
    def roll(self, takes, jobs, costs, figures=FIGURES):
        return analysis.film_spend_rollup({FILM: ORG}, takes, jobs, costs, figures)[0]

    def test_a_quantity_times_the_registry_figure_is_an_estimate(self):
        f = self.roll([take(1)], [job(1)], [cost(1, quantity=10)])
        self.assertEqual((f["usd"], f["basis"], f["unknown"]), (Decimal("0.50"), "estimated", 0))
        self.assertEqual(f["takes"][0]["state"], "costed")

    def test_a_recorded_usd_estimate_wins_over_the_estimate_and_is_labelled_recorded(self):
        f = self.roll([take(1)], [job(1)], [cost(1, quantity=10, usd="2.25")])
        self.assertEqual((f["usd"], f["basis"]), (Decimal("2.25"), "recorded"))

    def test_one_estimated_line_makes_the_film_an_estimate(self):
        f = self.roll([take(1), take(2)], [job(1), job(2)], [cost(1, usd="1"), cost(2, quantity=20)])
        self.assertEqual((f["usd"], f["basis"]), (Decimal("2.00"), "estimated"))

    def test_the_routed_model_is_priced_before_the_requested_one(self):
        f = self.roll([take(1)], [job(1, model="something-else", routed=CLIP)], [cost(1, quantity=10)])
        self.assertEqual(f["usd"], Decimal("0.50"))

    def test_no_quantity_is_unknown_not_zero(self):
        f = self.roll([take(1), take(2)], [job(1), job(2)], [cost(1, quantity=10), cost(2, quantity=None)])
        self.assertEqual((f["usd"], f["unknown"]), (Decimal("0.50"), 1))
        self.assertEqual((f["takes"][1]["state"], f["takes"][1]["usd"]), ("unknown", None))

    def test_a_model_with_no_registry_figure_is_unknown_not_zero(self):
        f = self.roll([take(1, kind="keyframe")], [job(1, model=PICTURE)], [cost(1, quantity=1, unit="image")])
        self.assertEqual((f["usd"], f["basis"], f["unknown"]), (Decimal(0), None, 1))
        self.assertIsNone(f["takes"][0]["usd"])

    def test_a_model_missing_from_the_registry_is_unknown(self):
        f = self.roll([take(1)], [job(1, model="gone-model")], [cost(1, quantity=10)])
        self.assertEqual((f["usd"], f["unknown"]), (Decimal(0), 1))

    def test_a_quantity_in_another_unit_than_the_figure_is_not_priced(self):
        for unit in ("image", None, ""):
            f = self.roll([take(1)], [job(1)], [cost(1, quantity=10, unit=unit)])
            self.assertEqual((f["usd"], f["unknown"]), (Decimal(0), 1), unit)

    def test_garbage_numbers_are_unknown(self):
        for bad in ("abc", "-1", "NaN", "Infinity", True):
            f = self.roll([take(1)], [job(1)], [cost(1, quantity=bad)])
            self.assertEqual(f["unknown"], 1, bad)

    def test_a_finished_take_with_a_job_and_no_cost_row_is_not_recorded(self):
        for status in ("completed", "failed", "superseded", "skipped"):
            f = self.roll([take(1, status=status)], [job(1)], [])
            self.assertEqual((f["takes"][0]["state"], f["unknown"]), ("not_recorded", 1), status)

    def test_a_take_in_flight_or_never_sent_is_not_an_unknown_line(self):
        f = self.roll([take(1, status="running"), take(2, status="planned")], [job(1)], [])
        self.assertEqual([t["state"] for t in f["takes"]], ["pending", "no_job"])
        self.assertEqual(f["unknown"], 0)

    def test_a_model_priced_in_variants_is_estimated_at_its_dearest_variant(self):
        figs = [{"id": CLIP, "usd_per_unit": "0.05", "price_unit": "second",
                 "variant_prices": {"720p": 0.05, "1080p": 0.08, "4k": None}}]
        f = self.roll([take(1)], [job(1)], [cost(1, quantity=10)], figs)
        self.assertEqual((f["usd"], f["basis"], f["unknown"]), (Decimal("0.80"), "estimated_highest", 0))

    def test_gemini_3_1_flash_image_from_the_real_registry_is_priced_at_its_4k_figure(self):
        import json
        from pathlib import Path

        doc = json.loads((Path(__file__).resolve().parent.parent / "schemas" / "model_registry.json").read_text())
        entry = next(m for m in (doc["models"] if isinstance(doc, dict) else doc) if m["id"] == "gemini-3.1-flash-image")
        pricing = entry["pricing"]
        self.assertEqual((pricing["provider_usd_per_unit"], pricing["variants"]["prices"]["4K"]), (0.067, 0.15))
        # What PostgREST hands the bot for this row: the three path selects of sources._film_costs.
        fig = {"id": entry["id"], "usd_per_unit": str(pricing["provider_usd_per_unit"]), "price_unit": pricing["unit"],
               "variant_prices": pricing["variants"]["prices"]}
        self.assertEqual(analysis.film_unit_price(fig), ("estimated_highest", Decimal("0.15")))
        f = self.roll([take(1, kind="keyframe")], [job(1, model=entry["id"])], [cost(1, quantity=2, unit="image")], [fig])
        self.assertEqual((f["usd"], f["basis"]), (Decimal("0.30"), "estimated_highest"))

    def test_a_variant_table_with_no_figure_is_unknown_never_the_base_figure(self):
        figs = [{"id": CLIP, "usd_per_unit": "0.05", "price_unit": "second", "variant_prices": {"720p": None, "1080p": None}}]
        f = self.roll([take(1)], [job(1)], [cost(1, quantity=10)], figs)
        self.assertEqual((f["usd"], f["basis"], f["unknown"]), (Decimal(0), None, 1))

    def test_a_single_price_and_a_variant_price_together_say_both(self):
        figs = FIGURES + [{"id": "img-v", "usd_per_unit": "0.04", "price_unit": "image", "variant_prices": {"1K": 0.04, "4K": 0.1}}]
        f = self.roll([take(1), take(2, kind="keyframe")], [job(1), job(2, model="img-v")],
                      [cost(1, quantity=10), cost(2, quantity=1, unit="image")], figs)
        self.assertEqual((f["usd"], f["basis"]), (Decimal("0.60"), "estimated_mixed"))
        self.assertEqual([t["basis"] for t in f["takes"]], ["estimated", "estimated_highest"])

    def test_another_films_rows_are_never_summed(self):
        f = self.roll([take(1), take(1, film=FILM2)], [job(1), job(1, film=FILM2)],
                      [cost(1, quantity=10), cost(1, film=FILM2, quantity=1000)])
        self.assertEqual(f["usd"], Decimal("0.50"))


# ── the alerts ───────────────────────────────────────────────────────────────

class SpendAlertTestCase(unittest.TestCase):
    def test_below_the_warn_line_nothing(self):
        self.assertEqual(spend_alerts(tables_for([100])), [])          # USD 5.00

    def test_at_the_warn_line_one_warning_keyed_on_the_film_and_the_line(self):
        a = spend_alerts(tables_for([60, 60]))                           # USD 6.00
        self.assertEqual([(x.kind, x.severity, x.key, x.cooldown_min) for x in a],
                         [("film", "warn", f"film:spend:{FILM}:6", 0)])
        line = a[0].line
        for word in ("USD 6.00", "estimated (registry figure)", "USD 6.00 (stop line USD 8.00)", FILM[:8], ORG[:8]):
            self.assertIn(word, line)
        self.assertNotIn(FILM, line)
        self.assertNotIn(ORG, line)
        self.assertNotIn("measured", line)

    def test_at_the_stop_line_one_critical_naming_the_stop_ladder_and_the_unknown_lines(self):
        a = spend_alerts(tables_for([100, 60]))                          # USD 8.00
        self.assertEqual([(x.severity, x.key) for x in a], [("critical", f"film:spend:{FILM}:8")])
        line = a[0].line
        for word in ("Stop the film by hand now (runbook step 6", "set_org_film_studio_enabled", "film_cancel_segment",
                     "NIGHTSHIFT_FILM_WORKER", "Unknown lines are not included: check the vendor billing pages",
                     "estimated (registry figure)"):
            self.assertIn(word, line)

    def test_a_variant_estimate_is_labelled_highest_variant_in_every_language(self):
        t = tables_for([120])
        t["model_registry"] = [{"id": CLIP, "usd_per_unit": "0.05", "price_unit": "second",
                                "variant_prices": {"720p": 0.05, "1080p": 0.06}}]            # 120 s x 0.06 = 7.20
        words = {"en": "estimated (highest variant)", "ru": "оценка (самый дорогой вариант)",
                 "uz": "taxminiy (eng qimmat variant)"}
        for lang in LANGUAGES:
            a = spend_alerts(t, lang=lang)
            self.assertEqual([x.key for x in a], [f"film:spend:{FILM}:6"])
            self.assertIn("7.20", a[0].line)
            self.assertIn(words[lang], a[0].line)

    def test_a_recorded_figure_is_labelled_recorded(self):
        t = tables_for([], extra_takes=[take(1)], extra_jobs=[job(1)], extra_costs=[cost(1, usd="6.10")])
        a = spend_alerts(t)
        self.assertIn("USD 6.10 at its vendors so far, recorded", a[0].line)

    def test_custom_lines_from_the_config_shape_the_key(self):
        cfg = OperatorConfig(film_spend_warn_usd=Decimal("2.5"), film_spend_stop_usd=Decimal("4"))
        self.assertEqual([x.key for x in spend_alerts(tables_for([60]), cfg=cfg)], [f"film:spend:{FILM}:2.5"])

    def test_an_unknown_line_warns_and_is_never_counted(self):
        # USD 5.00 known, plus a failed retry whose job has no cost row and a picture with no registry figure.
        t = tables_for([100], extra_takes=[take(2, status="superseded"), take(3, kind="keyframe")],
                       extra_jobs=[job(2), job(3, model=PICTURE)], extra_costs=[cost(3, quantity=1, unit="image")])
        a = spend_alerts(t)
        self.assertEqual([(x.severity, x.key) for x in a], [("warn", f"film:spend_unrecorded:{FILM}")])
        line = a[0].line
        self.assertIn("2 vendor line(s) have no dollar figure", line)
        self.assertIn("Known so far: USD 5.00", line)
        self.assertIn("plus 2 unknown line(s), not counted", line)

    def test_a_film_with_only_unknown_lines_reads_no_figure_known_not_zero_dollars_measured(self):
        t = tables_for([], extra_takes=[take(1, kind="keyframe")], extra_jobs=[job(1, model=PICTURE)],
                       extra_costs=[cost(1, quantity=1, unit="image")])
        a = spend_alerts(t)
        self.assertEqual([x.key for x in a], [f"film:spend_unrecorded:{FILM}"])
        self.assertIn("no dollar figure known yet", a[0].line)

    def test_each_fires_once(self):
        engine, tg, _ops, sync, clock = build()
        self.assertTrue(engine.tick().baseline)
        sync.tables.update(tables_for([100, 60], extra_takes=[take(9, status="failed")], extra_jobs=[job(9)]))
        rep = engine.tick()
        self.assertEqual(rep.sent, 2)
        for _ in range(3):
            clock.advance(minutes=10)
            sync.tables["worker_status"] = healthy_tables(clock.now)["worker_status"]
            sync.tables["provider_balances"] = healthy_tables(clock.now)["provider_balances"]
            engine.tick()
        texts = "\n".join(tg.texts())
        self.assertEqual(texts.count("STOP line"), 1)
        self.assertEqual(texts.count("have no dollar figure"), 1)

    def test_a_settled_segment_inside_the_day_is_watched_and_an_older_one_is_not(self):
        recent = tables_for([200], segments=[seg(status="settled", settled_minutes=60)])
        self.assertEqual([x.severity for x in spend_alerts(recent)], ["critical"])
        old = tables_for([200], segments=[seg(status="settled", settled_minutes=60 * 25)])
        self.assertEqual(spend_alerts(old), [])

    def test_a_source_that_cannot_answer_raises_nothing_and_health_says_why(self):
        for table in ("film_segments", "film_takes", "creative_jobs", "creative_job_costs", "model_registry"):
            with self.subTest(table=table):
                self.assertEqual(spend_alerts(tables_for([200]), fail=(table,)), [])
                _e, _t, ops, _s, _c = build(tables_for([200]), fail=(table,))
                self.assertIn("Film spend: unknown", views.film_spend_line(ops, "en"))

    def test_a_refused_config_raises_no_spend_alert_and_health_names_the_variable(self):
        cfg = OperatorConfig.from_env({FILM_SPEND_WARN_ENV: "lots"})
        self.assertEqual(spend_alerts(tables_for([200]), cfg=cfg), [])
        _e, _t, ops, _s, _c = build(tables_for([200]), cfg=cfg)
        for lang in LANGUAGES:
            line = views.film_spend_line(ops, lang)
            self.assertIn(FILM_SPEND_WARN_ENV, line)
            self.assertNotIn("lots", line)

    def test_health_shows_the_dearest_film_its_basis_the_unknowns_and_both_lines(self):
        t = tables_for([100], extra_takes=[take(2, status="failed")], extra_jobs=[job(2)])
        _e, _t, ops, _s, _c = build(t)
        line = views.film_spend_line(ops, "en")
        for word in ("1 film(s)", FILM[:8], "USD 5.00", "estimated (registry figure)", "1 unknown line(s) in all",
                     "warn USD 6.00", "stop USD 8.00"):
            self.assertIn(word, line)
        self.assertIn(line, views.view_health(ops, "en").text)
        _e, _t, ops, _s, _c = build({"film_segments": []})
        self.assertIn("no film with an open or recently settled segment", views.film_spend_line(ops, "en"))

    def test_the_reads_select_no_prompt_params_error_or_price_source(self):
        _e, _t, ops, sync, _c = build(tables_for([100]))
        ops.film_spend(NOW - timedelta(hours=24))
        selects = [p.get("select", "") for tbl, p in sync.reads
                   if tbl in ("film_segments", "film_takes", "creative_jobs", "creative_job_costs", "model_registry")]
        self.assertTrue(selects)
        for s in selects:
            for word in ("prompt", "params", "error", "price_source", "*"):
                self.assertNotIn(word, s)
        self.assertIn("id,usd_per_unit:spec->pricing->>provider_usd_per_unit,price_unit:spec->pricing->>unit,"
                      "variant_prices:spec->pricing->variants->prices", selects)

    def test_no_line_in_any_language_carries_a_secret_a_prompt_or_a_full_id(self):
        t = tables_for([100, 60], extra_takes=[take(3, status="failed")], extra_jobs=[job(3)])
        with mock.patch.dict(os.environ, {"SUPABASE_SERVICE_KEY": KEY}):
            for lang in LANGUAGES:
                lines = [a.line for a in spend_alerts(t, lang=lang)]
                _e, _t, ops, _s, _c = build(t)
                lines.append(views.film_spend_line(ops, lang))
                self.assertEqual(len(lines), 3)
                for line in lines:
                    for bad in (KEY, PROMPT, "PRICE-SOURCE-TEXT", FILM, ORG, "{"):
                        self.assertNotIn(bad, line, (lang, line))


# ── the one-shot CLI ─────────────────────────────────────────────────────────

class CliTestCase(unittest.TestCase):
    def run_cli(self, argv, tables=None, env=None):
        _o, sync = make_ops(tables if tables is not None else {})
        lines: list = []
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"SUPABASE_SERVICE_KEY": KEY, **(env or {})}), redirect_stdout(buf):
            code = cli.main(argv, sync=sync, out=lines.append)
        return code, "\n".join(lines) + buf.getvalue()

    def film_tables(self):
        t = tables_for([100, 40], extra_takes=[take(3, status="superseded"), take(4, kind="keyframe"),
                                                take(5, status="running"), take(6, status="planned")],
                       extra_jobs=[job(3), job(4, model=PICTURE), job(5)],
                       extra_costs=[cost(4, quantity=1, unit="image")])
        t["films"] = [{"id": FILM, "org_id": ORG}]
        return t

    def test_it_prints_the_total_each_take_and_the_lines(self):
        code, text = self.run_cli(["--film", FILM], self.film_tables())
        self.assertEqual(code, 0)
        for word in (f"Film {FILM} (org {ORG[:8]})", "warn USD 6.00, stop USD 8.00",
                     "Known vendor cost: USD 7.00, estimated (registry figure); plus 2 unknown line(s), NOT counted",
                     "not recorded", "unknown", "in flight, no cost row yet", "no vendor call",
                     "USD 5.00 estimated (registry figure)", "At or above the warn line",
                     "Unknown lines are not included: check the vendor billing pages"):
            self.assertIn(word, text)
        self.assertNotIn(KEY, text)
        self.assertNotIn(PROMPT, text)

    def test_at_the_stop_line_it_says_stop_by_hand(self):
        t = self.film_tables()
        t["creative_job_costs"][0]["quantity"] = 200
        _code, text = self.run_cli(["--film", FILM], t)
        self.assertIn("AT OR ABOVE THE STOP LINE: stop the film by hand now (runbook step 6)", text)

    def test_it_refuses_a_malformed_line_a_bad_id_a_missing_film_and_a_failed_read(self):
        code, text = self.run_cli(["--film", FILM], self.film_tables(), {FILM_SPEND_STOP_ENV: "ten"})
        self.assertEqual(code, 2)
        self.assertIn(FILM_SPEND_STOP_ENV, text)
        self.assertNotIn("ten", text.replace(FILM_SPEND_STOP_ENV, "").replace("written", ""))
        code, text = self.run_cli(["--film", "1; drop table films"], self.film_tables())
        self.assertEqual(code, 2)
        self.assertNotIn("drop table", text)
        code, text = self.run_cli(["--film", FILM2], self.film_tables())
        self.assertEqual((code, "not found" in text), (2, True))
        t = self.film_tables()
        _o, sync = make_ops(t, fail=("creative_job_costs",))
        lines: list = []
        with mock.patch.dict(os.environ, {"SUPABASE_SERVICE_KEY": KEY}):
            self.assertEqual(cli.main(["--film", FILM], sync=sync, out=lines.append), 2)
        self.assertIn("could not be read (unavailable)", "\n".join(lines))
        self.assertNotIn(KEY, "\n".join(lines))

    def test_without_supabase_it_refuses(self):
        lines: list = []
        self.assertEqual(cli.main(["--film", FILM], sync=mock.Mock(enabled=False), out=lines.append), 2)
        self.assertIn("SUPABASE_URL and SUPABASE_SERVICE_KEY are not set", lines[0])


if __name__ == "__main__":
    unittest.main()
