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

All in the channel's `agent_config` (no column; the Command Center's writers merge into the blob, so the keys survive).
A value that is not one of the allowed words reads as the conservative one, never as "never". The Channels page has a
card for the first two (see "Who can set what"); the other two are set in the database.

| Key | Values | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `ai_disclosure` | `auto` / `always` / `never` | `auto` | `always` labels every video; `never` labels none; `auto` is the table below. Anything else = `auto`. |
| `ai_disclosure_voice` | `generic` / `own_clone` / `real_person` | `generic` | What the narrator's voice is; the pipeline cannot hear it. `real_person` = another real person's voice, cloned or sound-alike. Anything else = `real_person`. |
| `ai_disclosure_line` | `false` to stop the line | `true` | Only an explicit `false` drops the description / caption line; the platform flag is still sent. |
| `ai_disclosure_text` | up to 300 characters | empty | The line's wording. Empty = the standard wording in the channel's language. One line, no angle brackets (YouTube rejects them). |

`never` switches the label off and `own_clone` declares a voice as the owner's own, so both reduce what is declared to the
platforms. Only a **platform administrator** may set them (migration 0114): see "Who can set what".

## The `auto` decision table

`auto` labels the video when **any** row marked "label" holds, and lists every row that holds as the recorded reasons.

| Row (reason word) | What the pipeline knows | Decision | Why, against the official page |
| :-- | :-- | :-- | :-- |
| `generated_video` | at least one AI-generated b-roll clip (`broll.generated`; manifest asset `kind=video, source=generated`) | **label** | "Generates a realistic scene that didn't actually occur." The code cannot tell from pixels whether a clip looks realistic, so every generated clip counts as realistic (conservative). |
| `generated_images` | at least one AI-generated still (`gen_images`; manifest asset `kind=image, source=generated`) | **label** | Same reasoning for stills. |
| `ai_presenter` | an AI presenter clip was generated (`presenter_path`) | **label** | A realistic synthetic person on screen is a realistic scene that did not occur. |
| `real_person_voice` | channel setting `ai_disclosure_voice: real_person` (or an unreadable value) | **label** | "Makes a real person appear to say or do something they didn't do." |
| `provenance_unknown` | no recorded event for the video (nor, for a Short, for its parent video), so only a stored manifest or nothing: a manifest cannot show an AI presenter, so a manifest-only answer is never "known" (only a video uploaded before this change, or a failed read, gets here) | **label** | CLAUDE.md rule 5: an unknown is not a measured "no". The page says undisclosed realistic AI content can be labelled by YouTube itself; over-labelling costs a label. |
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

Cross-posts resolve the facts in this order, first that exists: (1) the video's own event (newest wins); (2) for a
Short (`video_format = short` with a `parent_video_id`) the same event of its **parent** video, because a Short is cut
from the long video's own frames and the Shorts uploaded before this change have no record of their own; (3) the stored
`videos.manifest` (the video's, else the Short's parent's), which can show generated clips and stills but **not an AI
presenter**, so a manifest-only answer is never "known": it labels with `provenance_unknown` next to whatever generated
media it does show; (4) nothing, which labels. New Shorts get their own event at upload (same facts as the long video). The channel's *current* settings are applied to the recorded facts (a setting changed since the
upload applies to the next post). The video's **own** channel's settings are used for every cross-post, including a
YouTube target, because the label describes the content.

## Who can set what (migration 0114, owner decision of 2026-10-20)

`ai_disclosure = never` and `ai_disclosure_voice = own_clone` reduce what the pipeline declares to YouTube, Instagram and
TikTok (a compliance risk for the whole site), so they are writable only by a **platform administrator**:
`public.is_platform_admin()` (migration 0018), i.e. the site owner and the helpers on the platform roster. Not by an
editor, and not by an organization's admin either: on this site every customer is the admin of their own organization,
so an organization-admin lock would stop nobody.

| Who | `ai_disclosure` | `ai_disclosure_voice` | Anything else in `agent_config` |
| :-- | :-- | :-- | :-- |
| Platform administrator (site owner, helpers) | `auto`, `always`, `never` | `generic`, `own_clone`, `real_person` | as before |
| Anyone else who can edit the channel (an organization's editor, admin or owner) | `auto`, `always` | `generic`, `real_person` | as before |
| The service role (the pipeline, `supabase_sync`), the SQL editor | all | all | all (0086's convention: only the browser roles are held to the guard) |
| Someone who cannot edit the channel | nothing | nothing | nothing |

What "set" means. A write is refused when it makes the stored value one the **reader** (`normalize_mode`,
`normalize_voice`) would read as `never` / `own_clone` and the stored text was not already exactly that. So:

* `Never`, ` never`, `NEVER`, `never\n`, a no-break space around it, and every other spelling Python's `str.strip().lower()`
  reads as `never` (or `own_clone`) are refused. The SQL helper `ai_disclosure_norm` lists the stripped characters
  explicitly, and `tests/test_ai_disclosure_lock_migration.py` and `tests/security/test_sec_ai_disclosure_lock.py` check
  it against the reader over every Unicode code point. A value the reader reads as a conservative word (a typo, a number,
  a list) is not lowering and is not refused.
* A write that leaves the stored value as it is passes: editing the language of a channel that already has `never`
  (the Voice, Cast and Schedule pages write the whole blob back) still works, and moving a key to a value that raises the
  label (`always`, `real_person`) or removing it always works. A page that was loaded before a platform administrator
  moved a key off `never` and then writes the old blob back is refused (it would set `never` again); reload and retry.
* The refusal is SQLSTATE `42501`, message prefix `ai_disclosure_lock:`, hint `ai_disclosure_lock`. The Channels page words
  it in the person's language.

Where it is enforced, and every writer of `agent_config`:

| Writer | How the lock covers it |
| :-- | :-- |
| `UPDATE channels` from the browser (PostgREST: the Channels, Voice, Cast, Schedule, Studio pages) | `channels_config_guard()` trigger (0086, extended in 0114): runs as the caller, refuses the write unless `is_platform_admin()` |
| `INSERT` into `channels` from the browser | INSERT is revoked from the browser roles (0086); the same trigger is the second wall |
| `create_channel(...)` (the wizard, the YouTube connect callback) | `SECURITY DEFINER`, so the trigger does not see the browser: 0114 repeats the check on `p_agent_config` (`trusted caller or is_platform_admin()`) |
| `set_channel_dna(...)` (0056) | `SECURITY DEFINER`, merges only `elevenlabs_voice_id` and `language`; it cannot set either key (pinned by a test) |
| `set_channel_credential`, `set_channel_status`, `channel_stamp_from_connection` (0086) | do not touch `agent_config` |
| `supabase_sync.mirror_channels` (the pipeline) | service role; writes only into an empty `channels` table, from the operator's own `channels.json`; passes the guard like every service write |
| `channels.json` (the operator's own file, read by the pipeline) | not a database write: only whoever holds the server can edit it, which is the platform side; the pipeline reads it, never writes it |
| 0001 / 0005 / 0018 backfills | run once as the database owner; touch no `agent_config` value of either key |
| The public API and MCP (`api_*`, `oauth_*`, 0031, 0042, 0093) | read `agent_config`; none writes it |

A test fails if a new migration writes `channels` or `agent_config` without being added to that list.

Nothing was rewritten: the live check before 0114 found no channel with either key set, so there is no backfill. A
channel that gets either value from the platform keeps it, and every use stays visible, as before: `main.py` logs a warning
("channel settings (...) are in effect for this video"), the recorded event carries `overrides: ["mode_never",
"voice_own_clone"]`, and the review note says that a person chose it (and, for `never`, that the content was not checked:
it does not say "nothing in this video needs the label").

The Channels page has an "AI-content label" card per channel with both settings. A platform administrator sees all three
words of each; everyone else sees `never` and `own_clone` locked, with the reason, and can move a setting away from them.
The ru and uz sentences of the card are machine drafts.

Rollback: `docs/sql/rollback_0114_ai_disclosure_admin_lock.sql` puts 0086's two function bodies back (the trigger is the
same trigger) and drops the two helpers; it rewrites no row.

## The default voice is an assumption

`ai_disclosure_voice` defaults to `generic`, i.e. "the narrator is not a real person's voice". The pipeline cannot hear
or classify a voice: a cloned or celebrity-sounding ElevenLabs voice picked from the account's list is **not detected**
and is not labelled unless the channel sets `real_person`. This is an owner decision (below), not a measurement: the default
stays `generic` and all three values stay available, but `own_clone` is a platform administrator's to set.

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
3. ~~Should `ai_disclosure: never` be an admin-only key?~~ **Decided 2026-10-20: yes, a platform administrator's** (migration
   0114; an organization-admin lock was rejected because every customer is the admin of their own organization).
   A fully animated channel that wants `never` asks the platform team.
4. A fully animated / cartoon channel: set `never` per channel, or record a "non-photoreal style" setting that `auto`
   can honour (the page's "not realistic" exemption).
5. Instagram refusal for `not_faststart`: keep it (honest, but blocks every Instagram post until the compositor
   writes `+faststart`), or ship the follow-up first.
6. ~~The default voice `generic` is an assumption.~~ **Decided 2026-10-20: the default stays `generic` and all three values
   stay available.** `own_clone` (the one that lowers the label) is a platform administrator's to set; `real_person` is open to
   every editor of the channel. The pipeline still cannot hear a voice: a cloned or celebrity voice picked from the account's
   list is not detected unless the channel says `real_person`.
7. `AAC` on TikTok and `moov` first on TikTok are not enforced (the official page is silent). Say so if you want them
   enforced anyway.
