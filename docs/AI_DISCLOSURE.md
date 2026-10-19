# AI-content disclosure ("altered or synthetic content") and the pre-upload checks

One pure rule, `modules/ai_disclosure.py`, decides whether a video carries the platforms' "altered or synthetic
content" label. YouTube uploads, Instagram Reels, TikTok Direct Post and the YouTube cross-post all ask it, so the
same cut never gets two answers. This page says exactly what it decides, why, what each platform is sent, what is
recorded, and what is **not** verified.

Nothing here changes what is published or when (CLAUDE.md rules 2 and 3): every upload stays private, TikTok stays
`SELF_ONLY`, and no browser sends anything. The label is a declaration to the platform; it never widens privacy.

## Official sources (read 2026-10-19; re-read before relying on a quote, the pages change)

* YouTube Help, "Disclosing use of altered or synthetic content" - https://support.google.com/youtube/answer/14328491
  * "We require creators to disclose AI-generated or altered content that seems realistic."
  * "Creators must disclose GenAI content that: Makes a real person appear to say or do something they didn't do.
    Alters footage of a real event or place. Generates a realistic scene that didn't actually occur. Creates music
    that's the main focus of the video."
  * Not required: content that is "not realistic" (its example: "Using an AI-generated or altered animation of a
    missile in a fully animated video"; "Someone riding a unicorn through a fantastical world"); minor, primarily
    aesthetic edits ("Applying beauty filters", "Color adjustment or lighting filters", "Special effects filters");
    production help ("using generative AI tools to create or improve a video outline, script, thumbnail, title, or
    infographic", "Caption creation", "Idea generation"); "Cloning one's own voice to create voice overs or dubs";
    "Video sharpening, upscaling or repair and voice or audio repair".
  * "Keep in mind, the above list is not exhaustive." "Creators who consistently choose not to disclose this
    information may be subject to manual application of a label" (the page goes on to penalties, up to suspension
    from the YouTube Partner Program).
  * The page does **not** mention text-to-speech or narration by name, stock footage, or the API.
* YouTube Data API, `videos` resource - https://developers.google.com/youtube/v3/docs/videos : `status.containsSyntheticMedia`
  (boolean): "In a `videos.insert` or `videos.update` request, this property allows the channel owner to disclose that
  a video ... contains realistic Altered or Synthetic (A/S) content." It is listed among the settable properties of
  `videos.insert` (https://developers.google.com/youtube/v3/docs/videos/insert).
* Instagram, `POST /{ig-user-id}/media` - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media :
  `is_ai_generated` (true / false): "An optional parameter to provide a self-disclosure of AI usage in the post. Not
  available for carousel children."
* TikTok, Content Posting API Direct Post - https://developers.tiktok.com/doc/content-posting-api-reference-direct-post :
  `post_info.is_aigc` (bool, optional): "Set to true if the video is AI generated content." When set, "the video will
  be labelled with Creator labeled as AI-generated tag in video's description."

## What a channel sets

All in the channel's `agent_config` (no migration; the Command Center's writers merge into the blob, so the keys
survive). A value that is not one of the allowed words reads as the conservative one, never as "never".

| Key | Values | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `ai_disclosure` | `auto` / `always` / `never` | `auto` | `always` labels every video; `never` labels none; `auto` is the table below. Anything else = `auto`. |
| `ai_disclosure_voice` | `generic` / `own_clone` / `real_person` | `generic` | What the narrator's voice is; the pipeline cannot hear it. `real_person` = another real person's voice, cloned or sound-alike. Anything else = `real_person`. |
| `ai_disclosure_line` | `false` to stop the line | `true` | Only an explicit `false` drops the description / caption line; the platform flag is still sent. |
| `ai_disclosure_text` | up to 300 characters | empty | The line's wording. Empty = the standard wording in the channel's language. One line, no angle brackets (YouTube rejects them). |

`never` switches off a compliance feature, so it is the owner's call. It is not an admin-locked key today
(`channels_config_guard`, migration 0086); see "Decisions for the owner".

## The `auto` decision table

`auto` labels the video when **any** row marked "label" holds, and lists every row that holds as the recorded reasons.

| Row (reason word) | What the pipeline knows | Decision | Why, against the official page |
| :-- | :-- | :-- | :-- |
| `generated_video` | at least one AI-generated b-roll clip (`broll.generated`; manifest asset `kind=video, source=generated`) | **label** | "Generates a realistic scene that didn't actually occur." The code cannot tell from pixels whether a clip looks realistic, so every generated clip counts as realistic (conservative). |
| `generated_images` | at least one AI-generated still (`gen_images`; manifest asset `kind=image, source=generated`) | **label** | Same reasoning for stills. |
| `ai_presenter` | an AI presenter clip was generated (`presenter_path`) | **label** | A realistic synthetic person on screen is a realistic scene that did not occur. |
| `real_person_voice` | channel setting `ai_disclosure_voice: real_person` (or an unreadable value) | **label** | "Makes a real person appear to say or do something they didn't do." |
| `provenance_unknown` | no readable record and no manifest (only a video that predates the manifest, migration 0013, being cross-posted) | **label** | CLAUDE.md rule 5: an unknown is not a measured "no". The page says undisclosed realistic AI content can be labelled by YouTube itself; over-labelling costs a label. |
| `no_synthetic_media` | none of the above: stock footage and stock stills only, generic voice | no label | Nothing in the page's four categories. |
| (no row) | `ai_disclosure_voice: own_clone` | no label | The page lists "Cloning one's own voice to create voice overs or dubs" as not requiring disclosure. |
| (no row) | the script, title, thumbnail or outline was written with a model | no label | The page exempts "create or improve a video outline, script, thumbnail, title, or infographic". |
| (no row) | generic text-to-speech narration (ElevenLabs stock voice, Edge TTS) | no label | **The page is silent on text-to-speech.** It names no category for a synthetic narrator that is not a real person's voice; the brief for this change put "stock footage + generic TTS narration" under the exemptions. Choose `always` if you want it labelled (owner decision below). |
| (no row) | Remotion graphics, captions, music from the library | no label | Not AI-generated media. |

What `auto` cannot do: tell that generated pictures are clearly unrealistic (a fully animated or cartoon channel).
The page exempts that, but nothing in the pipeline records "style: cartoon", so `auto` labels it. Such a channel sets
`ai_disclosure: never` on purpose.

`always` / `never` override the table entirely (reasons `mode_always` / `mode_never`).

## What each platform is sent

Only when the label is true. When it is false **nothing** is added, so an unlabelled request is byte for byte the
request it always was (pinned by tests).

| Where | Label true | Label false |
| :-- | :-- | :-- |
| YouTube upload (`videos.insert`, long video and its Short) | `status.containsSyntheticMedia: true` next to `privacyStatus` and `selfDeclaredMadeForKids`; the line is appended to the description before the watch-next block | body unchanged |
| YouTube cross-post to another channel | the same flag via the same uploader; the line is in the recorded description | unchanged |
| Instagram Reels | `is_ai_generated=true` on the media container; the line in the caption | field absent |
| TikTok Direct Post | `post_info.is_aigc: true` (still `SELF_ONLY`); the line in the title/caption | field absent |

The line is appended after the creator's own text and **before** hashtags (captions) or the watch-next block
(YouTube). When a limit forces a choice the creator's words are trimmed, not the line (captions; the YouTube cross-post
description). On the pipeline's own YouTube upload the line is the one thing dropped when the description is already
at 5000 bytes (a warning is logged and the flag is still sent), because that description is written and measured
elsewhere. The limit is measured in bytes for YouTube (a Russian or Uzbek letter is two bytes), UTF-16 units for TikTok.

### Standard wording

| Language | Line |
| :-- | :-- |
| en (and any other language) | This video contains realistic AI-generated or AI-altered content. |
| ru | В этом видео есть реалистичный контент, созданный или изменённый с помощью ИИ. |
| uz | Ushbu videoda sun'iy intellekt yordamida yaratilgan yoki o'zgartirilgan realistik kontent mavjud. |

The Russian and Uzbek lines are machine drafts: have a native reader confirm them. The language is the channel's
`agent_config.language`.

## What is recorded, and where it is shown

No column and no migration were needed. After a successful upload `main.py` emits a `video.ai_disclosure` event
(`system_events`, with the video id) carrying `label`, `mode`, `reasons` (the closed words above), whether a line was
added, the language, and the facts the decision was made from (counts of generated clips and stills, presenter, voice
word). Counts and words only: no prompt, path or key. The video page reads it the way it reads the publish gate's
event, and shows it in its own "AI-content label" note right under the review panel. A video with no readable record shows as **unknown** (or
"decided at upload" while held), never as "not labelled". The event reaches Supabase with the other events (the
intelligence poll mirrors them), so the panel can say "unknown" for a few minutes after an upload.

Cross-posts read the same event (newest wins) and fall back to the stored `videos.manifest`, then to
`provenance_unknown`. The channel's *current* settings are applied to the recorded facts (a setting changed since the
upload applies to the next post). The video's **own** channel's settings are used for every cross-post, including a
YouTube target, because the label describes the content.

## Interaction with the visibility worker (PR #543, not touched here)

`modules/visibility_publish.py` in #543 rebuilds `status` for `videos.update(part="status")` from a fresh
`videos.list(part=status)` read through `writable_status`, whose `WRITABLE_STATUS` already contains
`containsSyntheticMedia`. So a video uploaded with the flag keeps it when that worker flips privacy, **provided
`videos.list` returns the field for a video where it is true**. `part="status"` replaces the part: if the read ever
omitted a true flag, the update would reset it. This is not verified against the live API (see below); the worker's
own read-back could be extended to refuse when the flag the database recorded as sent is missing from the read.

## The pre-upload checks (Instagram and TikTok)

`modules/social_probe.py` reads the master (ffprobe when installed, else `ffmpeg -i`, plus a header-only walk of the
MP4 boxes for where `moov` sits) before anything is staged or sent. Duration, size and aspect stay in
`social_publish.check_format`.

| Reason word | Instagram Reels | TikTok | Source |
| :-- | :-- | :-- | :-- |
| `bad_codec` | picture H.264 or HEVC | H.264, HEVC, VP8 or VP9 | Instagram Reels `video_url` requirements; TikTok media transfer guide ("H.264 preferred ... H.265, VP8 and VP9 also supported") |
| `bad_audio` | AAC when there is audio (a silent Reel is allowed) | not checked | Instagram: "Audio: AAC"; TikTok's page names no audio codec |
| `bad_framerate` | 23 to 60 fps | 23 to 60 fps | both pages |
| `too_wide` | at most 1920 px wide | - | Instagram: "1920 pixels maximum width" |
| `bad_resolution` | - | both sides 360 to 4096 px | TikTok: "Minimum of 360 pixels for both height and width ... Maximum of 4096" |
| `not_faststart` | `moov` before the media data | not checked | Instagram: "moov atom at the front"; TikTok's page says nothing and sends the file in chunks |
| `unreadable_video` | facts could not be read | same | refused, never passed on a guess |

A refusal is `status = refused` with the word and a plain sentence in en / ru / uz; nothing is re-encoded or remuxed
(an approval binds to the exact cut's hash). Not checked, although the Instagram page lists them: edit lists, closed
GOP, 4:2:0 chroma, 25 Mbps bitrate, 48 kHz audio sample rate.

**Known consequence:** the compositor's `write_videofile` (`modules/compositor.py`) does not pass
`-movflags +faststart`, so a master has `moov` at the end and **every Instagram post will now be refused as
`not_faststart`** until the follow-up below. That is the check doing its job (Instagram documents the requirement),
but it turns "tried and maybe failed after a staged upload" into "refused at once". TikTok is unaffected.

Follow-up (not in this PR): add `-movflags +faststart` to the master encode (`ffmpeg_params` in the compositor), or
produce a stream-copy remux for Instagram (and re-hash the approval), instead of refusing.

## TikTok: unaudited app

TikTok answers HTTP 403 `unaudited_client_can_only_post_to_private_accounts` on `/video/init/` when an app that has
not passed its audit posts for an account that is not private. It is now the closed reason word `tiktok_unaudited`
(a failure, never retried; the detail names the fix), with a sentence in en / ru / uz telling the person to make the
TikTok account private until the app is audited. The post is still requested as `SELF_ONLY`.

## NOT verified (no real platform call was made)

* That YouTube accepts `status.containsSyntheticMedia: true` on `videos.insert` for this app, shows the label, and
  returns it on `videos.list(part=status)` (needed for #543's `writable_status`).
* That Instagram accepts `is_ai_generated` on a Reels container, and TikTok `is_aigc` on Direct Post, for these apps.
* That a master with `moov` at the end is actually rejected by Instagram (the page says it must be at the front).
* The exact wording of the official pages beyond the quotes above (they were read through a page fetch on
  2026-10-19; the YouTube page is stated to be non-exhaustive).
* The Russian and Uzbek disclosure lines and the new panel sentences are machine drafts.
* That `videos.manifest` is populated for videos cross-posted today (it is written from migration 0013 on).

## Decisions for the owner

1. The default wording of the disclosure line (table above), and who reads the ru / uz lines.
2. Generic TTS narration: unlabelled by `auto` (the page is silent). Set `ai_disclosure: always` per channel, or tell
   me to make narration by a synthetic voice a label row.
3. Should `ai_disclosure: never` be an admin-only key (add it to `channels_config_guard`, a new migration)? Today any
   editor who can write `agent_config` can switch the label off.
4. A fully animated / cartoon channel: set `never` per channel, or record a "non-photoreal style" setting that `auto`
   can honour (the page's "not realistic" exemption).
5. Instagram refusal for `not_faststart`: keep it (honest, but blocks every Instagram post until the compositor
   writes `+faststart`), or ship the follow-up first.
6. `AAC` on TikTok and `moov` first on TikTok are not enforced (the official page is silent). Say so if you want them
   enforced anyway.
