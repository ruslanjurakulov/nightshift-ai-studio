"""Tests for modules/series.py — the Series model and its registry.

Mirrors the safety posture proven for channels: parsing tolerates messy rows,
loading degrades (Supabase → file → empty) and never raises, and unknown ids
fail loudly. No real Supabase or filesystem is touched — a fake sync is
injected and the file path points at a tempdir.
"""

import json
import tempfile
import unittest
from pathlib import Path

from modules.series import (
    STATUS_ACTIVE,
    STATUS_PAUSED,
    Series,
    SeriesRegistry,
    effective_cadence,
    effective_niche,
    effective_visual_style,
    effective_voice_style,
    normalize_automation_level,
    normalize_status,
    resolve_series,
    style_keywords,
    validate_series_id,
)


class _FakeSync:
    """Stand-in for SupabaseSync: enabled flag + a canned select()."""

    def __init__(self, rows, enabled=True, raise_on_select=False):
        self._rows = rows
        self.enabled = enabled
        self._raise = raise_on_select

    def select(self, table):
        assert table == "content_series"
        if self._raise:
            raise RuntimeError("supabase down")
        return self._rows


class NormalizationTestCase(unittest.TestCase):
    def test_status_defaults_to_paused(self):
        self.assertEqual(normalize_status(None), STATUS_PAUSED)
        self.assertEqual(normalize_status(""), STATUS_PAUSED)
        self.assertEqual(normalize_status("weird"), STATUS_PAUSED)
        self.assertEqual(normalize_status("active"), STATUS_ACTIVE)
        self.assertEqual(normalize_status("Archived"), "ARCHIVED")

    def test_automation_level_defaults_to_manual(self):
        self.assertEqual(normalize_automation_level(None), "manual")
        self.assertEqual(normalize_automation_level("FULL_AUTOPILOT"), "full_autopilot")
        self.assertEqual(normalize_automation_level("nonsense"), "manual")

    def test_validate_series_id(self):
        self.assertEqual(validate_series_id("ancient-mysteries"), "ancient-mysteries")
        for bad in ["", "-leading", "Has Space", "UPPER", "way" + "x" * 80]:
            with self.assertRaises(ValueError):
                validate_series_id(bad)


class FromRowTestCase(unittest.TestCase):
    def test_parses_full_row(self):
        s = Series.from_row({
            "series_id": "ancient-mysteries",
            "channel_id": "history",
            "name": "Ancient Mysteries",
            "niche": "history",
            "language": "English",
            "format": "8–12 min long + 5 Shorts",
            "content_type": "mixed",
            "cadence": {"long_per_week": 2, "shorts_per_day": 1},
            "platforms": ["youtube", "tiktok", "instagram"],
            "automation_level": "autopilot_approval",
            "status": "ACTIVE",
        })
        self.assertEqual(s.series_id, "ancient-mysteries")
        self.assertEqual(s.channel_id, "history")
        self.assertEqual(s.cadence, {"long_per_week": 2, "shorts_per_day": 1})
        self.assertEqual(s.platforms, ("youtube", "tiktok", "instagram"))
        self.assertTrue(s.is_active)

    def test_tolerates_json_string_fields_and_missing_keys(self):
        """A series.json file may store platforms/cadence as JSON strings."""
        s = Series.from_row({
            "series_id": "faceless-daily",
            "platforms": '["youtube","tiktok"]',
            "cadence": '{"shorts_per_day": 3}',
        })
        self.assertEqual(s.platforms, ("youtube", "tiktok"))
        self.assertEqual(s.cadence, {"shorts_per_day": 3})
        # Missing everything else → safe defaults, PAUSED, one platform default.
        self.assertEqual(s.channel_id, "default")
        self.assertEqual(s.status, STATUS_PAUSED)
        self.assertEqual(s.automation_level, "manual")

    def test_empty_platforms_defaults_to_youtube(self):
        s = Series.from_row({"series_id": "x", "platforms": []})
        self.assertEqual(s.platforms, ("youtube",))

    def test_to_dict_round_trips(self):
        row = {
            "series_id": "s1", "channel_id": "c1", "name": "N",
            "platforms": ["youtube"], "cadence": {"long_per_week": 1},
            "status": "ACTIVE", "automation_level": "assisted",
        }
        self.assertEqual(Series.from_row(Series.from_row(row).to_dict()).to_dict()["series_id"], "s1")


class SeriesRegistryTestCase(unittest.TestCase):
    def _series(self, sid, channel="default", status="ACTIVE", created=None):
        return Series.from_row({
            "series_id": sid, "channel_id": channel, "status": status,
            "created_at": created,
        })

    def test_explicit_list_short_circuits_sources(self):
        reg = SeriesRegistry([self._series("a"), self._series("b")])
        self.assertEqual({s.series_id for s in reg.list()}, {"a", "b"})

    def test_get_unknown_raises(self):
        reg = SeriesRegistry([self._series("a")])
        with self.assertRaises(KeyError):
            reg.get("missing")

    def test_list_filters_by_channel_and_status(self):
        reg = SeriesRegistry([
            self._series("a", channel="history", status="ACTIVE"),
            self._series("b", channel="history", status="PAUSED"),
            self._series("c", channel="finance", status="ACTIVE"),
        ])
        self.assertEqual({s.series_id for s in reg.list(channel_id="history")}, {"a", "b"})
        self.assertEqual({s.series_id for s in reg.active(channel_id="history")}, {"a"})
        self.assertEqual({s.series_id for s in reg.active()}, {"a", "c"})

    def test_list_orders_newest_first(self):
        reg = SeriesRegistry([
            self._series("old", created="2026-01-01T00:00:00Z"),
            self._series("new", created="2026-09-01T00:00:00Z"),
        ])
        self.assertEqual([s.series_id for s in reg.list()], ["new", "old"])

    def test_loads_from_supabase_when_enabled(self):
        sync = _FakeSync([{"series_id": "from-db", "status": "ACTIVE"}])
        reg = SeriesRegistry(sync=sync, file_path="/nonexistent/series.json")
        self.assertEqual([s.series_id for s in reg.list()], ["from-db"])

    def test_supabase_failure_falls_through_to_empty(self):
        sync = _FakeSync([], raise_on_select=True)
        reg = SeriesRegistry(sync=sync, file_path="/nonexistent/series.json")
        self.assertEqual(reg.list(), [])  # never raises

    def test_loads_from_file_when_supabase_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "series.json"
            path.write_text(json.dumps({"series": [{"series_id": "from-file", "status": "ACTIVE"}]}))
            reg = SeriesRegistry(sync=_FakeSync([], enabled=False), file_path=path)
            self.assertEqual([s.series_id for s in reg.list()], ["from-file"])

    def test_malformed_file_degrades_to_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "series.json"
            path.write_text("{not valid json")
            reg = SeriesRegistry(sync=_FakeSync([], enabled=False), file_path=path)
            self.assertEqual(reg.list(), [])


class PipelineHelpersTestCase(unittest.TestCase):
    def _series(self, sid, niche="history", status="ACTIVE"):
        return Series.from_row({"series_id": sid, "niche": niche, "status": status})

    def test_resolve_series_none_for_empty(self):
        self.assertIsNone(resolve_series(None))
        self.assertIsNone(resolve_series(""))

    def test_resolve_series_returns_from_registry(self):
        reg = SeriesRegistry([self._series("ancient")])
        s = resolve_series("ancient", registry=reg)
        self.assertIsNotNone(s)
        self.assertEqual(s.series_id, "ancient")

    def test_resolve_series_unknown_id_returns_none_not_raise(self):
        reg = SeriesRegistry([self._series("ancient")])
        # An overlay that can't be found must not stop a run.
        self.assertIsNone(resolve_series("missing", registry=reg))

    def test_effective_niche_precedence(self):
        s = self._series("x", niche="finance")
        # explicit wins over everything
        self.assertEqual(effective_niche("space", s, "gaming"), "space")
        # then the series' niche over the channel's
        self.assertEqual(effective_niche(None, s, "gaming"), "finance")
        # then the channel's over the default
        self.assertEqual(effective_niche(None, None, "gaming"), "gaming")
        # then the long-standing default
        self.assertEqual(effective_niche(None, None, None), "history mysteries")
        # a series with an empty niche falls through to the channel's
        self.assertEqual(effective_niche(None, self._series("y", niche=""), "gaming"), "gaming")

    def test_effective_visual_and_voice_style_precedence(self):
        s = Series(series_id="x", visual_style="dark cinematic", voice_style="calm narrator")
        # explicit wins
        self.assertEqual(effective_visual_style("neon", s, "plain"), "neon")
        # then the series
        self.assertEqual(effective_visual_style(None, s, "plain"), "dark cinematic")
        self.assertEqual(effective_voice_style(None, s, "plain"), "calm narrator")
        # then the channel default
        self.assertEqual(effective_visual_style(None, None, "plain"), "plain")
        # empty when nothing set — a run may legitimately have no style opinion
        self.assertEqual(effective_visual_style(None, None, None), "")
        self.assertEqual(effective_voice_style(None, None, None), "")

    def test_effective_cadence_is_a_copy(self):
        s = Series(series_id="x", cadence={"long_per_week": 2})
        got = effective_cadence(s)
        self.assertEqual(got, {"long_per_week": 2})
        got["long_per_week"] = 99  # mutating the result must not touch the Series
        self.assertEqual(s.cadence, {"long_per_week": 2})
        # no series → empty dict
        self.assertEqual(effective_cadence(None), {})

    def test_style_keywords_tokenizes_and_caps(self):
        self.assertEqual(style_keywords("dark, cinematic, moody"), ["dark", "cinematic", "moody"])
        # connective words dropped, de-duplicated, capped
        self.assertEqual(
            style_keywords("a very cinematic and cinematic dramatic epic wide look", limit=3),
            ["cinematic", "dramatic", "epic"],
        )
        # empty in → empty out (no style means no added keywords)
        self.assertEqual(style_keywords(""), [])
        self.assertEqual(style_keywords(None), [])


if __name__ == "__main__":
    unittest.main()
