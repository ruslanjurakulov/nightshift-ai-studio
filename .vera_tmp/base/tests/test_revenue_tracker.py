"""Revenue tracking (roadmap #71) — pure, offline.

The point of these tests is the two rules that make the figure honest: revenue
is USD and RPM is revenue/views×1000, and a video with no reported revenue is
*unknown* (excluded from totals and RPM), never a $0 earner that would drag an
average down. No network, no disk — build_report is pure."""

import unittest

from modules import revenue_tracker as rt


def _row(revenue=None, views=None):
    row = {}
    if revenue is not None:
        row["estimatedRevenue"] = revenue
    if views is not None:
        row["views"] = views
    return row


class RevenueFromRowTestCase(unittest.TestCase):
    def test_reads_usd_revenue(self):
        self.assertEqual(rt.revenue_from_row(_row(revenue="12.5")), 12.5)

    def test_missing_or_blank_is_none_not_zero(self):
        self.assertIsNone(rt.revenue_from_row(_row()))
        self.assertIsNone(rt.revenue_from_row(_row(revenue="")))
        self.assertIsNone(rt.revenue_from_row({"estimatedRevenue": None}))

    def test_negative_and_nonnumeric_are_unmeasured(self):
        self.assertIsNone(rt.revenue_from_row(_row(revenue=-3.0)))
        self.assertIsNone(rt.revenue_from_row(_row(revenue="abc")))

    def test_non_dict_is_none(self):
        self.assertIsNone(rt.revenue_from_row(None))
        self.assertIsNone(rt.revenue_from_row("12.0"))


class BuildReportTestCase(unittest.TestCase):
    def test_rpm_and_total_over_measured(self):
        rows = {
            "a": _row(revenue=10.0, views=1000),   # RPM 10.0
            "b": _row(revenue=6.0, views=2000),    # RPM 3.0
        }
        report = rt.build_report(rows)
        self.assertEqual(report.total_usd, 16.0)
        self.assertEqual(report.measured_count, 2)
        self.assertEqual(report.video_count, 2)
        # channel RPM = 16 / 3000 * 1000
        self.assertAlmostEqual(report.channel_rpm_usd, 16.0 / 3000 * 1000, places=3)
        self.assertEqual(report.currency, "USD")
        # best earner first
        self.assertEqual(report.top_earner.video_id, "a")
        by_id = {v.video_id: v for v in report.videos}
        self.assertEqual(by_id["a"].rpm_usd, 10.0)
        self.assertEqual(by_id["b"].rpm_usd, 3.0)

    def test_unmeasured_video_excluded_not_zeroed(self):
        rows = {
            "a": _row(revenue=10.0, views=1000),
            "b": _row(views=5000),          # measured views, unknown revenue
            "c": {},                        # nothing at all
        }
        report = rt.build_report(rows)
        # total and RPM ignore b and c entirely — not counted as $0 earners
        self.assertEqual(report.total_usd, 10.0)
        self.assertEqual(report.measured_count, 1)
        self.assertEqual(report.video_count, 3)
        self.assertAlmostEqual(report.channel_rpm_usd, 10.0, places=3)  # 10/1000*1000
        by_id = {v.video_id: v for v in report.videos}
        self.assertIsNone(by_id["b"].revenue_usd)
        self.assertIsNone(by_id["b"].rpm_usd)
        self.assertFalse(by_id["b"].measured)

    def test_no_revenue_anywhere_is_none_total(self):
        report = rt.build_report({"a": _row(views=100), "b": {}})
        self.assertIsNone(report.total_usd)          # "not measured", not 0.0
        self.assertIsNone(report.channel_rpm_usd)
        self.assertFalse(report.has_revenue)
        self.assertIsNone(report.top_earner)
        self.assertEqual(report.measured_count, 0)
        self.assertEqual(report.video_count, 2)

    def test_empty_input(self):
        report = rt.build_report({})
        self.assertIsNone(report.total_usd)
        self.assertEqual(report.video_count, 0)
        self.assertEqual(report.videos, ())
        self.assertFalse(report.has_revenue)

    def test_no_rpm_without_views(self):
        report = rt.build_report({"a": _row(revenue=5.0)})   # revenue, no views
        v = report.videos[0]
        self.assertEqual(v.revenue_usd, 5.0)
        self.assertIsNone(v.views)
        self.assertIsNone(v.rpm_usd)                 # can't divide by unknown views
        self.assertEqual(report.total_usd, 5.0)
        self.assertIsNone(report.channel_rpm_usd)    # no measured views to divide by

    def test_views_fallback_from_metrics(self):
        # revenue row omits views; the metrics snapshot supplies them for RPM
        report = rt.build_report(
            {"a": _row(revenue=4.0)},
            views_by_video={"a": {"views": 2000}},
        )
        self.assertEqual(report.videos[0].rpm_usd, 2.0)   # 4 / 2000 * 1000
        self.assertEqual(report.videos[0].views, 2000)

    def test_row_views_win_over_fallback(self):
        report = rt.build_report(
            {"a": _row(revenue=4.0, views=1000)},
            views_by_video={"a": 9999},
        )
        self.assertEqual(report.videos[0].views, 1000)
        self.assertEqual(report.videos[0].rpm_usd, 4.0)

    def test_blank_video_id_skipped(self):
        report = rt.build_report({"  ": _row(revenue=1.0, views=10)})
        self.assertEqual(report.video_count, 0)


class SummarizeTestCase(unittest.TestCase):
    def test_summary_is_small_and_usd(self):
        rows = {str(i): _row(revenue=float(i), views=1000) for i in range(1, 9)}
        report = rt.build_report(rows)
        summary = rt.summarize(report)
        self.assertEqual(summary["currency"], "USD")
        self.assertEqual(summary["measured_count"], 8)
        self.assertEqual(summary["video_count"], 8)
        self.assertEqual(summary["total_usd"], report.total_usd)
        # top earners capped, highest first
        self.assertEqual(len(summary["top_earners"]), 5)
        self.assertEqual(summary["top_earners"][0]["video_id"], "8")

    def test_summary_when_nothing_measured(self):
        summary = rt.summarize(rt.build_report({"a": {}}))
        self.assertIsNone(summary["total_usd"])
        self.assertEqual(summary["top_earners"], [])


if __name__ == "__main__":
    unittest.main()
