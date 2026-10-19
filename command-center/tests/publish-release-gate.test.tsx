/**
 * "Publish when approved" is hidden from customers until the owner releases it (server flag PUBLISH_ON_APPROVE_RELEASED, default
 * off). Calls the REAL pages with their data layer scripted (the way create-page-no-channel.test.tsx does) and reads what they hand
 * to the browser:
 *
 *   flag off  ->  the Channels page draws no "Publish when approved" switch (the channel's value is not even in the props), and the
 *                 video page's review panel is told "no switch, no request": the key reads "Approve" everywhere, there is no
 *                 "Approve and publish" and no request status, even for a channel whose switch IS on and a request that exists;
 *   flag on   ->  both are shown as before.
 *
 * What would break: the feature visible by default (an unset, empty or odd value, or a NEXT_PUBLIC_ name baked in at build),
 * the switch's value leaking to the browser while hidden, the label "Approve and publish" before release.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("next/link", () => ({ default: () => null }));

const h = vi.hoisted(() => ({
  channels: [] as Record<string, unknown>[],
  video: {} as Record<string, unknown>,
  switchOn: true,
  request: null as Record<string, unknown> | null,
  reads: [] as string[],
}));

/** A PostgREST-ish builder that answers per table and records which columns the page asked for. */
function table(name: string, cols: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["eq", "in", "is", "or", "order", "limit", "select"]) b[m] = () => b;
  h.reads.push(`${name}:${cols}`);
  const data = () => {
    if (name === "videos") return h.video;
    if (name === "channels" && cols === "publish_on_approve") return { publish_on_approve: h.switchOn };
    if (name === "channels") return { auto_publish: false, name: "Chronos" };
    if (name === "video_visibility_requests") return h.request;
    return null;
  };
  b.maybeSingle = async () => ({ data: data(), error: null });
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  return b;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (name: string) => ({ select: (cols: string) => table(name, cols) }),
    rpc: async () => ({ data: "ok", error: null }),
  }),
  getUser: async () => null,
}));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/channels-server", () => ({
  getChannelScope: async () => ({ selection: "all-channels" }),
  fetchChannelTopicScores: async () => [],
  getChannelContext: async () => ({ channels: h.channels, credentials: [], notMigrated: false, scope: { selection: "all-channels" } }),
}));
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  channelInScope: () => true,
  scopeQuery: (q: unknown) => q,
  orgWide: (s: unknown) => s,
  channelHealth: () => ({ channelId: "chronos", tone: "ok", actionRequired: false, subsystems: [] }),
  channelStats: () => [],
}));
vi.mock("@/lib/server/publish", () => ({ loadPublishPanel: async () => ({ accounts: [], youtube: null, requests: [] }) }));
vi.mock("@/lib/server/downloads", () => ({ loadDownloads: async () => null }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "org-1", is_default: true } }) }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => false, resolveCurrentOrgRole: async () => "owner" }));
vi.mock("@/lib/server/channel-tokens", () => ({ fetchTokenStatuses: async () => null }));
vi.mock("@/lib/server/google-oauth", () => ({ YOUTUBE_OAUTH_SCOPES: [], isGoogleOAuthConfigured: false }));
vi.mock("@/lib/server/social-accounts", () => ({ fetchSocialAccounts: async () => ({ rows: [], available: false }) }));
vi.mock("@/lib/server/social-oauth", () => ({ isSocialConfigured: () => false }));
vi.mock("@/lib/server/style-kits", () => ({ loadStyleContext: async () => null }));
vi.mock("@/lib/server/channel-dna", () => ({ loadDnaCharacters: async () => ({ byChannel: new Map(), available: false }) }));

import ChannelsPage from "@/app/(app)/[channel]/channels/page";
import VideoDetail from "@/app/(app)/[channel]/videos/[id]/page";
import { PUBLISH_ON_APPROVE_FLAG, publishOnApproveReleased, withoutPublishSwitch } from "@/lib/server/release-flags";

const CUT = "ab".repeat(32);
const DECIDED = "2026-10-19T10:00:00.000Z";

function find(node: ReactNode, name: string, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, name, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function" && (el.type as { name?: string }).name === name) out.push(el as ReactElement<Record<string, unknown>>);
    find(el.props.children, name, out);
    for (const v of Object.values(el.props)) if (v && typeof v === "object" && !Array.isArray(v) && "props" in (v as object)) find(v as ReactNode, name, out);
  }
  return out;
}

function arrange() {
  h.reads.length = 0;
  h.channels = [{ channel_id: "chronos", name: "Chronos", niche: "history", status: "ACTIVE", auto_publish: false, publish_on_approve: true, agent_config: {} }];
  h.video = {
    video_id: "dQw4w9WgXcQ", channel_id: "chronos", title: "T", privacy: "private", published_at: "2026-10-19T09:00:00Z",
    publish_state: "uploaded", review_state: "approved", approved_cut_sha256: CUT, decided_at: DECIDED, cut_sha256: CUT,
    approval_expires_at: "2099-01-01T00:00:00Z", preview_path: "chronos/x.mp4", gate_verdict: { allowed: true, blocks: [] },
  };
  h.switchOn = true;
  h.request = { id: 41, status: "queued", reason: null, attempts: 0, lifetime_attempts: 0, approved_cut_sha256: CUT, decided_at: DECIDED,
                expires_at: "2099-01-01T00:00:00Z", next_attempt_at: DECIDED, before_privacy: null, after_privacy: null, finished_at: null, created_at: DECIDED };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function channelCards() {
  const tree = (await ChannelsPage({ searchParams: Promise.resolve({}) })) as ReactElement;
  return find(tree, "ChannelCard");
}
async function reviewPanel() {
  const tree = (await VideoDetail({ params: Promise.resolve({ id: "dQw4w9WgXcQ" }) })) as ReactElement;
  const panels = find(tree, "ReviewPanel");
  expect(panels).toHaveLength(1);
  return panels[0].props;
}

describe("the flag", () => {
  it("is off unless it is on / 1 / true / yes, whatever else is set", () => {
    expect(publishOnApproveReleased(undefined)).toBe(false);
    for (const v of ["", "off", "0", "false", "no", "maybe", "onn", " "]) expect(publishOnApproveReleased(v), v).toBe(false);
    for (const v of ["on", "ON", " on ", "1", "true", "Yes"]) expect(publishOnApproveReleased(v), v).toBe(true);
  });

  it("with no argument it reads the server's environment when it is called, and a browser-bundled name counts for nothing", () => {
    expect(publishOnApproveReleased()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_PUBLISH_ON_APPROVE_RELEASED", "on");
    expect(publishOnApproveReleased()).toBe(false);
    vi.stubEnv(PUBLISH_ON_APPROVE_FLAG, "on");
    expect(publishOnApproveReleased()).toBe(true);
    vi.stubEnv(PUBLISH_ON_APPROVE_FLAG, "off");
    expect(publishOnApproveReleased()).toBe(false);
  });

  it("is a server-only module and not a NEXT_PUBLIC variable, not baked in", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "server", "release-flags.ts"), "utf8");
    expect(src).toMatch(/import "server-only";/);
    expect(PUBLISH_ON_APPROVE_FLAG).not.toMatch(/NEXT_PUBLIC/);
    expect(src).toContain("process.env.PUBLISH_ON_APPROVE_RELEASED");
    expect(src).not.toMatch(/process\.env\.NEXT_PUBLIC/);
    for (const page of ["app/(app)/[channel]/channels/page.tsx", "app/(app)/[channel]/videos/[id]/page.tsx"]) {
      const text = readFileSync(join(__dirname, "..", page), "utf8");
      expect(text, page).toContain("publishOnApproveReleased()");
      expect(text, page).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("strips the switch from a channel without touching anything else", () => {
    expect(withoutPublishSwitch({ channel_id: "c", publish_on_approve: true, name: "N" })).toEqual({ channel_id: "c", name: "N" });
    expect("publish_on_approve" in withoutPublishSwitch({ publish_on_approve: false })).toBe(false);
  });
});

describe("flag OFF (the default): nothing of the feature is visible", () => {
  it("the Channels page hands the cards no switch at all, even for a channel whose switch is on", async () => {
    arrange();
    const cards = await channelCards();
    expect(cards).toHaveLength(1);
    const channel = cards[0].props.channel as Record<string, unknown>;
    expect("publish_on_approve" in channel).toBe(false);
    expect(JSON.stringify(cards[0].props)).not.toContain("publish_on_approve");
    expect(channel.channel_id).toBe("chronos");
  });

  it("the video page tells the review panel: no switch, no request (the key stays 'Approve')", async () => {
    arrange();
    const props = await reviewPanel();
    expect(props.publishOnApprove).toBe(false);
    expect(props.request).toBeNull();
    // and it did not even read the two things: nothing about the feature is fetched for a customer who must not see it
    expect(h.reads.filter((r) => r === "channels:publish_on_approve" || r.startsWith("video_visibility_requests:"))).toEqual([]);
  });

  it("an empty or odd value is off too", async () => {
    arrange();
    for (const v of ["", "off", "0", "perhaps"]) {
      vi.stubEnv(PUBLISH_ON_APPROVE_FLAG, v);
      expect((await reviewPanel()).publishOnApprove, v).toBe(false);
      expect("publish_on_approve" in ((await channelCards())[0].props.channel as object), v).toBe(false);
    }
  });
});

describe("flag ON: as released", () => {
  it("the Channels page keeps the switch's value for the card (the card draws the switch from it)", async () => {
    arrange();
    vi.stubEnv(PUBLISH_ON_APPROVE_FLAG, "on");
    const cards = await channelCards();
    expect((cards[0].props.channel as Record<string, unknown>).publish_on_approve).toBe(true);
  });

  it("the video page passes the switch and the request on; an off switch stays off", async () => {
    arrange();
    vi.stubEnv(PUBLISH_ON_APPROVE_FLAG, "on");
    let props = await reviewPanel();
    expect(props.publishOnApprove).toBe(true);
    expect((props.request as { id: number }).id).toBe(41);
    h.switchOn = false;
    props = await reviewPanel();
    expect(props.publishOnApprove).toBe(false);
  });
});
