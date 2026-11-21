"""One paid call to Gemini TTS for the owner's listening test: the 3-sentence Uzbek line, saved as a WAV.

    GEMINI_API_KEY=... python tools/probe_gemini_tts.py --voice Kore [--model gemini-3.8-flash-lite-tts] [--out probe.wav]

Run by a person, once, by hand: never by a workflow. It goes through the same adapter the Studio would
(modules/capabilities/gemini_tts.py), so a pass also proves the request shape that adapter sends. It prints only
"OK <path>" or "FAILED <code>: <remedy>"; the message is the adapter's, already scrubbed of every secret in the
environment, and the key itself is read from the environment only, never from an argument.

The key should be on a BILLED Google project: on unpaid services Google may use what is sent to improve its products.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.capabilities.base import TTS, AdapterError, CapabilityRequest  # noqa: E402
from modules.capabilities.gemini_tts import MODELS, PREBUILT_VOICES, GeminiTTSAdapter  # noqa: E402

LINE = ("Salom, mening ismim Dilnoza. Bugun 21-noyabr, soat to'qqizda yangi film boshlanadi. "
        "Bilasizmi, bu kunni uch yil kutdim!")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", choices=MODELS, default=MODELS[0])
    # Required, never defaulted: the listening test compares voices, and a picked-for-you voice is not a choice.
    ap.add_argument("--voice", required=True, choices=sorted(PREBUILT_VOICES))
    ap.add_argument("--style", default=None, help="optional delivery direction, e.g. 'Warm and calm'")
    ap.add_argument("--out", type=Path, default=None, help="WAV path (default: gemini_tts_probe_<model>_<voice>.wav)")
    args = ap.parse_args(argv)
    out = args.out or Path(f"gemini_tts_probe_{args.model}_{args.voice}.wav")
    adapter = GeminiTTSAdapter(env=os.environ)
    request = CapabilityRequest(capability=TTS, prompt=LINE, voice_id=args.voice, text_language="uz", style=args.style)
    try:
        task = adapter.submit(request, args.model)
        data = task.outputs[0].data or b""
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
    except AdapterError as e:
        print(f"FAILED {e.code}: {e.message}")
        return 1
    except OSError as e:
        print(f"FAILED write: {type(e).__name__}")
        return 1
    print(f"OK {out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
