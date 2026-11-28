"""The picture size a job was quoted (0208, params.image_size) reaches the adapter.

``creative_adapters.capability_request`` used to drop ``image_size``, which broke three models in two ways (measured in
docs/studio/S9_PARAM_PARITY.md, G1):

* Flux 3 (flux-3-image, -klein) and Nano Banana 2.1 require a size, because their price depends on it, and never default one. So
  every Studio job on them was refused with ``bad_request`` after the database had already quoted it.
* The Gemini image models (gemini-3.1-flash-image, -flash-lite, gemini-3-pro-image) send ``imageSize`` only when the request has
  one, so a job quoted at 2K or 4K was made at the vendor's default size. That is a silent quality fallback (CLAUDE.md rule 4).

The list of models is read from the registry (every model priced by ``image_size``), so a new one is covered without editing this
file. No network: the vendor call is replaced, except in the Gemini wire test, which uses a fake session.
"""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import build_adapter
from tests.test_creative_media_inputs import PNG, SRC, FakeSession
from tests.test_creative_worker import JOB, ORG

SIZE_PRICED = sorted(e.id for e in reg.registry().values()
                     if (e.raw.get("pricing", {}).get("variants") or {}).get("by") == "image_size"
                     and not e.registry_only and not e.shut_down())


class _Captured(Exception):
    def __init__(self, request):
        super().__init__("captured")
        self.request = request


class SizeReachesTheAdapter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name) / "src.png"
        self.src.write_bytes(PNG)

    def tearDown(self):
        self.tmp.cleanup()

    def _submit(self, model, cap, size):
        entry = reg.get(model)
        adapter = build_adapter(entry.adapter, env={})

        def capture(request, vendor_model):
            raise _Captured(request)

        adapter.submit = capture
        params = {"prompt": "a lighthouse at dawn", "image_size": size}
        if entry.qualities:
            params["quality"] = entry.qualities[0]
        files = ()
        if cap == "edit":
            params["source_asset_id"] = SRC
            files = (self.src,)
        ra = ca.RegistryAdapter(entry, adapter, sync_store={})
        with self.assertRaises(_Captured, msg=(model, cap, size)) as cm:
            ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability=cap, model=model, params=params,
                                           input_files=files, quantity=1))
        return cm.exception.request

    def test_the_registry_still_prices_these_models_by_size(self):
        # If this list empties, the test below proves nothing: the models it was written for must still be in it.
        for model in ("flux-3-image", "flux-3-image-klein", "gemini-nano-banana-2.1", "gemini-3.1-flash-image",
                      "gemini-3-pro-image"):
            self.assertIn(model, SIZE_PRICED)

    def test_every_listed_size_of_every_size_priced_model_reaches_submit_unrefused(self):
        for model in SIZE_PRICED:
            entry = reg.get(model)
            self.assertTrue(entry.image_sizes, model)
            for cap in [c for c in entry.capabilities if c in ("t2i", "edit")]:
                for size in entry.image_sizes:
                    self.assertEqual(self._submit(model, cap, size).image_size, size, (model, cap, size))

    def test_a_job_with_no_size_carries_none_and_is_not_given_one(self):
        # The worker never makes a size up: the database requires one for these models, and a job without it is refused by the
        # adapters that need it rather than billed at a size nobody quoted.
        req = ca.capability_request(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2i", model="m",
                                                         params={"prompt": "x"}))
        self.assertIsNone(req.image_size)


class GeminiSendsTheQuotedSize(unittest.TestCase):
    """The silent fallback: the vendor body must name the size the job was quoted."""

    IMG = {"candidates": [{"content": {"parts": [
        {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(PNG).decode()}}]}}]}

    def test_the_generate_call_names_the_quoted_image_size(self):
        for model in ("gemini-3.1-flash-image", "gemini-3-pro-image"):
            entry = reg.get(model)
            for size in entry.image_sizes:
                sess = FakeSession([("POST", ":generateContent", 200, self.IMG)])
                ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env={"GEMINI_API_KEY": "g" * 30}, session=sess),
                                        sync_store={})
                ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2i", model=model,
                                               params={"prompt": "x", "image_size": size}, quantity=1))
                body = sess.sent[0]["json"]
                self.assertEqual(body["generationConfig"]["imageConfig"]["imageSize"], size, (model, size))


if __name__ == "__main__":
    unittest.main()
