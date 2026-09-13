import { describe, expect, it } from "vitest";
import {
  ACCOUNT_WINDOW_DAYS,
  accountSummaries,
  rollupAccounts,
  type AccountsInput,
} from "@/lib/channels";
import type {
  ChannelCredentialRow,
  ChannelRow,
  ContentQueueRow,
  SystemEventRow,
  VideoRow,
} from "@/lib/types";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** The bot writes `datetime.utcnow().isoformat()` — UTC with no zone suffix. */
function ago(days: number): string {
  return new Date(NOW - days * DAY).toISOString().replace(/Z$/, "");
}

/** A channel YouTube has confirmed — the wizard writes both halves. */
function verified(over: Partial<ChannelRow> & { channel_id: string }): ChannelRow {
  return {
    channel_id: over.channel_id,
    name: over.name ?? over.channel_id,
    niche: "",
    status: over.status ?? "ACTIVE",
    agent_config: null,
    schedule_config: over.schedule_config ?? null,
    credential_ref: over.credential_ref ?? {
      youtube_channel_id: `UC_${over.channel_id}`,
      verified_at: ago(30),
    },
    auto_publish: false,
    created_at: null,
    updated_at: null,
  };
}

/** A channel row nobody ever confirmed: a typed name and a guess. */
function draft(over: Partial<ChannelRow> & { channel_id: string }): ChannelRow {
  return { ...verified(over), credential_ref: over.credential_ref ?? null };
}

let seq = 0;
function ev(over: Partial<SystemEventRow> & { channel_id: string; ts: string }): SystemEventRow {
  seq += 1;
  return {
    event_key: `k${seq}`,
    event: over.event ?? "pipeline.stage",
    ts: over.ts,
    video_id: null,
    job_id: null,
    agent: over.agent ?? null,
    status: over.status ?? "completed",
    duration_ms: null,
    metadata: null,
    channel_id: over.channel_id,
  };
}

function video(channel_id: string, published_at: string | null): VideoRow {
  seq += 1;
  return {
    video_id: `v${seq}`,
    channel_id,
    topic: null,
    title: null,
    slug: null,
    published_at,
    privacy: null,
    category_id: null,
    local_path: null,
    thumbnail_variant: null,
    title_variant: null,
    hook_variant: null,
    video_format: "long",
    parent_video_id: null,
    preview_path: null,
    script_text: null,
    review_state: "pending",
  };
}

function queued(channel_id: string, status = "queued"): ContentQueueRow {
  seq += 1;
  return {
    entry_id: `q${seq}`,
    topic: `topic ${seq}`,
    added_at: ago(1),
    source: null,
    rationale: null,
    status,
    channel_id,
    synced_at: null,
  };
}

function credential(channel_id: string, status = "connected"): ChannelCredentialRow {
  return {
    channel_id,
    provider: "youtube",
    status,
    youtube_channel_id: null,
    expires_at: null,
    last_verified_at: null,
    detail: null,
    synced_at: null,
  };
}

function input(over: Partial<AccountsInput> & { channels: ChannelRow[] }): AccountsInput {
  return {
    channels: over.channels,
    videos: over.videos ?? [],
    queue: over.queue ?? [],
    events: over.events ?? [],
    credentials: over.credentials ?? [],
    lastEventAt: over.lastEventAt ?? {},
    now: over.now ?? NOW,
    windowDays: over.windowDays,
  };
}

function only(over: Partial<AccountsInput> & { channels: ChannelRow[] }) {
  const rows = accountSummaries(input(over));
  expect(rows).toHaveLength(over.channels.length);
  return rows[0];
}

// -- never run -------------------------------------------------------------

describe("a channel that has never run", () => {
  it("is never-run rather than a row of zeros", () => {
    const a = only({ channels: [verified({ channel_id: "finance" })] });
    expect(a.everRan).toBe(false);
    expect(a.activity).toBe("never-run");
    expect(a.lastPublishedAt).toBeNull();
    expect(a.lastActivityAt).toBeNull();
  });

  it("counts as dormant even though its standing is live", () => {
    const a = only({ channels: [verified({ channel_id: "finance" })] });
    expect(a.standing).toBe("live");
    expect(a.dormant).toBe(true);
  });

  it("still reports a queue filled before anything processed it", () => {
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      queue: [queued("finance"), queued("finance")],
    });
    expect(a.everRan).toBe(false);
    expect(a.queued).toBe(2);
  });

  it("is not never-run once ANY event exists, however old", () => {
    // Six months of silence is exactly the channel this screen exists to
    // surface, and the windowed event fetch cannot see it.
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      lastEventAt: { finance: ago(180) },
    });
    expect(a.everRan).toBe(true);
    expect(a.activity).toBe("quiet");
    expect(a.lastActivityAt).toBe(ago(180));
  });

  it("is not never-run once a video exists, even with no event behind it", () => {
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      videos: [video("finance", ago(200))],
    });
    expect(a.everRan).toBe(true);
    expect(a.activity).toBe("quiet");
  });
});

// -- standing --------------------------------------------------------------

describe("standing", () => {
  it("treats an unconfirmed channel as a draft, not a live account", () => {
    const a = only({ channels: [draft({ channel_id: "guess", status: "ACTIVE" })] });
    expect(a.standing).toBe("draft");
    expect(a.dormant).toBe(true);
  });

  it("keeps it a draft even while the row still says ACTIVE", () => {
    // Migration 0005 demotes these, but a dashboard that only tells the truth
    // after a migration is applied is not telling it.
    const rollup = rollupAccounts(
      input({ channels: [draft({ channel_id: "guess", status: "ACTIVE" })] }),
    );
    expect(rollup.live).toBe(0);
    expect(rollup.drafts).toBe(1);
  });

  it("exempts the legacy default channel, which predates confirmation", () => {
    const a = only({ channels: [draft({ channel_id: "default" })] });
    expect(a.standing).toBe("live");
  });

  it("separates a paused channel from a draft", () => {
    const a = only({ channels: [verified({ channel_id: "finance", status: "PAUSED" })] });
    expect(a.standing).toBe("paused");
    expect(a.dormant).toBe(true);
  });
});

// -- activity --------------------------------------------------------------

describe("activity", () => {
  const channels = [verified({ channel_id: "finance" })];

  it("is publishing when something was uploaded inside the window", () => {
    const a = only({
      channels,
      videos: [video("finance", ago(2))],
      lastEventAt: { finance: ago(2) },
    });
    expect(a.activity).toBe("publishing");
    expect(a.published).toBe(1);
    expect(a.dormant).toBe(false);
  });

  it("puts a failure ahead of an upload — that is the channel worth opening", () => {
    const a = only({
      channels,
      videos: [video("finance", ago(1)), video("finance", ago(3))],
      events: [ev({ channel_id: "finance", ts: ago(1), status: "failed", agent: "compositor" })],
      lastEventAt: { finance: ago(1) },
    });
    expect(a.activity).toBe("failing");
    expect(a.published).toBe(2);
    expect(a.failures).toBe(1);
  });

  it("is quiet when the channel has run but not inside the window", () => {
    const a = only({
      channels,
      videos: [video("finance", ago(40))],
      lastEventAt: { finance: ago(40) },
    });
    expect(a.activity).toBe("quiet");
    expect(a.published).toBe(0);
    expect(a.dormant).toBe(true);
  });

  it("excludes an upload one day outside the window", () => {
    const a = only({
      channels,
      videos: [video("finance", ago(ACCOUNT_WINDOW_DAYS + 1))],
      lastEventAt: { finance: ago(ACCOUNT_WINDOW_DAYS + 1) },
    });
    expect(a.published).toBe(0);
    expect(a.activity).toBe("quiet");
  });

  it("honours a caller-supplied window", () => {
    const a = only({
      channels,
      videos: [video("finance", ago(20))],
      lastEventAt: { finance: ago(20) },
      windowDays: 30,
    });
    expect(a.published).toBe(1);
    expect(a.activity).toBe("publishing");
  });
});

// -- per-channel isolation -------------------------------------------------

describe("per-channel isolation", () => {
  const channels = [verified({ channel_id: "finance" }), verified({ channel_id: "history" })];

  it("never lets one channel's rows land on another", () => {
    const rows = accountSummaries(
      input({
        channels,
        videos: [video("finance", ago(1)), video("history", ago(2)), video("history", ago(3))],
        queue: [queued("finance"), queued("history"), queued("history")],
        events: [
          ev({ channel_id: "finance", ts: ago(1), status: "failed" }),
          ev({ channel_id: "history", ts: ago(1), status: "completed" }),
        ],
        lastEventAt: { finance: ago(1), history: ago(1) },
      }),
    );
    const [finance, history] = rows;
    expect(finance.published).toBe(1);
    expect(finance.queued).toBe(1);
    expect(finance.failures).toBe(1);
    expect(history.published).toBe(2);
    expect(history.queued).toBe(2);
    expect(history.failures).toBe(0);
  });

  it("counts only entries still queued, not ones already published", () => {
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      queue: [queued("finance"), queued("finance", "published"), queued("finance", "skipped")],
    });
    expect(a.queued).toBe(1);
  });
});

// -- timestamps ------------------------------------------------------------

describe("last activity", () => {
  it("is whichever of the last event and the last upload is newer", () => {
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      videos: [video("finance", ago(1))],
      lastEventAt: { finance: ago(9) },
    });
    expect(a.lastActivityAt).toBe(ago(1));
  });

  it("falls back to the event when nothing was ever uploaded", () => {
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      videos: [video("finance", null)],
      lastEventAt: { finance: ago(9) },
    });
    expect(a.lastPublishedAt).toBeNull();
    expect(a.lastActivityAt).toBe(ago(9));
  });

  it("reports the newest upload as the last one, whatever order the rows arrive in", () => {
    const a = only({
      channels: [verified({ channel_id: "finance" })],
      videos: [video("finance", ago(30)), video("finance", ago(2)), video("finance", ago(11))],
    });
    expect(a.lastPublishedAt).toBe(ago(2));
  });
});

// -- roll-up ---------------------------------------------------------------

describe("rollupAccounts", () => {
  const channels = [
    verified({ channel_id: "finance" }), // live, publishing
    verified({ channel_id: "history", status: "PAUSED" }), // paused
    draft({ channel_id: "guess" }), // draft, never run
    verified({ channel_id: "space" }), // live, never run
  ];

  const rollup = rollupAccounts(
    input({
      channels,
      videos: [video("finance", ago(1)), video("history", ago(50))],
      queue: [queued("finance"), queued("space")],
      events: [ev({ channel_id: "history", ts: ago(2), status: "failed" })],
      lastEventAt: { finance: ago(1), history: ago(2) },
      credentials: [credential("finance"), credential("history", "expired")],
    }),
  );

  it("counts standings without double counting", () => {
    expect(rollup.live).toBe(2);
    expect(rollup.paused).toBe(1);
    expect(rollup.drafts).toBe(1);
    expect(rollup.live + rollup.paused + rollup.drafts).toBe(channels.length);
  });

  it("counts every channel that is not producing as dormant", () => {
    // history (paused), guess (draft), space (never run) — finance is working.
    expect(rollup.dormant).toBe(3);
  });

  it("sums the window's uploads, queue and failures", () => {
    expect(rollup.published).toBe(1);
    expect(rollup.queued).toBe(2);
    expect(rollup.failures).toBe(1);
    expect(rollup.failing).toBe(1);
    expect(rollup.neverRun).toBe(2);
    expect(rollup.windowDays).toBe(ACCOUNT_WINDOW_DAYS);
  });

  it("carries each channel's own health, and only its own", () => {
    const byId = Object.fromEntries(rollup.accounts.map((a) => [a.channelId, a]));
    // An expired token is one channel's problem, not the fleet's.
    expect(byId.history.health.actionRequired).toBe(true);
    expect(byId.finance.health.actionRequired).toBe(false);
  });
});
