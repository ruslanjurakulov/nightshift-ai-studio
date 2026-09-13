import { describe, expect, it } from "vitest";
import {
  ALL_CHANNELS,
  ALL_CHANNELS_SLUG,
  SECTIONS,
  channelHealth,
  channelPath,
  channelSlug,
  channelStats,
  inSelection,
  isScoped,
  isSection,
  isChannelVerified,
  isValidChannelId,
  resolveSelection,
  scopeQuery,
  selectionSlug,
  selectionToSlug,
  slugToSelection,
  slugifyChannelId,
  voiceOwners,
} from "@/lib/channels";
import type {
  ChannelCredentialRow,
  ChannelRow,
  MetricsSnapshotRow,
  SystemEventRow,
  VideoRow,
} from "@/lib/types";

function channel(over: Partial<ChannelRow> & { channel_id: string }): ChannelRow {
  return {
    channel_id: over.channel_id,
    name: over.name ?? over.channel_id,
    niche: over.niche ?? "",
    status: over.status ?? "ACTIVE",
    agent_config: over.agent_config ?? null,
    schedule_config: over.schedule_config ?? null,
    credential_ref: over.credential_ref ?? null,
    auto_publish: over.auto_publish ?? false,
    created_at: null,
    updated_at: null,
  };
}

let seq = 0;
function ev(over: Partial<SystemEventRow> & { event: string; ts: string }): SystemEventRow {
  seq += 1;
  return {
    event_key: over.event_key ?? `k${seq}`,
    event: over.event,
    ts: over.ts,
    video_id: over.video_id ?? null,
    job_id: null,
    agent: over.agent ?? null,
    status: over.status ?? null,
    duration_ms: null,
    metadata: null,
    channel_id: over.channel_id ?? null,
  };
}

function video(over: Partial<VideoRow> & { video_id: string; channel_id: string }): VideoRow {
  return {
    video_id: over.video_id,
    channel_id: over.channel_id,
    topic: over.topic ?? null,
    title: null,
    slug: null,
    published_at: over.published_at ?? null,
    privacy: null,
    category_id: null,
    local_path: null,
    thumbnail_variant: over.thumbnail_variant ?? null,
    title_variant: over.title_variant ?? null,
    hook_variant: over.hook_variant ?? null,
    video_format: over.video_format ?? "long",
    parent_video_id: over.parent_video_id ?? null,
    preview_path: null,
    script_text: null,
    review_state: "pending",
  };
}

function snap(video_id: string, views: number): MetricsSnapshotRow {
  return {
    video_id,
    snapshot_date: "2026-09-01",
    views,
    likes: null,
    comment_count: null,
    watch_time_minutes: null,
    average_view_duration_seconds: null,
    impressions: null,
    impression_ctr: null,
  };
}

function credential(over: Partial<ChannelCredentialRow> & { channel_id: string }): ChannelCredentialRow {
  return {
    channel_id: over.channel_id,
    provider: over.provider ?? "youtube",
    status: over.status ?? "connected",
    youtube_channel_id: null,
    expires_at: null,
    last_verified_at: null,
    detail: over.detail ?? null,
    synced_at: null,
  };
}

// -- selection -------------------------------------------------------------

describe("resolveSelection", () => {
  const channels = [channel({ channel_id: "default" }), channel({ channel_id: "finance" })];

  it("defaults to all channels with no cookie", () => {
    expect(resolveSelection(undefined, channels)).toBe(ALL_CHANNELS);
  });

  it("keeps a selection that names a real channel", () => {
    expect(resolveSelection("finance", channels)).toBe("finance");
  });

  it("falls back to all channels when the selected channel no longer exists", () => {
    // Showing an empty app with no explanation would be worse than widening.
    expect(resolveSelection("deleted-channel", channels)).toBe(ALL_CHANNELS);
  });

  it("knows when the view is scoped", () => {
    expect(isScoped(ALL_CHANNELS)).toBe(false);
    expect(isScoped("finance")).toBe(true);
  });
});

// -- query scoping ---------------------------------------------------------

describe("scopeQuery", () => {
  function fakeQuery() {
    const calls: string[] = [];
    const q = {
      calls,
      eq(column: string, value: string) {
        calls.push(`eq:${column}=${value}`);
        return q;
      },
      or(filter: string) {
        calls.push(`or:${filter}`);
        return q;
      },
    };
    return q;
  }

  it("does not filter in the all-channels view", () => {
    const q = fakeQuery();
    expect(scopeQuery(q, ALL_CHANNELS)).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("filters to one channel", () => {
    const q = fakeQuery();
    scopeQuery(q, "finance");
    expect(q.calls).toEqual(["eq:channel_id=finance"]);
  });

  it("keeps global rows when null means global", () => {
    const q = fakeQuery();
    scopeQuery(q, "finance", { nullIsGlobal: true });
    expect(q.calls).toEqual(["or:channel_id.eq.finance,channel_id.is.null"]);
  });

  it("honours a different column name", () => {
    // competitor_snapshots.channel_id is the competitor's channel; ours is
    // chronos_channel_id.
    const q = fakeQuery();
    scopeQuery(q, "finance", { column: "chronos_channel_id" });
    expect(q.calls).toEqual(["eq:chronos_channel_id=finance"]);
  });
});

describe("inSelection", () => {
  it("admits everything in the all-channels view", () => {
    expect(inSelection("finance", ALL_CHANNELS)).toBe(true);
    expect(inSelection(null, ALL_CHANNELS)).toBe(true);
  });

  it("rejects another channel's row while scoped", () => {
    expect(inSelection("history", "finance")).toBe(false);
  });

  it("treats null as global only when asked", () => {
    expect(inSelection(null, "finance")).toBe(false);
    expect(inSelection(null, "finance", { nullIsGlobal: true })).toBe(true);
  });
});

// -- health ----------------------------------------------------------------

describe("channelHealth", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");
  const recent = "2026-09-04T09:00:00Z";
  const old = "2026-08-20T09:00:00Z";

  it("reports an expired token as a failure needing action", () => {
    const h = channelHealth(
      channel({ channel_id: "finance" }),
      [ev({ event: "video.published", ts: recent, channel_id: "finance" })],
      credential({ channel_id: "finance", status: "expired", detail: "reconnect" }),
      now,
    );
    expect(h.tone).toBe("fail");
    expect(h.actionRequired).toBe(true);
    expect(h.subsystems.find((s) => s.key === "youtube")?.detail).toBe("reconnect");
  });

  it("does not fault a paused channel for being quiet", () => {
    // A paused channel is idle by choice; calling that unhealthy would train
    // the operator to ignore the indicator.
    const h = channelHealth(channel({ channel_id: "finance", status: "PAUSED" }), [], undefined, now);
    expect(h.subsystems.find((s) => s.key === "scheduler")?.tone).toBe("idle");
    expect(h.actionRequired).toBe(false);
  });

  it("warns when an active channel has produced nothing in 48h", () => {
    const h = channelHealth(
      channel({ channel_id: "finance" }),
      [ev({ event: "video.published", ts: old, channel_id: "finance" })],
      undefined,
      now,
    );
    expect(h.subsystems.find((s) => s.key === "scheduler")?.tone).toBe("warn");
  });

  it("ignores another channel's events entirely", () => {
    // The isolation that matters: History's failures must not colour Finance.
    const h = channelHealth(
      channel({ channel_id: "finance" }),
      [
        ev({ event: "agent.failed", ts: recent, channel_id: "history", agent: "compositor", status: "failed" }),
        ev({ event: "render.completed", ts: recent, channel_id: "finance", agent: "compositor", status: "completed" }),
      ],
      credential({ channel_id: "finance" }),
      now,
    );
    expect(h.subsystems.find((s) => s.key === "generator")?.tone).toBe("ok");
    expect(h.tone).not.toBe("fail");
  });

  it("stays idle rather than green with no evidence", () => {
    const h = channelHealth(channel({ channel_id: "finance", status: "PAUSED" }), [], undefined, now);
    expect(h.tone).toBe("idle");
  });
});

// -- comparison ------------------------------------------------------------

describe("channelStats", () => {
  const channels = [channel({ channel_id: "a", name: "A" }), channel({ channel_id: "b", name: "B" })];

  it("counts only each channel's own videos", () => {
    const stats = channelStats(
      channels,
      [
        video({ video_id: "v1", channel_id: "a", published_at: "2026-09-01T00:00:00Z" }),
        video({ video_id: "v2", channel_id: "b", published_at: "2026-09-02T00:00:00Z" }),
      ],
      [],
    );
    expect(stats.map((s) => s.videos)).toEqual([1, 1]);
  });

  it("reports views as unknown, not zero, when nothing has been polled", () => {
    // A channel with unpolled videos has unknown views; rendering 0 would make
    // a working channel look dead.
    const stats = channelStats(channels, [video({ video_id: "v1", channel_id: "a" })], []);
    expect(stats[0].views).toBeNull();
    expect(stats[0].avgViews).toBeNull();
  });

  it("sums only measured videos", () => {
    const stats = channelStats(
      channels,
      [video({ video_id: "v1", channel_id: "a" }), video({ video_id: "v2", channel_id: "a" })],
      [snap("v1", 100)],
    );
    expect(stats[0].views).toBe(100);
    expect(stats[0].avgViews).toBe(100); // averaged over measured videos only
  });

  it("leaves cadence unknown below two videos", () => {
    const stats = channelStats(channels, [video({ video_id: "v1", channel_id: "a", published_at: "2026-09-01T00:00:00Z" })], []);
    expect(stats[0].daysPerVideo).toBeNull();
  });
});

// -- ids -------------------------------------------------------------------

describe("channel ids", () => {
  it("accepts the shape the bot accepts", () => {
    expect(isValidChannelId("extinct-world")).toBe(true);
    expect(isValidChannelId("default")).toBe(true);
  });

  it("rejects ids the bot would reject", () => {
    expect(isValidChannelId("-leading")).toBe(false);
    expect(isValidChannelId("Upper")).toBe(false);
    expect(isValidChannelId("a")).toBe(false);
    expect(isValidChannelId("has space")).toBe(false);
  });

  it("slugifies a display name into a candidate id", () => {
    expect(slugifyChannelId("Extinct World")).toBe("extinct-world");
    expect(slugifyChannelId("  Chronos: Finance!  ")).toBe("chronos-finance");
  });
});

// ── The URL is the selection ────────────────────────────────────────────────
//
// Every screen lives at /{channel}/{section}. These are the pure pieces that
// make that hold: telling a section segment from a channel segment, and moving
// between the URL's spelling and the internal sentinel.

describe("isSection", () => {
  it("recognises every section the nav offers", () => {
    for (const s of SECTIONS) expect(isSection(s), s).toBe(true);
  });

  it("does not mistake a channel id for a section", () => {
    expect(isSection("chronos")).toBe(false);
    expect(isSection("extinct-world")).toBe(false);
    expect(isSection(ALL_CHANNELS_SLUG)).toBe(false);
    expect(isSection("")).toBe(false);
  });
});

describe("slug ↔ selection", () => {
  it("round-trips every channel", () => {
    for (const id of ["chronos", "extinct-world", "default"]) {
      expect(slugToSelection(selectionToSlug(id))).toBe(id);
    }
  });

  it("spells ALL_CHANNELS as a readable segment, not the sentinel", () => {
    expect(selectionToSlug(ALL_CHANNELS)).toBe("all-channels");
    expect(selectionToSlug(ALL_CHANNELS)).not.toContain("_");
    expect(slugToSelection("all-channels")).toBe(ALL_CHANNELS);
  });
});

describe("channelPath", () => {
  it("puts the channel first and the section after", () => {
    expect(channelPath("chronos", "/videos")).toBe("/chronos/videos");
    expect(channelPath("all-channels", "/command-center")).toBe("/all-channels/command-center");
    expect(channelPath("chronos", "/videos/abc123")).toBe("/chronos/videos/abc123");
  });
});

describe("isValidChannelId reserves the URL's own words", () => {
  it("refuses a name that would make a path ambiguous", () => {
    // A channel called "videos" would make /videos mean two things.
    for (const s of SECTIONS) expect(isValidChannelId(s), s).toBe(false);
    expect(isValidChannelId(ALL_CHANNELS_SLUG)).toBe(false);
  });

  it("still accepts ordinary ids", () => {
    expect(isValidChannelId("chronos")).toBe(true);
    expect(isValidChannelId("extinct-world")).toBe(true);
  });
});

// ── The URL shows the channel's name, never its internal key ────────────────
//
// The production channel's row id is "default", which tells an operator
// nothing. Its name is "Chronos", which tells them everything. The id stays in
// the database where the foreign keys point at it; the URL shows the name.

describe("channelSlug", () => {
  const chronos = channel({ channel_id: "default", name: "Chronos" });
  const extinct = channel({ channel_id: "extinct-world", name: "Extinct World" });
  const all = [chronos, extinct];

  it("uses the name, not the id", () => {
    expect(channelSlug(chronos, all)).toBe("chronos");
    expect(channelSlug(chronos, all)).not.toBe("default");
  });

  it("falls back to the id when two channels share a name", () => {
    const a = channel({ channel_id: "one", name: "Chronos" });
    const b = channel({ channel_id: "two", name: "Chronos" });
    expect(channelSlug(a, [a, b])).toBe("one");
    expect(channelSlug(b, [a, b])).toBe("two");
  });

  it("falls back to the id when the name would claim another channel's id", () => {
    const owner = channel({ channel_id: "finance", name: "Money" });
    const thief = channel({ channel_id: "x1", name: "Finance" });
    expect(channelSlug(thief, [owner, thief])).toBe("x1");
    expect(channelSlug(owner, [owner, thief])).toBe("money");
  });

  it("falls back to the id when the name is a reserved word or unusable", () => {
    const videos = channel({ channel_id: "v1", name: "Videos" });
    const blank = channel({ channel_id: "b1", name: "!!!" });
    const short = channel({ channel_id: "s1", name: "A" });
    expect(channelSlug(videos, [videos])).toBe("v1");
    expect(channelSlug(blank, [blank])).toBe("b1");
    expect(channelSlug(short, [short])).toBe("s1");
  });
});

describe("resolveSelection accepts both spellings", () => {
  const chronos = channel({ channel_id: "default", name: "Chronos" });
  const all = [chronos];

  it("resolves the readable slug", () => {
    expect(resolveSelection("chronos", all)).toBe("default");
  });

  it("still resolves the raw id, so old links keep working", () => {
    expect(resolveSelection("default", all)).toBe("default");
  });

  it("resolves the all-channels segment as well as the sentinel", () => {
    expect(resolveSelection(ALL_CHANNELS_SLUG, all)).toBe(ALL_CHANNELS);
    expect(resolveSelection(ALL_CHANNELS, all)).toBe(ALL_CHANNELS);
  });

  it("refuses a slug that names nothing", () => {
    expect(resolveSelection("nonsense", all)).toBe(ALL_CHANNELS);
  });
});

describe("selectionSlug", () => {
  const chronos = channel({ channel_id: "default", name: "Chronos" });
  it("is the canonical segment the layout redirects toward", () => {
    expect(selectionSlug("default", [chronos])).toBe("chronos");
    expect(selectionSlug(ALL_CHANNELS, [chronos])).toBe("all-channels");
  });
});

describe("a channel is an account only once YouTube says so", () => {
  // The `ruslanjurakulov` channel existed with a typed name, a typed niche and
  // an ElevenLabs voice id of "16516516145" — a number, not a voice. Nothing
  // required a confirmation, so the scheduler dispatched it a job on every
  // manual run. These pin the rule that replaced that.
  const confirmed = {
    verified_at: "2026-09-06T09:00:00Z",
    youtube_channel_id: "UCreal",
    youtube_title: "Extinct World",
  };

  it("accepts a channel YouTube answered for", () => {
    expect(isChannelVerified({ channel_id: "extinct-world", credential_ref: confirmed })).toBe(true);
  });

  it("refuses a draft with nothing behind it", () => {
    expect(isChannelVerified({ channel_id: "draft", credential_ref: null })).toBe(false);
    expect(isChannelVerified({ channel_id: "draft", credential_ref: {} })).toBe(false);
  });

  it("refuses half a record, in either direction", () => {
    // A stamp alone could be written by hand; an id alone could be a typo that
    // never resolved. Only the pair says a lookup happened.
    expect(
      isChannelVerified({ channel_id: "half", credential_ref: { verified_at: confirmed.verified_at } }),
    ).toBe(false);
    expect(
      isChannelVerified({ channel_id: "half", credential_ref: { youtube_channel_id: "UCtypo" } }),
    ).toBe(false);
  });

  it("exempts the legacy default channel", () => {
    // It predates the registry and never passed through a form.
    expect(isChannelVerified({ channel_id: "default", credential_ref: null })).toBe(true);
  });
});

describe("one ElevenLabs voice, one channel", () => {
  const withVoice = (id: string, name: string, provider: string, voice: string) =>
    channel({
      channel_id: id,
      name,
      agent_config: { tts_provider: provider, elevenlabs_voice_id: voice },
    });

  it("names the channel already using each voice", () => {
    const owners = voiceOwners([
      withVoice("a-one", "Alpha", "elevenlabs", "voice-1"),
      withVoice("b-two", "Bravo", "elevenlabs", "voice-2"),
    ]);
    expect(owners).toEqual({ "voice-1": "Alpha", "voice-2": "Bravo" });
  });

  it("ignores edge channels, which have no ElevenLabs voice to share", () => {
    expect(voiceOwners([withVoice("a-one", "Alpha", "edge", "voice-1")])).toEqual({});
  });

  it("ignores an empty voice id rather than claiming it", () => {
    expect(voiceOwners([withVoice("a-one", "Alpha", "elevenlabs", "   ")])).toEqual({});
  });

  it("keeps the first claimant when a collision already exists in the data", () => {
    // The database refuses this now, but rows created before migration 0005
    // could still hold it — the picker must still name somebody.
    const owners = voiceOwners([
      withVoice("a-one", "Alpha", "elevenlabs", "voice-1"),
      withVoice("b-two", "Bravo", "elevenlabs", "voice-1"),
    ]);
    expect(owners["voice-1"]).toBe("Alpha");
  });
});
