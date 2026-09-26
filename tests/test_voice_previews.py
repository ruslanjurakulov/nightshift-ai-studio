"""tools/voice_previews.py and its workflow: the clips the Create page plays
before a narrator voice is chosen. No network: the session is stubbed."""

import importlib.util
import json
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("voice_previews", ROOT / "tools" / "voice_previews.py")
vp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vp)

VOICE = "pNInz6obpgDQGcFmaJgB"
KEY, SERVICE = "el-secret-key", "service-secret-key"


class _Resp:
    def __init__(self, status=200, payload=None, content=b""):
        self.status_code, self._payload, self.content = status, payload, content

    def json(self):
        return self._payload


class _Session:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def _next(self, method, url, kw):
        self.calls.append((method, url, kw))
        return self.responses.pop(0)

    def get(self, url, **kw):
        return self._next("GET", url, kw)

    def post(self, url, **kw):
        return self._next("POST", url, kw)


def previewer(responses):
    s = _Session(responses)
    return vp.Previewer(KEY, "https://abc.supabase.co", SERVICE, session=s), s


class PreviewerTests(unittest.TestCase):
    def test_premade_voice_uses_the_free_preview_and_uploads_privately(self):
        p, s = previewer([
            _Resp(200, []),                                            # not in the bucket yet
            _Resp(200, {"preview_url": "https://storage.example/p.mp3"}),
            _Resp(200, content=b"ID3clip"),
            _Resp(200, {}),                                            # upload
        ])
        self.assertEqual(p.prepare(VOICE), "prepared")
        upload = s.calls[-1]
        self.assertEqual(upload[1], f"https://abc.supabase.co/storage/v1/object/voice-previews/{VOICE}.mp3")
        self.assertEqual(upload[2]["data"], b"ID3clip")
        self.assertEqual(upload[2]["headers"]["x-upsert"], "true")
        self.assertFalse(any("text-to-speech" in c[1] for c in s.calls), "a premade voice must not spend characters")

    def test_a_voice_without_a_preview_gets_one_short_sample(self):
        p, s = previewer([
            _Resp(200, []),
            _Resp(200, {"preview_url": None}),
            _Resp(200, content=b"ID3sample"),
            _Resp(200, {}),
        ])
        self.assertEqual(p.prepare(VOICE), "prepared")
        tts = s.calls[2]
        self.assertIn(f"/text-to-speech/{VOICE}", tts[1])
        self.assertLessEqual(len(tts[2]["json"]["text"]), 200)

    def test_existing_clip_is_skipped(self):
        p, s = previewer([_Resp(200, [{"name": f"{VOICE}.mp3"}])])
        self.assertEqual(p.prepare(VOICE), "exists")
        self.assertEqual(len(s.calls), 1)

    def test_bad_ids_and_unknown_voices_are_refused_without_leaking_keys(self):
        p, _ = previewer([])
        with self.assertRaises(vp.PreviewError):
            p.prepare("../../etc/passwd")
        p, _ = previewer([_Resp(200, []), _Resp(404, {})])
        with self.assertRaises(vp.PreviewError) as ctx:
            p.prepare(VOICE)
        self.assertNotIn(KEY, str(ctx.exception))
        self.assertNotIn(SERVICE, str(ctx.exception))

    def test_run_counts_failures_and_keeps_going(self):
        p, _ = previewer([_Resp(500, None), _Resp(200, [{"name": f"{'b' * 20}.mp3"}])])
        with self.assertLogs(vp.logger, level="INFO") as logs:
            self.assertEqual(vp.run([VOICE, "b" * 20], p), 1)
        text = "\n".join(logs.output)
        self.assertNotIn(KEY, text)
        self.assertIn("exists", text)


class ListAndWorkflowTests(unittest.TestCase):
    def test_every_listed_voice_is_a_valid_unique_id(self):
        ids = vp.listed_voice_ids()
        raw = json.loads(vp.VOICES_FILE.read_text())
        self.assertEqual(len(ids), len(raw))
        self.assertEqual(len(set(ids)), len(ids))

    def test_workflow_passes_the_id_through_env_and_is_dispatchable(self):
        wf = yaml.safe_load((ROOT / ".github/workflows/voice_previews.yml").read_text())
        self.assertIn("workflow_dispatch", wf[True])
        self.assertNotIn("pull_request", wf[True])
        for job in wf["jobs"].values():
            for step in job["steps"]:
                self.assertNotIn("${{", step.get("run", ""), step.get("name"))
        ts = (ROOT / "command-center/lib/server/github-secrets.ts").read_text()
        self.assertIn('"voice_previews.yml"', ts)

    def test_migration_creates_a_private_bucket(self):
        sql = (ROOT / "supabase/migrations/0026_voice_previews.sql").read_text()
        self.assertIn("'voice-previews', 'voice-previews', false", sql)


if __name__ == "__main__":
    unittest.main()
