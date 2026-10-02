import { describe, expect, it } from "vitest";
import { dictionaries } from "../lib/i18n";
import type { PriceMap } from "../lib/credits";
import {
  INBOX_LIMITS,
  buildItems,
  cardState,
  cleanReply,
  failureText,
  heldReason,
  inboxErrorText,
  isActive,
  isIdempotencyKey,
  isUuid,
  mapInboxError,
  matchesFilter,
  newIdempotencyKey,
  parseComments,
  parseDrafts,
  parseIntents,
  parsePosts,
  parseQuote,
  replyDraftPrice,
  type InboxItem,
} from "../lib/comment-inbox";

/**
 * The comment inbox's pure half (migration 0081).
 *
 * What would break without these: an unset price shown as free; a spam, flagged
 * or never-checked comment offered a draft; a reply cleaned differently from the
 * database; a refusal mapped to the wrong sentence (or leaking another
 * organization's existence); a card showing "replied" for a reply that is only
 * approved; a missing translation.
 */

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const D1 = "44444444-4444-4444-8444-444444444444";
const I1 = "55555555-5555-4555-8555-555555555555";
const P1 = "66666666-6666-4666-8666-666666666666";

const price = (unit: string, creditsPerUnit: number, margin = 0) => ({ unit, creditsPerUnit, margin, note: null, updatedAt: null });
const prices = (...p: ReturnType<typeof price>[]): PriceMap => Object.fromEntries(p.map((x) => [x.unit, x]));

const row = (over: Record<string, unknown> = {}) => ({
  id: C1, channel_id: "chan-a", video_id: "vid-a", author_name: "Ann", body: "Which camera?", published_at: "2026-09-30T10:00:00Z",
  category: "question", flagged_injection: false, status: "open", ...over,
});

describe("the price", () => {
  it("is null — never free — when the reply_draft price is not set", () => {
    expect(replyDraftPrice({})).toBeNull();
    expect(replyDraftPrice(prices(price("job_minimum", 5)))).toBeNull();
  });
  it("is the rate as charged, rounded up to the cent", () => {
    expect(replyDraftPrice(prices(price("reply_draft", 3)))).toBe(3);
    expect(replyDraftPrice(prices(price("reply_draft", 3, 0.5)))).toBe(4.5);
    expect(replyDraftPrice(prices(price("reply_draft", 0.333)))).toBe(0.34);
  });
  it("never goes below the platform's job minimum, and 0 stays 0 (included)", () => {
    expect(replyDraftPrice(prices(price("reply_draft", 3), price("job_minimum", 5)))).toBe(5);
    expect(replyDraftPrice(prices(price("reply_draft", 8), price("job_minimum", 5)))).toBe(8);
    expect(replyDraftPrice(prices(price("reply_draft", 0), price("job_minimum", 5)))).toBe(0);
  });
  it("refuses a rate that is not a number", () => {
    expect(replyDraftPrice(prices(price("reply_draft", Number.NaN)))).toBeNull();
    expect(replyDraftPrice(prices(price("reply_draft", -1)))).toBeNull();
  });
});

describe("cleanReply", () => {
  it("removes control, zero-width and direction-override characters and trims", () => {
    expect(cleanReply("  Hi\u0000 th‮e​re\r\nfriend\u0007 ")).toBe("Hi there\nfriend");
  });
  it("bounds the reply and reads a non-string as empty", () => {
    expect(cleanReply("x".repeat(900))).toHaveLength(INBOX_LIMITS.replyMax);
    expect(cleanReply(undefined)).toBe("");
    expect(cleanReply(42)).toBe("");
  });
});

describe("ids and keys", () => {
  it("accepts only a uuid and a well-formed key", () => {
    expect(isUuid(C1)).toBe(true);
    for (const bad of ["", "x", "../etc/passwd", `${C1}; drop`, 5, null]) expect(isUuid(bad)).toBe(false);
    expect(isIdempotencyKey("reply-draft:abc12345")).toBe(true);
    for (const bad of ["short", "has space 12345", "x".repeat(200), null]) expect(isIdempotencyKey(bad)).toBe(false);
  });
  it("makes a key per press that its own check accepts", () => {
    const a = newIdempotencyKey();
    expect(isIdempotencyKey(a)).toBe(true);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe("what the page reads", () => {
  it("keeps well-formed comments only, bounds text and never invents a category", () => {
    const out = parseComments([
      row({ body: "x".repeat(5000), author_name: "y".repeat(400), category: "mystery" }),
      row({ id: "not-a-uuid" }),
      row({ id: C2, status: "weird" }),
      null,
      "str",
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].body).toHaveLength(INBOX_LIMITS.bodyMax);
    expect(out[0].author).toHaveLength(INBOX_LIMITS.authorMax);
    expect(out[0].category).toBeNull();
    expect(out[1].status).toBe("open");
    expect(parseComments("nope")).toEqual([]);
  });
  it("reads drafts, intents and posts, dropping rows with an unknown state", () => {
    expect(parseDrafts([{ id: D1, comment_id: C1, status: "ready", body: "Hi", edited: true, quoted_credits: "3" }, { id: D1, comment_id: C1, status: "?" }])).toHaveLength(1);
    expect(parseIntents([{ id: I1, comment_id: C1, body: "Hi", approved_by_email: "a@b.c", approved_at: "2026-10-01" }])[0].approvedBy).toBe("a@b.c");
    const posts = parsePosts([
      { id: P1, comment_id: C1, status: "failed", error_code: "quota_exceeded" },
      { id: P1, comment_id: C2, status: "failed", error_code: "some secret reason" },
      { id: P1, comment_id: C3, status: "posted", error_code: "quota_exceeded" },
      { id: P1, comment_id: C3, status: "??" },
    ]);
    expect(posts.map((p) => p.errorCode)).toEqual(["quota_exceeded", "platform_error", null]);
  });
});

describe("who gets a draft", () => {
  it("holds back spam, flagged and unclassified comments (the database refuses the same three)", () => {
    expect(heldReason({ category: "spam", flagged: false })).toBe("spam");
    expect(heldReason({ category: "question", flagged: true })).toBe("flagged");
    expect(heldReason({ category: null, flagged: false })).toBe("not_classified");
    expect(heldReason({ category: "praise", flagged: false })).toBeNull();
    // flagged wins: the instruction attempt is the thing to say.
    expect(heldReason({ category: "spam", flagged: true })).toBe("flagged");
  });
});

function item(over: { comment?: Record<string, unknown>; draft?: InboxItem["draft"]; intent?: InboxItem["intent"]; post?: InboxItem["post"] } = {}): InboxItem {
  const [comment] = parseComments([row(over.comment)]);
  return { comment, draft: over.draft ?? null, intent: over.intent ?? null, post: over.post ?? null, held: heldReason(comment) };
}
const draft = (status: string, extra: Record<string, unknown> = {}) => parseDrafts([{ id: D1, comment_id: C1, status, body: "Hi", ...extra }])[0];
const post = (status: string, extra: Record<string, unknown> = {}) => parsePosts([{ id: P1, comment_id: C1, status, ...extra }])[0];
const intent = () => parseIntents([{ id: I1, comment_id: C1, body: "Hi" }])[0];

describe("the card", () => {
  it("reads each state from what the database holds", () => {
    expect(cardState(item())).toBe("open");
    expect(cardState(item({ comment: { category: "spam" } }))).toBe("held");
    expect(cardState(item({ comment: { flagged_injection: true } }))).toBe("held");
    expect(cardState(item({ draft: draft("pending") }))).toBe("writing");
    expect(cardState(item({ draft: draft("drafting") }))).toBe("writing");
    expect(cardState(item({ draft: draft("ready") }))).toBe("ready");
    expect(cardState(item({ draft: draft("failed") }))).toBe("draft_failed");
    expect(cardState(item({ comment: { status: "dismissed" } }))).toBe("dismissed");
  });
  it("shows an approved reply as waiting, a failed one as not posted, and replied only once posted", () => {
    expect(cardState(item({ intent: intent(), post: post("queued") }))).toBe("posting");
    expect(cardState(item({ intent: intent(), post: post("posting") }))).toBe("posting");
    expect(cardState(item({ intent: intent(), post: post("failed", { error_code: "quota_exceeded" }) }))).toBe("post_failed");
    expect(cardState(item({ intent: intent(), post: post("posted") }))).toBe("posted");
    expect(cardState(item({ comment: { status: "replied" } }))).toBe("posted");
  });
  it("a comment set aside after its posting failed reads as set aside", () => {
    expect(cardState(item({ comment: { status: "dismissed" }, intent: intent(), post: post("failed", { error_code: "comment_gone" }) }))).toBe("dismissed");
  });
  it("filters and knows when the worker is busy", () => {
    const open = item();
    const ready = item({ draft: draft("ready") });
    const done = item({ intent: intent(), post: post("posted") });
    expect([open, ready, done].map((i) => matchesFilter(i, "todo"))).toEqual([true, false, false]);
    expect([open, ready, done].map((i) => matchesFilter(i, "drafted"))).toEqual([false, true, false]);
    expect([open, ready, done].map((i) => matchesFilter(i, "replied"))).toEqual([false, false, true]);
    expect(isActive([open, ready, done])).toBe(false);
    expect(isActive([open, item({ draft: draft("pending") })])).toBe(true);
    expect(isActive([item({ intent: intent(), post: post("queued") })])).toBe(true);
  });
  it("joins the reads, newest comment first, ignoring a discarded or approved draft", () => {
    const comments = parseComments([row({ id: C1, published_at: "2026-09-01T00:00:00Z" }), row({ id: C2, published_at: "2026-09-02T00:00:00Z" })]);
    const drafts = parseDrafts([
      { id: D1, comment_id: C1, status: "discarded", created_at: "2026-09-03" },
      { id: "77777777-7777-4777-8777-777777777777", comment_id: C1, status: "ready", body: "B", created_at: "2026-09-02" },
      { id: "88888888-8888-4888-8888-888888888888", comment_id: C2, status: "approved", body: "A", created_at: "2026-09-02" },
    ]);
    const items = buildItems(comments, drafts, [], []);
    expect(items.map((i) => i.comment.id)).toEqual([C2, C1]);
    expect(items[0].draft).toBeNull();
    expect(items[1].draft?.status).toBe("ready");
  });
});

describe("the quote", () => {
  it("reads a priced quote, and an unpriced or odd one never as a price", () => {
    expect(parseQuote({ status: "priced", credits: "4.5", may_start: true, reply_ready: true })).toMatchObject({ status: "priced", credits: 4.5, mayStart: true, replyReady: true });
    expect(parseQuote({ status: "unpriced", credits: null }).credits).toBeNull();
    expect(parseQuote({ status: "priced", credits: 0 })).toMatchObject({ status: "unavailable", credits: null });
    expect(parseQuote({ status: "priced" })).toMatchObject({ status: "unavailable", credits: null });
    expect(parseQuote(null).status).toBe("unavailable");
    expect(parseQuote({ status: "unavailable", reason: "spam" }).reason).toBe("spam");
  });
});

describe("the database's refusals", () => {
  const e = (code: string, message: string, details: string | null = null) => mapInboxError({ code, message, details });
  it("reads another organization's id exactly like a missing one", () => {
    expect(e("P0002", "not_found")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(e("42501", "forbidden")).toEqual({ status: 403, body: { error: "forbidden" } });
  });
  it("carries only what the person may see", () => {
    expect(e("NS402", "insufficient credits", "available=1.5 needed=4.5")).toEqual({
      status: 402, body: { error: "insufficient_credits", needed: 4.5, available: 1.5 },
    });
    expect(e("NS409", "price_changed", "credits=6 confirmed=4.5")).toEqual({ status: 409, body: { error: "price_changed", credits: 6 } });
    expect(e("22023", "price_required", "credits=4.5")).toEqual({ status: 409, body: { error: "price_required", credits: 4.5 } });
    expect(e("NS400", "unpriced")).toEqual({ status: 409, body: { error: "unpriced" } });
    expect(e("NS400", "not_draftable", "flagged")).toEqual({ status: 409, body: { error: "not_draftable", reason: "flagged" } });
    expect(e("NS400", "not_draftable", "a secret")).toEqual({ status: 409, body: { error: "not_draftable", reason: "unknown" } });
  });
  it("maps the conflicts, the limits and the missing migration", () => {
    for (const m of ["in_progress", "draft_exists", "already_replied", "not_editable", "not_approvable", "comment_closed", "channel_not_ready", "not_retryable", "idempotency_conflict"]) {
      expect(e("NS409", m)).toEqual({ status: 409, body: { error: m } });
    }
    expect(e("NS429", "daily_limit").status).toBe(429);
    expect(e("NS429", "run limit").body).toEqual({ error: "run_limit" });
    expect(e("NS400", "invalid_body").status).toBe(400);
    expect(e("42883", "function does not exist").body).toEqual({ error: "inbox_unavailable" });
    expect(e("XX000", "boom with a secret").body).toEqual({ error: "inbox_failed" });
  });
});

function flatten(o: unknown, p = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === "string") out[p + k] = v;
    else Object.assign(out, flatten(v, `${p}${k}.`));
  }
  return out;
}

describe("what the screen says", () => {
  const locales = ["en", "ru", "uz"] as const;
  const bodies: Record<string, unknown>[] = [
    { error: "forbidden" }, { error: "not_found" }, { error: "insufficient_credits", needed: 5, available: 1 }, { error: "run_limit" },
    { error: "daily_limit" }, { error: "price_changed", credits: 6 }, { error: "price_required" }, { error: "unpriced" },
    { error: "not_draftable", reason: "spam" }, { error: "not_draftable" }, { error: "channel_not_ready" }, { error: "invalid_body" },
    { error: "in_progress" }, { error: "inbox_unavailable" }, { error: "inbox_failed" }, {},
  ];
  it("has a sentence for every refusal, in every language, with no placeholder left over", () => {
    for (const l of locales) {
      for (const b of bodies) {
        const text = inboxErrorText(b, dictionaries[l].inbox);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/\{\w+\}/);
      }
    }
  });
  it("names a stored failure by its own words, never a response body", () => {
    for (const l of locales) {
      for (const code of ["quota_exceeded", "token_expired", "outcome_unknown", "comment_gone", "something else", null]) {
        expect(failureText(code, dictionaries[l].inbox).length).toBeGreaterThan(5);
      }
    }
  });
  it("is complete and consistent in en, ru and uz", () => {
    const en = flatten(dictionaries.en.inbox);
    for (const l of ["ru", "uz"] as const) {
      const other = flatten(dictionaries[l].inbox);
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(other)) {
        expect(v.trim().length, `${l}.inbox.${k}`).toBeGreaterThan(0);
        expect((v.match(/\{\w+\}/g) ?? []).sort(), `${l}.inbox.${k}`).toEqual((en[k].match(/\{\w+\}/g) ?? []).sort());
      }
    }
    expect(dictionaries.ru.nav.inbox).not.toBe(dictionaries.en.nav.inbox);
    expect(dictionaries.uz.nav.inbox).not.toBe(dictionaries.en.nav.inbox);
  });
  it("keeps customer copy free of provider and model names and of role words", () => {
    const banned = /gemini|openai|google|anthropic|claude|veo|elevenlabs|\b(owner|editor|viewer|admin)\b|владел|редактор\b|наблюдател|администратор/i;
    for (const l of locales) {
      for (const [k, v] of Object.entries(flatten(dictionaries[l].inbox))) expect(v, `${l}.${k}`).not.toMatch(banned);
    }
  });
});
