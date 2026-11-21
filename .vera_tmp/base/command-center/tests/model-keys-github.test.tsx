/**
 * The "key used by runs" line against a FAKE GitHub API (lib/server/github-secrets.ts is NOT mocked here).
 *
 * What would break without these: a vendor whose secret name the Providers board's allowlist does not know (xAI, AssemblyAI, Runway, Luma,
 * Kling's access/secret pair) reading "not set, a run stops" for a key that IS set (CLAUDE.md rule 5), and a listing GitHub cut at 100
 * secrets reading "not set" for a name that was simply not on the first page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ALL_ENV_NAMES } from "../lib/model-keys";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u1" }),
  createClient: async () => {
    throw new Error("the page must not create a database client");
  },
}));
vi.mock("@/lib/auth/org-roles", () => ({ guardOperatorPage: async () => true }));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => "owner" }));

const TOKEN = "ghp_faketoken_0123456789";
const m = en.modelKeys;

interface Fake {
  /** secrets per page, in order */
  pages: string[][];
  total: number;
  status?: number;
}
let fake: Fake;
let calls: { url: string; auth: string | null }[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", "on");
  vi.stubEnv("GITHUB_SECRETS_TOKEN", TOKEN);
  vi.stubEnv("GITHUB_SECRETS_REPO", "acme/bot");
  calls = [];
  fake = { pages: [[]], total: 0 };
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (u.origin !== "https://api.github.com" || u.pathname !== "/repos/acme/bot/actions/secrets") throw new Error(`unexpected request ${url}`);
    if (fake.status) return new Response("{}", { status: fake.status });
    const n = Number(u.searchParams.get("page") ?? "1");
    expect(u.searchParams.get("per_page")).toBe("100");
    const names = fake.pages[n - 1] ?? [];
    return new Response(JSON.stringify({ total_count: fake.total, secrets: names.map((name) => ({ name, created_at: "x", updated_at: "y" })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const page = async () => renderToStaticMarkup((await (await import("../app/(app)/[channel]/model-keys/page")).default()) as ReactElement);
/** The "key used by runs" source of each card, read from the markup. */
const sources = (html: string) => {
  const out: Record<string, string> = {};
  for (const part of html.split('data-provider="').slice(1)) {
    const id = part.slice(0, part.indexOf('"'));
    out[id] = /data-source="(\w+)"/.exec(part)?.[1] ?? "?";
  }
  return out;
};

describe("a vendor whose secret the Providers board does not list", () => {
  it("reads 'env' for xAI, AssemblyAI, Runway, Luma and Kling (both the single key and the pair) when GitHub has the secrets", async () => {
    fake = { pages: [["XAI_API_KEY", "ASSEMBLYAI_API_KEY", "RUNWAYML_API_SECRET", "LUMA_AGENTS_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY", "UNRELATED_SECRET"]], total: 7 };
    const s = sources(await page());
    expect(s.xai).toBe("env");
    expect(s.assemblyai).toBe("env");
    expect(s.runway).toBe("env");
    expect(s.luma).toBe("env");
    expect(s.kling).toBe("env");
    // and the rest are truly not set, because the listing was complete
    expect(s.openai).toBe("none");
    expect(s.bfl).toBe("none");
  });

  it("Kling's pair needs BOTH halves; the single key alone is enough too", async () => {
    fake = { pages: [["KLING_ACCESS_KEY"]], total: 1 };
    expect(sources(await page()).kling).toBe("none");
    vi.resetModules();
    fake = { pages: [["KLING_API_KEY"]], total: 1 };
    expect(sources(await page()).kling).toBe("env");
  });

  it("asks GitHub with the server's token, never shows it, and learns nothing but names", async () => {
    fake = { pages: [["XAI_API_KEY"]], total: 1 };
    const html = await page();
    expect(calls.length).toBe(1);
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("UNRELATED");
  });
});

describe("a listing that spans several pages, or is cut short", () => {
  it("pages through all of it: a name on page 2 is found", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `OTHER_SECRET_${i}`);
    fake = { pages: [first, ["XAI_API_KEY", "OPENAI_API_KEY"]], total: 102 };
    const s = sources(await page());
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(s.xai).toBe("env");
    expect(s.openai).toBe("env");
    expect(s.bfl).toBe("none");
  });

  it("total_count 150 but 100 returned: a name not seen is 'unknown' (never 'none'), a name seen is still 'env'", async () => {
    const first = [...Array.from({ length: 99 }, (_, i) => `OTHER_SECRET_${i}`), "OPENAI_API_KEY"];
    fake = { pages: [first, []], total: 150 };
    const html = await page();
    const s = sources(html);
    expect(s.openai).toBe("env");
    expect(s.xai).toBe("unknown");
    expect(s.bfl).toBe("unknown");
    expect(Object.values(s)).not.toContain("none");
    expect(calls).toHaveLength(2); // page 2 came back empty: no further asking
    expect(html).not.toContain("is not set");
    expect(html).toContain(m.source.unknown.replace(/&/g, "&amp;"));
  });

  it("a GitHub that never gives the rest is bounded: it stops after the page cap and says unknown", async () => {
    const same = Array.from({ length: 100 }, (_, i) => `OTHER_SECRET_${i}`);
    fake = { pages: Array.from({ length: 30 }, () => same), total: 3000 };
    const s = sources(await page());
    expect(calls.length).toBe(10);
    expect(s.xai).toBe("unknown");
  });
});

describe("a GitHub that cannot be read", () => {
  it.each([401, 403, 404, 500])("answering %i is 'unknown' for every card, never 'none'", async (status) => {
    fake = { pages: [[]], total: 0, status };
    const html = await page();
    expect(new Set(Object.values(sources(html)))).toEqual(new Set(["unknown"]));
    expect(html).not.toContain(TOKEN);
  });

  it("no forwarding configured is 'unknown' too, and GitHub is not called", async () => {
    vi.stubEnv("GITHUB_SECRETS_TOKEN", "");
    const html = await page();
    expect(new Set(Object.values(sources(html)))).toEqual(new Set(["unknown"]));
    expect(calls).toHaveLength(0);
  });
});

describe("the names asked about", () => {
  it("are exactly the registry's, so a new vendor is covered without touching the page", async () => {
    fake = { pages: [[...ALL_ENV_NAMES]], total: ALL_ENV_NAMES.length };
    expect(new Set(Object.values(sources(await page())))).toEqual(new Set(["env"]));
  });
});

describe("listSecretNamesComplete on its own", () => {
  it("returns only the names asked about (the repository's other secret names stay unknown to the page) and says whether it read them all", async () => {
    fake = { pages: [["XAI_API_KEY", "SUPABASE_SERVICE_KEY", "OPENAI_API_KEY"]], total: 3 };
    const { listSecretNamesComplete } = await import("../lib/server/github-secrets");
    expect(await listSecretNamesComplete(["XAI_API_KEY", "OPENAI_API_KEY", "BFL_API_KEY"])).toEqual({ names: ["XAI_API_KEY", "OPENAI_API_KEY"], complete: true });
  });

  it("is null, without any request, when forwarding is not configured", async () => {
    vi.stubEnv("GITHUB_SECRETS_TOKEN", "");
    const { listSecretNamesComplete } = await import("../lib/server/github-secrets");
    expect(await listSecretNamesComplete(["XAI_API_KEY"])).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws a code, never a body, when GitHub refuses", async () => {
    fake = { pages: [[]], total: 0, status: 403 };
    const { listSecretNamesComplete } = await import("../lib/server/github-secrets");
    await expect(listSecretNamesComplete(["XAI_API_KEY"])).rejects.toThrow("github_unauthorized");
  });
});
