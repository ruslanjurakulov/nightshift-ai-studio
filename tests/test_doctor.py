"""tools/doctor.py - the read-only readiness check. No network: HTTP is a fake.

What these pin: nothing secret ever reaches the output (not a value, a prefix
or a length), a switch that is on while its key is empty is a FAIL (CLAUDE.md
#4), only GET goes out (plus the one YouTube token refresh), the offline modes
make no request, and every non-pass line carries a next step.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools import doctor as d
from tools.doctor import FAIL, PASS, SKIP, UNVERIFIED, WARN, Resp

NOW = datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc)
GB = 1024 ** 3
# Long, distinctive, token-shaped: if any fragment shows up in output the test fails.
SECRETS = {
    "GEMINI_API_KEY": "Qz7GEMsent0123456789abcdefQx",
    "PEXELS_API_KEY": "Wv9PEXsent0123456789abcdefWx",
    "ELEVENLABS_API_KEY": "Jk3ELVsent0123456789abcdefJx",
    "SUPABASE_SERVICE_KEY": "Hn5SUPsent0123456789abcdefHx",
    "KLING_API_KEY": "Bt2KLNsent0123456789abcdefBx",
    "FAL_KEY": "Rm8FALsent0123456789abcdefRx",
}
VOICE = "A" * 20


class FakeHttp:
    """Answers by (method, url substring); records every call."""

    def __init__(self, routes=None):
        self.routes = list(routes or [])
        self.calls = []

    def _answer(self, method, url, headers=None, params=None, data=None):
        self.calls.append((method, url, dict(headers or {}), dict(params or {}), dict(data or {})))
        for m, needle, resp in self.routes:
            if m == method and needle in url:
                return resp(url, params) if callable(resp) else resp
        return Resp(404)

    def get(self, url, headers=None, params=None):
        return self._answer("GET", url, headers, params)

    def post_form(self, url, data):
        return self._answer("POST", url, None, None, data)

    @property
    def methods(self):
        return {c[0] for c in self.calls}


def sb(**tables):
    """Supabase routes: {table: Resp}. Unlisted tables answer 200 with []."""
    def route(url, params):
        for table, resp in tables.items():
            if f"/rest/v1/{table}" in url:
                return resp
        return Resp(200, [])
    return [("GET", "/rest/v1/", route), ("GET", "/storage/v1/bucket/previews", Resp(200, {}))]


def make_ctx(env=None, routes=None, free_gb=50, ffmpeg=True, whisper=True, tmp=None, **kw):
    base = {"SUPABASE_URL": "https://abc.supabase.co", **SECRETS, "TTS_PROVIDER": "elevenlabs",
            "ELEVENLABS_VOICE_ID": VOICE, "ELEVENLABS_SECONDARY_VOICE_ID": "narrator"}
    base.update(env or {})
    base = {k: v for k, v in base.items() if v is not None}
    cache = Path(tmp or "/nonexistent")
    return d.Ctx(env=base, http=FakeHttp(routes), now=NOW, output_dir=Path("/out"),
                 free_fn=lambda p: int(free_gb * GB), which=(lambda n: f"/usr/bin/{n}") if ffmpeg else (lambda n: None),
                 cache_home=cache, **kw)


def by_name(checks, name):
    return [c for c in checks if c.name == name]


def one(checks, name):
    found = by_name(checks, name)
    assert len(found) == 1, (name, [c.name for c in checks])
    return found[0]


class SecretHygiene(unittest.TestCase):
    def test_no_secret_fragment_in_any_output(self):
        routes = [
            ("GET", "api.elevenlabs.io/v1/user/subscription",
             Resp(200, {"character_count": 100, "character_limit": 100000, "status": "active", "tier": "creator"})),
            ("GET", "/voices/", Resp(200, {})),
            ("GET", "api.pexels.com", Resp(401)),
            ("POST", "oauth2.googleapis.com", Resp(400, {"error": "invalid_grant", "error_description": SECRETS["GEMINI_API_KEY"]})),
        ] + sb()
        env = {"YOUTUBE_TOKEN_JSON": json.dumps({"refresh_token": "1//refreshSENTINEL0123456789abcdef", "client_id": "cid", "client_secret": "csecretSENTINEL012345"}),
               "CHRONOS_VIDEO_PROVIDER": "kling", "CHRONOS_ENABLE_VIDEO_GEN": "true"}
        ctx = make_ctx(env, routes, extended=True)
        checks = d.run_checks(ctx)
        text = d.render(checks, ctx.env) + d.to_json(checks, ctx.env)
        for value in list(SECRETS.values()) + ["1//refreshSENTINEL0123456789abcdef", "csecretSENTINEL012345"]:
            self.assertNotIn(value, text)
            for frag in (value[:6], value[:10], value[-6:]):
                self.assertNotIn(frag, text, "a prefix or suffix of a secret leaked")
        self.assertNotRegex(text, r"\b3[0-9]\b chars|length|characters long")

    def test_scrubber_catches_a_value_even_if_a_check_echoed_it(self):
        ctx = make_ctx()
        leaky = [d.Check("x", "leaky", WARN, f"oops {SECRETS['FAL_KEY']}", "none")]
        self.assertNotIn(SECRETS["FAL_KEY"], d.render(leaky, ctx.env))
        self.assertNotIn(SECRETS["FAL_KEY"], d.to_json(leaky, ctx.env))

    def test_every_non_pass_line_has_a_next_step_when_it_can_act(self):
        ctx = make_ctx({"GEMINI_API_KEY": None, "PEXELS_API_KEY": None, "CHRONOS_VIDEO_PROVIDER": "veoo"}, sb(), free_gb=1, ffmpeg=False)
        for c in d.run_checks(ctx):
            if c.status in (FAIL, WARN):
                self.assertTrue(c.fix, c.name)


class EffectiveConfig(unittest.TestCase):
    def video(self, **env):
        return d.check_video(make_ctx(env))[0]

    def test_everything_off_is_a_deliberate_pass(self):
        self.assertEqual(self.video().status, PASS)

    def test_flag_on_with_empty_key_fails_instead_of_silent_stock(self):
        c = self.video(CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="veo", KLING_API_KEY=None)
        self.assertEqual(c.status, FAIL)
        self.assertIn("VEO_API_KEY", c.fix)

    def test_unknown_provider_id_fails(self):
        self.assertEqual(self.video(CHRONOS_VIDEO_PROVIDER="veoo", CHRONOS_ENABLE_VIDEO_GEN="true").status, FAIL)

    def test_minimax_needs_its_own_flag_not_the_generic_one(self):
        c = self.video(CHRONOS_ENABLE_VIDEO_GEN="true", MINIMAX_API_KEY="k" * 20)
        self.assertEqual(c.status, FAIL)
        self.assertIn("CHRONOS_ENABLE_MINIMAX_BROLL", c.detail)

    def test_minimax_h3_without_query_path_fails_with_the_hailuo_fix(self):
        c = self.video(CHRONOS_ENABLE_MINIMAX_BROLL="true", MINIMAX_API_KEY="k" * 20)
        self.assertEqual(c.status, FAIL)
        self.assertIn("MiniMax-Hailuo-2.3", c.fix)
        ok = self.video(CHRONOS_ENABLE_MINIMAX_BROLL="true", MINIMAX_API_KEY="k" * 20, MINIMAX_H3_MODEL="MiniMax-Hailuo-2.3")
        self.assertEqual(ok.status, PASS)

    def test_provider_chosen_but_generation_off_is_not_a_pass(self):
        self.assertEqual(self.video(CHRONOS_VIDEO_PROVIDER="kling", KLING_API_KEY="k" * 20).status, FAIL)

    def test_kling_pair_counts_as_a_key(self):
        c = self.video(CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="kling", KLING_ACCESS_KEY="a" * 12, KLING_SECRET_KEY="b" * 12)
        self.assertEqual(c.status, PASS)

    def test_the_pipelines_own_preflight_refusal_is_reported(self):
        def refuse():
            raise RuntimeError("wan (wan2.7-t2v): the configuration is unusable. Fix: set WAN_WORKSPACE_ID")
        ctx = make_ctx({"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "wan", "WAN_API_KEY": "k" * 20, "WAN_WORKSPACE_ID": "ws1"},
                       preflight_video=refuse)
        c = d.check_video(ctx)[-1]
        self.assertEqual(c.status, FAIL)
        self.assertIn("WAN_WORKSPACE_ID", c.detail)

    def test_images_flag_on_key_empty_fails(self):
        c = d.check_images(make_ctx({"CHRONOS_IMAGE_PROVIDER": "leonardo", "CHRONOS_ENABLE_IMAGE_GEN": "true"}))[0]
        self.assertEqual(c.status, FAIL)
        self.assertEqual(d.check_images(make_ctx())[0].status, PASS)

    def test_tts_unset_without_key_warns_about_the_edge_voice(self):
        c = d.check_tts(make_ctx({"TTS_PROVIDER": None, "ELEVENLABS_API_KEY": None}))[0]
        self.assertEqual(c.status, WARN)
        self.assertIn("Edge", c.detail)

    def test_tts_explicit_elevenlabs_without_key_fails(self):
        self.assertEqual(d.check_tts(make_ctx({"ELEVENLABS_API_KEY": None}))[0].status, FAIL)

    def test_tts_edge_on_purpose_and_elevenlabs_explicit_pass(self):
        self.assertEqual(d.check_tts(make_ctx({"TTS_PROVIDER": "edge", "ELEVENLABS_API_KEY": None}))[0].status, PASS)
        self.assertEqual(d.check_tts(make_ctx())[0].status, PASS)

    def test_tts_by_key_only_warns_and_missing_voices_warn(self):
        out = d.check_tts(make_ctx({"TTS_PROVIDER": None, "ELEVENLABS_VOICE_ID": None, "ELEVENLABS_SECONDARY_VOICE_ID": None}))
        self.assertEqual([c.status for c in out], [WARN, WARN, WARN])

    def test_shapes(self):
        ctx = make_ctx({"PEXELS_API_KEY": '"quoted"', "FAL_KEY": "Bearer abc", "ELEVENLABS_VOICE_ID": "123",
                        "GEMINI_API_KEY": "has space", "YOUTUBE_TOKEN_JSON": "{not json"})
        c = d.check_shapes(ctx)[0]
        self.assertEqual(c.status, FAIL)
        for name in ("PEXELS_API_KEY", "FAL_KEY", "ELEVENLABS_VOICE_ID", "GEMINI_API_KEY", "YOUTUBE_TOKEN_JSON"):
            self.assertIn(name, c.detail)
        self.assertEqual(d.check_shapes(make_ctx())[0].status, PASS)

    def test_missing_required_keys_fail(self):
        out = d.check_required_keys(make_ctx({"GEMINI_API_KEY": None}))
        self.assertEqual([c.status for c in out], [FAIL, PASS])


class Providers(unittest.TestCase):
    def test_elevenlabs_characters_and_voices(self):
        routes = [("GET", "/user/subscription", Resp(200, {"character_count": 90000, "character_limit": 100000, "status": "active"})),
                  ("GET", "/voices/", Resp(200, {}))]
        ctx = make_ctx({"ELEVENLABS_SECONDARY_VOICE_ID": "B" * 20}, routes)
        out = d.check_elevenlabs(ctx)
        self.assertEqual(one(out, "elevenlabs").status, WARN)  # 10000 left, under the alert level
        self.assertIn("10000 characters", one(out, "elevenlabs").detail)
        self.assertEqual(one(out, "narrator voice").status, PASS)
        self.assertEqual(one(out, "secondary voice").status, PASS)

    def test_elevenlabs_zero_left_and_bad_key_and_missing_voice(self):
        zero = make_ctx(routes=[("GET", "/user/subscription", Resp(200, {"character_count": 5, "character_limit": 5})),
                                ("GET", "/voices/", Resp(404))])
        out = d.check_elevenlabs(zero)
        self.assertEqual(one(out, "elevenlabs").status, FAIL)
        self.assertEqual(one(out, "narrator voice").status, FAIL)
        bad = d.check_elevenlabs(make_ctx(routes=[("GET", "/user/subscription", Resp(401))]))
        self.assertEqual(bad[0].status, FAIL)
        self.assertIn("refused the key", bad[0].detail)

    def test_pexels(self):
        ok = make_ctx(routes=[("GET", "api.pexels.com", Resp(200, {}, {"X-Ratelimit-Remaining": "199"}))])
        self.assertEqual(d.check_pexels(ok)[0].status, PASS)
        self.assertIn("199", d.check_pexels(ok)[0].detail)
        self.assertEqual(ok.http.calls[0][2]["Authorization"], SECRETS["PEXELS_API_KEY"])  # in the header only
        dead = make_ctx(routes=[("GET", "api.pexels.com", Resp(401))])
        self.assertEqual(d.check_pexels(dead)[0].status, FAIL)
        self.assertEqual(d.check_pexels(make_ctx({"PEXELS_API_KEY": None}))[:], [])

    def test_leonardo(self):
        ctx = make_ctx({"LEONARDO_API_KEY": "l" * 20}, [("GET", "leonardo.ai/api/rest/v1/me", Resp(200, {"user_details": [{"apiPaidTokens": 100}]}))])
        self.assertEqual(d.check_leonardo(ctx)[0].status, PASS)

    def test_gemini_is_unverified_unless_extended(self):
        plain = make_ctx()
        self.assertEqual(d.check_gemini(plain)[0].status, UNVERIFIED)
        self.assertEqual(plain.http.calls, [])
        ext = make_ctx(routes=[("GET", "generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash", Resp(200, {}))], extended=True)
        self.assertEqual(d.check_gemini(ext)[0].status, PASS)
        self.assertEqual(ext.http.calls[0][2]["x-goog-api-key"], SECRETS["GEMINI_API_KEY"])
        gone = make_ctx(routes=[("GET", "generativelanguage", Resp(404))], extended=True)
        self.assertEqual(d.check_gemini(gone)[0].status, FAIL)

    def test_providers_without_a_free_endpoint_are_never_pass(self):
        ctx = make_ctx({"MINIMAX_API_KEY": "m" * 20, "KLING_ACCESS_KEY": "a" * 12, "RUNWAYML_API_SECRET": "r" * 20})
        out = d.check_unverified(ctx)
        self.assertEqual(out[0].status, UNVERIFIED)
        self.assertEqual(ctx.http.calls, [])
        for name in ("minimax", "kling", "runway", "fal"):
            self.assertIn(name, out[0].detail)
        self.assertEqual(d.check_unverified(make_ctx({"FAL_KEY": None, "KLING_API_KEY": None})), [])


class SupabaseAndWorker(unittest.TestCase):
    def test_healthy(self):
        out = d.check_supabase(make_ctx(routes=sb(credit_prices=Resp(200, [{"unit": u, "credits_per_unit": 1} for u in d.REQUIRED_PRICES + d.UNIT_PRICES]),
                                                  api_prices=Resp(200, [{"unit": "video_minute", "cents": 5}, {"unit": "job_minimum", "cents": 5}]))))
        self.assertEqual(one(out, "supabase").status, PASS)
        self.assertEqual(one(out, "migrations").status, PASS)
        self.assertEqual(one(out, "storage bucket").status, PASS)
        self.assertEqual(one(out, "credit prices").status, PASS)

    def test_unapplied_migration_is_a_fail_naming_it(self):
        def route(url, params):
            return Resp(404) if "video_costs" in url else Resp(200, [])
        out = d.check_supabase(make_ctx(routes=[("GET", "/rest/v1/", route), ("GET", "/storage", Resp(200))]))
        m = one(out, "migrations")
        self.assertEqual(m.status, FAIL)
        self.assertIn("0106", m.detail)

    def test_refused_service_key_and_missing_env(self):
        out = d.check_supabase(make_ctx(routes=[("GET", "/rest/v1/", Resp(401))]))
        self.assertEqual(out[0].status, FAIL)
        self.assertIn("service key", out[0].detail)
        gone = d.check_supabase(make_ctx({"SUPABASE_SERVICE_KEY": None}))
        self.assertEqual(gone[0].status, FAIL)
        self.assertIn("SUPABASE_SERVICE_KEY", gone[0].detail)

    def test_missing_bucket(self):
        out = d.check_supabase(make_ctx(routes=[("GET", "/rest/v1/", Resp(200, [])), ("GET", "/storage/v1/bucket/previews", Resp(404))]))
        self.assertEqual(one(out, "storage bucket").status, FAIL)

    def test_prices_missing_is_fail_only_when_credits_are_enforced(self):
        routes = sb(credit_prices=Resp(200, [{"unit": "tts_characters", "credits_per_unit": 1}]))
        soft = one(d.check_prices(make_ctx(routes=routes)), "credit prices")
        hard = one(d.check_prices(make_ctx({"NIGHTSHIFT_CREDITS_ENFORCE": "on"}, routes)), "credit prices")
        self.assertEqual((soft.status, hard.status), (WARN, FAIL))
        self.assertIn("video_minute", hard.detail)

    def test_negative_price_row_does_not_count_as_priced(self):
        routes = sb(credit_prices=Resp(200, [{"unit": "video_minute", "credits_per_unit": -1}, {"unit": "job_minimum", "credits_per_unit": 1}]))
        self.assertIn("video_minute", one(d.check_prices(make_ctx(routes=routes)), "credit prices").detail)

    def liveness(self, jobs, workers=None):
        return d.check_liveness(make_ctx(routes=sb(render_jobs=Resp(200, jobs), worker_status=Resp(200, workers or []))))

    def iso(self, **delta):
        return (NOW - timedelta(**delta)).isoformat()

    def test_fresh_heartbeat_passes_stale_fails(self):
        ok = self.liveness([{"status": "running", "heartbeat_at": self.iso(seconds=20), "started_at": self.iso(minutes=5)}])
        self.assertEqual(one(ok, "worker liveness").status, PASS)
        bad = self.liveness([{"status": "running", "heartbeat_at": self.iso(minutes=9), "started_at": self.iso(minutes=30)}])
        self.assertEqual(one(bad, "worker liveness").status, FAIL)

    def test_hang_with_a_live_heartbeat_is_a_warning(self):
        out = self.liveness([{"status": "running", "heartbeat_at": self.iso(seconds=10), "started_at": self.iso(minutes=70)}])
        self.assertEqual(one(out, "long job").status, WARN)

    def test_queued_and_nothing_running_warns(self):
        out = self.liveness([{"status": "queued", "created_at": self.iso(minutes=30)}])
        self.assertEqual(one(out, "queue").status, WARN)

    def test_idle_worker_is_honestly_unverified(self):
        out = self.liveness([])
        self.assertEqual(one(out, "worker liveness").status, UNVERIFIED)

    def test_side_worker_heartbeat(self):
        out = self.liveness([], [{"kind": "media", "state": "running", "updated_at": self.iso(seconds=30)}])
        self.assertIn("media", one(out, "side workers").detail)


class YouTube(unittest.TestCase):
    TOKEN = json.dumps({"refresh_token": "1//r", "client_id": "cid", "client_secret": "csec", "token_uri": "https://evil.example/token"})

    def test_ok_and_post_goes_only_to_the_fixed_google_uri(self):
        ctx = make_ctx({"YOUTUBE_TOKEN_JSON": self.TOKEN, "YOUTUBE_CHANNEL_ID": "UCx"}, [("POST", "oauth2.googleapis.com/token", Resp(200, {"access_token": "a"}))])
        out = d.check_youtube(ctx)
        self.assertEqual(one(out, "operator channel token").status, PASS)
        self.assertEqual([c[1] for c in ctx.http.calls], [d.YOUTUBE_TOKEN_URI])

    def test_invalid_grant_names_the_testing_mode_gotcha(self):
        ctx = make_ctx({"YOUTUBE_TOKEN_JSON": self.TOKEN, "YOUTUBE_CHANNEL_ID": "UCx"}, [("POST", "oauth2", Resp(400, {"error": "invalid_grant"}))])
        c = one(d.check_youtube(ctx), "operator channel token")
        self.assertEqual(c.status, FAIL)
        self.assertIn("Testing", c.fix)

    def test_client_pair_falls_back_to_client_secret_json(self):
        token = json.dumps({"refresh_token": "1//r"})
        client = json.dumps({"installed": {"client_id": "cid2", "client_secret": "csec2"}})
        ctx = make_ctx({"YOUTUBE_TOKEN_JSON": token, "YOUTUBE_CLIENT_SECRET_JSON": client, "YOUTUBE_CHANNEL_ID": "UCx"},
                       [("POST", "oauth2", Resp(200, {"access_token": "a"}))])
        d.check_youtube(ctx)
        self.assertEqual(ctx.http.calls[0][4]["client_id"], "cid2")

    def test_missing_token_warns_and_no_youtube_flag_skips_the_post(self):
        self.assertEqual(d.check_youtube(make_ctx())[0].status, WARN)
        ctx = make_ctx({"YOUTUBE_TOKEN_JSON": self.TOKEN, "YOUTUBE_CHANNEL_ID": "UCx"}, youtube=False)
        self.assertEqual(one(d.check_youtube(ctx), "operator channel token").status, SKIP)
        self.assertEqual(ctx.http.calls, [])


class Host(unittest.TestCase):
    def test_disk_thresholds(self):
        self.assertEqual(one(d.check_host(make_ctx(free_gb=4)), "free disk").status, FAIL)
        self.assertEqual(one(d.check_host(make_ctx(free_gb=7)), "free disk").status, WARN)
        self.assertEqual(one(d.check_host(make_ctx(free_gb=60)), "free disk").status, PASS)

    def test_ffmpeg_and_whisper_cache(self):
        import tempfile
        self.assertEqual(one(d.check_host(make_ctx(ffmpeg=False)), "ffmpeg").status, FAIL)
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(one(d.check_host(make_ctx(tmp=t)), "whisper model").status, WARN)
            (Path(t) / "whisper").mkdir()
            (Path(t) / "whisper" / "base.pt").write_bytes(b"x")
            self.assertEqual(one(d.check_host(make_ctx(tmp=t)), "whisper model").status, PASS)


class GitHub(unittest.TestCase):
    REPO = "owner/name"

    def routes(self, secrets, variables, last_deploy="2026-10-18T10:00:00Z"):
        s = lambda names: [{"name": n, "updated_at": "2026-10-17T09:00:00Z"} for n in names]  # noqa: E731
        v = [{"name": n, "value": "VALUE-MUST-NEVER-PRINT", "updated_at": "2026-10-17T09:00:00Z"} for n in variables]
        return [("GET", "/environments/production/secrets", Resp(404)), ("GET", "/environments/production/variables", Resp(404)),
                ("GET", "/actions/secrets", Resp(200, {"secrets": secrets if secrets and isinstance(secrets[0], dict) else s(secrets)})),
                ("GET", "/actions/variables", Resp(200, {"variables": v})),
                ("GET", "/workflows/deploy_web.yml/runs", Resp(200, {"workflow_runs": [{"updated_at": last_deploy}]}))]

    def test_no_token_skips_and_calls_nothing(self):
        ctx = make_ctx()
        out = d.github_checks(ctx, self.REPO)
        self.assertEqual(out[0].status, SKIP)
        self.assertEqual(ctx.http.calls, [])

    def test_names_only_and_variable_values_never_printed(self):
        required = list(d.GITHUB_REQUIRED)
        ctx = make_ctx({"GITHUB_TOKEN": "ghp_" + "x" * 30}, self.routes(required, ["TTS_PROVIDER"]), )
        ctx.root = Path(__file__).resolve().parent.parent
        out = d.github_checks(ctx, self.REPO)
        text = d.render(out, ctx.env)
        self.assertNotIn("VALUE-MUST-NEVER-PRINT", text)
        self.assertNotIn("ghp_", text)
        self.assertEqual(one(out, "required names").status, PASS)
        self.assertIn("TTS_PROVIDER", one(out, "optional names present").detail)
        self.assertEqual({c[0] for c in ctx.http.calls}, {"GET"})

    def test_secret_stored_as_variable_is_a_fail(self):
        required = [n for n in d.GITHUB_REQUIRED if n != "PEXELS_API_KEY"]
        ctx = make_ctx({"GITHUB_TOKEN": "t" * 30}, self.routes(required, ["PEXELS_API_KEY"]))
        ctx.root = Path(__file__).resolve().parent.parent
        out = d.github_checks(ctx, self.REPO)
        c = one(out, "secret stored as variable")
        self.assertEqual(c.status, FAIL)
        self.assertIn("PEXELS_API_KEY", c.detail)

    def test_missing_required_and_changed_after_deploy(self):
        ctx = make_ctx({"GITHUB_TOKEN": "t" * 30}, self.routes([{"name": "GEMINI_API_KEY", "updated_at": "2026-10-18T11:00:00Z"}], [], "2026-10-18T10:00:00Z"))
        ctx.root = Path(__file__).resolve().parent.parent
        out = d.github_checks(ctx, self.REPO)
        self.assertEqual(one(out, "required names").status, FAIL)
        self.assertIn("SUPABASE_URL", one(out, "required names").detail)
        changed = one(out, "changed after deploy")
        self.assertEqual(changed.status, WARN)
        self.assertIn("GEMINI_API_KEY", changed.detail)

    def test_refused_token(self):
        ctx = make_ctx({"GITHUB_TOKEN": "t" * 30}, [("GET", "api.github.com", Resp(401))])
        self.assertEqual(d.github_checks(ctx, self.REPO)[0].status, FAIL)

    def test_repo_must_be_owner_name(self):
        ctx = make_ctx({"GITHUB_TOKEN": "t" * 30})
        self.assertEqual(d.github_checks(ctx, "../etc")[0].status, SKIP)
        self.assertEqual(ctx.http.calls, [])


class ModesAndHooks(unittest.TestCase):
    def test_offline_makes_no_request(self):
        ctx = make_ctx()
        d.run_checks(ctx, offline=True)
        self.assertEqual(ctx.http.calls, [])

    def test_online_run_only_gets_except_the_token_refresh(self):
        env = {"YOUTUBE_TOKEN_JSON": json.dumps({"refresh_token": "r", "client_id": "a", "client_secret": "b"}), "YOUTUBE_CHANNEL_ID": "UC"}
        ctx = make_ctx(env, [("POST", "oauth2", Resp(200, {"access_token": "t"})), ("GET", "elevenlabs", Resp(200, {"character_limit": 9e6, "character_count": 0}))] + sb())
        d.run_checks(ctx)
        self.assertEqual(ctx.http.methods, {"GET", "POST"})
        self.assertEqual([c[1] for c in ctx.http.calls if c[0] == "POST"], [d.YOUTUBE_TOKEN_URI])

    def test_one_crashing_check_does_not_hide_the_rest(self):
        ctx = make_ctx(routes=sb())
        original = d.check_pexels
        d.check_pexels = lambda c: 1 / 0
        try:
            out = d.run_checks(ctx)
        finally:
            d.check_pexels = original
        self.assertTrue(any(c.group == "doctor" for c in out))
        self.assertTrue(any(c.name == "supabase" for c in out))

    def test_exit_codes_and_json(self):
        good = [d.Check("a", "a", PASS, "ok"), d.Check("a", "b", UNVERIFIED, "x", "y")]
        warn = good + [d.Check("a", "c", WARN, "w", "fix")]
        bad = warn + [d.Check("a", "d", FAIL, "f", "fix")]
        self.assertEqual([d.summarize(x)["exit_code"] for x in (good, warn, bad)], [0, 2, 1])
        doc = json.loads(d.to_json(bad, {}))
        self.assertFalse(doc["ready"])
        self.assertEqual(doc["counts"]["FAIL"], 1)
        self.assertEqual(doc["checks"][3]["fix"], "fix")

    def test_nothing_checked_is_not_reported_ready(self):
        skipped = [d.Check("github", "github", SKIP, "no token", "export one")]
        self.assertEqual(d.summarize(skipped)["exit_code"], 2)
        self.assertTrue(d.render(skipped, {}).startswith("READY: UNKNOWN"))

    def test_real_http_wrapper_swallows_network_errors(self):
        self.assertEqual(d.Http(timeout=1).get("http://127.0.0.1:9/").status, None)

    def test_human_report_header(self):
        text = d.render([d.Check("a", "x", FAIL, "broken", "do this")], {})
        self.assertTrue(text.startswith("READY: NO (1 blocking, 0 warnings)"))
        self.assertIn("[FAIL]", text)
        self.assertIn("next: do this", text)

    def test_preflight_summary_blocks_on_effective_config_and_is_offline(self):
        env = {"SUPABASE_URL": "https://x.supabase.co", "CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "veo"}
        boom = FakeHttp()
        res = d.preflight_summary(env, http=boom, free_fn=lambda p: 100 * GB, which=lambda n: "/bin/" + n, output_dir=Path("/out"))
        self.assertFalse(res["ready"])
        self.assertTrue(any("VEO_API_KEY" in line for line in res["blocking"]))
        self.assertEqual(boom.calls, [])

    def test_preflight_summary_never_raises(self):
        res = d.preflight_summary({"A": "b"}, free_fn=lambda p: (_ for _ in ()).throw(RuntimeError("x")))
        self.assertIn("ready", res)

    def test_main_returns_the_exit_code_and_json_flag(self):
        import contextlib
        import io
        from unittest import mock
        buf = io.StringIO()
        with mock.patch.object(d, "default_ctx", side_effect=lambda **kw: make_ctx(routes=sb(), **kw)), contextlib.redirect_stdout(buf):
            code = d.main(["--json", "--offline", "--no-youtube"])
        self.assertIn(code, (0, 1, 2))
        self.assertIn("checks", json.loads(buf.getvalue()))

    def test_module_is_read_only_by_construction(self):
        src = (Path(d.__file__)).read_text()
        for banned in ("requests.put", "requests.patch", "requests.delete", ".write_text(", ".write_bytes(", "open(", "os.remove", "rmtree"):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main()
