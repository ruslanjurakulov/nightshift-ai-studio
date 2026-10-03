---
name: download-and-publish
description: Download a finished Nightshift video as a 720p or 1080p MP4 and cross-post it to YouTube, Instagram or TikTok through the API. Explains the publish gate and approvals, that YouTube uploads are private, and never claims a video will go public. Use when asked to export, download, share or publish a video.
---

# Download and publish

## Download an MP4

1. Find the video id: `nightshift videos list --channel my-channel --limit 5`.
2. Order the file. This can cost money; the price is printed:

```bash
nightshift download request VIDEO_ID --quality 1080p --wait
```

Expected: `Price: $X.XX; charged when the file is ready.` then `download 45: queued`, `processing`, and `Download 45 ready.` `--quality` is `720p` or `1080p`. Ordering the same video and quality again within 7 days is free. State the price to the person from the output. A download that ends `failed` or `expired` exits 1.

3. Save it (free; the charge was made when the file became ready):

```bash
nightshift download save 45 --out ./tides.mp4
```

It will not overwrite an existing file without `--force`. If `save` says `download_not_ready`, run `nightshift download get 45 --wait` first. An `expired` file must be ordered again (free within 7 days of the first order).

## Publish (cross-post)

Publishing is free and goes through the same publish gate and approvals as the website. The CLI cannot override or skip either.

```bash
nightshift accounts
nightshift publish VIDEO_ID --youtube my-channel
nightshift publish VIDEO_ID --account ACCOUNT_UUID
```

`accounts` lists targets: YouTube channels of the organization (`--youtube CHANNEL_ID`) and connected Instagram or TikTok accounts (`--account UUID`). Up to 10 targets per request; the flags repeat.

What the answer means:

- Each target prints a status and, if there is one, a reason. Quote them exactly.
- A recorded request is **not** proof that anything is live. Some requests wait for a person's approval.
- **YouTube uploads are always private.** Never tell the person a video "will go public", "is live" or "is published". Say "a private upload was requested". Making it public is a decision made in YouTube Studio by a person.
- A target in the `refused` list (for example `forbidden`, `already_sending`) did not get a request. The command then exits 1.
- `publish_refused` (HTTP 409): the gate or approvals refused the video, for instance it has not passed review. Report the reason. Do not retry in a loop and do not look for a workaround.
- Pass `--idempotency-key` if you may retry, so the same request is not recorded twice.

Check the outcome afterwards:

```bash
nightshift videos get VIDEO_ID
```

It shows review state, publish state, privacy, the YouTube link once uploaded, and each publish request with its status.
