/**
 * The Model API keys page and NIGHTSHIFT_MODEL_KEYS.
 *
 * Off (the default; anything but exactly `on`): the operator guard and the owner check still run, the page is an "off" note, and NO database
 * and NO GitHub call is made. On: the page reads only the NAMES of the GitHub secrets, never a database, and an environment that could not
 * be read is "unknown", never "no key". An administrator who is not the owner gets 404, as a stranger does. Nothing about any key is stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  createClient: vi.fn(async () => {
    throw new Error("the page must not create a database client");
  }),
  guardCalls: 0,
  guard: "ok" as "ok" | "throw",
  mayRead: true,
  role: "owner" as string | null,
  github: { configured: true, names: ["OPENAI_API_KEY"] as string[] | "throw", complete: true, asked: [] as string[], calls: 0 },
}));

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: s.createClient, getUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({
  guardOperatorPage: async () => {
    s.guardCalls += 1;
    if (s.guard === "throw") throw new Error("NEXT_NOT_FOUND");
    return s.mayRead;
  },
}));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => s.role }));
vi.mock("@/lib/server/github-secrets", () => ({
  get isGithubConfigured() {
    return s.github.configured;
  },
  listSecretNamesComplete: async (allow: Iterable<string>) => {
    s.github.calls += 1;
    s.github.asked = [...allow];
    if (s.github.names === "throw") throw new Error("github down");
    return { names: s.github.names, complete: s.github.complete };
  },
}));

const m = en.modelKeys;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const has = (html: string, text: string) => html.includes(esc(text));

beforeEach(() => {
  s.guardCalls = 0;
  s.guard = "ok";
  s.mayRead = true;
  s.role = "owner";
  s.createClient.mockClear();
  s.github = { configured: true, names: ["OPENAI_API_KEY"], complete: true, asked: [], calls: 0 };
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const page = async () => renderToStaticMarkup((await (await import("../app/(app)/[channel]/model-keys/page")).default()) as ReactElement);

describe("with the switch off the page is a note and reads nothing", () => {
  it.each([undefined, "", "off", "true", "1", "enabled"])("switch %j: the note; no database call, no GitHub call", async (value) => {
    if (value !== undefined) vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", value);
    else delete process.env.NIGHTSHIFT_MODEL_KEYS;
    const html = await page();
    expect(s.guardCalls).toBe(1);
    expect(s.createClient).not.toHaveBeenCalled();
    expect(s.github.calls).toBe(0);
    expect(has(html, m.off.title)).toBe(true);
    expect(has(html, m.off.body)).toBe(true);
    expect(html).not.toMatch(/<input|<button|type="password"/);
  });
});

describe("who sees it", () => {
  beforeEach(() => vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", "on"));

  it("a stranger never sees even the note (the operator guard runs first)", async () => {
    s.guard = "throw";
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(s.createClient).not.toHaveBeenCalled();
  });

  it("an administrator who is not the owner gets 404 and nothing is read", async () => {
    s.role = null;
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(s.createClient).not.toHaveBeenCalled();
    expect(s.github.calls).toBe(0);
  });

  it("and with the switch off the owner check still runs first", async () => {
    vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", "off");
    s.role = null;
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("with the switch on", () => {
  beforeEach(() => vi.stubEnv("NIGHTSHIFT_MODEL_KEYS", "on"));

  it("reads NO database (no client, no rpc) and draws every vendor", async () => {
    const html = await page();
    expect(s.createClient).not.toHaveBeenCalled();
    expect((html.match(/data-provider=/g) ?? []).length).toBe(18);
    expect(has(html, m.nothingStored)).toBe(true);
    expect(has(html, m.status.not_checked)).toBe(true);
    expect(html).not.toMatch(/Vault|Stored key|\u2022\u2022/);
    expect(html).not.toContain("sk-");
  });

  it("says which key a run uses from the GitHub secret names, never from their values, and shows the variable to set", async () => {
    const html = await page();
    expect(has(html, "The GitHub secret OPENAI_API_KEY is set. Runs use that key.")).toBe(true);
    expect(has(html, "The GitHub secret BFL_API_KEY is not set.")).toBe(true);
    expect(has(html, "add it to GitHub Actions secrets and the worker environment as KLING_API_KEY or KLING_ACCESS_KEY + KLING_SECRET_KEY")).toBe(true);
    expect(s.github.calls).toBe(1);
  });

  it("asks GitHub about the names of ALL vendors, not the Providers board's shorter list", async () => {
    await page();
    for (const n of ["XAI_API_KEY", "ASSEMBLYAI_API_KEY", "RUNWAYML_API_SECRET", "LUMA_AGENTS_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY"]) expect(s.github.asked).toContain(n);
  });

  it("a listing GitHub says is longer than what was read is 'unknown' for a name not seen, and still 'env' for one that was", async () => {
    s.github.complete = false;
    const html = await page();
    expect(has(html, "The GitHub secret OPENAI_API_KEY is set. Runs use that key.")).toBe(true);
    expect(html).not.toContain("is not set");
    expect(has(html, m.source.unknown)).toBe(true);
  });

  it("an environment that cannot be read is 'unknown', not 'none'", async () => {
    s.github.names = "throw";
    let html = await page();
    expect(has(html, m.source.unknown)).toBe(true);
    expect(html).not.toContain("is not set");
    vi.resetModules();
    s.github.configured = false;
    html = await page();
    expect(has(html, m.source.unknown)).toBe(true);
    expect(html).not.toContain("is not set");
  });

  it("an operator who may not read GitHub gets 'unknown' and GitHub is not asked", async () => {
    s.mayRead = false;
    const html = await page();
    expect(s.github.calls).toBe(0);
    expect(has(html, m.source.unknown)).toBe(true);
    expect(html).not.toContain("is not set");
  });

  it("is the same page with no database configured at all: it never needed one", async () => {
    expect((await page()).match(/data-provider=/g)?.length).toBe(18);
  });
});
