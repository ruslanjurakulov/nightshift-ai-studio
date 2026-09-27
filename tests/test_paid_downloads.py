"""Paid 720p / 1080p downloads: migration 0030 pins and the worker side
(modules/paid_downloads.py) with mocked Supabase and ffmpeg.

SQL does not run in CI, so the migration tests pin what matters: the browser
only reads (org-scoped RLS) and spends through request_download (editor+);
the price formula, the minimum and the unpriced refusal; idempotent re-use and
the 7-day free re-download; credits move only through the ledger helpers; a
failed download is refunded; the worker functions are service-only."""

import os
import re
import tempfile
import time
import unittest
from pathlib import Path

from modules import paid_downloads as pd
from modules.social_publish import VideoInfo

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0030_paid_downloads.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


def fn_body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


class MigrationPins(unittest.TestCase):
    def test_rls_read_only_and_org_scoped(self):
        for table in ("download_masters", "download_requests"):
            self.assertIn(f"alter table public.{table} enable row level security;", CODE)
            self.assertRegex(CODE, rf"create policy {table}_select on public\.{table}\s+for select to authenticated\s+"
                                   rf"using \(org_id in \(select public\.accessible_org_ids\('viewer'\)\)\);")
            self.assertIn(f"revoke all on public.{table} from public, anon, authenticated, service_role;", CODE)
            policies = re.findall(rf"create policy \w+ on public\.{table}\s+for (\w+)", CODE)
            self.assertEqual(policies, ["select"])
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete)\b[^;]* to [^;]*authenticated")
        self.assertIn("grant update (heartbeat_at, updated_at) on public.download_requests to service_role;", CODE)
        self.assertNotRegex(CODE, r"\bto anon\b")

    def test_function_grants(self):
        grants = sorted(re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);", CODE))
        self.assertEqual(grants, [
            ("claim_download_request", "service_role"),
            ("finish_download_request", "service_role"),
            ("forget_download_master", "service_role"),
            ("record_download_master", "service_role"),
            ("request_download", "authenticated"),
        ])
        for fn in ("download_refund_locked", "download_fail_locked", "download_quality_side", "request_download",
                   "claim_download_request", "finish_download_request"):
            self.assertRegex(CODE, rf"revoke all on function public\.{fn}\([^)]*\) from public, anon, authenticated, service_role;")
        for fn in ("claim_download_request", "finish_download_request", "record_download_master", "forget_download_master"):
            self.assertIn("if not public.credits_trusted_caller() then", fn_body(fn), fn)
        # every definer function pins its search_path
        for m in re.finditer(r"create or replace function public\.(\w+)\([^$]*?\$\$", CODE, re.S):
            header = m.group(0)
            if "security definer" in header:
                self.assertIn("set search_path = public, pg_temp", header, m.group(1))

    def test_request_download_checks_editor_and_charges_through_the_ledger(self):
        body = fn_body("request_download")
        self.assertIn("if auth.uid() is null then", body)
        self.assertIn("if not public.is_org_member(org, 'editor') then", body)
        self.assertIn("pg_advisory_xact_lock", body)
        self.assertIn("acc := public.credit_account_lock(org);", body)
        self.assertIn("using errcode = 'NS402'", body)
        self.assertIn("format('available=%s needed=%s'", body)
        self.assertIn("public.credit_log(org, 'capture', -price, 'download:' || r.id", body)
        self.assertIn("public.credits_exempt(org)", body)
        # never trusts a browser-supplied duration: the worker-probed master
        self.assertIn("select * into m from public.download_masters where video_id = vid;", body)
        self.assertIn("least(m.width, m.height) < public.download_quality_side(q)", body)

    def test_price_formula_minimum_and_unpriced(self):
        body = fn_body("request_download")
        self.assertIn("ceil(round(m.duration_seconds * rate.credits_per_unit * (1 + rate.margin) / 60.0, 6))", body)
        self.assertIn("ceil(round(coalesce(floor_c, 0), 6))", body)
        self.assertIn("unit = format('download_%s_minute', q)", body)
        self.assertIn("unit = 'download_minimum'", body)
        self.assertIn("errcode = 'NS400'", body)  # unset price: refused, never free
        self.assertIn("price > p_max_credits", body)  # more than confirmed: refused
        self.assertIn("errcode = 'NS409'", body)
        self.assertIn("on conflict (unit) do nothing;", CODE)

    def test_idempotent_reuse_and_free_redownload(self):
        body = fn_body("request_download")
        reuse = body.index("(d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))")
        charge = body.index("public.credit_log(org, 'capture'")
        self.assertLess(reuse, charge)
        self.assertIn("'reused', true", body)
        self.assertIn("d.paid_until > now() and d.status <> 'failed'", body)
        self.assertIn("why := 'redownload';", body)
        self.assertIn("until_ := paid.paid_until;", body)
        self.assertIn("until_ := now() + interval '7 days';", body)

    def test_failure_is_refunded_once_through_the_ledger(self):
        refund = fn_body("download_refund_locked")
        self.assertIn("r.refund_txn is not null", refund)  # once
        self.assertIn("perform public.credit_account_lock(r.org_id);", refund)
        self.assertIn("public.credit_log(r.org_id, 'refund', r.charged, 'download:' || r.id", refund)
        fail = fn_body("download_fail_locked")
        self.assertIn("perform public.download_refund_locked(p_id, p_reason);", fail)
        finish = fn_body("finish_download_request")
        self.assertIn("perform public.download_fail_locked(", finish)
        self.assertIn("if r.status not in ('queued', 'processing') then\n    return r.status;", finish)
        claim = fn_body("claim_download_request")
        self.assertIn("perform public.download_fail_locked(s.id, 'interrupted'", claim)
        self.assertIn("for update skip locked", claim)
        # Balances change only in the ledger functions' transactions.
        self.assertEqual(len(re.findall(r"update public\.credit_accounts", CODE)), 2)


class FakeStore:
    def __init__(self, video=None, masters=None, videos=None):
        self._video = video
        self.finished = []
        self.beats = 0
        self.recorded = {}
        self.forgot = []
        self._masters = masters or {}
        self._videos = videos or []
        self.claims = []

    def video(self, vid):
        return self._video

    def heartbeat(self, rid, worker):
        self.beats += 1

    def finish(self, rid, worker, *, ok, bytes_=None, reason=None, error=None, ttl_hours=24):
        self.finished.append({"id": rid, "ok": ok, "bytes": bytes_, "reason": reason, "error": error})

    def videos_with_path(self, limit=1000):
        return self._videos

    def recorded_masters(self):
        return dict(self._masters)

    def record_master(self, vid, info):
        self.recorded[vid] = info

    def forget_master(self, vid):
        self.forgot.append(vid)

    def claim(self, worker):
        return self.claims.pop(0) if self.claims else None


LANDSCAPE = VideoInfo(195.0, 1920, 1080, 1000)
PORTRAIT = VideoInfo(58.0, 1080, 1920, 1000)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.out = root / "output"
        (self.out / "slug").mkdir(parents=True)
        self.master = self.out / "slug" / "final.mp4"
        self.master.write_bytes(b"MASTER" * 100)
        self.dl = root / "downloads"
        self.video = {"video_id": "v1", "local_path": "output/slug/final.mp4"}

    def tearDown(self):
        self.tmp.cleanup()

    def test_transcode_command_scales_the_short_side(self):
        argv = pd.transcode_command("ffmpeg", Path("/m.mp4"), Path("/o.mp4"), "720p", LANDSCAPE)
        self.assertEqual(argv[0], "ffmpeg")
        self.assertEqual(argv[argv.index("-vf") + 1], "scale=-2:720")
        self.assertEqual(argv[argv.index("-c:v") + 1], "libx264")
        self.assertIn("+faststart", argv)
        self.assertEqual(argv[-1], "/o.mp4")
        self.assertEqual(argv[argv.index("-i") + 1], "/m.mp4")
        portrait = pd.transcode_command("ffmpeg", Path("/m.mp4"), Path("/o.mp4"), "720p", PORTRAIT)
        self.assertEqual(portrait[portrait.index("-vf") + 1], "scale=720:-2")

    def test_plan_copies_when_master_is_that_quality(self):
        self.assertEqual(pd.plan("1080p", LANDSCAPE), "copy")
        self.assertEqual(pd.plan("720p", LANDSCAPE), "transcode")
        with self.assertRaises(pd.DownloadStop) as e:
            pd.plan("1080p", VideoInfo(10.0, 1280, 720, 1))
        self.assertEqual(e.exception.reason, "master_too_small")
        with self.assertRaises(pd.DownloadStop):
            pd.plan("720p", VideoInfo(10.0, None, None, 1))

    def test_download_path_is_by_id_only(self):
        self.assertEqual(pd.download_path(Path("/d"), 42), Path("/d/42.mp4"))
        for bad in ("../x", "0", "-1", "1/../2", "", "01", "1.5"):
            with self.assertRaises(ValueError, msg=bad):
                pd.download_path(Path("/d"), bad)

    def test_1080p_copies_the_master_without_ffmpeg(self):
        store = FakeStore(self.video)
        calls = []
        status = pd.process_request({"id": 7, "video_id": "v1", "quality": "1080p"}, store=store,
                                    output_dir=self.out, downloads_dir=self.dl, worker_id="w",
                                    probe_fn=lambda p: LANDSCAPE, runner=lambda *a, **k: calls.append(a) or 0)
        self.assertEqual(status, "ready")
        self.assertEqual(calls, [])
        f = self.dl / "7.mp4"
        self.assertEqual(f.read_bytes(), self.master.read_bytes())
        self.assertEqual(oct(f.stat().st_mode & 0o777), "0o644")
        self.assertEqual(store.finished, [{"id": 7, "ok": True, "bytes": f.stat().st_size, "reason": None, "error": None}])

    def test_720p_transcodes_into_a_part_file_then_renames(self):
        store = FakeStore(self.video)
        seen = {}

        def runner(argv, heartbeat):
            seen["argv"] = argv
            heartbeat()
            Path(argv[-1]).write_bytes(b"x" * 10)
            return 0

        status = pd.process_request({"id": 8, "video_id": "v1", "quality": "720p"}, store=store,
                                    output_dir=self.out, downloads_dir=self.dl, worker_id="w",
                                    probe_fn=lambda p: LANDSCAPE, ffmpeg_exe=lambda: "/usr/bin/ffmpeg",
                                    runner=runner)
        self.assertEqual(status, "ready")
        self.assertTrue(seen["argv"][-1].endswith("8.part.mp4"))
        self.assertEqual(seen["argv"][seen["argv"].index("-i") + 1], str(self.master.resolve()))
        self.assertEqual(store.beats, 1)
        self.assertTrue((self.dl / "8.mp4").exists())
        self.assertFalse((self.dl / "8.part.mp4").exists())

    def test_failures_are_reported_for_refund_and_leave_no_file(self):
        store = FakeStore(self.video)
        status = pd.process_request({"id": 9, "video_id": "v1", "quality": "720p"}, store=store,
                                    output_dir=self.out, downloads_dir=self.dl, worker_id="w",
                                    probe_fn=lambda p: LANDSCAPE, ffmpeg_exe=lambda: "ffmpeg",
                                    runner=lambda argv, hb: Path(argv[-1]).write_bytes(b"half") and 1)
        self.assertEqual(status, "failed")
        self.assertEqual(store.finished[0]["ok"], False)
        self.assertEqual(store.finished[0]["reason"], "transcode_failed")
        self.assertEqual(list(self.dl.iterdir()), [])

    def test_missing_master_and_unexpected_errors_fail_cleanly(self):
        store = FakeStore({"video_id": "v1", "local_path": "/etc/passwd"})
        pd.process_request({"id": 10, "video_id": "v1", "quality": "720p"}, store=store, output_dir=self.out,
                           downloads_dir=self.dl, worker_id="w", probe_fn=lambda p: LANDSCAPE)
        self.assertEqual(store.finished[-1]["reason"], "master_not_available")

        def boom(p):
            raise OSError("secret-ish detail")

        store = FakeStore(self.video)
        pd.process_request({"id": 11, "video_id": "v1", "quality": "720p"}, store=store, output_dir=self.out,
                           downloads_dir=self.dl, worker_id="w", probe_fn=boom)
        self.assertEqual(store.finished[-1]["reason"], "worker_error")
        self.assertNotIn("secret-ish", store.finished[-1]["error"])

    def test_gc_deletes_expired_and_stale_part_files(self):
        self.dl.mkdir()
        now = time.time()
        fresh, old, part = self.dl / "1.mp4", self.dl / "2.mp4", self.dl / "3.part.mp4"
        other = self.dl / "notes.txt"
        for f in (fresh, old, part, other):
            f.write_bytes(b"x")
        os.utime(old, (now - 26 * 3600, now - 26 * 3600))
        os.utime(part, (now - 7 * 3600, now - 7 * 3600))
        os.utime(other, (now - 90 * 3600, now - 90 * 3600))
        self.assertEqual(pd.gc_downloads(self.dl, now=now), 2)
        self.assertEqual(sorted(p.name for p in self.dl.iterdir()), ["1.mp4", "notes.txt"])

    def test_master_sync_records_new_and_forgets_vanished(self):
        store = FakeStore(masters={"gone": 5}, videos=[self.video, {"video_id": "v2", "local_path": "output/none.mp4"}])
        svc = pd.DownloadService("u", "k", output_dir=self.out, downloads_dir=self.dl, worker_id="w",
                                 store=store, probe_fn=lambda p: LANDSCAPE, clock=lambda: 0.0)
        self.assertEqual(svc.sync_masters(), 2)
        self.assertEqual(list(store.recorded), ["v1"])
        self.assertEqual(store.forgot, ["gone"])
        # rate-limited, and unchanged masters are not probed again
        self.assertEqual(svc.sync_masters(), 0)
        store.recorded.clear()
        store._masters = {"v1": self.master.stat().st_size}
        self.assertEqual(svc.sync_masters(force=True), 0)
        self.assertEqual(store.recorded, {})

    def test_run_once_claims_one_request(self):
        store = FakeStore(self.video)
        store.claims = [{"id": 12, "video_id": "v1", "quality": "1080p"}]
        svc = pd.DownloadService("u", "k", output_dir=self.out, downloads_dir=self.dl, worker_id="w",
                                 store=store, probe_fn=lambda p: LANDSCAPE)
        self.assertTrue(svc.run_once())
        self.assertFalse(svc.run_once())
        self.assertTrue((self.dl / "12.mp4").exists())


class DeployWiring(unittest.TestCase):
    def test_web_mounts_only_the_downloads_volume_read_only(self):
        compose = (ROOT / "deploy" / "docker-compose.yml").read_text()
        self.assertIn("- worker_downloads:/data/downloads:ro", compose)
        self.assertIn("- worker_downloads:/app/downloads", compose)
        self.assertIn("NIGHTSHIFT_DOWNLOADS_DIR: /data/downloads", compose)
        self.assertIn("NIGHTSHIFT_DOWNLOADS_DIR: /app/downloads", compose)
        self.assertNotIn("worker_output:/data", compose)

    def test_queue_worker_runs_downloads_between_jobs(self):
        src = (ROOT / "tools" / "queue_worker.py").read_text()
        self.assertIn("published = self._download_one() or published", src)
        self.assertIn("paid_downloads.DownloadService(", src)


if __name__ == "__main__":
    unittest.main()
