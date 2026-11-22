# Kling lip-sync: the facts the adapter is built on (read 2026-11-22)

Copied from `docs/studio/S6_GAPS.md` §1.2 (Scout, read 2026-11-22) and kept to what `modules/capabilities/lipsync.py` and the
registry entry `kling-lipsync` rely on. **Docs-only**: no paid call was made and no key was used. Nothing here is available until a
real call through the adapter has succeeded and a migration teaches the database the `lipsync` capability.

## Base URL and auth

- Base URL `https://api-singapore.klingai.com`. Auth `Authorization: Bearer <API Key>`.
- The access-key/secret JWT is "only applicable to legacy version design standards"
  ([authentication](https://kling.ai/document-api/api/get-started/authentication.md)). So the registry says **API key**, not
  "JWT or API key" (S6_GAPS G8), and a `KLING_API_KEY` written as `<access>:<secret>` is refused as not configured.

## The two steps

| Step | Official statement | Source |
| :-- | :-- | :-- |
| 1. Find the faces | `POST /v1/videos/identify-face` with exactly one of `video_id` (a Kling video of the last 30 days, ≤ 60 s) or `video_url` (.mp4/.mov, ≤ 100 MB, 2–60 s, 720p/1080p, each side 512–2160 px). Returns `session_id` and `face_data[]` (`face_id`, `start_time`/`end_time` in ms). **Billed.** How long a session stays valid: **not stated**. | https://kling.ai/document-api/api/video/lip-sync/face-detection.md |
| 2. Lip-sync | `POST /v1/videos/advanced-lip-sync` with `session_id` and `face_choose[]`. "currently only supports one person lip-sync". | https://kling.ai/document-api/api/video/lip-sync.md |
| Audio | per face, exactly one of `audio_id` (Kling TTS) or `sound_file` (base64 or URL; mp3/wav/m4a/aac; ≤ 5 MB; 2–60 s) | same |
| Timing | `sound_start_time`, `sound_end_time`, `sound_insert_time` (ms). The crop must be ≥ 2 s and overlap the face's interval by ≥ 2 s. | same |
| Optional | `sound_volume`, `original_audio_volume` (0–2), `watermark_info`, `external_task_id`, `callback_url` | same |
| Query | `GET /v1/videos/advanced-lip-sync/{task_id}`: `submitted`, `processing`, `succeed`, `failed` (`task_status_msg`) | same |
| Output | `task_result.videos[]` with `url`, `watermark_url`, `duration`; `final_unit_deduction` | same |
| Retention | "deleted after 30 days" | same |
| Kling TTS | `voice_language` "Allowed values are `zh` and `en`". No uz, no ru. | https://kling.ai/document-api/api/video/avatar/text-to-speech.md |
| Price | Lip Sync "0.5 Units ($0.07) /5s". Face Recognition "0.05 Units ($0.007) /call". | https://kling.ai/document-api/pricing/base/video.md |
| Concurrency | per account, model version and package type; over the limit the API answers `1303`. No numbers published. | https://kling.ai/document-api/api/get-started/concurrency-rules.md |
| Package | **unverified**: which package lip-sync draws on (the video package is a lead, not a fact) | https://kling.ai/document-api/api/assets/billing-deduction/package.md |
| Callback schema | **unverified** (not read) | https://kling.ai/document-api/api/get-started/callbacks.md |

## What the adapter does with them

- Refuses a file outside the limits **before the face check**, because that call is billed whatever it finds. It reads the
  worker's measurements (`CapabilityRequest.input_media_facts` / `input_audio_facts`), never a job row's claims. "MB" is read as
  10^6 bytes and "720p/1080p" as the frame's short side: our readings, the stricter ones.
- One face, never a guess: no `face_id` in the request means exactly one face must be found. Zero, two or more, a named face that is
  not there, or speech that overlaps the face for under 2 s stop the job before the lip-sync call (`no_face`, `several_faces`,
  `face_not_found`, `face_overlap`).
- Sends `sound_file` (our signed link) always and `audio_id` never: Kling's TTS cannot speak Uzbek or Russian.
- Sends no `watermark_info` and no volume field; stores the default `url` (docs/AI_DISCLOSURE.md, "Vendor watermarks").
- Task id `<session_id>/<face_id>/<task_id>`: a crash polls instead of paying again, and the moved face survives for provenance.
- The caller copies the result straight after success (30-day deletion).

## Terms

[Paid service](https://kling.ai/document-api/guides/protocols/paid-service.md), effective 2026-04-21: §3.3 the licence is
"non-exclusive, non-transferable or sublicensable"; §8.2.3 we may not "sell, transfer, license or transfer any one or more API
Services"; output "commercial purposes is not restricted". Use on the owner's own channels is fine; offering it to Studio customers
needs Kling's written confirmation. Hence `web_only` and `terms_review_required`, as on the other Kling entries.

## Still open

- the session's lifetime, the callback schema, and the package to buy;
- how a part of 5 s is rounded in the price;
- lip-sync quality on Uzbek and Russian speech (a paid probe, the owner's call).
