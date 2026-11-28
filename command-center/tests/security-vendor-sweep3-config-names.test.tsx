// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vendor sweep 3/3: three of our own names (the pricing variables, the per-channel token secret's prefix, the marketing
 * board's banned provider names) were in chunks any signed-in viewer downloads. The build is held by
 * scripts/vendor-bundle-check.mjs (tests/security-vendor-bundle-check-breach.test.ts); these hold what each viewer is
 * actually handed: the operator gets the names, nobody else does.
 */
const h = vi.hoisted(() => ({ operator: false }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/qa${p}` }));
vi.mock("@/lib/channels-server", () => ({ getChannelScope: async () => ({ kind: "all" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "org-1", is_default: false } }) }));
vi.mock("@/lib/auth/org-roles", () => ({ resolveCurrentOrgRole: async () => "owner", isOperator: async () => h.operator }));
vi.mock("@/lib/auth/roles", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/roles")>()), requireRole: async () => null }));
vi.mock("@/lib/server/google-oauth", () => ({ isGoogleOAuthConfigured: true }));
vi.mock("@/lib/server/social-oauth", () => ({ socialConnectOpen: () => false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/qa/channels/new" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/qa${p}` }));

import NewChannelPage from "@/app/(app)/[channel]/channels/new/page";
import IntelligencePage from "@/app/(app)/[channel]/intelligence/page";
import { AddChannelWizard } from "@/components/channels/AddChannelWizard";
import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { priceConfigHints } from "@/lib/server/price-config-hints";
import { CHANNEL_TOKEN_SECRET_PREFIX, channelTokenSecret } from "@/lib/server/github-secrets";
import { secretRefSuffix } from "@/lib/secret-ref";
import { BANNED_LIST } from "@/lib/marketing-banned";
import { bannedHitsIn, compileBanned } from "@/lib/marketing-banned-match";

function propsOf(node: ReactNode, name: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = propsOf(n, name);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode } & Record<string, unknown>>;
    if (typeof el.type === "function" && (el.type as { name?: string }).name === name) return el.props;
    return propsOf(el.props.children, name);
  }
  return null;
}

beforeEach(() => {
  h.operator = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONFIG_NAME = /CHRONOS_(?:PRICE_|SPONSORSHIP_CPM_USD|YT_TOKEN_)/;

describe("C1: the pricing variables reach the operator only", () => {
  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("the shared %s dictionary (a static chunk every signed-in page loads) names none of them", (_l, dict) => {
    expect(JSON.stringify(dict)).not.toMatch(CONFIG_NAME);
  });

  it("a non-operator's Intelligence page hands the panel no operator sentence", async () => {
    const tree = (await IntelligencePage()) as ReactElement;
    const props = propsOf(tree, "AdvisoryPanel");
    expect(props).not.toBeNull();
    expect(props!.operatorHints).toBeNull();
    expect(JSON.stringify(props)).not.toMatch(CONFIG_NAME);
  });

  it("the operator's names the per-unit cost and sponsor CPM variables", async () => {
    h.operator = true;
    const props = propsOf((await IntelligencePage()) as ReactElement, "AdvisoryPanel");
    const hints = props!.operatorHints as { spendOverview: string; sponsor: string };
    expect(hints.spendOverview).toContain("CHRONOS_PRICE_<UNIT>");
    expect(hints.sponsor).toContain("CHRONOS_SPONSORSHIP_CPM_USD");
  });

  it("Uzbek has no operator sentence: the owner's copy says 'ask the developer' in words (tests/owner-plain-copy.test.ts)", () => {
    expect(priceConfigHints("uz")).toBeNull();
    expect(priceConfigHints("en")?.measure).toContain("CHRONOS_PRICE_<UNIT>");
    expect(priceConfigHints("ru")?.portfolio).toContain("CHRONOS_PRICE_<UNIT>");
  });
});

describe("C2: the per-channel token secret's name reaches the operator only", () => {
  it("a customer's new-channel page hands the wizard no token prefix (its RSC payload)", async () => {
    const props = propsOf((await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement, "AddChannelWizard");
    expect(props).not.toBeNull();
    expect(JSON.stringify(props)).not.toMatch(/CHRONOS_YT_TOKEN_/);
    // #958 kept the YouTube secrets' names for every viewer; only the token prefix is the operator's.
    expect((props!.youtubeNames as Record<string, unknown>).dataKey).toBe("YOUTUBE_DATA_API_KEY");
  });

  it("the operator's does", async () => {
    h.operator = true;
    const props = propsOf((await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement, "AddChannelWizard");
    expect((props!.youtubeNames as Record<string, unknown>).tokenPrefix).toBe("CHRONOS_YT_TOKEN_");
  });

  const names = { dataKey: "YOUTUBE_DATA_API_KEY", clientSecret: "YOUTUBE_CLIENT_SECRET_JSON", channelId: "YOUTUBE_CHANNEL_ID" };
  /** The wizard walked to its API keys step, then to the connect step: returns the text of each. */
  function walk(tokenPrefix: string | null) {
    render(
      <I18nProvider locale="en">
        <AddChannelWizard keyNames={null} youtubeNames={{ ...names, tokenPrefix }} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Finance Daily" } });
    const next = () => fireEvent.click(screen.getByRole("button", { name: en.channels.next }));
    for (let i = 0; i < 5; i++) next();
    const keys = document.body.textContent ?? "";
    next();
    next();
    return { keys, connect: document.body.textContent ?? "" };
  }

  it("a customer's wizard draws no token field and names no secret: it points to the Channels page instead", () => {
    const { keys, connect } = walk(null);
    expect(keys).toContain(en.channels.keyClientSecret);
    expect(keys).not.toContain(en.channels.keyToken);
    expect(connect).toContain(en.channels.connectHintVault);
    expect(`${keys}${connect}`).not.toMatch(/CHRONOS_YT_TOKEN_/);
  });

  it("the operator's names the secret the token is forwarded to", () => {
    const { keys, connect } = walk(CHANNEL_TOKEN_SECRET_PREFIX);
    expect(keys).toContain(en.channels.keyToken);
    expect(keys).toContain("CHRONOS_YT_TOKEN_FINANCE_DAILY");
    expect(connect).toContain("CHRONOS_YT_TOKEN_FINANCE_DAILY");
  });

  // Rows of tests/security/secret_name_corpus.py, the table modules/channel_credentials.secret_name_for and SQL's
  // channel_secret_name answer to: the browser's prefix + suffix and the server's name must give the same literal.
  it.each([
    ["extinct-world", "CHRONOS_YT_TOKEN_EXTINCT_WORLD"],
    ["Extinct World", "CHRONOS_YT_TOKEN_EXTINCT_WORLD"],
    ["-extinct-world", "CHRONOS_YT_TOKEN_EXTINCT_WORLD"],
    ["a_-_b", "CHRONOS_YT_TOKEN_A_B"],
    ["  x  ", "CHRONOS_YT_TOKEN_X"],
    ["my.channel_1", "CHRONOS_YT_TOKEN_MY_CHANNEL_1"],
    ["9lives", "CHRONOS_YT_TOKEN_9LIVES"],
  ])("%j is saved as %s", (ref, want) => {
    expect(channelTokenSecret(ref)).toBe(want);
    expect(CHANNEL_TOKEN_SECRET_PREFIX + secretRefSuffix(ref)).toBe(want);
  });
});

describe("C3: the banned provider names come from the server's prop, not the form's chunk", () => {
  it("the form's matcher knows no vendor of its own: with an empty list it finds none", () => {
    const empty = compileBanned({ rules: [], providerNames: [] });
    expect(bannedHitsIn({ en: "Made with Runway and Kling" }, empty)).toEqual([]);
  });

  it("with the list the page passes, it finds them", () => {
    const ids = bannedHitsIn({ en: "Made with Runway and Kling" }, compileBanned(BANNED_LIST)).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["provider:runway", "provider:kling"]));
  });
});
