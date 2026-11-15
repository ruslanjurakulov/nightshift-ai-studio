"""Breach on 0176 (voice to video): a hold that expired while the job waited for the render slot.

A voice video renders on the worker, one at a time per process; a second one is kept claimed ("parked") until the slot frees,
up to 8 per thread, each render up to ~70 minutes (docs/VOICE_EXPLAINER.md, "Capacity"). A hold that was never started lives
3 hours (0020 reserve_credits / expire_credit_reservations), and the creative worker starts it only when the job finally runs
(_check_hold). With NIGHTSHIFT_CREDITS_ENFORCE unset (the default: credits.enforcement_enabled is "off unless explicitly on",
and deploy/.env.worker.example ships it blank), a job whose hold already expired is run anyway: the paid Scribe call and the
render happen, and finish_creative_job captures 0 from a released hold ("the job still completes"). A free voice video.

For vendor jobs this window was minutes; the serial slot makes it hours. Whatever the switch says, a job whose hold is not open
must not reach the paid call. FAILS on 63423b2.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests"))

from test_creative_worker import Base, FakeAdapter, FakeCredits, FakeQueue, job  # noqa: E402


class VoiceVideoHoldExpiry(Base):
    def test_a_voice_video_whose_hold_expired_is_not_rendered_even_with_enforcement_off(self):
        q = FakeQueue(job(capability="voice_explainer", requested_model="nightshift-voice-explainer",
                          routed_model="nightshift-voice-explainer",
                          params={"source_asset_id": "00000000-0000-4000-8000-000000000001", "look": "dusk"}))
        a = FakeAdapter()
        self.worker(q, a, credits=FakeCredits(amount=None), enforce=False).run_once()
        self.assertEqual(a.log, [], "the paid transcription and the render ran on a hold that is not open")
        self.assertEqual(q.finished["error_code"], "hold_not_open")
