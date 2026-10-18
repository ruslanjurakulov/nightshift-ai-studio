/**
 * The Marketing page's pure side (lib/marketing-posts.ts, lib/marketing-text.ts) and its words.
 *
 * What would break without these: the page turning on for a value that is not exactly `on`; a request body that reaches
 * Postgres malformed; an argument name that drifted from the SQL function (the call would fail at the moment of the
 * approval); a refusal the database can give that the page has no sentence for, in some language; a preview that disagrees with what
 * the sender will build (the owner approves words they did not see); an unknown drawn as a zero; a control that sends or
 * tests a post.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import {
  CAPTION_LIMIT,
  MARKETING_REFUSALS,
  MESSAGE_LIMIT,
  LINK_CHOICES,
  POST_COLUMNS,
  POST_KINDS,
  POST_STATUSES,
  buildPreview,
  channelHandle,
  coerceListedPost,
  coercePost,
  coercePosts,
  coerceSettings,
  isMarketingRefusal,
  isOtherPost,
  lastSettled,
  linkOk,
  mediaKind,
  newRequestId,
  parseMarketing,
  parseMarketingFlag,
  safeCode,
  senderRefusal,
  sortPosts,
  textsProblem,
  validOrigin,
  type MarketingPost,
  type Texts,
} from "../lib/marketing-posts";
import { fixText, marketingFailureText, marketingRefusalText, pluralForm, refusalMeansStale, sendNote, unitCount } from "../lib/marketing-text";

const ROOT = join(__dirname, "..", "..");
const sql = readFileSync(join(ROOT, "supabase", "migrations", "0108_marketing_posts.sql"), "utf8");
const sql0110 = readFileSync(join(ROOT, "supabase", "migrations", "0110_marketing_promo_custom.sql"), "utf8");
const dicts = { en, ru, uz } as const;
const ID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);
const TEXTS: Texts = { uz: "Yangi funksiya.", ru: "Новая функция.", en: "A new feature." };
const REASON = "the channel is checked and the bot is admin";

describe("NIGHTSHIFT_MARKETING_POSTS", () => {
  it.each([
    ["on", true],
    [" on ", true], // the worker strips whitespace too (tools/marketing_worker.py posts_switch_on)
    ["off", false],
    ["", false],
    [undefined, false],
    [null, false],
    ["ON", false],
    ["1", false],
    ["true", false],
    ["yes", false],
    ["enabled", false],
  ])("%j reads as %s: only the word on turns it on", (value, expected) => {
    expect(parseMarketingFlag(value as string | undefined)).toBe(expected);
  });
});

describe("the refusal codes", () => {
  it("every code the owner_marketing_* functions can answer with is one the page can word", () => {
    const from = sql.indexOf("create or replace function public.owner_marketing_get");
    const to = sql.indexOf("create or replace function public.marketing_draft_upsert");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const used = new Set([...sql.slice(from, to).matchAll(/owner_err\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]));
    const missing = [...used].filter((c) => !isMarketingRefusal(c));
    expect(missing, `add these to MARKETING_REFUSALS and lib/i18n/marketing: ${missing.join(", ")}`).toEqual([]);
    // the ones the page leans on (the front door's own, mfa_required and rate_limited, come from owner_guard in 0107)
    for (const code of ["poster_off", "content_changed", "cap_full", "expired", "bad_texts", "reason_required"]) {
      expect(used.has(code), code).toBe(true);
    }
    for (const code of ["mfa_required", "rate_limited"]) expect(isMarketingRefusal(code), code).toBe(true);
  });

  it("names no refusal twice", () => {
    expect(new Set(MARKETING_REFUSALS).size).toBe(MARKETING_REFUSALS.length);
  });

  it.each(["en", "ru", "uz"] as const)("%s words every refusal and nothing else is missing", (loc) => {
    const err = dicts[loc].marketing.err as Record<string, string>;
    for (const code of MARKETING_REFUSALS) expect(err[code], `${loc}.err.${code}`).toBeTruthy();
  });

  it.each(["ru", "uz"] as const)("%s does not answer a refusal in English", (loc) => {
    for (const code of MARKETING_REFUSALS) {
      expect((dicts[loc].marketing.err as Record<string, string>)[code], `${loc}.${code}`).not.toBe((en.marketing.err as Record<string, string>)[code]);
    }
  });

  it("every code produces a sentence with no unfilled placeholder in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const code of MARKETING_REFUSALS) {
        const text = marketingRefusalText(dicts[loc], { error: code, used_7d: 1, approved_waiting: 1, max_per_7d: 2 });
        expect(text.length).toBeGreaterThan(10);
        expect(text, `${loc}.${code}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("a full week names its figures, and a figure the database did not send reads unknown, never 0", () => {
    expect(marketingRefusalText(en, { error: "cap_full", used_7d: 1, approved_waiting: 1, max_per_7d: 2 })).toBe(
      "The weekly limit is already used or promised: 1 used and 1 approved and waiting, out of 2. Wait, or reject a waiting post. Nothing was approved.",
    );
    for (const loc of ["en", "ru", "uz"] as const) {
      const text = marketingRefusalText(dicts[loc], { error: "cap_full" });
      expect(text).toContain(dicts[loc].marketing.err.figureUnknown);
      expect(text).not.toMatch(/\b0\b/);
    }
  });

  it("a code this build does not know is shown as a refusal with that code, not as success or silence", () => {
    expect(marketingRefusalText(en, { ok: false, error: "tomorrow_new_rule" })).toContain("tomorrow_new_rule");
    expect(marketingRefusalText(en, undefined)).toContain("refused");
  });

  it("the stale-page refusals are exactly the ones after which the page must reload", () => {
    for (const code of ["content_changed", "not_draft", "poster_off", "cap_full", "expired"]) expect(refusalMeansStale(code), code).toBe(true);
    for (const code of ["mfa_required", "reason_required", "rate_limited", "rpc_failed", undefined, 4]) expect(refusalMeansStale(code), String(code)).toBe(false);
  });
});

describe("marketingFailureText", () => {
  const fail = (kind: "server" | "mfa" | "session" | "network" | "forbidden" | "rate_limited", data: Record<string, unknown> = {}, status = 422) => ({ kind, status, data });

  it("a refusal from the database is worded by its code", () => {
    expect(marketingFailureText(en, fail("server", { ok: false, error: "content_changed" }))).toBe(en.marketing.err.content_changed);
    expect(marketingFailureText(en, fail("server", { ok: false, error: "poster_off" }))).toBe(en.marketing.err.poster_off);
    expect(marketingFailureText(en, fail("mfa", { error: "mfa_required" }, 401))).toBe(en.marketing.err.mfa_required);
    expect(marketingFailureText(en, fail("rate_limited", { ok: false, error: "rate_limited" }, 429))).toBe(en.marketing.err.rate_limited);
  });

  it("an ended session, the app second step and a refused account keep the words every other owner button uses", () => {
    expect(marketingFailureText(en, fail("session", { error: "unauthorized" }, 401))).toBe(en.ownerTruth.sessionEnded);
    expect(marketingFailureText(en, fail("mfa", { error: "mfa_recent_required" }, 403))).toBe(en.mfa.recentRequired);
    expect(marketingFailureText(en, fail("forbidden", { error: "forbidden" }, 403))).toBe(en.ownerTruth.forbidden);
  });

  it("a dropped connection says to look first when the action may have gone through", () => {
    expect(marketingFailureText(en, fail("network", {}, 0), true)).toContain(en.ownerTruth.checkBeforeRetry);
    expect(marketingFailureText(en, fail("network", {}, 0), false)).not.toContain(en.ownerTruth.checkBeforeRetry);
  });
});

describe("parseMarketing: the five moves and nothing else", () => {
  it("edit: the id and the three trimmed texts, as named in owner_marketing_edit", () => {
    const r = parseMarketing({ action: "edit", id: ID, texts: { uz: "  a ", ru: "б\n", en: " c" }, p_id: "x", service_key: "x" });
    expect(r).toEqual({ ok: true, call: { fn: "owner_marketing_edit", args: { p_id: ID, p_texts: { uz: "a", ru: "б", en: "c" } } } });
  });

  it("approve: the id and the hash the owner SAW", () => {
    expect(parseMarketing({ action: "approve", id: ID, contentHash: HASH })).toEqual({
      ok: true,
      call: { fn: "owner_marketing_approve", args: { p_id: ID, p_content_hash: HASH } },
    });
  });

  it("reject: the id and the trimmed reason", () => {
    expect(parseMarketing({ action: "reject", id: ID, reason: `  ${REASON} ` })).toEqual({
      ok: true,
      call: { fn: "owner_marketing_reject", args: { p_id: ID, p_reason: REASON } },
    });
  });

  it("kill: stopping needs no reason and sends none; re-arming needs one", () => {
    expect(parseMarketing({ action: "kill", kill: true, reason: "ignored" })).toEqual({ ok: true, call: { fn: "owner_marketing_kill", args: { p_kill: true, p_reason: null } } });
    expect(parseMarketing({ action: "kill", kill: false, reason: REASON })).toEqual({ ok: true, call: { fn: "owner_marketing_kill", args: { p_kill: false, p_reason: REASON } } });
    for (const reason of [undefined, null, "", "short", "x".repeat(301), 7]) {
      expect(parseMarketing({ action: "kill", kill: false, reason }), String(reason)).toEqual({ ok: false, error: "reason_required" });
    }
  });

  it.each([
    [null, "bad_request"],
    [[], "bad_request"],
    [{}, "bad_request"],
    [{ action: "send", id: ID }, "bad_request"],
    [{ action: "send_now", id: ID }, "bad_request"],
    [{ action: "test", id: ID }, "bad_request"],
    [{ action: "post", id: ID }, "bad_request"],
    [{ action: "resend", id: ID }, "bad_request"],
    [{ action: "approve", id: "nope", contentHash: HASH }, "no_such_post"],
    [{ action: "approve", id: ID }, "content_hash_required"],
    [{ action: "approve", id: ID, contentHash: "A".repeat(64) }, "content_hash_required"],
    [{ action: "approve", id: ID, contentHash: "abc" }, "content_hash_required"],
    [{ action: "reject", id: ID, reason: "short" }, "reason_required"],
    [{ action: "edit", id: ID, texts: { uz: "a", ru: "b" } }, "bad_texts"],
    [{ action: "edit", id: ID, texts: { uz: "a", ru: "b", en: "" } }, "bad_texts"],
    [{ action: "edit", id: ID, texts: { uz: "a", ru: "b", en: "   " } }, "bad_texts"],
    [{ action: "edit", id: ID, texts: { uz: "a", ru: "b", en: "c", fr: "d" } }, "bad_texts"],
    [{ action: "edit", id: ID, texts: { uz: "a", ru: "b", en: 3 } }, "bad_texts"],
    [{ action: "edit", id: ID, texts: { uz: "a", ru: "b", en: "x".repeat(1001) } }, "bad_texts"],
    [{ action: "kill", kill: "yes" }, "bad_arguments"],
    [{ action: "kill" }, "bad_arguments"],
  ])("%j is refused with %s and reaches no database function", (body, error) => {
    expect(parseMarketing(body)).toEqual({ ok: false, error });
  });

  it("1000 characters per language is accepted, counted as the database counts them (code points)", () => {
    const ok = parseMarketing({ action: "edit", id: ID, texts: { uz: "😀".repeat(1000), ru: "б", en: "c" } });
    expect(ok.ok).toBe(true);
    expect(parseMarketing({ action: "edit", id: ID, texts: { uz: "😀".repeat(1001), ru: "б", en: "c" } }).ok).toBe(false);
  });
});

describe("parseMarketing: create, a custom draft the owner typed (owner_marketing_create, migration 0110)", () => {
  const RID = "0123456789abcdef0123456789abcdef";
  const body = (over: Record<string, unknown> = {}) => ({ action: "create", requestId: RID, texts: TEXTS, link: "/pricing", ...over });

  it("sends the request id, the three trimmed texts, the link and kind custom, as named in owner_marketing_create", () => {
    const r = parseMarketing(body({ texts: { uz: " a ", ru: "б\n", en: " c" }, kind: "promo", p_kind: "promo", service_key: "x" }));
    expect(r).toEqual({
      ok: true,
      call: { fn: "owner_marketing_create", args: { p_request_id: RID, p_texts: { uz: "a", ru: "б", en: "c" }, p_link: "/pricing", p_kind: "custom" } },
    });
  });

  it("a person can only make a custom post: a kind in the body is never forwarded", () => {
    for (const kind of ["promo", "news", "showcase", "price", "custom", "x"]) {
      const r = parseMarketing(body({ kind, p_kind: kind }));
      expect(r.ok && r.call.args.p_kind, kind).toBe("custom");
    }
  });

  it("no link, a null link and an empty link are all 'no link' (SQL null), never an empty string", () => {
    for (const link of [undefined, null, "", "   "]) {
      const r = parseMarketing(body({ link }));
      expect(r.ok && r.call.args.p_link, JSON.stringify(link)).toBeNull();
    }
  });

  it("the call never approves, sends or names an id of a post", () => {
    const r = parseMarketing(body());
    expect(r.ok && Object.keys(r.call.args).sort()).toEqual(["p_kind", "p_link", "p_request_id", "p_texts"]);
  });

  it.each([
    [{ requestId: undefined }, "bad_request_id"],
    [{ requestId: "" }, "bad_request_id"],
    [{ requestId: "short" }, "bad_request_id"],
    [{ requestId: "a".repeat(15) }, "bad_request_id"],
    [{ requestId: "a".repeat(65) }, "bad_request_id"],
    [{ requestId: "has space 0123456789" }, "bad_request_id"],
    [{ requestId: "0123456789abcdef!" }, "bad_request_id"],
    [{ requestId: 12345678901234567 }, "bad_request_id"],
    [{ texts: { uz: "a", ru: "b" } }, "bad_texts"],
    [{ texts: { uz: "a", ru: "b", en: "  " } }, "bad_texts"],
    [{ texts: { uz: "a", ru: "b", en: "c", de: "d" } }, "bad_texts"],
    [{ texts: { uz: "a", ru: "b", en: 3 } }, "bad_texts"],
    [{ texts: { uz: "a", ru: "b", en: "x".repeat(1001) } }, "bad_texts"],
    [{ texts: { uz: "a\u200bb", ru: "b", en: "c" } }, "bad_texts"],
    [{ texts: { uz: "a\u202eb", ru: "b", en: "c" } }, "bad_texts"],
    [{ texts: { uz: "a\u0007b", ru: "b", en: "c" } }, "bad_texts"],
    [{ texts: { uz: "a\u0000b", ru: "b", en: "c" } }, "bad_texts"],
    [{ texts: { uz: "a\ud83dz", ru: "b", en: "c" } }, "bad_texts"],
    [{ texts: { uz: "a\ude00z", ru: "b", en: "c" } }, "bad_texts"],
    [{ link: "pricing" }, "bad_link"],
    [{ link: "/Pricing" }, "bad_link"],
    [{ link: "/a//b" }, "bad_link"],
    [{ link: "/a/../b" }, "bad_link"],
    [{ link: "/pricing?x=1" }, "bad_link"],
    [{ link: "https://evil.example/pricing" }, "bad_link"],
    [{ link: "//evil.example" }, "bad_link"],
    [{ link: "/" + "a".repeat(80) }, "bad_link"],
    [{ link: 5 }, "bad_link"],
    [{ link: ["/pricing"] }, "bad_link"],
  ])("%j is refused with %s and reaches no database function", (over, error) => {
    expect(parseMarketing(body(over))).toEqual({ ok: false, error });
  });

  it("1000 characters in each language is accepted (three of them, plus the labels, are under the database's 4096)", () => {
    expect(parseMarketing(body({ texts: { uz: "x".repeat(1000), ru: "x".repeat(1000), en: "x".repeat(1000) } })).ok).toBe(true);
  });

  it("the longest link the database accepts (80 characters) is accepted", () => {
    expect(parseMarketing(body({ link: "/" + "a".repeat(79) })).ok).toBe(true);
  });

  it("a new line inside a text is allowed, a carriage return is not (the database allows 0x0a only)", () => {
    expect(parseMarketing(body({ texts: { uz: "a\nb", ru: "b", en: "c" } })).ok).toBe(true);
    expect(parseMarketing(body({ texts: { uz: "a\rb", ru: "b", en: "c" } })).ok).toBe(false);
  });
});

describe("the request id of a New post screen", () => {
  it("is 32 hex characters, inside what the database accepts, and different every time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(/^[A-Za-z0-9_-]{16,64}$/.test([...ids][0])).toBe(true);
  });
});

describe("textsProblem and linkOk: what the form checks before the database does", () => {
  const T = (over: Partial<Texts> = {}): Texts => ({ ...TEXTS, ...over });
  it("a fine post has no problem", () => {
    expect(textsProblem(T())).toBeNull();
  });
  it("names the first problem, in the database's order of checks", () => {
    expect(textsProblem(T({ en: "" }))).toBe("empty");
    expect(textsProblem(T({ en: "a\u200bb" }))).toBe("bad_chars");
    expect(textsProblem(T({ en: "a\u0000b" }))).toBe("bad_chars"); // Postgres cannot hold NUL
    expect(textsProblem(T({ en: "broken \ud83d" }))).toBe("bad_chars"); // a lone surrogate (22P05)
    expect(textsProblem(T({ en: "\ude00 broken" }))).toBe("bad_chars");
    expect(textsProblem(T({ en: "x".repeat(1001) }))).toBe("lang_too_long");
  });
  it("a whole emoji (a surrogate pair) is fine", () => {
    expect(textsProblem(T({ en: "ok \ud83d\ude00" }))).toBeNull();
  });
  it("counts code points as the database does: 1000 emoji is one language of 1000 characters", () => {
    expect(textsProblem(T({ en: "😀".repeat(1000) }))).toBeNull();
    expect(textsProblem(T({ en: "😀".repeat(1001) }))).toBe("lang_too_long");
  });
  it("the offered links are all valid links", () => {
    for (const link of LINK_CHOICES) expect(linkOk(link), link).toBe(true);
    expect(linkOk("/pricing")).toBe(true);
    expect(linkOk("pricing")).toBe(false);
  });
});

describe("migration 0110 and this page agree (owner_marketing_create)", () => {
  const body0110 = (() => {
    const from = sql0110.indexOf("create or replace function public.owner_marketing_create");
    const to = sql0110.indexOf("create or replace function public.marketing_draft_upsert_v2");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return sql0110.slice(from, to);
  })();

  it("every refusal owner_marketing_create can give is one the page can word, and the five we lean on are among them", () => {
    const used = new Set([...body0110.matchAll(/owner_err\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]));
    const missing = [...used].filter((c) => !isMarketingRefusal(c));
    expect(missing, `add these to MARKETING_REFUSALS and lib/i18n/marketing: ${missing.join(", ")}`).toEqual([]);
    for (const code of ["bad_texts", "bad_link", "bad_request_id", "bad_kind", "key_reused"]) expect(used.has(code), code).toBe(true);
  });

  it("the arguments the route sends are the ones the function declares", () => {
    const m = /create or replace function public\.owner_marketing_create\(([\s\S]*?)\)\s*returns/.exec(sql0110);
    expect(m).toBeTruthy();
    const declared = [...m![1].matchAll(/\b(p_[a-z0-9_]+)\s+[a-z]/g)].map((x) => x[1]).sort();
    const r = parseMarketing({ action: "create", requestId: "0123456789abcdef0123456789abcdef", texts: TEXTS, link: null });
    expect(r.ok && Object.keys(r.call.args).sort()).toEqual(declared);
  });

  it("the request id and link shapes are the function's own", () => {
    expect(body0110).toContain("'^[A-Za-z0-9_-]{16,64}$'");
    expect(body0110).toContain("'^/[a-z0-9][a-z0-9/_-]{0,78}$'");
  });

  it("POST_KINDS is the kind CHECK list of migration 0110, word for word", () => {
    const m = /add constraint marketing_posts_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(sql0110);
    expect(m, "the kind CHECK of 0110 was not found: the regex needs updating").not.toBeNull();
    const inSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect([...inSql].sort()).toEqual([...POST_KINDS].sort());
  });

  it("every kind has a label in every language, and promo and custom are not the English label", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const kind of POST_KINDS) expect((dicts[loc].marketing.kind as Record<string, string>)[kind], `${loc}.kind.${kind}`).toBeTruthy();
    }
    for (const loc of ["ru", "uz"] as const) {
      expect(dicts[loc].marketing.kind.custom).not.toBe(en.marketing.kind.custom);
    }
  });

  it("the audit action the function writes is one the audit list allows", () => {
    expect(body0110).toContain("'marketing.create'");
    expect(sql0110).toMatch(/audit_action_allowed[\s\S]*'marketing\.create'/);
  });
});

describe("the arguments the route sends are the ones the SQL functions declare", () => {
  const declared = (fn: string): string[] => {
    const m = new RegExp(`create or replace function public\\.${fn}\\(([\\s\\S]*?)\\)\\s*returns`).exec(sql);
    expect(m, `${fn} is declared in 0108`).toBeTruthy();
    return [...m![1].matchAll(/\b(p_[a-z0-9_]+)\s+[a-z]/g)].map((x) => x[1]).sort();
  };
  const good = [
    parseMarketing({ action: "edit", id: ID, texts: TEXTS }),
    parseMarketing({ action: "approve", id: ID, contentHash: HASH }),
    parseMarketing({ action: "reject", id: ID, reason: REASON }),
    parseMarketing({ action: "kill", kill: true }),
    parseMarketing({ action: "kill", kill: false, reason: REASON }),
  ];

  it.each(good.map((g) => (g.ok ? g.call : null)))("%j", (call) => {
    expect(call).not.toBeNull();
    expect(Object.keys(call!.args).sort(), call!.fn).toEqual(declared(call!.fn));
  });

  it("covers every owner function that changes something, and the read takes no argument", () => {
    expect(good.every((g) => g.ok)).toBe(true);
    expect(new Set(good.map((g) => (g.ok ? g.call.fn : ""))).size).toBe(4);
    expect(declared("owner_marketing_get")).toEqual([]);
  });

  it("the columns the page reads exist in marketing_posts", () => {
    const table = /create table if not exists public\.marketing_posts \(([\s\S]*?)\n\);/.exec(sql)![1];
    const columns = new Set([...table.matchAll(/^\s{2}([a-z_0-9]+)\s/gm)].map((m) => m[1]));
    for (const c of POST_COLUMNS.split(",")) expect(columns.has(c), c).toBe(true);
  });

  it("the page never reads the facts or a person's id (they are the drafter's and the audit's)", () => {
    expect(POST_COLUMNS.split(",")).not.toContain("facts");
    expect(POST_COLUMNS).not.toMatch(/approved_by|edited_by|rejected_by|claimed_by|provider_message_id/);
  });
});

describe("the preview is the message the sender builds", () => {
  const cases = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "marketing_message_cases.json"), "utf8")).cases as {
    name: string;
    texts: Texts;
    link: string | null;
    origin: string | null;
    has_media: boolean;
    expect: { plain?: string; utf16?: number; limit?: number; over?: boolean; refused?: string };
  }[];

  it("has cases to compare", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    // The TypeScript mirror gives the sender's own verdict, for every refusal code it can give.
    expect(senderRefusal(c.texts, c.link, c.origin, c.has_media), "senderRefusal").toBe(c.expect.refused ?? null);
    if (c.expect.refused === "no_origin") {
      // The sender refuses a link it cannot complete; the page has no address to complete it with and says so.
      const pv = buildPreview(c.texts, c.link, validOrigin(c.origin), c.has_media);
      expect(pv.linkUncounted).toBe(true);
      expect(pv.linkUrl).toBeNull();
      expect(pv.plain).not.toContain(c.link ?? "\u0000");
      return;
    }
    if (c.expect.plain === undefined) return; // refused before a message exists (bad_texts, bad_link, unsafe_text)
    const pv = buildPreview(c.texts, c.link, c.origin, c.has_media);
    expect(pv.linkUncounted).toBe(false);
    expect(pv.plain).toBe(c.expect.plain);
    expect(pv.total).toBe(c.expect.utf16);
    expect(pv.limit).toBe(c.expect.limit);
    expect(pv.over).toBe(c.expect.over);
    expect(pv.unsafe).toBe(false);
  });

  it("covers every refusal code the sender can give", () => {
    const codes = new Set(cases.map((c) => c.expect.refused).filter(Boolean));
    for (const code of ["bad_texts", "bad_link", "no_origin", "unsafe_text", "too_long"]) expect(codes.has(code), code).toBe(true);
  });

  it("the page's own preview flags unsafe words and a message that is too long (what blocks Approve)", () => {
    expect(buildPreview({ uz: "a", ru: "б", en: "mail me@example.com" }, null, null, false).unsafe).toBe(true);
    expect(buildPreview({ uz: "😀".repeat(700), ru: "😀".repeat(700), en: "😀".repeat(700) }, null, null, false).over).toBe(true);
    expect(buildPreview(TEXTS, null, null, false)).toMatchObject({ unsafe: false, over: false });
  });

  it("with the site's address unknown the page still catches unsafe and too-long words, and does not claim no_origin", () => {
    expect(senderRefusal({ ...TEXTS, en: "mail me@example.com" }, "/pricing", null, false, true)).toBe("unsafe_text");
    expect(senderRefusal(TEXTS, "/pricing", null, false, true)).toBeNull();
    expect(senderRefusal(TEXTS, "/pricing", null, false)).toBe("no_origin");
  });

  it("counts emoji as two units each, like the sender, and the limits are 4096 and 1024", () => {
    expect(MESSAGE_LIMIT).toBe(4096);
    expect(CAPTION_LIMIT).toBe(1024);
    const pv = buildPreview({ uz: "😀", ru: "б", en: "c" }, null, null, false);
    expect(pv.blocks[0].units).toBe(2);
    expect(pv.blocks.map((b) => b.lang)).toEqual(["uz", "ru", "en"]);
  });

  it("a link with no known site address leaves the link out of the count and says so (a lower bound, never exact)", () => {
    const pv = buildPreview(TEXTS, "/pricing", null, false);
    expect(pv.linkUncounted).toBe(true);
    expect(pv.total).toBe(buildPreview(TEXTS, null, null, false).total);
  });

  it("an origin is accepted the way the sender accepts it", () => {
    expect(validOrigin("https://nightshift-ai.studio")).toBe("https://nightshift-ai.studio");
    expect(validOrigin("https://nightshift-ai.studio/")).toBe("https://nightshift-ai.studio");
    expect(validOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    // as Python's urlsplit keeps it: the port as typed, the host's case as typed, the scheme lower-cased
    expect(validOrigin("https://nightshift-ai.studio:443")).toBe("https://nightshift-ai.studio:443");
    expect(validOrigin("HTTPS://Nightshift-AI.studio/")).toBe("https://Nightshift-AI.studio");
    for (const bad of [undefined, null, "", "http://evil.example", "https://a.example/path", "https://u:p@a.example", "ftp://a.example", "not a url"]) {
      expect(validOrigin(bad as string | undefined), String(bad)).toBeNull();
    }
  });

  it("the channel is a public @name, or unknown: never guessed", () => {
    // the deploy's own rule (deploy/build-service-env.py CHAT)
    expect(channelHandle("@nightshiftaistudio")).toBe("@nightshiftaistudio");
    expect(channelHandle(" @nightshift_test ")).toBe("@nightshift_test");
    for (const good of ["@abcde", "@" + "a".repeat(32), "-1001234567890", "123456"]) expect(channelHandle(good), good).toBe(good);
    for (const bad of [undefined, "", "nightshift", "@a", "@abcd", "@" + "a".repeat(33), "@1abcd", "-100abc", "@bad name", "https://t.me/x"]) {
      expect(channelHandle(bad), String(bad)).toBeNull();
    }
  });

  it("a file is a photo, a video or something the sender will not send", () => {
    expect(mediaKind(null)).toBeNull();
    expect(mediaKind("showcase/a.PNG")).toBe("photo");
    expect(mediaKind("showcase/a.mp4")).toBe("video");
    expect(mediaKind("showcase/a.gif")).toBe("other");
  });
});

describe("reading what the database sent: an unknown is not a number", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    kind: "news",
    status: "draft",
    texts: TEXTS,
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

  it("a good row is read whole", () => {
    expect(coercePost(row())).toMatchObject({ id: ID, kind: "news", status: "draft", contentHash: HASH, link: "/pricing", attempts: 0 });
  });

  it("promo and custom (migration 0110) are known kinds: normal Telegram posts with a hash to approve, not Other rows", () => {
    const owner = "owner:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const promo = coercePost(row({ kind: "promo", source_ref: "promo:welcome" }));
    const custom = coercePost(row({ kind: "custom", source_ref: owner }));
    expect(promo).toMatchObject({ kind: "promo", status: "draft", contentHash: HASH, sourceRef: "promo:welcome" });
    expect(custom).toMatchObject({ kind: "custom", status: "draft", contentHash: HASH, sourceRef: owner });
    for (const kind of ["promo", "custom"]) {
      const listed = coerceListedPost(row({ kind, source_ref: kind === "promo" ? "promo:welcome" : owner }));
      expect(listed && isOtherPost(listed), kind).toBe(false);
    }
  });

  it("a promo or custom row on another target, or with another delivery, is still Other (never approved as Telegram)", () => {
    for (const kind of ["promo", "custom"]) {
      expect(coercePost(row({ kind, target: "instagram" }))).toBeNull();
      expect(coerceListedPost(row({ kind, target: "instagram" }))).toMatchObject({ other: true, reason: "target", kindCode: kind });
      expect(coerceListedPost(row({ kind, delivery: "manual" }))).toMatchObject({ other: true, reason: "delivery", kindCode: kind });
    }
  });

  it("a kind that is truly unknown is still an Other row beside a custom post, not 'could not read'", () => {
    const list = coercePosts([row({ kind: "custom", source_ref: "owner:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }), row({ id: "2".repeat(8) + "-2222-3333-4444-555555555555", kind: "banner" })]);
    expect(list).toHaveLength(2);
    expect(list!.map((p) => (isOtherPost(p) ? `other:${p.kindCode}` : p.kind))).toEqual(["custom", "other:banner"]);
  });

  it.each([
    ["no id", { id: null }],
    ["a status this page does not know", { status: "teleported" }],
    ["a kind it does not know", { kind: "ad" }],
    ["no hash", { content_hash: "" }],
    ["a short hash", { content_hash: "abc" }],
    ["a missing language", { texts: { uz: "a", ru: "b" } }],
    ["an empty language", { texts: { uz: "a", ru: "", en: "c" } }],
    ["texts that are not an object", { texts: "x" }],
  ])("%s is not a row", (_name, over) => {
    expect(coercePost(row(over))).toBeNull();
  });

  it("ONE unreadable row makes the whole list unreadable (a list that drops a post reads as 'nothing to approve')", () => {
    expect(coercePosts([row(), row({ id: "2".repeat(8) + "-2222-3333-4444-555555555555" })])).toHaveLength(2);
    expect(coercePosts([row(), row({ status: "?" })])).toBeNull();
    expect(coercePosts(null)).toBeNull();
    expect(coercePosts({})).toBeNull();
    expect(coercePosts([])).toEqual([]);
  });

  it("a counter that is not a number stays null, never 0", () => {
    const p = coercePost(row({ attempts: "many", max_attempts: undefined }))!;
    expect(p.attempts).toBeNull();
    expect(p.maxAttempts).toBeNull();
  });

  it("the settings: the week's count that did not arrive is unknown, not 0", () => {
    expect(coerceSettings({ ok: true, enabled: false, max_per_7d: 2, used_7d: 1, approved_waiting: 0, approval_ttl_hours: 72 })).toEqual({
      enabled: false,
      maxPer7d: 2,
      used7d: 1,
      approvedWaiting: 0,
      approvalTtlHours: 72,
    });
    expect(coerceSettings({ ok: true, enabled: true })).toEqual({ enabled: true, maxPer7d: null, used7d: null, approvedWaiting: null, approvalTtlHours: null });
    expect(coerceSettings({ ok: true, enabled: "yes" })).toBeNull();
    expect(coerceSettings({ ok: false, error: "mfa_required" })).toBeNull();
    expect(coerceSettings(null)).toBeNull();
    // the switch's state is never defaulted to off: no `enabled`, no settings
    expect(coerceSettings({ ok: true })).toBeNull();
  });

  const post = (over: Partial<MarketingPost>): MarketingPost => ({ ...coercePost(row())!, ...over });

  it("drafts and approvals come first, then the rest, each newest first", () => {
    const list = [
      post({ id: "a", status: "sent", createdAt: "2026-10-17T12:00:00Z" }),
      post({ id: "b", status: "draft", createdAt: "2026-10-10T12:00:00Z" }),
      post({ id: "c", status: "approved", createdAt: "2026-10-12T12:00:00Z" }),
      post({ id: "d", status: "rejected", createdAt: "2026-10-18T12:00:00Z" }),
    ];
    expect(sortPosts(list).map((p) => p.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("the last send is the most recent settled post, and none is 'none'", () => {
    expect(lastSettled([post({ status: "draft" }), post({ status: "approved" })])).toBeNull();
    const list = [
      post({ id: "old", status: "sent", sentAt: "2026-10-01T00:00:00Z" }),
      post({ id: "new", status: "dead", lastErrorCode: "unconfirmed", updatedAt: "2026-10-05T00:00:00Z" }),
    ];
    expect(lastSettled(list)?.id).toBe("new");
  });
});

describe("what the page says about a send", () => {
  const when = { sent: "today 10:00", next: "today 10:05" };
  const note = (status: MarketingPost["status"], code: string | null, posterOn = true) => sendNote(en, { status, lastErrorCode: code }, when, posterOn, "tomorrow 09:00");

  it("a post nobody can confirm says: check the channel, do not resend, in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const n = sendNote(dicts[loc], { status: "dead", lastErrorCode: "unconfirmed" }, when, true, "")!;
      expect(n.tone).toBe("fail");
      expect(n.lines[0]).toBe(dicts[loc].marketing.send.unconfirmed);
    }
    expect(note("dead", "unconfirmed")!.lines[0]).toMatch(/check the channel, do not resend/);
    expect(note("dead", "http_5xx")!.lines.join(" ")).toMatch(/do not resend/);
  });

  it("each failed code names its fix", () => {
    expect(note("failed", "blocked")!.lines.join(" ")).toMatch(/not an administrator/);
    expect(note("failed", "not_configured")!.lines.join(" ")).toMatch(/TELEGRAM_CHANNEL_BOT_TOKEN/);
    expect(note("failed", "bad_request")!.lines.join(" ")).toMatch(/MARKETING_TELEGRAM_CHAT/);
    for (const code of ["blocked", "bad_request", "not_configured", "rate_limited", "network", "http_5xx", "unconfirmed", "expired"]) {
      for (const loc of ["en", "ru", "uz"] as const) {
        expect((dicts[loc].marketing.fix as Record<string, string>)[code], `${loc}.fix.${code}`).toBeTruthy();
      }
    }
  });

  it("every closed code of the database has a fix (the list in 0108)", () => {
    const list = /last_error_code in\s*\(([^)]*)\)/.exec(sql)![1];
    const codes = [...list.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBe(8);
    for (const code of codes) expect((en.marketing.fix as Record<string, string>)[code], code).toBeTruthy();
  });

  it("a code this build does not know is named, never swallowed", () => {
    expect(fixText(en, "tomorrow_new_code")).toContain("tomorrow_new_code");
  });

  it("an approved post says whether it will go: the poster off means it will not", () => {
    expect(note("approved", null, false)!.lines[0]).toMatch(/poster is off/);
    expect(note("approved", null, true)!.lines[0]).toMatch(/worker sends it next/);
    expect(note("approved", "rate_limited", true)!.lines.join(" ")).toMatch(/try again by itself/);
  });

  it("sent, and a draft or a rejected post, are quiet or plain", () => {
    expect(note("sent", null)!.tone).toBe("ok");
    expect(note("draft", null)).toBeNull();
    expect(note("rejected", null)).toBeNull();
  });
});

describe("counting in the unit the limit uses, with the right plural", () => {
  it.each([
    [0, "many"], [1, "one"], [2, "few"], [3, "few"], [4, "few"], [5, "many"], [11, "many"], [12, "many"], [14, "many"],
    [21, "one"], [22, "few"], [25, "many"], [101, "one"], [111, "many"], [112, "many"], [122, "few"], [1000, "many"],
  ])("ru %i takes the %s form", (n, form) => {
    expect(pluralForm(n, "ru")).toBe(form);
  });

  it("ru words the count as 1 единица / 2 единицы / 5 единиц / 11 единиц, en as unit(s), uz does not inflect", () => {
    expect(unitCount(ru, "ru", 1)).toBe("1 единица");
    expect(unitCount(ru, "ru", 3)).toBe("3 единицы");
    expect(unitCount(ru, "ru", 5)).toBe("5 единиц");
    expect(unitCount(ru, "ru", 11)).toBe("11 единиц");
    expect(unitCount(ru, "ru", 21)).toBe("21 единица");
    expect(unitCount(en, "en", 1)).toBe("1 unit");
    expect(unitCount(en, "en", 2)).toBe("2 units");
    expect(unitCount(en, "en", 0)).toBe("0 units");
    expect(unitCount(uz, "uz", 1)).toBe("1 birlik");
    expect(unitCount(uz, "uz", 7)).toBe("7 birlik");
  });
});

describe("the wording that must not mislead", () => {
  it("uz never calls the 'outcome unknown' state 'Tasdiqlanmagan/Tasdiqlanmadi' (that reads as 'not approved')", () => {
    const m = uz.marketing;
    for (const text of [m.status.dead, m.lastSend.dead, m.send.unconfirmed, m.fix.unconfirmed, m.fix.http_5xx]) {
      expect(text).not.toMatch(/Tasdiqlanma(gan|di)/);
    }
    expect(m.status.dead).toBe("Holati aniqlanmadi");
    expect(m.send.unconfirmed).toMatch(/kanalni tekshiring, qayta yubormang/);
  });

  it("the unconfirmed state keeps its meaning in every language: look at the channel, do not resend", () => {
    expect(en.marketing.send.unconfirmed).toMatch(/check the channel, do not resend/);
    expect(ru.marketing.send.unconfirmed).toMatch(/проверьте канал, не отправляйте повторно/);
    expect(ru.marketing.status.dead).toBe("Исход неизвестен");
    expect(en.marketing.status.dead).toBe("Outcome unknown");
  });

  it("the channel-unknown line says 'not valid', not only 'not set'", () => {
    expect(en.marketing.poster.channelUnknown).toMatch(/not a valid @name/);
    expect(ru.marketing.poster.channelUnknown).toMatch(/корректным @именем/);
    expect(uz.marketing.poster.channelUnknown).toMatch(/yaroqli @nom/);
  });
});

describe("the words exist in en, ru and uz with the same keys and the same {fillers}", () => {
  const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  function leaves(node: unknown, path = ""): [string, string][] {
    if (typeof node === "string") return [[path, node]];
    if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
    return [];
  }
  const source = leaves(en.marketing);

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same fillers", (loc) => {
    const got = new Map(leaves(dicts[loc].marketing));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it("no ru or uz line is the English line (a pasted-over string)", () => {
    // "Post" is the Uzbek word as well
    const skip = new Set(["approve.dLang", "lastSend.source", "preview.perLang", "newPost.banned.found"]);
    for (const loc of ["ru", "uz"] as const) {
      const got = new Map(leaves(dicts[loc].marketing));
      for (const [key, text] of source) {
        if (skip.has(key) || /^\{\w+\}$/.test(text) || text.length < 12) continue;
        expect(got.get(key), `${loc}.${key}`).not.toBe(text);
      }
    }
  });

  it("the word typed to publish is short enough for a phone, in every language, and differs from nothing else typed", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const m = dicts[loc].marketing;
      expect(m.approve.word.length).toBeLessThanOrEqual(12);
      expect(m.poster.startWord.length).toBeLessThanOrEqual(12);
      expect(m.approve.word.length).toBeGreaterThan(2);
    }
  });

  it("the navigation names the page in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) expect(dicts[loc].nav.marketing, loc).toBeTruthy();
  });
});

describe("the new files hold no service key and no control that sends or tests", () => {
  const files = [
    "lib/marketing-posts.ts",
    "lib/marketing-text.ts",
    "lib/server/marketing.ts",
    "app/api/marketing/route.ts",
    "app/(app)/[channel]/marketing/page.tsx",
    "components/marketing/MarketingBoard.tsx",
    "components/marketing/NewPostPanel.tsx",
    "components/marketing/TelegramPreview.tsx",
    "lib/marketing-banned.ts",
  ];
  const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");

  it.each(files)("%s names no service key, no service-role client and no Telegram call", (f) => {
    const src = read(f);
    expect(src, f).not.toMatch(/SERVICE_KEY|SERVICE_ROLE|service_role|serviceKey|createServiceClient/i);
    expect(src, f).not.toMatch(/api\.telegram\.org|TELEGRAM_CHANNEL_BOT_TOKEN\s*[=:]|sendMessage|sendPhoto|sendVideo/);
  });

  it("the page's words offer no 'send now', 'test post', 'resend' or 'publish now' in any language", () => {
    const banned = /send now|test post|send test|resend|re-send|publish now|post now|отправить сейчас|тестовый пост|отправить тест|опубликовать сейчас|hozir yuborish|sinov post|test post/i;
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const [key, text] of (function walk(n: unknown, p = ""): [string, string][] {
        if (typeof n === "string") return [[p, n]];
        return n && typeof n === "object" ? Object.entries(n).flatMap(([k, v]) => walk(v, p ? `${p}.${k}` : k)) : [];
      })(dicts[loc].marketing)) {
        // "do not resend" is the warning itself
        const cleaned = text.replace(/do not resend|не отправляйте повторно|qayta yubormang/gi, "");
        expect(cleaned, `${loc}.${key}`).not.toMatch(banned);
      }
    }
  });

  it("the route and the board never name an action that sends", () => {
    const board = read("components/marketing/MarketingBoard.tsx") + read("components/marketing/NewPostPanel.tsx");
    const actions = [...board.matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(actions)).toEqual(new Set(["kill", "approve", "edit", "reject", "create"]));
  });

  it("every file in the new folders is one of the ones checked above", () => {
    const dir = join(__dirname, "..", "components", "marketing");
    const found = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
    expect(found.sort()).toEqual(["MarketingBoard.tsx", "NewPostPanel.tsx", "TelegramPreview.tsx"]);
  });
});

describe("a post this page version does not know is listed, never dropped and never approvable (slice 1 of the multichannel plan)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    kind: "news",
    status: "draft",
    texts: TEXTS,
    media_path: null,
    link: "/pricing",
    source_ref: "pr:#12",
    content_hash: HASH,
    created_at: "2026-10-17T10:00:00Z",
    updated_at: "2026-10-17T10:00:00Z",
    ...over,
  });
  const ID2 = "22222222-2222-3333-4444-555555555555";

  it("an unknown kind is an Other row with a sanitized code, its status and its age, not a failed read", () => {
    const p = coerceListedPost(row({ kind: "banner", target: "instagram", delivery: "manual", payload: { hashtags: ["a"] }, brand_new: 1 }));
    expect(p && isOtherPost(p)).toBe(true);
    expect(p).toMatchObject({ other: true, id: ID, status: "draft", reason: "kind", kindCode: "banner", targetCode: "instagram", deliveryCode: "manual", createdAt: "2026-10-17T10:00:00Z" });
  });

  it("the code is [a-z_]{1,24}, anything else is 'unknown': markup, case, a long word, digits, a non-string", () => {
    for (const kind of ["<script>alert(1)</script>", "Promo", "a-b", "x".repeat(25), "p2", "", "  promo", 7, null, { a: 1 }]) {
      expect(safeCode(kind), JSON.stringify(kind)).toBe("unknown");
      const p = coerceListedPost(row({ kind }));
      expect(p, JSON.stringify(kind)).toMatchObject({ other: true, kindCode: "unknown" });
    }
    expect(safeCode("x".repeat(24))).toBe("x".repeat(24));
    expect(safeCode("custom_post")).toBe("custom_post");
  });

  it("a known kind on another target, or with another delivery, is also Other (it is never approved as a Telegram post)", () => {
    expect(coerceListedPost(row({ target: "youtube" }))).toMatchObject({ other: true, reason: "target", kindCode: "news", targetCode: "youtube" });
    expect(coerceListedPost(row({ delivery: "manual" }))).toMatchObject({ other: true, reason: "delivery", deliveryCode: "manual" });
    expect(coerceListedPost(row({ target: "telegram", delivery: "auto" }))).not.toHaveProperty("other");
    // coercePost itself stays the strict reader of the Telegram path
    expect(coercePost(row({ target: "instagram" }))).toBeNull();
    expect(coercePost(row({ delivery: "manual" }))).toBeNull();
  });

  it("a row without target, delivery or payload is the Telegram path of today, byte for byte", () => {
    const plain = coerceListedPost(row());
    expect(plain).toEqual(coercePost(row()));
    expect(plain && isOtherPost(plain)).toBe(false);
    // extra fields on a known row are ignored, not a failure
    expect(coercePost(row({ target: "telegram", delivery: "auto", payload: { x: 1 }, future: [1, 2] }))).toMatchObject({ id: ID, kind: "news" });
  });

  it("its words are kept only if they have the known three-language shape", () => {
    expect(coerceListedPost(row({ kind: "banner" }))).toMatchObject({ texts: TEXTS });
    for (const texts of [{ uz: "a", ru: "b" }, { uz: "a", ru: "", en: "c" }, "x", null, { uz: "a", ru: "b", en: "x".repeat(1001) }, { uz: 1, ru: "b", en: "c" }]) {
      expect(coerceListedPost(row({ kind: "banner", texts })), JSON.stringify(texts)).toMatchObject({ other: true, texts: null });
    }
    // extra languages are ignored, not copied
    const extra = coerceListedPost(row({ kind: "banner", texts: { ...TEXTS, de: "Hallo" } }));
    expect(extra && isOtherPost(extra) && extra.texts).toEqual(TEXTS);
  });

  it("only a uuid and a known status are required of an Other row; a missing hash, source or texts do not fail the read", () => {
    expect(coerceListedPost({ id: ID, kind: "banner", status: "approved" })).toMatchObject({ other: true, texts: null, sourceRef: null });
    expect(coerceListedPost({ id: "nope", kind: "banner", status: "draft" })).toBeNull();
    expect(coerceListedPost({ id: ID, kind: "banner", status: "teleported" })).toBeNull();
    expect(coerceListedPost(null)).toBeNull();
    expect(coerceListedPost([])).toBeNull();
  });

  it("an unknown error code is shown as the closed code it is, or 'unknown'", () => {
    expect(coerceListedPost(row({ kind: "banner", last_error_code: "token_expired" }))).toMatchObject({ lastErrorCode: "token_expired" });
    expect(coerceListedPost(row({ kind: "banner", last_error_code: "http_5xx" }))).toMatchObject({ lastErrorCode: "http_5xx" });
    expect(coerceListedPost(row({ kind: "banner", last_error_code: "sk-abc Secret words" }))).toMatchObject({ lastErrorCode: "unknown" });
    expect(coerceListedPost(row({ kind: "banner", last_error_code: null }))).toMatchObject({ lastErrorCode: null });
    expect(fixText(en, "token_expired")).toContain("token_expired");
    expect(fixText(en, "<b>x</b> Secret")).toContain("(unknown)");
    expect(fixText(en, "<b>x</b> Secret")).not.toContain("Secret");
    expect(marketingRefusalText(en, { ok: false, error: "A very Secret sentence" })).toContain("unknown");
    expect(marketingRefusalText(en, { ok: false, error: "A very Secret sentence" })).not.toContain("Secret");
    expect(marketingRefusalText(en, { ok: false, error: "target_off" })).toContain("target_off");
    expect(marketingRefusalText(en, {})).toContain("?");
  });

  it("a mixed list keeps the known posts and the unknown ones, in one list, in order", () => {
    const list = coercePosts([row(), row({ id: ID2, kind: "banner", target: "instagram", created_at: "2026-10-18T08:00:00Z" })]);
    expect(list).toHaveLength(2);
    expect(list!.map((p) => isOtherPost(p))).toEqual([false, true]);
    // the same sorting and 'last send' rules apply to both
    const sorted = sortPosts(list!);
    expect(sorted.map((p) => p.id)).toEqual([ID2, ID]);
    const settled = coercePosts([row({ status: "sent", sent_at: "2026-10-17T11:00:00Z" }), row({ id: ID2, kind: "banner", status: "sent", sent_at: "2026-10-18T11:00:00Z" })])!;
    expect(lastSettled(settled)!.id).toBe(ID2);
    // a row that is unreadable even as Other still fails the whole list (it is never silently dropped)
    expect(coercePosts([row(), row({ id: ID2, kind: "banner", status: "?" })])).toBeNull();
    expect(coercePosts([row(), row({ status: "?" })])).toBeNull();
  });

  it("the page does not select columns that do not exist yet (delivery, payload come with a later migration)", () => {
    const cols = POST_COLUMNS.split(",");
    expect(cols).toContain("target");
    expect(cols).not.toContain("delivery");
    expect(cols).not.toContain("payload");
  });

  it("POST_STATUSES is the status CHECK list of migration 0108, word for word", () => {
    const m = /add constraint marketing_posts_status_check\s+check \(status in \(([^)]*)\)\)/.exec(sql);
    expect(m, "the status CHECK of 0108 was not found: the regex needs updating").not.toBeNull();
    const inSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(inSql.length).toBeGreaterThan(0);
    expect([...inSql].sort()).toEqual([...POST_STATUSES].sort());
  });

  it("extra fields in the settings document are ignored", () => {
    expect(coerceSettings({ ok: true, enabled: true, max_per_7d: 2, used_7d: 1, targets: [{ target: "instagram" }], future: { a: 1 } })).toMatchObject({ enabled: true, maxPer7d: 2, used7d: 1 });
  });
});
