/**
 * The custom voice page is dark unless CUSTOM_VOICE_ENABLED=1 (lib/custom-voice.ts, slice V3 of docs/CUSTOM_VOICE.md).
 *
 * What would break without these: a flag-off request that still reaches the auth gate or the page (a Supabase call for a page that is
 * meant not to exist); a flag-off request answered with a redirect to /login instead of the public 404 (it would say the page exists);
 * the flag-on request not reaching the gate (the page would be public); the page's own check missing, so a request that got past the
 * middleware would still read the channel and the organization; the page linked from somewhere while it is dark.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null, created: 0, getUser: 0 }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    auth.created++;
    return {
      auth: {
        getUser: async () => {
          auth.getUser++;
          return { data: { user: auth.user } };
        },
      },
    };
  },
}));
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));

const page = vi.hoisted(() => ({ server: 0, channel: 0, org: 0, dict: 0 }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    page.server++;
    return null;
  },
  getUser: async () => {
    page.server++;
    return null;
  },
}));
vi.mock("@/lib/channels-server", () => ({
  getChannelContext: async () => {
    page.channel++;
    return { selection: "chronos", channels: [{ channel_id: "chronos" }], scope: {} };
  },
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => {
    page.org++;
    return { supported: true, orgs: [], current: { id: "org-1" } };
  },
}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("@/lib/i18n/en");
  return {
    getDictionary: async () => {
      page.dict++;
      return { t: en };
    },
  };
});
vi.mock("@/components/voice/CustomVoice", () => ({ CustomVoice: () => null }));

const { middleware } = await import("@/middleware");
const { default: CustomVoicePage } = await import("@/app/(app)/[channel]/agents/voice/page");

async function visit(path: string) {
  const res = await middleware(new NextRequest(`https://nightshift.test${path}`, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } }));
  const rewrite = res.headers.get("x-middleware-rewrite");
  return {
    res,
    notFound: res.status === 404 && Boolean(rewrite?.endsWith("/_not-found")),
    toLogin: res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login"),
    served: res.status === 200 && !rewrite,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  auth.user = null;
  auth.created = 0;
  auth.getUser = 0;
  page.server = page.channel = page.org = page.dict = 0;
});

const PAGES = ["/chronos/agents/voice", "/all-channels/agents/voice", "/chronos/agents/voice/", "/chronos/agents/voice.rsc"];

describe("flag off (unset)", () => {
  it.each(PAGES)("%s is the public 404 for a signed-out visitor and creates no Supabase client", async (p) => {
    const r = await visit(p);
    expect(r.notFound).toBe(true);
    expect(auth.created).toBe(0);
    expect(auth.getUser).toBe(0);
  });

  it.each(PAGES)("%s is the same 404 for a signed-in person, with no Supabase call", async (p) => {
    auth.user = { id: "u1" };
    const r = await visit(p);
    expect(r.notFound).toBe(true);
    expect(auth.created).toBe(0);
  });

  it.each(["", "0", "true", "yes", " 1", "on"])("a flag set to %j is off too", async (v) => {
    vi.stubEnv("CUSTOM_VOICE_ENABLED", v);
    expect((await visit("/chronos/agents/voice")).notFound).toBe(true);
    expect(auth.created).toBe(0);
  });

  it("does not touch the neighbouring pages: the agents page still reaches the gate", async () => {
    const r = await visit("/chronos/agents");
    expect(auth.created).toBe(1);
    expect(r.notFound).toBe(false);
  });

  it("the page itself is a 404 and reads nothing: no dictionary, no channel, no organization, no client", async () => {
    await expect(CustomVoicePage()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(page).toEqual({ server: 0, channel: 0, org: 0, dict: 0 });
  });
});

describe("flag on (1)", () => {
  beforeEach(() => vi.stubEnv("CUSTOM_VOICE_ENABLED", "1"));

  it("a signed-out visitor still goes to sign-in, not to the page", async () => {
    const r = await visit("/chronos/agents/voice");
    expect(auth.created).toBe(1);
    expect(r.toLogin).toBe(true);
  });

  it("a signed-in person reaches the page", async () => {
    auth.user = { id: "u1" };
    const r = await visit("/chronos/agents/voice");
    expect(r.served).toBe(true);
  });

  it("the page renders for the current channel and organization, and reads no table itself", async () => {
    const el = (await CustomVoicePage()) as { props: { children: Array<{ props: Record<string, unknown> }> } };
    const voice = el.props.children[1];
    expect(voice.props).toMatchObject({ channelId: "chronos", orgId: "org-1" });
    expect(page.server).toBe(0);
  });
});

describe("where it is linked from", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

  it("the agents page links to it only inside the flag", () => {
    const src = read("app", "(app)", "[channel]", "agents", "page.tsx");
    expect(src).toMatch(/customVoiceEnabled\(\) && \(\s*<p>\s*<Link href=\{\(await getChannelPath\(\)\)\("agents\/voice"\)\}/);
  });

  it("no navigation list, sitemap or section list names it", () => {
    for (const f of [["lib", "navigation.ts"], ["lib", "public-paths.ts"], ["app", "sitemap.ts"], ["lib", "channels.ts"]]) {
      expect(read(...f), f.join("/")).not.toMatch(/agents\/voice/);
    }
  });
});

describe("the switch is wired the way the deploy expects", () => {
  const root = join(__dirname, "..", "..");
  it("ships empty in the environment example and is mapped by the deploy workflow", () => {
    expect(readFileSync(join(root, "deploy", ".env.web.example"), "utf8")).toMatch(/^CUSTOM_VOICE_ENABLED=$/m);
    expect(readFileSync(join(root, ".github", "workflows", "deploy_web.yml"), "utf8")).toContain("WEBENV_CUSTOM_VOICE_ENABLED: ${{ vars.CUSTOM_VOICE_ENABLED }}");
  });
});
