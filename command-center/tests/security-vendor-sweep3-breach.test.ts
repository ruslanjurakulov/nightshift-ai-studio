/**
 * Breach, vendor sweep 3/3 (bcf95029f): does the hardened scripts/vendor-bundle-check.mjs still print "clean" over a
 * build that carries a vendor name, an effect's model routing, the provider map or our configuration's naming, and does
 * any of the three names this PR moved out of static chunks still reach a customer?
 *
 * Every case below failed on bcf95029f and passes since the sweep 3 fix round. None is skipped. Three SW3-2 shapes Breach
 * found are not caught and are not here (no failing test is committed): an effect's order as a fallback map
 * ({"a":"b","b":"c"}), as Map entries with a rank ([["a",0],["b",1]]) and as [{id:"a"},{id:"b"}] objects; they are in the
 * script header's "not caught" list. SW3-5 (vendor metadata inside the showcase clips) is the owner's decision and not
 * tested here either.
 *
 *   SW3-1  the compiler's own template-literal output (`"a".concat("b")`, which this build emits for app code; SWC ES5
 *          output shown in the case) is not reassembled: only backtick templates are, and the build has none of those
 *          in app code. A prefix, a model id or a provider name assembled by a template passes.
 *   SW3-2  further shapes a developer writes that passed: the provider map as a switch, reversed (name -> slug); an
 *          effect's order in arrow copy; the banned list as one regex or one split string; a prefix joined with a run-time
 *          piece.
 *   SW3-3  CHRONOS_SPONSORSHIP_CPM_USD, our sponsorship pricing variable, is still in the shared dictionary (the same
 *          static chunk, 3425-*.js, every signed-in page loads) and the guard does not know the name.
 *   SW3-4  the new-channel page hands CHANNEL_TOKEN_SECRET_PREFIX ("CHRONOS_YT_TOKEN_") to every viewer's wizard: the
 *          prefix left the static chunk and moved into a customer's RSC payload (and the keys step draws it).
 *   SW3-6  false positive: a Studio picker's own default model (a Studio model id, shown by design) under the ordinary
 *          key `defaultModel:` fails the build.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// SW3-4: the real new-channel page, its data layer scripted as a customer (admin of their own, non-default organization).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/qa${p}` }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "org-customer", is_default: false } }) }));
vi.mock("@/lib/auth/org-roles", () => ({ resolveCurrentOrgRole: async () => "owner", isOperator: async () => false }));
vi.mock("@/lib/auth/roles", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/roles")>()), requireRole: async () => null }));
vi.mock("@/lib/server/google-oauth", () => ({ isGoogleOAuthConfigured: true }));
vi.mock("@/lib/server/social-oauth", () => ({ socialConnectOpen: () => false }));

import NewChannelPage from "@/app/(app)/[channel]/channels/new/page";

const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "vendor-bundle-check.mjs");
const { SIGNED_IN_SOURCES } = (await import("../scripts/vendor-bundle-check.mjs")) as {
  SIGNED_IN_SOURCES: string[];
};
const SOURCES = [
  "lib/effects/effects.json",
  "lib/effects/catalog.ts",
  "lib/server/provider-names.ts",
  "lib/server/ledger-units.ts",
  ...SIGNED_IN_SOURCES,
];
const roots: string[] = [];

type Fx = { id: string; models: string[] };
const EFFECTS = JSON.parse(readFileSync(path.join(CC, "lib/effects/effects.json"), "utf8")).effects as Fx[];
const LONG = [...EFFECTS].sort((a, b) => b.models.length - a.models.length)[0];
const [M0, M1] = LONG.models;
const PROVIDERS = [...readFileSync(path.join(CC, "lib/server/provider-names.ts"), "utf8").matchAll(/^\s*([a-z0-9_]+):\s*"([^"]+)",/gm)].map(
  (m) => [m[1], m[2]] as const,
);
// A pair whose name is not its slug written properly: one is the map's own (the guard's `alone`).
const OWN_PAIR = PROVIDERS.find(([slug, name]) => name.toLowerCase().replace(/[^a-z0-9]/g, "") !== slug)!;
const BANNED = [
  ...(readFileSync(path.join(CC, "lib/marketing-banned.ts"), "utf8").match(/export const BANNED_PROVIDER_NAMES[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
const q = (v: string) => JSON.stringify(v);
const half = (s: string) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))] as const;

function fakeBuild(): string {
  const root = mkdtempSync(path.join(tmpdir(), "breach-sweep3-"));
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

const put = (root: string, rel: string, data: string) => {
  const file = path.join(root, ".next", rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
};

const run = (root: string) => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("sweep 3 breach: harness control", () => {
  it("a clean stand-in build passes and the plainly written routing fails", () => {
    expect(run(fakeBuild()).code).toBe(0);
    const root = fakeBuild();
    put(root, "static/chunks/155-a.js", `m=${JSON.stringify([M0, M1])}`);
    expect(run(root).code).toBe(1);
  });
});

describe("SW3-1: the compiler writes a template literal as .concat(), and the guard does not reassemble it (each must exit 1)", () => {
  // What SWC emits (target ES5, minified) for these sources, verbatim from next/dist/build/swc transform():
  //   const KIND = "PRICE"; export const priceEnvVar = (u) => `CHRONOS_${KIND}_${u.toUpperCase()}`;
  //   -> export var priceEnvVar=function(n){return"CHRONOS_".concat("PRICE","_").concat(n.toUpperCase())};
  //   const MAKER = "runway"; export const ORDER = [`${MAKER}-gen4.5`, "minimax-h3"];
  //   -> export var ORDER=["".concat("runway","-gen4.5"),"minimax-h3"];
  // The real build has the same shape in app code ("ns-rec".concat("quoting"), "Bearer ".concat("<your API key>")).
  const cases: [string, string][] = [
    ["the per-unit cost prefix from a template with an inlined constant", 'export var priceEnvVar=function(n){return"CHRONOS_".concat("PRICE","_").concat(n.toUpperCase())};'],
    ["the token secret prefix from a template", 'var s=function(e){return"CHRONOS_".concat("YT_TOKEN","_").concat(e)};'],
    ["an effect's model order with one id from a template", `export var ORDER=["".concat(${q(half(M0)[0])},${q(half(M0)[1])}),${q(M1)}];`],
    ["a provider pair whose name comes from a template", `var M={${OWN_PAIR[0]}:"".concat(${q(half(OWN_PAIR[1])[0])},${q(half(OWN_PAIR[1])[1])})};`],
  ];
  it.each(cases)("catches %s", (_label, text) => {
    const root = fakeBuild();
    put(root, "static/chunks/400-concat.js", text);
    const r = run(root);
    expect(r.out).not.toContain("clean");
    expect(r.code).toBe(1);
  });
});

describe("SW3-2: shapes a developer writes that the guard passes (each must exit 1)", () => {
  const cases: [string, () => string][] = [
    // providerName() written as a switch instead of a lookup object: the whole map, and no `slug:"Name"` anywhere.
    ["the provider map as a switch", () => `function n(e){switch(e){${PROVIDERS.map(([s, v]) => `case${q(s)}:return ${q(v)};`).join("")}default:return e}}`],
    // A reverse lookup (a picker turning a label back into a slug).
    ["the provider map reversed, name -> slug", () => `R=${JSON.stringify(Object.fromEntries(PROVIDERS.map(([s, v]) => [v, s])))}`],
    ["an effect's order in copy, with arrows", () => `t=${q(`Tries ${LONG.models.join(" → ")}`)}`],
    // The matcher precompiled to one expression: the list itself, no quotes between the names.
    ["the banned provider names as one regex literal", () => `R=/\\b(?:${BANNED.join("|")})\\b/i`],
    ["the banned provider names as one split string", () => `S=new Set(${q(BANNED.join(","))}.split(","))`],
    // A join of literals and one run-time piece: joinRe requires every element to be a literal.
    ["the per-unit cost prefix joined with a run-time unit", () => 'f=function(e){return["CHRONOS","PRICE",e.toUpperCase()].join("_")}'],
  ];
  it.each(cases)("catches %s", (_label, text) => {
    const root = fakeBuild();
    put(root, "static/chunks/410-shape.js", text());
    const r = run(root);
    expect(r.out).not.toContain("clean");
    expect(r.code).toBe(1);
  });
});

describe("SW3-3: our sponsorship pricing variable is in the shared dictionary", () => {
  it.each(["en", "ru", "uz"])("lib/i18n/%s.ts names no CHRONOS_ configuration variable (it is a static chunk every signed-in page loads)", (loc) => {
    // Today: ops.advSponsorHint "… Set CHRONOS_SPONSORSHIP_CPM_USD to price it." in all three.
    expect(readFileSync(path.join(CC, `lib/i18n/${loc}.ts`), "utf8")).not.toMatch(/CHRONOS_[A-Z]/);
  });

  it("and the guard fails a chunk that carries it", () => {
    const root = fakeBuild();
    put(root, "static/chunks/3425-dict.js", 'advSponsorHint:"Suggested price for one integrated slot. Set CHRONOS_SPONSORSHIP_CPM_USD to price it."');
    expect(run(root).code).toBe(1);
  });
});

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

describe("SW3-4: the token secret's prefix reaches a customer's new-channel page", () => {
  it("the wizard is drawn for a customer (control)", async () => {
    const tree = (await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    expect(propsOf(tree, "AddChannelWizard")).not.toBeNull();
  });

  it("and nothing in its props carries CHRONOS_YT_TOKEN_ (the RSC payload a customer downloads)", async () => {
    const tree = (await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    const props = propsOf(tree, "AddChannelWizard") ?? {};
    // Today: youtubeNames.tokenPrefix = "CHRONOS_YT_TOKEN_" for every viewer; the keys step then renders
    // CHRONOS_YT_TOKEN_<REF> in its hint. Only /api/setup/secrets (platform admin) can ever write that secret.
    expect(JSON.stringify(props)).not.toMatch(/CHRONOS_YT_TOKEN_/);
  });
});

describe("SW3-6: false positive on a Studio picker's own default model (must exit 0)", () => {
  it("a defaultModel: key whose value is a Studio model id is the picker, not an image generator's vendor default", () => {
    const studioIds = [...readFileSync(path.join(CC, "lib/creative/model-names.ts"), "utf8").matchAll(/^\s*"([^"]+)":\s*"/gm)].map((m) => m[1]);
    const id = studioIds.find((s) => s.startsWith("kling-")) ?? studioIds[0];
    const root = fakeBuild();
    put(root, "static/chunks/420-picker.js", `var P={defaultModel:${q(id)},aspect:"16:9"};`);
    const r = run(root);
    expect(r.out).toContain("clean");
    expect(r.code).toBe(0);
  });
});
