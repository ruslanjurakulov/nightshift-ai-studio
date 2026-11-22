# Export downloads: original vs preview (stream S2)

## 1. Evidence (measured on `main` at 0025a1a, before any change)

### Where the files live

| Path | Who writes it | Where the master is | Rendered size | Preview copy |
| :-- | :-- | :-- | :-- | :-- |
| Editor export | `modules/editor_export.py:351` `run_export`, renders and then `store_generated(..., source="render")` at `:468` | media volume, `<media>/<aa>/<uuid>/original` (`modules/media_library.py:133`, `lib/server/media.ts:63-76`) | the project's own frame, or a frame from `schemas/export_presets.json` (1920x1080, 1080x1920, 1080x1080, 1080x1350, 1280x720; above 1080p is paid, 0132) | `proxy.mp4`, short side **480** (`media_library.py:140`, `:799-806`) |
| Creative job (a model's video or image) | `modules/creative_worker.py:1202` `_to_library` → `store_generated(..., source="generated")` | the same media volume, `original` | whatever the provider returned (native) | the same 480p `proxy.mp4` for video |
| Pipeline (YouTube bot) video | `main.py` render; review copy uploaded by `modules/video_review.py:40` | 480p review copy in the Supabase `previews` bucket (50 MB ceiling); the master stays on the worker's downloads volume | 1080p master | the `previews` bucket copy |

### Who can reach what

* `media_assets` rows: RLS `media_assets_select`, `deleted_at is null and org_id in accessible_org_ids()` (`supabase/migrations/0038_media_assets.sql:835-837`), so any member, viewers included. `editor_exports`: the same org rule (`0054_editor_projects.sql:530-532`).
* File bytes: `GET /api/media/file/{id}/{variant}` (`app/api/media/file/[id]/[variant]/route.ts`). This route reads **no session**. The HMAC link is the authorization, bound to id, variant, mime and expiry (`lib/server/media.ts:103-140`), and it is served `Content-Disposition: inline`.
* Pipeline HD: `POST /api/downloads` (buy, `request_download`, editor+), then `GET /api/downloads/{id}` streams `<NIGHTSHIFT_DOWNLOADS_DIR>/<id>.mp4` to members (RLS) while the row is `ready` and not expired. `/api/v1/downloads/{id}/file` does the same for API keys.

### URL lifetimes

* Signed media links: `MEDIA_URL_TTL_S = 600` s, never above 3600 (`lib/server/media.ts:87-90`). They are minted when the page renders, so after ten minutes an open Library or editor page holds dead links (410 `expired`).
* Pipeline HD file: `expires_at`, 24 h by default, at most 168 h (`0030_paid_downloads.sql:477`). Asking again within 7 days is free (`:353`, `:369`; `lib/downloads.ts` `REDOWNLOAD_DAYS`).

### What the UI offers today, and the bug

* `withUrls()` (`lib/server/media.ts:245-252`) gives a video exactly one `viewUrl`: the **proxy**. No original link is ever made for a page.
* The editor's finished export: `ExportStatusPanel.tsx:251-259` "Open video" → `viewUrl` = **480p proxy**. There is no download of the original. **This is the observed bug** ("the 480p preview showed; no separate 1080p original").
* The Library viewer: `components/media/MediaViewer.tsx:323-331` "Open in tab" → `viewUrl` = proxy. There is no original either.
* The Create result card: `components/studio/JobFeed.tsx:955-1000` `DownloadKey` fetches `/api/media/{id}` and downloads `urls.original`, so this one is correct. But when signing fails it opens `resultHref(job)` (`lib/creative/studio.ts:1333`), the **provider's** URL. That is a different file, it may expire, and it is a quiet substitute (rule 4).
* `GET /api/media/{id}` already signs `original` (`app/api/media/[id]/route.ts:39`). That makes it a bearer link: anyone holding it can fetch the original for 10 minutes without a session.
* `exportDisplayStatus` (`lib/editorExportStatus.ts:28-33`) shows `link_pending` when an export is `done` but has no `viewUrl`.
* The poll (`components/editor/useExportPoll.ts:14-26`) only re-reads the project with `fetchProject`, a GET. It renders nothing. Re-export is the explicit Export or Try again button, which calls `request_editor_export`.
* SRT: the editor can download captions from its own document (`lib/captions.ts:672` `buildSrt`). A finished export offers no SRT, although `editor_exports.doc` keeps the exported revision's `captions` (`0054:128`).

## 2. The change

`GET /api/library/{asset}/download?variant=original|preview|captions`

| variant | What it returns | Auth |
| :-- | :-- | :-- |
| `original` | streams the master (`original`): `Content-Disposition: attachment`, the real `Content-Type` and `Content-Length`, Range supported, `Cache-Control: private, no-store` | session; the asset row is read under RLS first |
| `preview` | `303` to a freshly signed `/api/media/file/{id}/proxy` link (video) or `display` (image), so a `<video>` keeps its range requests. Audio, captions and a picture without a display copy have no preview. Another variant is never substituted | session; RLS read first |
| `captions` | `application/x-subrip` SRT, as an attachment, from one of two sources: the export's captions (`editor_exports.doc.captions` of the export that made this asset), or, when no export made it, a film master's own captions file (see "A film master's captions" below). Always SRT, whichever the source | session; RLS on both tables |

Answers:

| Status | `error` | Meaning |
| :-- | :-- | :-- |
| 401 | `unauthorized` | no session |
| 400 | `bad_request` | not a uuid, an unknown variant, or a stored type outside the allowed list |
| 404 | `not_found` | no such asset in any of the caller's organizations. Another tenant's asset gets the same answer, so it cannot be probed |
| 404 | `no_preview` | this asset has no preview copy (yet). The original is **not** served instead |
| 404 | `no_captions` | the newest export that made this asset has no caption cues; or no export made it and it names no captions file, or the file it names is not its own (below) |
| 416 | | a Range outside the file |
| 502 | `read_failed` | the export row or the film's captions row could not be read, or the captions file is not WebVTT this route can convert as a whole (never reported as "no captions", never a partial file) |
| 410 | `gone` | the row exists but the file was purged (the master, or a film's captions file) |
| 503 | `media_unavailable` | this host has no media volume or no signing key (Vercel) |
| 503 | `not_configured` | Supabase is not configured on this host |

The URL is stable and holds no secret, so it never expires. Each press re-reads the row and, for a preview, signs a new link. A page left open for an hour still downloads.

No route here renders, charges or writes anything: it reads under the caller's session and streams. A status re-read never creates an export. Re-export stays the explicit button that calls `request_editor_export`.

### A film master's captions (S4 G3)

**Before:** a film master (`modules/film_assembly.py`) has no editor export, so `?variant=captions` answered `404 no_captions` and the person could not take the film's captions with it.

**After:** film_assembly stores the film's captions as their own library file (`kind = caption`, `text/vtt`, `source = generated`, provenance `film_segment_id`, `film_id`, `cut_sha256`, `role: "captions"`) and writes its id into the master's provenance as `captions_asset_id`. When no export made the asset, the route:

1. reads the master's `org_id` and `provenance` in the same RLS read as the rest of its row;
2. takes `captions_asset_id` only if it is a canonical uuid (`parseMediaId`; anything else, `../../etc/passwd` included, is `no_captions` and never reaches a query or a path);
3. reads that row under the same session (RLS: the caller's workspace, not deleted; never the service key) and accepts it only if it is `kind = caption`, `text/vtt`, the master's own `org_id`, the same `film_segment_id` and `cut_sha256` as the master, and `role = "captions"`. Anything else is `404 no_captions`;
4. reads the file from the media volume (`assetFilePath(dir, id, "original")`; `503 media_unavailable` without the volume, `410 gone` when purged, at most 2 MB) and converts WebVTT to SRT (`lib/libraryDownload.ts` `vttToSrt`: the `WEBVTT` header and `NOTE`/`STYLE`/`REGION` blocks dropped, cue settings and voice/class tags dropped, cues renumbered from 1, `.` to `,`). One timing line that does not parse refuses the whole file as `502 read_failed`.

The answer has the same headers as an export's SRT (`application/x-subrip`, attachment, `private, no-store`, `nosniff`). `AssetDownloads` already takes `captions`, so the studio's live view can offer it on the final node by passing `captions`.
