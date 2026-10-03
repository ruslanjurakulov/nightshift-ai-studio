---
name: make-a-video
description: Make one video with Nightshift from a brief - choose a channel and length, create the job, wait for it, then find the finished video. Covers the money rules (price is held at creation, charged only on success, never retry with a new idempotency key). Use when asked to create, render or produce a video.
---

# Make a video

Prerequisite: `nightshift whoami` works (see `nightshift-setup`).

## Money rules (read first)

- `nightshift create` spends from the prepaid USD API balance. The price for the requested length is **held immediately**, **charged only if the job succeeds**, and **released in full if it fails**.
- There is no price quote for a video and no ceiling flag. The price is the live per-minute list (with a per-video minimum) applied to the length you ask for, and `create` prints it: "Held from your API balance: $X.XX". Do not quote a price from memory. State the held amount to the person every time, copied from the output.
- Because you cannot know the price before you spend, get the person's go-ahead for the length first ("one video of about 90 seconds on channel X; the price is held when I start it"). Check `nightshift balance` first: if Available is low, stop and say so.
- **Always pass your own `--idempotency-key`.** If a request times out you cannot tell whether it reached the server. Retrying with the same key never charges twice; a new key can. Use one key per intent, for example `mv-<channel>-<topic-slug>-<date>`. Reusing a key with different arguments is refused (`idempotency_key_reused`).
- Never loop `create` hoping one works. One brief, one key.

## Steps

1. Pick the channel.

```bash
nightshift channels
```

Use an id marked `active`. A channel that is not active cannot make videos (`channel_not_active`).

2. Settle the brief with the person: topic (max 300 characters; omit to let the channel pick), optional `--niche`, `--language`, `--visual-style`, and a length. `--duration` takes seconds or `90s`, `2m`, `1m30s`, from 30 seconds to 1 hour. Without it the channel's target length is used; if the channel has none, `duration_required`.

3. Create and wait.

```bash
nightshift create --channel my-channel --topic "How tides work" --duration 90s \
  --idempotency-key mv-my-channel-tides-2026-10-03 --wait --json
```

Expected without `--json`: `Queued job 123 ...`, the held amount, then `job 123: queued`, `running`, and a final `Job 123 succeeded.` with `Charge: charged $X.XX (held $X.XX)`. Exit code 0 only if the job succeeded; a failed or cancelled job exits 1 and the charge reads `nothing charged (the $X.XX hold was released)`.

With `--json --wait` the output is the final job as JSON: `status`, `charge` (`held_cents`, `captured_cents`) and `price_cents` (what was held at creation, or `null` if the API did not report one; never treat `null` as zero).

`--wait` polls with backoff (2s growing to 15s) and gives up after `--timeout` seconds (default 1800). Giving up does not cancel the job. Resume with `nightshift jobs get 123 --wait`.

4. Find the finished video. A job is not linked to the video it made, so list the channel's newest:

```bash
nightshift videos list --channel my-channel --limit 5
nightshift videos get VIDEO_ID
```

Report `review`, `publish` and `privacy` exactly as shown. The video is private; the channel's own review and publish rules apply. **Making a video publishes nothing.** See `download-and-publish` for what comes next.

## If it goes wrong

- Network error or timeout on `create`: the output prints the key. Re-run the identical command with the same `--idempotency-key`. Then `nightshift balance` shows whether a hold exists.
- Exit 4 (`insufficient_balance`, `monthly_limit_reached`, `key_limit_reached`): nothing was held. Tell the person; do not retry.
- Exit 5 (`rate_limit_exceeded`, `concurrency_limit_exceeded`): wait the `Retry-After` seconds shown, then run the same command again with the same key.
- Anything else: `troubleshoot-errors`.
