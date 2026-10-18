/**
 * The Marketing page and NIGHTSHIFT_MARKETING_POSTS.
 *
 * Off (the default; anything but exactly `on`): the operator guard still runs, the page is an "off" note, and NO database read is
 * made: nothing new is drawn and nothing else changes. On: the settings and the newest posts are read as the signed-in
 * owner, the week's count and the poster's state are drawn, and a read that failed or a migration that is not applied is
 * said, never drawn as an empty list or a "0 of 2".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc } from "./helpers/supabaseStub";
import { recordingSupabase, type Res } from "./helpers/recordingStub";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({ client: null as unknown, guardCalls: 0, guard: "ok" as "ok" | "throw" }));

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/marketing" }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => s.client, getUser: async () => ({ id: "u1", email: "me@a.uz" }) }));
vi.mock("@/lib/auth/org-roles", () => ({
  guardOperatorPage: async () => {
    s.guardCalls += 1;
    if (s.guard === "throw") throw new Error("NEXT_NOT_FOUND");
    return true;
  },
}));

const ID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);
const post = (over: Record<string, unknown> = {}) => ({
  id: ID,
  kind: "news",
  status: "draft",
  texts: { uz: "Yangi funksiya.", ru: "Новая функция.", en: "A new feature." },
  media_path: null,
  link: "/pricing",
  source_ref: "pr:#12",
  content_hash: HASH,
  created_at: "2026-10-17T10:00:00Z",
  updated_at: "2026-10-17T10:00:00Z",
  approved_at: null,
  expires_at: null,
  edited_at: null,
  rejected_at: null,
  reject_reason: null,
  claimed_at: null,
  sent_at: null,
  attempts: 0,
  max_attempts: 3,
  next_attempt_at: "2026-10-17T10:00:00Z",
  last_error_code: null,
  facts_as_of: null,
  ...over,
});
const SETTINGS = { ok: true, enabled: true, max_per_7d: 2, facts_max_age_hours: 24, approval_ttl_hours: 72, used_7d: 1, approved_waiting: 0, updated_at: "2026-10-17T10:00:00Z" };

let results: Record<string, Res> = {};
const stub = () => recordingSupabase((name) => results[name] ?? { data: [], error: null });
const asked = (st: ReturnType<typeof stub>) => new Set(st.log.map((q) => q.table));
const has = (html: string, text: string) => html.includes(esc(text));
const m = en.marketing;

beforeEach(() => {
  s.guardCalls = 0;
  s.guard = "ok";
  results = { owner_marketing_get: { data: SETTINGS, error: null }, marketing_posts: { data: [post()], error: null } };
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const page = async () => renderToStaticMarkup((await (await import("../app/(app)/[channel]/marketing/page")).default()) as ReactElement);

describe("with the switch off the page is a note and reads nothing", () => {
  it.each([undefined, "", "off", "true", "1", "ON"])("switch %j: the note, the guard ran, no database call at all", async (value) => {
    if (value !== undefined) vi.stubEnv("NIGHTSHIFT_MARKETING_POSTS", value);
    else delete process.env.NIGHTSHIFT_MARKETING_POSTS;
    const st = stub();
    s.client = st.client;
    const html = await page();
    expect(s.guardCalls).toBe(1);
    expect(st.log).toHaveLength(0);
    expect(has(html, m.off.title)).toBe(true);
    expect(has(html, m.off.body)).toBe(true);
    // nothing of the board
    expect(has(html, m.poster.title)).toBe(false);
    expect(has(html, "A new feature.")).toBe(false);
    expect(html).not.toMatch(/<button/);
  });

  it("the operator guard runs first: a stranger never sees even the note", async () => {
    s.guard = "throw";
    s.client = stub().client;
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("with the switch on", () => {
  beforeEach(() => {
    vi.stubEnv("NIGHTSHIFT_MARKETING_POSTS", "on");
    vi.stubEnv("MARKETING_TELEGRAM_CHAT", "@nightshift_test");
    vi.stubEnv("APP_ORIGIN", "https://nightshift-ai.studio");
  });

  it("reads the settings and the posts as the signed-in user, and draws them", async () => {
    const st = stub();
    s.client = st.client;
    const html = await page();
    expect(asked(st)).toEqual(new Set(["owner_marketing_get", "marketing_posts"]));
    expect(has(html, m.poster.title)).toBe(true);
    expect(has(html, "Posts this week: 1 of 2")).toBe(true);
    expect(has(html, "@nightshift_test")).toBe(true);
    expect(has(html, "A new feature.")).toBe(true);
    expect(has(html, "https://nightshift-ai.studio/pricing")).toBe(true);
    expect(has(html, m.status.draft)).toBe(true);
    expect(has(html, "pr:#12")).toBe(true);
  });

  it("asks for the newest posts only, and never for the facts", async () => {
    const st = stub();
    s.client = st.client;
    await page();
    const q = st.of("marketing_posts")[0];
    const selected = String(q.calls.find(([c]) => c === "select")?.[1][0]);
    expect(selected).not.toMatch(/\bfacts\b/);
    expect(q.calls.some(([c, a]) => c === "limit" && a[0] === 40)).toBe(true);
    expect(q.calls.some(([c, a]) => c === "order" && a[0] === "created_at")).toBe(true);
  });

  it("the poster off: the page says so and does not offer a working Approve", async () => {
    results.owner_marketing_get = { data: { ...SETTINGS, enabled: false }, error: null };
    s.client = stub().client;
    const html = await page();
    expect(has(html, m.poster.offNote)).toBe(true);
    expect(has(html, m.approve.needPosterOn)).toBe(true);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve…/);
    expect(has(html, m.poster.start)).toBe(true);
  });

  it("a week's count the database did not send is unknown, not 0 of 2", async () => {
    results.owner_marketing_get = { data: { ok: true, enabled: true, max_per_7d: 2 }, error: null };
    s.client = stub().client;
    const html = await page();
    expect(has(html, "Posts this week: unknown of 2")).toBe(true);
    expect(has(html, "Posts this week: 0")).toBe(false);
  });

  it("no posts: the empty state, with the poster panel still there", async () => {
    results.marketing_posts = { data: [], error: null };
    s.client = stub().client;
    const html = await page();
    expect(has(html, m.empty.title)).toBe(true);
    expect(has(html, m.poster.title)).toBe(true);
    expect(has(html, m.lastSend.none)).toBe(true);
  });

  it("migration 0108 not applied: says so, and draws no board", async () => {
    results.owner_marketing_get = { data: null, error: { code: "42883", message: "does not exist" } };
    s.client = stub().client;
    const html = await page();
    expect(has(html, m.unsupported)).toBe(true);
    expect(has(html, m.poster.title)).toBe(false);
  });

  it.each([
    ["the settings read failed", { owner_marketing_get: { data: null, error: { code: "XX000", message: "boom" } } }],
    ["the posts read failed", { marketing_posts: { data: null, error: { code: "XX000", message: "boom" } } }],
    ["a row that cannot be read", { marketing_posts: { data: [post({ status: "teleported" })], error: null } }],
    ["a settings answer that is a refusal", { owner_marketing_get: { data: { ok: false, error: "mfa_required" }, error: null } }],
  ])("%s: the failure is said with Retry, never an empty list or a zero", async (_name, over) => {
    results = { ...results, ...over };
    s.client = stub().client;
    const html = await page();
    expect(has(html, m.failed)).toBe(true);
    expect(html).toContain("data-read-error");
    expect(has(html, m.empty.title)).toBe(false);
    expect(has(html, m.poster.title)).toBe(false);
  });

  it("no database client at all is a failure, said", async () => {
    s.client = null;
    const html = await page();
    expect(has(html, m.failed)).toBe(true);
  });

  it("a channel the server does not know is said to be unknown, not guessed", async () => {
    vi.stubEnv("MARKETING_TELEGRAM_CHAT", "https://t.me/whatever");
    s.client = stub().client;
    const html = await page();
    expect(has(html, m.poster.channelUnknown)).toBe(true);
    expect(html).not.toContain("t.me/whatever");
  });

  it("a post list that fills the read says it may be incomplete", async () => {
    results.marketing_posts = {
      data: Array.from({ length: 40 }, (_v, i) => post({ id: `11111111-2222-3333-4444-${String(i).padStart(12, "0")}`, source_ref: `pr:#${i + 1}` })),
      error: null,
    };
    s.client = stub().client;
    const html = await page();
    expect(has(html, "Showing the newest 40 posts. Older ones are not listed here.")).toBe(true);
  });
});

describe("the page is registered as an owner section", () => {
  it("is a known section, in the operator's navigation, and operator-only", async () => {
    const { isSection } = await import("../lib/channels");
    const { NAV_ITEMS, isOperatorOnlySection } = await import("../lib/navigation");
    expect(isSection("marketing")).toBe(true);
    expect(NAV_ITEMS.some((i) => i.href === "/marketing" && i.key === "marketing")).toBe(true);
    expect(isOperatorOnlySection("marketing")).toBe(true);
  });
});
