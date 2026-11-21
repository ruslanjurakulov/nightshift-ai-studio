/**
 * What /api/agent/run said, in words (lib/run-answer.ts): every failure says
 * whether credits were taken or held, in all three languages, and the
 * answers that settle a key are exactly the ones where a hold was taken.
 */
import { describe, expect, it } from "vitest";
import { dictionaries, type Locale } from "@/lib/i18n";
import { readRunAnswer, unsureRunAnswer } from "@/lib/run-answer";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const read = (status: number, data: Record<string, unknown>, locale: Locale = "en", earlierUnsure = false) =>
  readRunAnswer({ ok: status >= 200 && status < 300, status }, data, dictionaries[locale], locale, earlierUnsure);
const failed = (status: number, data: Record<string, unknown>, locale: Locale = "en", earlierUnsure = false) => {
  const a = read(status, data, locale, earlierUnsure);
  if (a.outcome !== "failed") throw new Error(`expected a failure, got ${a.outcome}`);
  return a;
};

describe("readRunAnswer", () => {
  it("200 is a start, and 409 run_already_started is a replay (shown as started, not as a failure)", () => {
    expect(read(200, { ok: true }).outcome).toBe("started");
    expect(read(409, { error: "run_already_started" }).outcome).toBe("replay");
    // Only the 409 is a replay; the same code on another status is not trusted as one.
    expect(read(500, { error: "run_already_started" }).outcome).toBe("failed");
  });

  it("409 price_changed names the new price, says nothing was taken or held, and does not settle the key", () => {
    const a = failed(409, { error: "price_changed", credits: 150 });
    expect(a.priceChanged).toBe(true);
    expect(a.settled).toBe(false);
    expect(a.message).toContain("150");
    expect(a.message).toContain(dictionaries.en.create.flow.notTaken);
    // A body without the figure still says it.
    expect(failed(409, { error: "price_changed" }).message).toBe(dictionaries.en.create.flow.priceChangedShort);
  });

  it("409 price_changed after an earlier try that may have held (no usable answer) does NOT claim nothing was held: the route compares the price before it looks for the hold", () => {
    const a = failed(409, { error: "price_changed", credits: 150 }, "en", true);
    expect(a.priceChanged).toBe(true);
    expect(a.unsure).toBe(true);
    expect(a.settled).toBe(false);
    expect(a.message).toContain("150");
    expect(a.message).not.toContain(dictionaries.en.create.flow.notTaken);
    expect(a.message).toBe(dictionaries.en.create.flow.priceChangedUnsure.replace("{n}", "150"));
    // Without the figure it falls back to the plain cannot-tell sentence.
    expect(failed(409, { error: "price_changed" }, "en", true).message).toBe(dictionaries.en.create.flow.startUnsure);
  });

  it("'no credits were taken or held' is said only when the body proves no hold: a price_changed that does carry credits_held gets the held sentence", () => {
    const proven = failed(409, { error: "price_changed", credits: 150 });
    expect(proven.message).toContain(dictionaries.en.create.flow.notTaken);
    expect(proven.unsure).toBe(false);
    const held = failed(409, { error: "price_changed", credits: 150, credits_held: 120 });
    expect(held.message).toBe(dictionaries.en.create.flow.startHeld.replace("{n}", "120"));
    expect(held.message).not.toContain(dictionaries.en.create.flow.notTaken);
    expect(held.settled).toBe(true);
    // Even with an earlier unsure try, a body that proves the hold wins.
    expect(failed(409, { error: "price_changed", credits: 150, credits_held: 120 }, "en", true).message).toBe(held.message);
  });

  it("a replay after an unsure try is NOT a start: the honest 'a hold exists, it may or may not have started'", () => {
    const a = failed(409, { error: "run_already_started" }, "en", true);
    expect(a.message).toBe(dictionaries.en.create.flow.startUnsureReplay);
    expect(a.unsure).toBe(true);
    expect(a.settled).toBe(false);
    expect(a.blockedCredits).toBeNull();
    // Without an earlier unsure try it is the start it always was.
    expect(read(409, { error: "run_already_started" }).outcome).toBe("replay");
  });

  it("402 insufficient credits keeps the figures and says no credits were taken or held", () => {
    const a = failed(402, { error: "insufficient_credits", needed: 120, available: 20 });
    expect(a.message).toContain("120");
    expect(a.message).toContain("20");
    expect(a.message).toContain(dictionaries.en.create.flow.notTaken);
    expect(a.settled).toBe(false);
  });

  it("429 run_limit says how many run at once and that nothing was taken or held", () => {
    const a = failed(429, { error: "run_limit", active: 2, limit: 2 });
    expect(a.message).toContain("2");
    expect(a.message).toContain(dictionaries.en.create.flow.notTaken);
    expect(a.settled).toBe(false);
  });

  it("a hold taken but the run not started says how many credits are held and that they come back; the key is settled", () => {
    const a = failed(502, { error: "github_dispatch_failed", credits_held: 120 });
    expect(a.settled).toBe(true);
    expect(a.message).toContain("120");
    expect(a.message).toContain("3 hours");
    expect(a.message).not.toContain(dictionaries.en.create.flow.notTaken);
    // The same for a queue insert that failed after the hold.
    expect(failed(502, { error: "queue_insert_failed", credits_held: 80 }).settled).toBe(true);
  });

  it("a generic failure with no hold says nothing was taken or held, and keeps the key", () => {
    for (const [status, error] of [
      [502, "credit_reserve_failed"],
      [403, "github_unauthorized"],
      [503, "credits_unavailable"],
    ] as const) {
      const a = failed(status, { error });
      expect(a.message).toContain(dictionaries.en.create.flow.notTaken);
      expect(a.settled).toBe(false);
      expect(a.priceChanged).toBe(false);
    }
    expect(failed(403, { error: "github_unauthorized" }).message).toContain(dictionaries.en.agents.runUnauthorized);
  });

  it("credits_read_failed already says nothing was put on hold, so it is not said twice", () => {
    const a = failed(503, { error: "credits_read_failed" });
    expect(a.message).toBe(dictionaries.en.credits.readFailedRun);
  });

  it("a gateway error with no body (or a dropped connection) says it cannot tell whether it started", () => {
    expect(failed(504, {}).message).toBe(dictionaries.en.create.flow.startUnsure);
    expect(failed(504, {}).unsure).toBe(true);
    expect(unsureRunAnswer(dictionaries.en).message).toBe(dictionaries.en.create.flow.startUnsure);
    expect(unsureRunAnswer(dictionaries.en).settled).toBe(false);
    expect(unsureRunAnswer(dictionaries.en).unsure).toBe(true);
  });

  it("the extra-credits-off refusal still carries its flag so the link is shown", () => {
    expect(failed(402, { error: "insufficient_credits", needed: 120, available: 10, extra_off: true, extra: 500 }).extraOff).toBe(true);
    expect(failed(402, { error: "insufficient_credits", needed: 120, available: 10 }).extraOff).toBe(false);
  });
});

describe("a start that failed after the hold (lib/server/run-start.ts)", () => {
  const f = dictionaries.en.create.flow;

  it("start_unsure: the key is kept (not settled), the attempt is unsure, nothing is blocked, and it says it may have started with the amount held", () => {
    const a = failed(502, { error: "start_unsure", reason: "github_dispatch_failed", credits_held: 120 });
    expect(a.unsure).toBe(true);
    expect(a.settled).toBe(false);
    expect(a.blockedCredits).toBeNull();
    expect(a.message).toBe(f.startUnsureHeld.replace("{n}", "120"));
    expect(a.message).toContain("may have started");
    expect(a.message).toContain("about 3 hours");
    // Without an amount it is the plain cannot-tell sentence; it never says 'nothing was taken'.
    expect(failed(502, { error: "start_unsure", reason: "x" }).message).toBe(f.startUnsure);
    expect(a.message).not.toContain(f.notTaken);
  });

  it("start_failed with credits still held: not settled (no new key), blocked with the amount, and it says they return in about 3 hours", () => {
    const a = failed(502, { error: "start_failed", reason: "github_unauthorized", credits_held: 120, retry_with_new_key: true });
    expect(a.settled).toBe(false);
    expect(a.blockedCredits).toBe(120);
    expect(a.unsure).toBe(false);
    expect(a.message).toBe(f.startFailedHeld.replace("{n}", "120"));
    expect(a.message).toContain("about 3 hours");
  });

  it("start_failed with a hold of unknown size (true, or 0) is blocked too, with the short sentence", () => {
    for (const held of [true, 0]) {
      const a = failed(502, { error: "start_failed", reason: "x", credits_held: held, retry_with_new_key: true });
      expect(a.blockedCredits, String(held)).toBe(0);
      expect(a.settled).toBe(false);
      expect(a.message).toBe(f.startFailedHeldShort);
    }
  });

  it("only retry_with_new_key together with credits_held:false (released) rotates to a new key", () => {
    const released = failed(502, { error: "start_failed", reason: "x", credits_held: false, retry_with_new_key: true });
    expect(released.settled).toBe(true);
    expect(released.blockedCredits).toBeNull();
    expect(released.message).toBe(f.startFailedReleased);
    // Released but not told to rotate: no new key, and a replay must read as unsure rather than started.
    const noFlag = failed(502, { error: "start_failed", reason: "x", credits_held: false });
    expect(noFlag.settled).toBe(false);
    expect(noFlag.unsure).toBe(true);
    // The flag alone, with the hold still held, never rotates.
    expect(failed(502, { error: "start_failed", credits_held: 120, retry_with_new_key: true }).settled).toBe(false);
  });

  it("is read before the older numeric credits_held, which still rotates the key as it did", () => {
    const old = failed(502, { error: "github_dispatch_failed", credits_held: 120 });
    expect(old.settled).toBe(true);
    expect(old.message).toBe(f.startHeld.replace("{n}", "120"));
    expect(failed(502, { error: "start_failed", credits_held: 120 }).settled).toBe(false);
    expect(failed(502, { error: "start_unsure", credits_held: 120 }).settled).toBe(false);
  });

  it("the honest sentences exist in en, ru and uz with the amount filled in (colon form in Russian)", () => {
    for (const locale of LOCALES) {
      for (const data of [
        { error: "start_unsure", credits_held: 120 },
        { error: "start_failed", credits_held: 120, retry_with_new_key: true },
        { error: "start_failed", credits_held: true, retry_with_new_key: true },
        { error: "start_failed", credits_held: false, retry_with_new_key: true },
      ]) {
        const m = failed(502, data, locale).message;
        expect(m, `${locale} ${JSON.stringify(data)}`).not.toMatch(/[{}]/);
        if (!("credits_held" in data && data.credits_held === false)) expect(m).toContain("3");
        if (locale !== "en") expect(m).not.toBe(failed(502, data, "en").message);
      }
      expect(failed(409, { error: "run_already_started" }, locale, true).message).toBe(dictionaries[locale].create.flow.startUnsureReplay);
    }
    const ru = dictionaries.ru.create.flow;
    for (const k of ["startUnsureHeld", "startFailedHeld"] as const) {
      expect(ru[k]).toMatch(/[Кк]редитов[^.]*: \{n\}/);
      expect(ru[k]).not.toMatch(/\{n\}\s+кредит/);
    }
  });
});

describe("the new sentences exist in every language and are filled in", () => {
  it("each answer reads as a finished sentence in en, ru and uz (no braces left, not the English text)", () => {
    const answers: [number, Record<string, unknown>][] = [
      [409, { error: "price_changed", credits: 150 }],
      [409, { error: "price_changed" }],
      [409, { error: "price_changed", credits: 150, unsureCase: true }],
      [402, { error: "insufficient_credits", needed: 120, available: 20 }],
      [429, { error: "run_limit", active: 2, limit: 2 }],
      [502, { error: "github_dispatch_failed", credits_held: 120 }],
      [502, { error: "credit_reserve_failed" }],
      [504, {}],
    ];
    for (const locale of LOCALES) {
      for (const [status, data] of answers) {
        const unsureCase = "unsureCase" in data;
        const msg = failed(status, data, locale, unsureCase).message;
        expect(msg, `${locale} ${status} ${JSON.stringify(data)}`).not.toMatch(/[{}]/);
        expect(msg.length).toBeGreaterThan(10);
        if (locale !== "en") expect(msg).not.toBe(failed(status, data, "en", unsureCase).message);
      }
      const f = dictionaries[locale].create.flow;
      for (const k of ["alreadySent", "priceChanged", "priceChangedShort", "priceChangedUnsure", "notTaken", "startHeld", "startUnsure"] as const) {
        expect(f[k].length).toBeGreaterThan(10);
        if (locale !== "en") expect(f[k]).not.toBe(dictionaries.en.create.flow[k]);
      }
    }
  });

  it("the Russian credit sentences use the colon form, never a fixed plural after the number (1, 2-4, 5+ and decimals all read right)", () => {
    const ru = dictionaries.ru.create.flow;
    for (const k of ["priceChanged", "priceChangedUnsure", "startHeld"] as const) {
      expect(ru[k], k).toContain("кредитов:");
      expect(ru[k], k).not.toMatch(/\{n\}\s+кредит/);
    }
  });

  it("the hold and the expiry are described with the real number: about 3 hours (migration 0020, expire_credit_reservations)", () => {
    for (const locale of LOCALES) {
      const f = dictionaries[locale].create.flow;
      expect(f.startHeld).toContain("3");
      expect(f.alreadySent).toContain("3");
    }
    // Age threshold, not a promise to the minute: "about".
    expect(dictionaries.en.create.flow.startHeld).toContain("about 3 hours");
    expect(dictionaries.en.create.flow.alreadySent).toContain("about 3 hours");
    for (const f of [dictionaries.ru.create.flow, dictionaries.uz.create.flow]) {
      expect(f.startHeld).not.toMatch(/в течение 3|3 soat ichida/);
    }
  });
});
