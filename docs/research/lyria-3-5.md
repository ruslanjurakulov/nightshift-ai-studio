# Google Lyria 3.5 on the Gemini API: contract, price, terms (Scout, read 2026-11-27)

This is docs-only: no call was made, and no key or sign-up was used. The owner's decision (27 Nov, through Atlas) is to add
Lyria 3.5 music on the Gemini API paid tier, as migration 0228 (S6). Re-copy any clause verbatim from the live page before legal
sign-off.

## Contract

- **Model and status.** Model `lyria-3.5`, "Stable", latest update September 2026
  ([model page](https://aistudio.google.com/docs/models/lyria-3.5)). `lyria-3-clip-preview` and `lyria-3-pro-preview` are legacy.
- **Endpoint.** The call goes through the **Interactions API**, not generateContent:
  `POST https://generativelanguage.googleapis.com/v1beta/interactions`, with the header `Api-Revision: 2026-05-20`
  ([music generation](https://aistudio.google.com/docs/music-generation)). Batch and Live are not supported.
- **Request.** The fields are `model`, `input` (text, or text plus up to 10 images) and `response_format` (audio; `audio/wav` on
  request).
  - There is **no field** for lyrics, duration, seed, negative prompt or language. All of these go in the prompt.
  - Lyrics are written with `[Verse]` and `[Chorus]` tags.
  - Timing is written as `[0:00 - 0:10]`.
  - "Instrumental only, no vocals" is also written in the prompt.
- **Output.** MP3 by default, or WAV; 44.1 kHz stereo. The audio comes back as base64, with the lyrics or song structure as text.
  - The response carries **no lyric timings**.
  - "Results may vary between calls, even with the same prompt."
  - The call is single-turn, and editing a result is not supported.
- **Sync or background.** The examples are synchronous. Background mode (`background=true`, `store=true`) is retrieved with
  `interactions.get` ([interactions](https://aistudio.google.com/docs/interactions)).
  - On the paid tier, stored interactions are kept 55 days. The window can be 7, 14, 28 or 55 days, and they can be deleted.
  - Use the shortest window, and delete after copying the result.
- **Safety filter.** It blocks prompts that "request specific artist voices or the generation of copyrighted lyrics". That block
  must reach the person as a named error, never a substitute (rule 4).

## Price ([pricing](https://aistudio.google.com/docs/pricing))

- Lyria 3.5 (Full Song): **"$0.08 per song"**, on the paid tier only. The free tier is "Not available".
- A "song" is not defined (there is no maximum length stated). Billing appears to be per request: **unverified**.
- Paid-tier content is "**not** used to improve our products".
- The Vertex AI price for 3.5 is unverified: the page did not render.

## Terms

- **Gemini API Additional Terms** ([terms](https://aistudio.google.com/docs/terms), effective 2026-03-23):
  - **Who may use it.** It is "for developers building with Google AI models … for professional or business purposes".
  - **Ownership.** "Google won't claim ownership over that content". "Google may generate the same or similar content for
    others", so outputs are not exclusive.
  - **Regions.** "You may only access the Services (or make API Clients available to users) within" the available regions, so
    the limit **applies to our end users**. The EEA, Switzerland and the UK are allowed on paid services only.
  - **Age.** Users must be 18 or older, and the product must not be directed at, or likely to be used by, anyone under 18
    (re-copy that clause verbatim).
  - **Competing models.** No developing "models that compete with the Services".
  - **Resale.** There is no general resale clause.
- **Google APIs Terms** ([developers.google.com/terms](https://developers.google.com/terms)):
  - §4a: no sublicensing an API to a third party, and no "API Client that functions substantially the same as the APIs". So
    Lyria stays inside the video workflow, never as a bare prompt-to-song passthrough or a public API.
  - §3d: we must publish a privacy policy for the product.
  - §6b: we must display any attribution Google requires.
- **Prohibited Use Policy** ([policy](https://policies.google.com/terms/generative-ai/use-policy)): no infringing others' IP, no
  deceptive impersonation, and no deceptively claiming a work is human-made. Our end-user terms must pass this on.

## Regions ([available regions](https://aistudio.google.com/docs/available-regions))

Uzbekistan is listed. **Russia is not listed.** Unknown country → refused (owner's decision, via `lib/geo/blocked.ts` and
`lib/server/brain/google-gate.ts`).

## SynthID

"All generated audio includes a SynthID audio watermark for identification", which is imperceptible, with no opt-out. No
end-user disclosure duty is documented for SynthID itself. The owner's decision is to disclose it in the UI anyway.

## Verdict

No term read blocks offering Lyria 3.5 inside our web app to paying, 18+ customers in available regions, embedded in their video
workflow.

**Conditions:**
- paid tier only;
- the region gate, with Russia and unknown countries refused;
- the existing adult attestation;
- a privacy policy that covers prompts sent to Google and their retention;
- end-user terms that pass on the Prohibited Use Policy;
- no raw passthrough or API exposure (`web_only`);
- output labelled AI-generated, with SynthID disclosed;
- a safety-filter block shown by name.

**Unverified until a paid probe** (the owner's call):
- Russian and Uzbek vocals: the only official list, for Vertex Lyria 3, has neither;
- the maximum length, and what one "song" is;
- the rate limits;
- the Vertex price;
- background retrieval and latency;
- the error codes.

Only the languages a real call has proven are offered (CLAUDE.md, Definition of Done).
