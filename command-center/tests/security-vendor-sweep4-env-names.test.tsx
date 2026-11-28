// @vitest-environment jsdom
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vendor sweep 4: our deployment's configuration NAMES (GITHUB_SECRETS_TOKEN, MEDIA_URL_SECRET, NIGHTSHIFT_MODEL_SWITCH, …,
 * lib/server/config-env.ts) were in the shared dictionary, the static chunk every signed-in page loads, in setup sentences on a
 * dozen screens. Names, not values; still our infrastructure's, which a customer can neither set nor needs.
 *
 * What would break: a dictionary sentence that names one again (D1), the guard not knowing one (D3, which runs the real
 * scripts/vendor-bundle-check.mjs on a stand-in build: on the base commit the old sentences passed it), a page handing a
 * customer the operator's sentence (D4), or a screen that shows the operator's sentence to nobody (D5).
 */
const h = vi.hoisted(() => ({ operator: false, guard: true }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/qa${p}` }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null, getUser: async () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "org-1", is_default: false } }) }));
vi.mock("@/lib/auth/org-roles", () => ({
  resolveCurrentOrgRole: async () => "owner",
  isOperator: async () => h.operator,
  guardOperatorPage: async () => h.guard,
}));
vi.mock("@/lib/auth/roles", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/roles")>()), requireRole: async () => null }));
vi.mock("@/lib/server/google-oauth", () => ({ isGoogleOAuthConfigured: false }));
vi.mock("@/lib/server/social-oauth", () => ({ socialConnectOpen: () => false }));
vi.mock("@/lib/server/github-secrets", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/github-secrets")>()),
  isGithubConfigured: false,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/qa/providers" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/qa${p}` }));

import * as ENV from "@/lib/server/config-env";
import { configHints } from "@/lib/server/config-hints";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { I18nProvider } from "@/lib/i18n/context";
import ProvidersPage from "@/app/(app)/[channel]/providers/page";
import NewChannelPage from "@/app/(app)/[channel]/channels/new/page";
import { ProvidersBoard } from "@/components/providers/ProvidersBoard";
import { ChannelTokenPanel } from "@/components/channels/ChannelTokenPanel";

const NAMES = Object.values(ENV).filter((v): v is string => typeof v === "string");
// A whole name, or a prefix as the start of one; not a longer name that merely ends in one of ours.
const NAME_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${NAMES.map((n) => (n.endsWith("_") ? n : `${n}(?![A-Za-z0-9_])`)).join("|")})`);

function leaves(node: unknown, at: string, out: Array<[string, string]>) {
  if (typeof node === "string") out.push([at, node]);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) leaves(v, at ? `${at}.${k}` : k, out);
}

/** Every string a server page's tree holds (its text and its props, which is what the RSC payload would carry). */
function strings(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    if (Array.isArray(node)) for (const n of node) strings(n, out, seen);
    else if ("props" in node) strings((node as { props: unknown }).props, out, seen);
    else for (const v of Object.values(node)) strings(v, out, seen);
  }
  return out;
}

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
  h.guard = true;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("D1: the shared dictionaries name none of our configuration variables", () => {
  it("config-env.ts lists the names Breach found, and more than a handful (the guard reads this file)", () => {
    for (const n of ["GITHUB_SECRETS_TOKEN", "GITHUB_SECRETS_REPO", "PAYMENTS_PROVIDER", "DODO_PAYMENTS_API_KEY", "DODO_TEST_ORG_IDS", "MEDIA_URL_SECRET", "RESEND_API_KEY", "SLACK_WEBHOOK_URL", "TELEGRAM_CHANNEL_BOT_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET", "NIGHTSHIFT_MODEL_KEYS", "NIGHTSHIFT_MODEL_SWITCH"]) {
      expect(NAMES).toContain(n);
    }
    expect(NAMES.length).toBeGreaterThanOrEqual(18);
  });

  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("%s: no sentence of the whole dictionary (sub-dictionaries included) names one", (_l, dict) => {
    const all: Array<[string, string]> = [];
    leaves(dict, "", all);
    const hits = all.filter(([, text]) => NAME_RE.test(text)).map(([p]) => p);
    expect(hits).toEqual([]);
  });

  it("each name is one our server or pipeline really reads (a renamed variable would leave the guard watching a dead name)", () => {
    const cc = process.cwd();
    const repo = path.dirname(cc);
    const skip = new Set(["config-env.ts", "config-hints.ts"]);
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === "node_modules" || name === "i18n" || name.startsWith(".")) continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:ts|tsx|py)$/.test(name) && !skip.has(name)) files.push(p);
      }
    };
    for (const d of [path.join(cc, "lib"), path.join(cc, "app"), path.join(repo, "modules"), path.join(repo, "tools")]) walk(d);
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const dead = NAMES.filter((n) => !new RegExp(`(?<![A-Za-z0-9_])${n}`).test(text));
    expect(dead).toEqual([]);
  });
});

describe("D2: the operator's sentences say what the dictionary no longer does", () => {
  it("en and ru name the variables; Uzbek has none (the owner's copy says 'ask the developer', tests/owner-plain-copy.test.ts)", () => {
    expect(configHints("uz")).toBeNull();
    for (const l of ["en", "ru"] as const) {
      const c = configHints(l)!;
      expect(c.runs).toContain("GITHUB_SECRETS_TOKEN");
      expect(c.providers.ytSetup).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
      expect(c.alerts).toContain("SLACK_WEBHOOK_URL");
      expect(c.credits.notConfiguredDodo).toContain("PAYMENTS_PROVIDER=dodo");
      expect(c.credits.notConfiguredDodo).toContain("DODO_PRODUCT_*");
      expect(c.mediaNoSigning).toContain("MEDIA_URL_SECRET");
      expect(c.modelSwitchOff).toContain("NIGHTSHIFT_MODEL_SWITCH");
      expect(c.marketing.fix.not_configured).toContain("TELEGRAM_CHANNEL_BOT_TOKEN");
    }
  });

  it("Uzbek operator screens keep plain words that send the owner to the developer", () => {
    for (const text of [uz.agents.runNotConfigured, uz.providers.githubNotConfigured, uz.modelKeys.off.body, uz.modelSwitch.off.body, uz.marketing.off.body]) {
      expect(text).toMatch(/dasturchi/i);
      expect(text).not.toMatch(NAME_RE);
    }
  });
});

// ─── D3: the real guard, on a stand-in build ────────────────────────────────────────────────────────────────────────

const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "vendor-bundle-check.mjs");
const { SIGNED_IN_SOURCES } = (await import("../scripts/vendor-bundle-check.mjs")) as { SIGNED_IN_SOURCES: string[] };
const SOURCES = ["lib/effects/effects.json", "lib/effects/catalog.ts", "lib/server/provider-names.ts", "lib/server/ledger-units.ts", ...SIGNED_IN_SOURCES];
const roots: string[] = [];

function fakeBuild(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sweep4-"));
  roots.push(root);
  for (const rel of SOURCES) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    copyFileSync(path.join(CC, rel), path.join(root, rel));
  }
  const chunks = path.join(root, ".next", "static", "chunks");
  mkdirSync(path.join(chunks, "app", "pricing"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(path.join(chunks, `${i}-filler.js`), `self.x${i}={a:1,b:"ok"};`);
  writeFileSync(path.join(chunks, "app", "pricing", "page-def.js"), "self.p=1;");
  writeFileSync(
    path.join(chunks, "70-desk.js"),
    'e("ul",{className:"fx-grid"});e("ul",{className:"cv-effects"});e("div",{id:"credit-prices"});' +
      'e("div",{className:"g2-key-field"});a=t.providers.routingAutopilot;b=t.create.voiceModelDropped;t="00B / Direct model provider review"',
  );
  mkdirSync(path.join(root, ".next", "server", "app"), { recursive: true });
  writeFileSync(path.join(root, ".next", "server", "app", "_not-found.html"), "<html>404</html>");
  return root;
}
const put = (root: string, rel: string, data: string) => writeFileSync(path.join(root, ".next", "static", "chunks", rel), data);
const run = (root: string) => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("D3: scripts/vendor-bundle-check.mjs fails a build whose static chunks name one", () => {
  it("control: the stand-in build is clean", () => {
    const r = run(fakeBuild());
    expect(r.out).toContain("configuration names");
    expect(r.code).toBe(0);
  });

  // Sentences as the base commit's dictionary chunk carried them (2372-*.js): each passed the guard there.
  it.each([
    ["the Run now sentence", 'runNotConfigured:"On-demand runs aren\'t configured (set GITHUB_SECRETS_TOKEN and GITHUB_SECRETS_REPO)."'],
    ["the Dodo sentence", 'notConfiguredDodo:"Selling through Dodo Payments is switched on (PAYMENTS_PROVIDER=dodo) but not configured: set DODO_PAYMENTS_API_KEY"'],
    ["a product id prefix alone", 'x:"the DODO_PRODUCT_* ids"'],
    ["the library sentence", 'noSigning:"Previews are off on this server: MEDIA_URL_SECRET is not set."'],
    ["the alerts sentence", 'setupNote:"Set SLACK_WEBHOOK_URL and RESEND_API_KEY as GitHub Actions secrets"'],
    ["the marketing fix", 'not_configured:"Replace the secret TELEGRAM_CHANNEL_BOT_TOKEN (never paste it here)"'],
    ["a switch read by key", 'var o=e.env["NIGHTSHIFT_MODEL_SWITCH"];'],
    ["a name assembled by the compiler", 'var s="GOOGLE_OAUTH_".concat("CLIENT_SECRET");'],
  ])("catches %s", (_label, text) => {
    const root = fakeBuild();
    put(root, "2372-dict.js", text);
    const r = run(root);
    expect(r.out).toMatch(/configuration name [A-Z]/);
    expect(r.code).toBe(1);
  });

  it.each([
    ["an ordinary ALL_CAPS constant", 'var e="HTTP_STATUS",t="NOT_FOUND_ERROR";'],
    ["a public client name that ends in one of ours", 'n={token:"NEXT_PUBLIC_PADDLE_API_KEY_HINT"};'],
    ["a longer name that starts with one of ours", 'var p="PAYMENTS_PROVIDERS_LIST";'],
  ])("does not flag %s", (_label, text) => {
    const root = fakeBuild();
    put(root, "300-ok.js", text);
    expect(run(root).code).toBe(0);
  });

  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("the %s dictionary as it is now, serialized into a chunk, passes", (_l, dict) => {
    const root = fakeBuild();
    put(root, "2372-dict.js", `self.d=${JSON.stringify(dict)};`);
    const r = run(root);
    expect(r.out).not.toMatch(/configuration name [A-Z]/);
    expect(r.code).toBe(0);
  });
});

// ─── D4: what each page hands a viewer ──────────────────────────────────────────────────────────────────────────────

describe("D4: a page hands the operator's sentence only to the operator", () => {
  const providers = async () =>
    (await ProvidersPage({ params: Promise.resolve({ channel: "qa" }), searchParams: Promise.resolve({ yt: "not_configured" }) })) as ReactElement;

  it("Providers, for the operator the guard let through: the variable names, in the YouTube card, the banner and both panels", async () => {
    const tree = await providers();
    const text = strings(tree).join("\n");
    const c = configHints("en")!.providers;
    expect(text).toContain(c.ytSetup);
    expect(text).toContain(c.ytNotConfigured);
    expect(propsOf(tree, "ProvidersBoard")!.githubHint).toBe(c.github);
    expect(propsOf(tree, "PipelineRouting")!.routingSetupHint).toBe(c.routing);
  });

  it("Providers the guard could not vouch for (no Supabase, no one to check): plain words, no name anywhere in the tree", async () => {
    h.guard = false;
    const tree = await providers();
    const text = strings(tree).join("\n");
    expect(text).toContain(en.providers.ytSetup);
    expect(propsOf(tree, "ProvidersBoard")!.githubHint).toBeNull();
    expect(text).not.toMatch(NAME_RE);
  });

  it("a customer's new-channel page hands the wizard no forwarding sentence; the operator's does", async () => {
    const page = async () => propsOf((await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement, "AddChannelWizard")!;
    const customer = await page();
    expect(customer.keysSetupHint).toBeNull();
    expect(JSON.stringify(customer)).not.toMatch(NAME_RE);
    h.operator = true;
    expect((await page()).keysSetupHint).toContain("GITHUB_SECRETS_TOKEN");
  });
});

// ─── D5: what a screen draws ────────────────────────────────────────────────────────────────────────────────────────

describe("D5: the screens draw the operator's sentence when handed one, and plain words otherwise", () => {
  const inApp = (node: ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

  it("the keys board with forwarding off", () => {
    const plain = inApp(<ProvidersBoard groups={[]} configured={[]} githubConfigured={false} />);
    expect(plain.container.textContent).toContain(en.providers.githubNotConfigured);
    expect(plain.container.textContent).not.toMatch(NAME_RE);
    cleanup();
    const op = inApp(<ProvidersBoard groups={[]} configured={[]} githubConfigured={false} githubHint={configHints("en")!.providers.github} />);
    expect(op.container.textContent).toContain("GITHUB_SECRETS_TOKEN");
  });

  it("a channel's YouTube panel when Google sign-in is not configured", () => {
    const props = { channelId: "c1", status: null, available: true, role: "admin" as const, oauthConfigured: false, requiredScopes: [] };
    const plain = inApp(<ChannelTokenPanel {...props} />);
    expect(plain.container.textContent).toContain(en.channelTokens.oauthNotConfigured);
    expect(plain.container.textContent).not.toMatch(NAME_RE);
    cleanup();
    const c = configHints("en")!.channels;
    const op = inApp(<ChannelTokenPanel {...props} setupHints={{ needsClient: c.needsClient, oauthNotConfigured: c.oauthNotConfigured }} />);
    expect(op.container.textContent).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });
});
