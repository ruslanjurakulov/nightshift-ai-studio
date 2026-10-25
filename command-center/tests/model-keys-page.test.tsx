/**
 * The Model API keys page and NIGHTSHIFT_MODEL_KEYS.
 *
 * Off (the default; anything but exactly `on`): the operator guard and the owner check still run, the page is an "off" note, and NO database
 * and NO GitHub call is made. On: what is stored is read as the signed-in owner and drawn, a read that failed or a migration that is not
 * applied is said (never drawn as "nothing stored"), and an environment that could not be read is "unknown", never "no key". An
 * administrator who is not the owner gets 404, as a stranger does, and the key itself has no read path: the page asks for status only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  rpc: vi.fn(),
  client: true,
  guardCalls: 0,
  guard: "ok" as "ok" | "throw",
  role: "owner" as string | null,
  github: { configured: true, names: ["OPENAI_API_KEY"] as string[] | "throw", calls: 0 },
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
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (s.client ? { rpc: s.rpc } : null), getUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({
  guardOperatorPage: async () => {
    s.guardCalls += 1;
    if (s.guard === "throw") throw new Error("NEXT_NOT_FOUND");
    return true;
  },
}));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => s.role }));
vi.mock("@/lib/server/github-secrets", () => ({
  get isGithubConfigured() {
    return s.github.configured;
  },
  listConfiguredSecretNames: async () => {
    s.github.calls += 1;
    if (s.github.names === "throw") throw new Error("github down");
    return s.github.names;
  },
}));

const m = en.modelKeys;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const has = (html: string, text: string) => html.includes(esc(text));
const STATUS = {
  ok: true,
  keys: [{ provider: "openai", status: "verified", last4: "wxyz", verified_at: "2026-10-25T09:30:00+00:00", checked_by_email: "o@a.uz" }],
};

beforeEach(() => {
  s.guardCalls = 0;
  s.guard = "ok";
  s.role = "owner";
  s.client = true;
  s.rpc.mockReset().mockResolvedValue({ data: STATUS, error: null });
  s.github = { configured: true, names: ["OPENAI_API_KEY"], calls: 0 };
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
    expect(s.rpc).not.toHaveBeenCalled();
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
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it("an administrator who is not the owner gets 404 and nothing is read", async () => {
    s.role = null;
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(s.rpc).not.toHaveBeenCalled();
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

  it("reads the status as the signed-in owner (one status call, no key read) and draws every vendor", async () => {
    const html = await page();
    expect(s.rpc.mock.calls).toEqual([["owner_model_key_status"]]);
    expect((html.match(/data-provider=/g) ?? []).length).toBe(13);
    expect(has(html, m.status.verified)).toBe(true);
    expect(html).toContain("wxyz");
    expect(has(html, m.vaultNote)).toBe(true);
    expect(html).not.toContain("sk-");
  });

  it("says which key a run uses from the GitHub secret names, never from their values", async () => {
    const html = await page();
    expect(has(html, "Environment: the GitHub secret OPENAI_API_KEY is set. Runs use that key.")).toBe(true);
    expect(has(html, m.source.envAlsoVault)).toBe(true);
    expect(has(html, m.source.none)).toBe(true);
  });

  it("an environment that cannot be read is 'unknown', not 'none'", async () => {
    s.github.names = "throw";
    let html = await page();
    expect(has(html, m.source.unknown)).toBe(true);
    expect(has(html, m.source.none)).toBe(false);
    vi.resetModules();
    s.github.configured = false;
    html = await page();
    expect(has(html, m.source.unknown)).toBe(true);
    expect(has(html, m.source.none)).toBe(false);
  });

  it("a migration that is not applied is said, and no card is drawn", async () => {
    s.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "x" } });
    const html = await page();
    expect(has(html, m.unsupported)).toBe(true);
    expect(html).not.toContain("data-provider=");
  });

  it.each([
    ["an error", { data: null, error: { code: "XX000", message: "boom" } }],
    ["a reply that is not the documented shape", { data: { ok: true, keys: [{ provider: "nonesuch", status: "verified", last4: "abcd" }] }, error: null }],
    ["a bad status", { data: { ok: true, keys: [{ provider: "openai", status: "trusted", last4: "abcd" }] }, error: null }],
    ["a refusal", { data: { ok: false, error: "owner_required" }, error: null }],
    ["forbidden", { data: null, error: { code: "42501", message: "x" } }],
  ])("%s: says it could not read, and never draws 'nothing stored'", async (_label, res) => {
    s.rpc.mockResolvedValue(res);
    const html = await page();
    expect(has(html, m.failed)).toBe(true);
    expect(html).not.toContain("data-provider=");
    expect(s.github.calls).toBe(0);
  });

  it("no database configured is the same unreadable state", async () => {
    s.client = false;
    expect(has(await page(), m.failed)).toBe(true);
  });
});
