import { describe, expect, it } from "vitest";
import {
  BOT_COPY,
  MAX_BODY,
  StoreError,
  bareLanguage,
  botWords,
  createRestStore,
  handleTelegramWebhook,
  parseUpdate,
  readBoundedText,
  secretIsUsable,
  secretMatches,
  type NotifyStore,
} from "../../supabase/functions/_shared/telegram-notify";

// The customer bot's webhook (supabase/functions/_shared/telegram-notify.ts)
// is runtime-neutral, so it is tested here with fakes. No Telegram call is made.

const SECRET = "test_webhook_secret_0123456789_abcdef";
const TOKEN = "0123456789abcdef".repeat(3) + "01234567"; // 56 hex
const CHAT = 424242;

type Call = [string, ...unknown[]];

function fakeStore(over: Partial<{ peek: { code: string; locale?: string | null; handle?: string | null };
  consume: { code: string; locale?: string | null }; mark: string | null; fresh: boolean }> = {}) {
  const calls: Call[] = [];
  const seen = new Set<number>();
  const store: NotifyStore = {
    async claimUpdate(id) {
      calls.push(["claim", id]);
      if (over.fresh === false || seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    async peek(t) {
      calls.push(["peek", t]);
      return over.peek ?? { code: "ok", locale: "en", handle: null };
    },
    async consume(t, chat, label, type, from) {
      calls.push(["consume", t, chat, label, type, from]);
      return over.consume ?? { code: "ok", locale: "en" };
    },
    async mark(chat, action) {
      calls.push(["mark", chat, action]);
      return over.mark === undefined ? "en" : over.mark;
    },
  };
  return { store, calls };
}

const from = (over: Record<string, unknown> = {}) => ({ id: CHAT, is_bot: false, first_name: "Ana", language_code: "ru", ...over });
const message = (text: string, over: Record<string, unknown> = {}, id = 1) =>
  ({ update_id: id, message: { message_id: 5, from: from(), chat: { id: CHAT, type: "private" }, text, ...over } });
const callback = (data: string, over: Record<string, unknown> = {}, id = 2) =>
  ({ update_id: id, callback_query: { id: "cb", from: from(), data, message: { message_id: 9, chat: { id: CHAT, type: "private" } }, ...over } });

async function hit(update: unknown, store: NotifyStore, over: Partial<{ method: string; contentType: string | null; secretHeader: string | null; rawBody: string; secret: string }> = {}) {
  return handleTelegramWebhook(
    {
      method: over.method ?? "POST",
      contentType: over.contentType === undefined ? "application/json" : over.contentType,
      rawBody: "rawBody" in over ? (over.rawBody as string) : JSON.stringify(update),
      secretHeader: over.secretHeader === undefined ? SECRET : over.secretHeader,
    },
    { secret: over.secret ?? SECRET, store },
  );
}

describe("the secret header", () => {
  it("matches only the exact secret", async () => {
    expect(await secretMatches(SECRET, SECRET)).toBe(true);
    for (const bad of [null, undefined, "", SECRET + "x", SECRET.slice(0, -1), SECRET.toUpperCase(), " " + SECRET, "x".repeat(5000)]) {
      expect(await secretMatches(bad, SECRET)).toBe(false);
    }
    expect(await secretMatches(SECRET, "")).toBe(false);
  });
  it("must be long and in Telegram's alphabet before the endpoint is on at all", () => {
    expect(secretIsUsable(SECRET)).toBe(true);
    for (const bad of [undefined, "", "short", "has space in it 0123456789 0123", "x".repeat(257)]) expect(secretIsUsable(bad)).toBe(false);
  });
  it("refuses a missing, wrong or different-length header with 401 and touches nothing", async () => {
    for (const secretHeader of [null, "", "wrong", SECRET + "0", SECRET.slice(1)]) {
      const { store, calls } = fakeStore();
      const r = await hit(message(`/start ${TOKEN}`), store, { secretHeader });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "unauthorized" });
      expect(calls).toEqual([]);
    }
  });
  it("is off (503) when no usable secret is configured, even for a request that sends one", async () => {
    const { store, calls } = fakeStore();
    for (const secret of ["", "short"]) {
      const r = await hit(message("/help"), store, { secret, secretHeader: secret });
      expect(r.status).toBe(503);
    }
    expect(calls).toEqual([]);
  });
  it("accepts POST only, JSON only, and a bounded body", async () => {
    const { store, calls } = fakeStore();
    expect((await hit({}, store, { method: "GET" })).status).toBe(405);
    expect((await hit({}, store, { contentType: "text/plain" })).status).toBe(415);
    expect((await hit({}, store, { contentType: null })).status).toBe(415);
    expect((await hit({}, store, { rawBody: "x".repeat(MAX_BODY + 1) })).status).toBe(413);
    expect((await hit({}, store, { rawBody: null as unknown as string })).status).toBe(413);
    expect(calls).toEqual([]);
  });
  it("answers 200 and does nothing for a body that is not JSON", async () => {
    const { store, calls } = fakeStore();
    expect((await hit(null, store, { rawBody: "{not json" })).status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("which updates are acted on", () => {
  const ok = (u: unknown) => expect(parseUpdate(u)).not.toBeNull();
  const no = (u: unknown) => expect(parseUpdate(u)).toBeNull();
  it("accepts a private /start with a token, a bare /start, /stop, /resume, /help", () => {
    ok(message(`/start ${TOKEN}`));
    ok(message("/start"));
    ok(message("/stop"));
    ok(message("/resume"));
    ok(message("/help"));
    ok(message(`/start@reply_NightshiftAiStudio_bot ${TOKEN}`));
  });
  it("ignores everything else: other text, groups, bots, a sender who is not the chat, odd ids", () => {
    no(message("hello there"));
    no(message(`/start ${TOKEN} extra`));
    no(message("/start", { chat: { id: -100123, type: "group" } }));
    no(message("/start", { chat: { id: CHAT, type: "supergroup" } }));
    no(message("/start", { from: from({ is_bot: true }) }));
    no(message("/start", { from: from({ id: 99 }) }));
    no(message("/start", { chat: { id: "424242", type: "private" } }));
    no(message("/start", { chat: { id: 1.5, type: "private" } }));
    no(message("/start", { from: null }));
    no(message("x".repeat(600)));
    no({ update_id: 1, edited_message: {} });
    no({ update_id: 1, channel_post: {} });
    no({ update_id: -1, message: {} });
    no({ update_id: "1", message: {} });
    no({ message: {} });
    no([]);
    no(null);
    no("string");
  });
  it("treats a /start argument that is not a token as a bare /start", () => {
    for (const arg of ["abc", "G".repeat(56), TOKEN.toUpperCase(), TOKEN + "0", "../x"]) {
      expect(parseUpdate(message(`/start ${arg}`))).toMatchObject({ kind: "start", token: "" });
    }
  });
  it("accepts only y:/n: callbacks with a token, from the private chat's own person", () => {
    expect(parseUpdate(callback(`y:${TOKEN}`))).toMatchObject({ kind: "confirm", yes: true, token: TOKEN, messageId: 9 });
    expect(parseUpdate(callback(`n:${TOKEN}`))).toMatchObject({ kind: "confirm", yes: false });
    no(callback(`z:${TOKEN}`));
    no(callback("y:short"));
    no(callback(`y:${TOKEN}`, { from: from({ id: 7 }) }));
    no(callback(`y:${TOKEN}`, { message: { message_id: 9, chat: { id: CHAT, type: "group" } } }));
    no(callback(`y:${TOKEN}`, { message: undefined }));
  });
  it("accepts my_chat_member of a private chat: kicked/left = blocked, member = unblocked", () => {
    const m = (status: string, chat: Record<string, unknown> = { id: CHAT, type: "private" }) =>
      ({ update_id: 3, my_chat_member: { chat, from: from(), new_chat_member: { status } } });
    expect(parseUpdate(m("kicked"))).toMatchObject({ kind: "member", status: "blocked", chat: String(CHAT) });
    expect(parseUpdate(m("left"))).toMatchObject({ status: "blocked" });
    expect(parseUpdate(m("member"))).toMatchObject({ status: "unblocked" });
    no(m("administrator"));
    no(m("kicked", { id: -100, type: "channel" }));
  });
  it("reads the sender's language as a bare lower-case code", () => {
    expect(bareLanguage("pt-BR")).toBe("pt");
    expect(bareLanguage("ru")).toBe("ru");
    expect(bareLanguage("zh_hans")).toBe("zh");
    for (const bad of [null, 5, "", "x", "<script>"]) expect(bareLanguage(bad)).toBeNull();
  });
});

describe("linking", () => {
  it("/start with a good token peeks (never consumes) and asks for a Yes", async () => {
    const { store, calls } = fakeStore({ peek: { code: "ok", locale: "uz", handle: "ana.k" } });
    const r = await hit(message(`/start ${TOKEN}`), store);
    expect(r.status).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(["claim", "peek"]);
    expect(r.body).toMatchObject({ method: "sendMessage", chat_id: CHAT });
    expect(r.body.text).toContain("@ana.k");
    expect(r.body.text).toBe(BOT_COPY.uz.confirmAs.replace("{handle}", "@ana.k"));
    expect(JSON.stringify(r.body.reply_markup)).toContain(`y:${TOKEN}`);
    expect(JSON.stringify(r.body.reply_markup)).toContain(`n:${TOKEN}`);
  });
  it("shows no account detail when the person has no @username, and never an email", async () => {
    const { store } = fakeStore({ peek: { code: "ok", locale: "en", handle: null } });
    const r = await hit(message(`/start ${TOKEN}`), store);
    expect(r.body.text).toBe(BOT_COPY.en.confirm);
    expect(JSON.stringify(r.body)).not.toMatch(/@\w+\.\w+/);
  });
  it("tells the person when the link is expired, used or invalid, and links nothing", async () => {
    for (const code of ["expired", "used", "invalid", "whatever"]) {
      const { store, calls } = fakeStore({ peek: { code, locale: "en" } });
      const r = await hit(message(`/start ${TOKEN}`), store);
      expect(r.body.text).toBe(BOT_COPY.en[code === "whatever" ? "invalid" : code]);
      expect(calls.some((c) => c[0] === "consume")).toBe(false);
    }
  });
  it("Yes consumes with the chat and sender ids of the callback, as a private chat, and edits the message", async () => {
    const { store, calls } = fakeStore({ consume: { code: "ok", locale: "ru" } });
    const r = await hit(callback(`y:${TOKEN}`), store);
    expect(calls.find((c) => c[0] === "consume")).toEqual(["consume", TOKEN, String(CHAT), "Ana", "private", String(CHAT)]);
    expect(r.body).toEqual({ method: "editMessageText", chat_id: CHAT, message_id: 9, text: BOT_COPY.ru.connected });
  });
  it("No consumes nothing", async () => {
    const { store, calls } = fakeStore();
    const r = await hit(callback(`n:${TOKEN}`), store);
    expect(calls.some((c) => c[0] === "consume")).toBe(false);
    expect(r.body.text).toBe(BOT_COPY.ru.cancelled);
  });
  it("says why a Yes did not connect", async () => {
    for (const [code, key] of [["expired", "expired"], ["used", "used"], ["already_linked", "alreadyLinked"], ["limit", "limit"],
      ["not_private", "notPrivate"], ["invalid", "invalid"], ["???", "invalid"]]) {
      const { store } = fakeStore({ consume: { code, locale: "en" } });
      const r = await hit(callback(`y:${TOKEN}`), store);
      expect(r.body.text).toBe(BOT_COPY.en[key]);
    }
  });
  it("a repeated update id does nothing the second time", async () => {
    const { store, calls } = fakeStore();
    const u = callback(`y:${TOKEN}`);
    await hit(u, store);
    const again = await hit(u, store);
    expect(again).toEqual({ status: 200, body: {} });
    expect(calls.filter((c) => c[0] === "consume")).toHaveLength(1);
  });
  it("answers a store failure with a gentle retry sentence, never an error detail", async () => {
    const { store } = fakeStore();
    store.peek = async () => { throw new StoreError("notification_link_peek", 500); };
    const r = await hit(message(`/start ${TOKEN}`), store);
    expect(r.status).toBe(200);
    expect(r.body.text).toBe(BOT_COPY.ru.failed);
    expect(JSON.stringify(r.body)).not.toMatch(/500|notification_link/);
  });
  it("bare /start and /help point to Settings; they link nothing", async () => {
    const { store, calls } = fakeStore();
    const r = await hit(message("/start"), store);
    expect(r.body.text).toBe(BOT_COPY.ru.help);
    expect(calls.map((c) => c[0])).toEqual(["claim"]);
  });
});

describe("the chat's own signals", () => {
  it("/stop pauses and /resume resumes, in the stored language", async () => {
    const a = fakeStore({ mark: "uz" });
    const stop = await hit(message("/stop"), a.store);
    expect(a.calls[1]).toEqual(["mark", String(CHAT), "paused"]);
    expect(stop.body.text).toBe(BOT_COPY.uz.paused);
    const b = fakeStore({ mark: "en" });
    const res = await hit(message("/resume", {}, 8), b.store);
    expect(b.calls[1]).toEqual(["mark", String(CHAT), "resume"]);
    expect(res.body.text).toBe(BOT_COPY.en.resumed);
  });
  it("/stop in a chat that is not connected says so", async () => {
    const { store } = fakeStore({ mark: null });
    expect((await hit(message("/stop"), store)).body.text).toBe(BOT_COPY.ru.notConnected);
  });
  it("blocking the bot marks the channel blocked and sends no reply", async () => {
    const { store, calls } = fakeStore();
    const r = await hit({ update_id: 11, my_chat_member: { chat: { id: CHAT, type: "private" }, from: from(), new_chat_member: { status: "kicked" } } }, store);
    expect(calls[1]).toEqual(["mark", String(CHAT), "blocked"]);
    expect(r).toEqual({ status: 200, body: {} });
  });
});

describe("language", () => {
  it("falls back to English for a language or a key that has no words, never throws", () => {
    for (const lang of ["ar", "ur", null, undefined, "", "../x", "RU"]) expect(botWords(lang, "paused")).toBe(BOT_COPY.en.paused);
    expect(botWords("ru", "paused")).toBe(BOT_COPY.ru.paused);
  });
  it("has every key in every language, and no brand or role words", () => {
    const keys = Object.keys(BOT_COPY.en).sort();
    const banned = /openai|google|runway|kling|veo|sora|elevenlabs|replicate|fal\.ai|minimax|\b(owner|editor|viewer|admin)\b|владелец|редактор|наблюдатель|администратор|egasi|muharrir|kuzatuvchi/i;
    for (const [lang, table] of Object.entries(BOT_COPY)) {
      expect(Object.keys(table).sort(), lang).toEqual(keys);
      for (const text of Object.values(table)) expect(text).not.toMatch(banned);
    }
  });
});

describe("the REST store", () => {
  it("calls the 0102 functions with the service key and returns only what they say", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const store = createRestStore({
      url: "https://x.supabase.test/",
      serviceKey: "svc",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ code: "ok", locale: "uz", handle: "a.b" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await store.peek(TOKEN)).toEqual({ code: "ok", locale: "uz", handle: "a.b" });
    expect(seen[0].url).toBe("https://x.supabase.test/rest/v1/rpc/notification_link_peek");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ p_token: TOKEN });
  });
  it("turns a failure into an error that names the function and status only", async () => {
    const store = createRestStore({ url: "https://x.test", serviceKey: "svc-secret", fetch: (async () => new Response("secret body", { status: 503 })) as unknown as typeof fetch });
    await expect(store.claimUpdate(1)).rejects.toThrow(StoreError);
    await expect(store.claimUpdate(1)).rejects.toThrow(/notify_telegram_update_claim failed \(HTTP 503\)/);
    await expect(store.claimUpdate(1)).rejects.not.toThrow(/secret/);
  });
});

describe("reading the body without trusting Content-Length", () => {
  const streamOf = (chunks: string[], pulled?: { n: number }) =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift();
        if (pulled) pulled.n += 1;
        if (next === undefined) c.close();
        else c.enqueue(new TextEncoder().encode(next));
      },
    });
  it("returns small bodies whole, including multi-byte text split across chunks", async () => {
    expect(await readBoundedText(streamOf(['{"a":', '"ё"}']))).toBe('{"a":"ё"}');
    expect(await readBoundedText(null)).toBe("");
  });
  it("stops reading the moment the limit is passed and says so", async () => {
    const pulled = { n: 0 };
    const chunks = Array.from({ length: 1000 }, () => "x".repeat(1024));
    expect(await readBoundedText(streamOf(chunks, pulled), 4096)).toBeNull();
    expect(pulled.n).toBeLessThan(10);
  });
  it("keeps the cap to a few KB", () => {
    expect(MAX_BODY).toBeLessThanOrEqual(8 * 1024);
  });
});
