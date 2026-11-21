import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { NOTIFICATION_KINDS } from "../lib/notifications";
import {
  CHANNEL_ERRORS,
  CHANNEL_EVENTS,
  isLinkToken,
  parseBotUsername,
  parseChannels,
  parsePreferences,
  telegramLinkUrl,
} from "../lib/notify-channels";

/**
 * Telegram notification channels (migration 0102), the web half: the pure
 * parsers, the deep link, the three routes with the database faked at the edge,
 * and the copy. No Telegram call and no database is touched.
 */

vi.mock("server-only", () => ({}));

const TOKEN = "0123456789abcdef".repeat(3) + "01234567";
const ID = "0f0e0d0c-0b0a-4000-8000-000000000001";
const BOT = "reply_NightshiftAiStudio_bot";
const ORIGIN = "https://app.example.test";

const h = {
  user: { id: "u-me" } as { id: string } | null,
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(async () => ({ data: null, error: null })),
  rate: "ok" as "ok" | "limited" | "unavailable",
  audit: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({
    rpc: (name: string, args?: Record<string, unknown>) => h.rpc(name, args),
    from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }),
  }),
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/server/web-rate", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/web-rate")>("../lib/server/web-rate");
  return { ...actual, takeWebRate: async () => h.rate };
});

const link = await import("../app/api/notifications/telegram/route");
const channel = await import("../app/api/notifications/telegram/channel/route");
const pref = await import("../app/api/notifications/telegram/preference/route");

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.user = { id: "u-me" };
  h.rate = "ok";
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  h.audit.mockReset();
  process.env.TELEGRAM_CUSTOMER_BOT_USERNAME = BOT;
});

describe("the deep link", () => {
  it("is t.me/<bot>?start=<token> for the owner's customer bot", () => {
    expect(telegramLinkUrl(BOT, TOKEN)).toBe(`https://t.me/${BOT}?start=${TOKEN}`);
    expect(telegramLinkUrl(`@${BOT}`, TOKEN)).toBe(`https://t.me/${BOT}?start=${TOKEN}`);
    expect(TOKEN.length).toBeLessThanOrEqual(64); // Telegram's start parameter limit
  });
  it("is null (never a half link) for a bad bot name or token", () => {
    for (const bad of [null, "", "notabot2", "a b_bot", "x_bot/../y", "https://t.me/x_bot", 5]) expect(telegramLinkUrl(bad, TOKEN)).toBeNull();
    for (const bad of [null, "", "abc", TOKEN.toUpperCase(), TOKEN + "0", `${TOKEN}&x=1`, 5]) expect(telegramLinkUrl(BOT, bad)).toBeNull();
    expect(isLinkToken(TOKEN)).toBe(true);
  });
  it("accepts a bot username only in Telegram's shape", () => {
    expect(parseBotUsername(" reply_NightshiftAiStudio_bot ")).toBe(BOT);
    expect(parseBotUsername("NightshiftBot")).toBe("NightshiftBot");
    for (const bad of [undefined, "", "bot", "abc", "1abc_bot", "has space_bot"]) expect(parseBotUsername(bad)).toBeNull();
  });
});

describe("what the page reads", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID, kind: "telegram", label: "Ana", locale: "ru", status: "active", verified_at: "2026-10-01T00:00:00Z",
    last_ok_at: null, last_error_code: null, ...over,
  });
  it("shows a delivery time only when one was recorded", () => {
    expect(parseChannels([row()])[0].last_ok_at).toBeNull();
    expect(parseChannels([row({ last_ok_at: "2026-10-02T10:00:00Z" })])[0].last_ok_at).toBe("2026-10-02T10:00:00Z");
  });
  it("drops malformed rows, other kinds and unknown statuses", () => {
    expect(parseChannels([row({ id: "x" }), row({ kind: "email" }), row({ status: "weird" }), null, 5, row()])).toHaveLength(1);
    expect(parseChannels("nope")).toEqual([]);
  });
  it("keeps a registered language and falls back to English for any other", () => {
    expect(parseChannels([row({ locale: "uz" })])[0].locale).toBe("uz");
    expect(parseChannels([row({ locale: "ar" })])[0].locale).toBe("en");
    expect(parseChannels([row({ locale: "<script>" })])[0].locale).toBe("en");
  });
  it("never carries a chat id, even if one is in the row", () => {
    expect(Object.keys(parseChannels([row({ external_id: "424242" })])[0])).not.toContain("external_id");
  });
  it("lists the app's notification kinds in order and treats an unreported one as OFF, not on", () => {
    const got = parsePreferences([{ event: "credits_low", channel: "telegram", enabled: true }]);
    expect(got.map((p) => p.event)).toEqual([...NOTIFICATION_KINDS]);
    expect(got.filter((p) => p.enabled).map((p) => p.event)).toEqual(["credits_low"]);
    expect(CHANNEL_EVENTS).toEqual(NOTIFICATION_KINDS);
  });
});

describe("POST /api/notifications/telegram (start linking)", () => {
  it("is off until the customer bot's username is set", async () => {
    delete process.env.TELEGRAM_CUSTOMER_BOT_USERNAME;
    const r = await link.POST(post("/api/notifications/telegram", { locale: "en" }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "not_configured" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("returns the deep link, never cached, and never writes the token anywhere else", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: true, token: TOKEN, expires_at: "2026-10-14T12:10:00Z" }, error: null });
    const r = await link.POST(post("/api/notifications/telegram", { locale: "ru" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, url: `https://t.me/${BOT}?start=${TOKEN}`, expires_at: "2026-10-14T12:10:00Z" });
    expect(h.rpc).toHaveBeenCalledWith("notification_link_start", { p_kind: "telegram", p_locale: "ru" });
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("refuses a signed-out caller, a cross-site post and a bad language before touching the database", async () => {
    h.user = null;
    expect((await link.POST(post("/api/notifications/telegram", { locale: "en" }))).status).toBe(401);
    h.user = { id: "u" };
    expect((await link.POST(post("/api/notifications/telegram", { locale: "en" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await link.POST(post("/api/notifications/telegram", { locale: "en" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    for (const body of [{}, { locale: "xx" }, { locale: "RU" }, { locale: 5 }, "not json", "[]"]) {
      expect((await link.POST(post("/api/notifications/telegram", body))).status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("maps the database's refusals to fixed codes", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: false, code: "rate_limited" }, error: null });
    const a = await link.POST(post("/api/notifications/telegram", { locale: "en" }));
    expect([a.status, (await a.json()).error]).toEqual([429, "rate_limited"]);
    h.rpc.mockResolvedValueOnce({ data: { ok: false, code: "limit" }, error: null });
    const b = await link.POST(post("/api/notifications/telegram", { locale: "en" }));
    expect([b.status, (await b.json()).error]).toEqual([409, "limit"]);
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const c = await link.POST(post("/api/notifications/telegram", { locale: "en" }));
    expect([c.status, (await c.json()).error]).toEqual([503, "not_configured"]);
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "secret db detail" } });
    const d = await link.POST(post("/api/notifications/telegram", { locale: "en" }));
    expect(JSON.stringify(await d.json())).not.toContain("secret");
  });
  it("does not hand out a link when the database's token is malformed", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: true, token: "short" }, error: null });
    expect((await link.POST(post("/api/notifications/telegram", { locale: "en" }))).status).toBe(502);
  });
});

describe("POST /api/notifications/telegram/channel", () => {
  const go = (body: unknown) => channel.POST(post("/api/notifications/telegram/channel", body));
  it("runs each action on the person's own channel through its own database function", async () => {
    const cases: [Record<string, unknown>, string, Record<string, unknown>, unknown][] = [
      [{ action: "disconnect" }, "notification_channel_disconnect", { p_id: ID }, true],
      [{ action: "pause" }, "notification_channel_set_paused", { p_id: ID, p_paused: true }, true],
      [{ action: "resume" }, "notification_channel_set_paused", { p_id: ID, p_paused: false }, true],
      [{ action: "locale", locale: "uz" }, "notification_channel_set_locale", { p_id: ID, p_locale: "uz" }, true],
      [{ action: "test" }, "notification_test_send", { p_channel_id: ID }, "ok"],
    ];
    for (const [extra, fn, args, data] of cases) {
      h.rpc.mockResolvedValueOnce({ data, error: null });
      const r = await go({ id: ID, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(200);
      expect(h.rpc).toHaveBeenLastCalledWith(fn, args);
    }
  });
  it("reads a foreign, unknown or already gone id as plain not found", async () => {
    h.rpc.mockResolvedValueOnce({ data: false, error: null });
    const r = await go({ id: ID, action: "disconnect" });
    expect([r.status, (await r.json()).error]).toEqual([404, "not_found"]);
    h.rpc.mockResolvedValueOnce({ data: "not_found", error: null });
    expect((await go({ id: ID, action: "test" })).status).toBe(404);
  });
  it("says so when a test is limited or the chat is not active", async () => {
    h.rpc.mockResolvedValueOnce({ data: "rate_limited", error: null });
    expect((await go({ id: ID, action: "test" })).status).toBe(429);
    h.rpc.mockResolvedValueOnce({ data: "not_active", error: null });
    expect((await go({ id: ID, action: "test" })).status).toBe(409);
  });
  it("refuses anything but a uuid, a known action and a bare language, before the database", async () => {
    for (const body of [{ id: "x", action: "pause" }, { id: ID, action: "drop" }, { id: ID, action: "locale" }, { id: ID, action: "locale", locale: "de" },
      { id: ID }, { action: "pause" }, { id: `${ID}' or 1=1`, action: "pause" }]) {
      expect((await go(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("is rate limited per person and signed-in only", async () => {
    h.rate = "limited";
    expect((await go({ id: ID, action: "pause" })).status).toBe(429);
    h.rate = "ok";
    h.user = null;
    expect((await go({ id: ID, action: "pause" })).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/telegram/preference", () => {
  const go = (body: unknown) => pref.POST(post("/api/notifications/telegram/preference", body));
  it("sets one of the five events for Telegram", async () => {
    h.rpc.mockResolvedValueOnce({ data: true, error: null });
    expect((await go({ event: "credits_low", enabled: false })).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("notification_pref_set", { p_event: "credits_low", p_channel: "telegram", p_enabled: false });
  });
  it("refuses an unknown event or a non-boolean before the database", async () => {
    for (const body of [{ event: "weekly_summary", enabled: true }, { event: "credits_low", enabled: "yes" }, { event: "credits_low" }, {}]) {
      expect((await go(body)).status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("tells the page when the database refused", async () => {
    h.rpc.mockResolvedValueOnce({ data: false, error: null });
    expect((await go({ event: "credits_low", enabled: true })).status).toBe(429);
  });
});

describe("the words", () => {
  const BANNED = /openai|google|runway|kling|veo|sora|elevenlabs|replicate|fal\.ai|minimax|\b(owner|editor|viewer|admin)\b|владелец|редактор|наблюдатель|администратор|egasi|muharrir|kuzatuvchi/i;
  const flat = (o: unknown, path = ""): [string, string][] =>
    o && typeof o === "object"
      ? Object.entries(o).flatMap(([k, v]) => flat(v, path ? `${path}.${k}` : k))
      : [[path, String(o)]];

  it("is complete in en, ru and uz with the same keys and every placeholder kept", () => {
    const keys = (d: unknown) => flat(d).map(([k]) => k).sort();
    expect(keys(ru.notifyChannels)).toEqual(keys(en.notifyChannels));
    expect(keys(uz.notifyChannels)).toEqual(keys(en.notifyChannels));
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    const e = Object.fromEntries(flat(en.notifyChannels));
    for (const d of [ru.notifyChannels, uz.notifyChannels]) {
      for (const [k, v] of flat(d)) {
        expect(v.trim(), k).not.toBe("");
        expect(vars(v), k).toBe(vars(e[k]));
      }
    }
  });
  it("has a sentence for every event and every error code", () => {
    for (const d of [en, ru, uz]) {
      for (const k of NOTIFICATION_KINDS) expect(d.notifyChannels.events[k].length).toBeGreaterThan(3);
      for (const c of CHANNEL_ERRORS) expect(d.notifyChannels.errors[c].length).toBeGreaterThan(3);
    }
  });
  it("names no provider and no role", () => {
    for (const d of [en, ru, uz]) for (const [k, v] of flat(d.notifyChannels)) expect(v, k).not.toMatch(BANNED);
  });
  it("only uses the word Telegram as the name of the channel", () => {
    for (const [k, v] of flat(en.notifyChannels)) {
      const brands = v.match(/\b(WhatsApp|Viber|Slack|Discord|Signal|Gmail|Resend)\b/g);
      expect(brands, k).toBeNull();
    }
  });
});
