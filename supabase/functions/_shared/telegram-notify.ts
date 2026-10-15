// The CUSTOMER bot's webhook logic (migration 0102): linking a person's Telegram
// chat to their account, and the chat's own signals (blocked the bot, /stop).
//
// Runtime-neutral on purpose (no Deno globals), like _shared/paddle.ts: the Edge
// Function wires the environment to it and the Command Center's vitest suite
// covers it with fakes. NOT the operator bot: that one polls
// (tools/run_telegram_control.py) and shares nothing with this file.
//
// Trust rules, in the order they are applied:
//   1. the secret header is compared in constant time before the body is read as
//      anything but bytes; a wrong or missing one is 401 and nothing else happens;
//   2. only three update shapes are accepted (a private-chat text message, a
//      callback from a private chat, a my_chat_member of a private chat); any
//      other shape is ignored with 200;
//   3. an update id is handled once (notify_telegram_updates);
//   4. a chat id from the body is stored ONLY together with a one-time token
//      that matched, from a private chat whose id is the sender's own id, and
//      only after the person pressed "Yes" in the chat. Everything else the body
//      says (names, text) is used for wording, never for authority.
// The function never holds the bot token: it answers by replying to the webhook
// request itself (Telegram executes the method named in the response).

export type Lang = string;

const SECRET_RE = /^[A-Za-z0-9_-]{24,256}$/;
const TOKEN_RE = /^[0-9a-f]{56}$/;
// A real update is well under 2 KB (a command, a callback or a member change). 8 KB is generous.
export const MAX_BODY = 8 * 1024;

export const BOT_COPY: Record<string, Record<string, string>> = {
  en: {
    help: "I send short updates about your Nightshift work. To connect this chat, open Settings in the app and press Connect Telegram.",
    confirm: "Connect this chat to your Nightshift account?",
    confirmAs: "Connect this chat to your Nightshift account {handle}?",
    yes: "Yes, connect",
    no: "No",
    connected: "Connected. You will get updates here. Send /stop to pause.",
    cancelled: "Cancelled. Nothing was connected.",
    expired: "This link has expired. Open Settings in the app and press Connect Telegram again.",
    invalid: "This link is not valid. Open Settings in the app and press Connect Telegram.",
    used: "This link was already used. Open Settings in the app to see your connections.",
    alreadyLinked: "This chat is already connected to an account. Disconnect it in Settings first.",
    limit: "You have reached the number of chats you can connect. Disconnect one in Settings first.",
    notPrivate: "Connect from a private chat with me.",
    paused: "Paused. Send /resume to get updates again.",
    resumed: "Updates are back on.",
    notConnected: "This chat is not connected. Open Settings in the app to connect it.",
    failed: "Something went wrong. Please press Start again.",
  },
  ru: {
    help: "Я присылаю короткие уведомления о вашей работе в Nightshift. Чтобы подключить этот чат, откройте Настройки в приложении и нажмите «Подключить Telegram».",
    confirm: "Подключить этот чат к вашему аккаунту Nightshift?",
    confirmAs: "Подключить этот чат к вашему аккаунту Nightshift {handle}?",
    yes: "Да, подключить",
    no: "Нет",
    connected: "Подключено. Уведомления будут приходить сюда. /stop — пауза.",
    cancelled: "Отменено. Ничего не подключено.",
    expired: "Срок ссылки истёк. Откройте Настройки в приложении и снова нажмите «Подключить Telegram».",
    invalid: "Ссылка недействительна. Откройте Настройки в приложении и нажмите «Подключить Telegram».",
    used: "Эта ссылка уже использована. Подключения можно посмотреть в Настройках.",
    alreadyLinked: "Этот чат уже подключён к аккаунту. Сначала отключите его в Настройках.",
    limit: "Достигнуто число чатов, которые можно подключить. Сначала отключите один в Настройках.",
    notPrivate: "Подключайте из личного чата со мной.",
    paused: "Пауза. Отправьте /resume, чтобы снова получать уведомления.",
    resumed: "Уведомления снова включены.",
    notConnected: "Этот чат не подключён. Откройте Настройки в приложении, чтобы подключить его.",
    failed: "Что-то пошло не так. Нажмите Start ещё раз.",
  },
  uz: {
    help: "Men Nightshift’dagi ishingiz haqida qisqa xabarlar yuboraman. Bu chatni ulash uchun ilovada Sozlamalarni oching va «Telegramni ulash» tugmasini bosing.",
    confirm: "Bu chat Nightshift hisobingizga ulansinmi?",
    confirmAs: "Bu chat Nightshift hisobingizga {handle} ulansinmi?",
    yes: "Ha, ulansin",
    no: "Yoʻq",
    connected: "Ulandi. Xabarlar shu yerga keladi. Toʻxtatish: /stop.",
    cancelled: "Bekor qilindi. Hech narsa ulanmadi.",
    expired: "Havola muddati tugagan. Ilovada Sozlamalarni oching va «Telegramni ulash» tugmasini qayta bosing.",
    invalid: "Havola yaroqsiz. Ilovada Sozlamalarni oching va «Telegramni ulash» tugmasini bosing.",
    used: "Bu havola allaqachon ishlatilgan. Ulanishlarni Sozlamalarda koʻring.",
    alreadyLinked: "Bu chat allaqachon boshqa hisobga ulangan. Avval uni Sozlamalarda uzing.",
    limit: "Ulash mumkin boʻlgan chatlar soniga yetdingiz. Avval bittasini Sozlamalarda uzing.",
    notPrivate: "Men bilan shaxsiy chatdan ulang.",
    paused: "Toʻxtatildi. Qayta yoqish uchun /resume yuboring.",
    resumed: "Xabarlar qayta yoqildi.",
    notConnected: "Bu chat ulanmagan. Ulash uchun ilovada Sozlamalarni oching.",
    failed: "Xatolik yuz berdi. Start tugmasini qayta bosing.",
  },
};

/** The words for `key` in `lang` (a bare language code), English when that
 *  language has none: adding a language is adding a key to BOT_COPY. */
export function botWords(lang: Lang | null | undefined, key: string): string {
  const code = typeof lang === "string" && /^[a-z]{2,3}$/.test(lang) ? lang : "en";
  return BOT_COPY[code]?.[key] ?? BOT_COPY.en[key];
}

/** Telegram's language_code ("ru", "pt-br", …) as a bare lower-case code. */
export function bareLanguage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const m = /^([A-Za-z]{2,3})(?:[-_]|$)/.exec(code);
  return m ? m[1].toLowerCase() : null;
}

// ── the secret header ───────────────────────────────────────────────────────

/** Constant-time comparison: both values are HMAC'd under a fresh random key
 *  and the two MACs are compared by crypto.subtle.verify, so neither the length
 *  nor any prefix of the secret changes how long the answer takes. */
export async function secretMatches(provided: string | null | undefined, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(expected));
  return crypto.subtle.verify("HMAC", key, mac, enc.encode(provided));
}

export function secretIsUsable(secret: string | undefined): boolean {
  return typeof secret === "string" && SECRET_RE.test(secret);
}

// ── update shapes ───────────────────────────────────────────────────────────

export type Parsed =
  | { kind: "start"; updateId: number; chat: string; from: string; lang: string | null; name: string | null; token: string | null }
  | { kind: "command"; updateId: number; chat: string; lang: string | null; command: "stop" | "resume" | "help" }
  | { kind: "confirm"; updateId: number; chat: string; from: string; lang: string | null; name: string | null;
      token: string; yes: boolean; messageId: number }
  | { kind: "member"; updateId: number; chat: string; status: "blocked" | "unblocked" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const FIRST_NAME_MAX = 64;

function person(v: unknown): { id: string; lang: string | null; name: string | null } | null {
  if (!isObj(v) || !isId(v.id) || v.is_bot === true) return null;
  const name = typeof v.first_name === "string" ? v.first_name.slice(0, FIRST_NAME_MAX) : null;
  return { id: String(v.id), lang: bareLanguage(v.language_code), name };
}

/** One of the three shapes this bot acts on, or null (ignored with 200). */
export function parseUpdate(raw: unknown): Parsed | null {
  if (!isObj(raw)) return null;
  const updateId = raw.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return null;

  if (isObj(raw.message)) {
    const m = raw.message;
    const from = person(m.from);
    if (!from || !isObj(m.chat) || m.chat.type !== "private" || !isId(m.chat.id) || String(m.chat.id) !== from.id) return null;
    if (typeof m.text !== "string" || m.text.length > 512) return null;
    const cmd = /^\/(start|stop|resume|help)(?:@[A-Za-z0-9_]{3,64})?(?:[ \t]+(\S{1,128}))?[ \t]*$/i.exec(m.text.trim());
    if (!cmd) return null;
    const name = cmd[1].toLowerCase();
    if (name === "start") {
      const arg = cmd[2] ?? null;
      if (arg !== null && !TOKEN_RE.test(arg)) {
        return { kind: "start", updateId, chat: from.id, from: from.id, lang: from.lang, name: from.name, token: "" };
      }
      return { kind: "start", updateId, chat: from.id, from: from.id, lang: from.lang, name: from.name, token: arg };
    }
    return { kind: "command", updateId, chat: from.id, lang: from.lang, command: name as "stop" | "resume" | "help" };
  }

  if (isObj(raw.callback_query)) {
    const q = raw.callback_query;
    const from = person(q.from);
    if (!from || typeof q.data !== "string" || !isObj(q.message) || !isObj(q.message.chat)) return null;
    const chat = q.message.chat;
    if (chat.type !== "private" || !isId(chat.id) || String(chat.id) !== from.id || !isId(q.message.message_id)) return null;
    const d = /^([yn]):([0-9a-f]{56})$/.exec(q.data);
    if (!d) return null;
    return { kind: "confirm", updateId, chat: from.id, from: from.id, lang: from.lang, name: from.name,
             token: d[2], yes: d[1] === "y", messageId: q.message.message_id as number };
  }

  if (isObj(raw.my_chat_member)) {
    const c = raw.my_chat_member;
    if (!isObj(c.chat) || c.chat.type !== "private" || !isId(c.chat.id) || !isObj(c.new_chat_member)) return null;
    const status = c.new_chat_member.status;
    if (status === "kicked" || status === "left") return { kind: "member", updateId, chat: String(c.chat.id), status: "blocked" };
    if (status === "member") return { kind: "member", updateId, chat: String(c.chat.id), status: "unblocked" };
    return null;
  }
  return null;
}

// ── the store (the 0102 functions, through PostgREST with the service key) ──

export interface PeekResult { code: string; locale?: string | null; handle?: string | null }
export interface ConsumeResult { code: string; locale?: string | null }

export interface NotifyStore {
  claimUpdate(updateId: number): Promise<boolean>;
  peek(token: string): Promise<PeekResult>;
  consume(token: string, chat: string, label: string | null, chatType: string, fromId: string): Promise<ConsumeResult>;
  mark(chat: string, action: "blocked" | "paused" | "resume" | "unblocked"): Promise<string | null>;
}

/** A store failure: the function and the HTTP status, never a body or a key. */
export class StoreError extends Error {
  constructor(readonly fn: string, readonly status: number | null) {
    super(`${fn} failed${status ? ` (HTTP ${status})` : ""}`);
  }
}

export function createRestStore(cfg: { url: string; serviceKey: string; fetch?: typeof fetch }): NotifyStore {
  const doFetch = cfg.fetch ?? fetch;
  const base = cfg.url.replace(/\/+$/, "");
  async function rpc(fn: string, body: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new StoreError(fn, null);
    }
    if (!res.ok) throw new StoreError(fn, res.status);
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const obj = (v: unknown) => (isObj(v) ? v : {});
  return {
    async claimUpdate(updateId) {
      return (await rpc("notify_telegram_update_claim", { p_update_id: updateId })) === true;
    },
    async peek(token) {
      const o = obj(await rpc("notification_link_peek", { p_token: token }));
      return { code: String(o.code ?? "invalid"), locale: typeof o.locale === "string" ? o.locale : null,
               handle: typeof o.handle === "string" ? o.handle : null };
    },
    async consume(token, chat, label, chatType, fromId) {
      const o = obj(await rpc("notification_link_consume",
        { p_token: token, p_external_id: chat, p_label: label, p_chat_type: chatType, p_ext_user_id: fromId }));
      return { code: String(o.code ?? "invalid"), locale: typeof o.locale === "string" ? o.locale : null };
    },
    async mark(chat, action) {
      const v = await rpc("notification_channel_mark", { p_external_id: chat, p_action: action });
      return typeof v === "string" ? v : null;
    },
  };
}

// ── the handler ─────────────────────────────────────────────────────────────

/** The body as text, read piece by piece and abandoned the moment it passes `limit` bytes
 *  (a client may omit or lie about Content-Length). null = over the limit. */
export async function readBoundedText(stream: ReadableStream<Uint8Array> | null, limit: number = MAX_BODY): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface WebhookRequest {
  method: string;
  contentType: string | null;
  /** The body, or null when it was over the limit and was not read to the end. */
  rawBody: string | null;
  secretHeader: string | null;
}
export interface WebhookResponse { status: number; body: Record<string, unknown> }

const say = (chat: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ method: "sendMessage", chat_id: Number(chat), text, ...extra });
const ack: WebhookResponse = { status: 200, body: {} };

export async function handleTelegramWebhook(
  req: WebhookRequest,
  deps: { secret: string | undefined; store: NotifyStore },
): Promise<WebhookResponse> {
  if (!secretIsUsable(deps.secret)) return { status: 503, body: { error: "not_configured" } };
  if (req.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (!(await secretMatches(req.secretHeader, deps.secret as string))) return { status: 401, body: { error: "unauthorized" } };
  if (!/^application\/json\b/i.test(req.contentType ?? "")) return { status: 415, body: { error: "unsupported_media_type" } };
  if (req.rawBody === null || req.rawBody.length > MAX_BODY) return { status: 413, body: { error: "too_large" } };

  let raw: unknown;
  try {
    raw = JSON.parse(req.rawBody);
  } catch {
    return ack;
  }
  const u = parseUpdate(raw);
  if (!u) return ack;

  const { store } = deps;
  let lang: string | null = "lang" in u ? u.lang : null;
  try {
    if (!(await store.claimUpdate(u.updateId))) return ack;

    switch (u.kind) {
      case "member": {
        await store.mark(u.chat, u.status);
        return ack;
      }
      case "command": {
        if (u.command === "help") return { status: 200, body: say(u.chat, botWords(lang, "help")) };
        const stored = await store.mark(u.chat, u.command === "stop" ? "paused" : "resume");
        if (stored === null) return { status: 200, body: say(u.chat, botWords(lang, "notConnected")) };
        return { status: 200, body: say(u.chat, botWords(stored, u.command === "stop" ? "paused" : "resumed")) };
      }
      case "start": {
        if (u.token === null || u.token === "") return { status: 200, body: say(u.chat, botWords(lang, "help")) };
        const p = await store.peek(u.token);
        lang = p.locale ?? lang;
        if (p.code !== "ok") {
          const key = p.code === "expired" ? "expired" : p.code === "used" ? "used" : "invalid";
          return { status: 200, body: say(u.chat, botWords(lang, key)) };
        }
        const text = p.handle
          ? botWords(lang, "confirmAs").replace("{handle}", `@${p.handle}`)
          : botWords(lang, "confirm");
        return { status: 200, body: say(u.chat, text, { reply_markup: { inline_keyboard: [[
          { text: botWords(lang, "yes"), callback_data: `y:${u.token}` },
          { text: botWords(lang, "no"), callback_data: `n:${u.token}` },
        ]] } }) };
      }
      case "confirm": {
        const edit = (key: string) => ({ method: "editMessageText", chat_id: Number(u.chat), message_id: u.messageId,
                                         text: botWords(lang, key) });
        if (!u.yes) return { status: 200, body: edit("cancelled") };
        const r = await store.consume(u.token, u.chat, u.name, "private", u.from);
        lang = r.locale ?? lang;
        const key = ({ ok: "connected", expired: "expired", used: "used", already_linked: "alreadyLinked",
                       limit: "limit", not_private: "notPrivate" } as Record<string, string>)[r.code] ?? "invalid";
        return { status: 200, body: edit(key) };
      }
    }
  } catch {
    // The update is already counted; answering lets the person simply press Start again.
    return { status: 200, body: say(u.chat, botWords(lang, "failed")) };
  }
}
