// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilmCreateButton } from "../components/studio-timeline/FilmCreateButton";
import { coerceQuote, type FilmQuote } from "../lib/studio/timeline";
import { FILM_ERRORS } from "../lib/films";
import { START_REMEDIES, startReasonText, startRemedy, type ReasonDictionaries } from "../lib/studio/useFilmStart";
import { studioTimelineEn as c } from "../lib/i18n/studio-timeline/en";
import { studioTimelineRu } from "../lib/i18n/studio-timeline/ru";
import { studioTimelineUz } from "../lib/i18n/studio-timeline/uz";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { filmStudioStrings } from "../lib/i18n/film-studio";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, fmt, locale: "en" }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/synthetic-channel${p}` }));

const k = c.create;
const QID = (v: number, ch: string) => `fq-${v}-${ch.repeat(32)}`;
function q(over: Record<string, unknown> = {}): FilmQuote {
  const raw = { priced: true, total: 16, quote_id: QID(3, "b"), startable: true, may_start: true, blocked_by: [], refusals: [], assembly_minutes: 8, available: 100, exempt: false, ...over };
  const out = coerceQuote(raw);
  if (!out) throw new Error("fixture is not a quote");
  return out;
}

type StartAnswer = Record<string, unknown> | "offline" | "pending" | { status: number; body: unknown };
let starts: { quote_id: string; idem: string }[];
let answers: StartAnswer[];
const started = vi.fn();

beforeEach(() => {
  starts = [];
  answers = [];
  started.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/films/synthetic/start") {
        starts.push(JSON.parse(String(init?.body)));
        const a = answers.shift() ?? { ok: true, replayed: false };
        if (a === "offline") throw new TypeError("Synthetic offline response failure");
        if (a === "pending") return new Promise<Response>(() => {});
        if ("status" in a && typeof a.status === "number") return new Response(JSON.stringify(a.body), { status: a.status });
        return new Response(JSON.stringify({ start: a }));
      }
      throw new Error(`Unexpected request in local mock: ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(quote: FilmQuote | null, requote?: () => Promise<FilmQuote | null>) {
  render(<FilmCreateButton filmId="synthetic" quote={quote} onStarted={started} requote={requote} />);
  return screen.getByTestId("film-create-key") as HTMLButtonElement;
}
const note = () => screen.queryByTestId("film-create-note")?.textContent ?? "";

/** Press the key, then the confirmation's own Confirm. */
async function pressAndConfirm(key: HTMLButtonElement) {
  fireEvent.click(key);
  fireEvent.click(await screen.findByTestId("film-create-confirm-key"));
}

describe("FilmCreateButton", () => {
  it("keeps the idempotency key across a network-error retry and mints a new one after a refusal", async () => {
    answers = ["offline", { ok: false, reason: "run_slots_full" }];
    const requote = vi.fn(async () => q({ quote_id: QID(3, "c") }));
    const key = mount(q(), requote);
    await pressAndConfirm(key);
    await waitFor(() => expect(note()).toBe(c.startNoAnswer));
    // No answer is not a refusal: the start may have gone through, so the retry must replay it under the same key.
    expect(key.textContent).toBe(c.retry);
    fireEvent.click(key);
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.run_slots_full));
    expect(starts).toHaveLength(2);
    expect(starts[1].idem).toBe(starts[0].idem);
    expect(starts[1].quote_id).toBe(starts[0].quote_id);
    // A refusal is terminal: the next press gets a new price and a new key, never the spent pair (idempotency_conflict).
    expect(key.textContent).toBe(k.getNewPrice);
    fireEvent.click(key);
    await pressConfirmAfterRequote();
    await waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2].idem).not.toBe(starts[0].idem);
    expect(starts[2].quote_id).toBe(QID(3, "c"));
    await waitFor(() => expect(started).toHaveBeenCalledWith({ replayed: false }));
  });

  it("re-quotes after price_changed and starts only after a fresh confirm that shows the old total and the change", async () => {
    answers = [{ ok: false, reason: "price_changed" }, { ok: true, replayed: false }];
    const requote = vi.fn(async () => q({ total: 20, quote_id: QID(4, "d") }));
    const key = mount(q(), requote);
    await pressAndConfirm(key);
    const change = await screen.findByTestId("film-create-change");
    expect(requote).toHaveBeenCalledTimes(1);
    expect(change.textContent).toBe("The price changed from 16 to 20 credits: 4 more.");
    expect(screen.getByTestId("film-create-confirm-key").textContent).toBe("Hold 20 credits and start");
    // The new total is not started on the old confirmation.
    expect(starts).toHaveLength(1);
    fireEvent.click(screen.getByTestId("film-create-confirm-key"));
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1].quote_id).toBe(QID(4, "d"));
    expect(starts[1].idem).not.toBe(starts[0].idem);
  });

  it("says a lower re-quoted price as a drop, and quote_expired re-quotes the same way", async () => {
    answers = [{ ok: false, reason: "quote_expired" }];
    const key = mount(q(), async () => q({ total: 10, quote_id: QID(3, "e") }));
    await pressAndConfirm(key);
    expect((await screen.findByTestId("film-create-change")).textContent).toBe("The price changed from 16 to 10 credits: 6 less.");
  });

  it("an unpriced line shows its own reason, never 'pricing is not live', and every blocked reason is listed", () => {
    const key = mount(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "model_not_set" }], blocked_by: [{ reason: "run_slots_full" }, { reason: "limit_reached" }] }));
    expect(key.disabled).toBe(true);
    const items = [...screen.getByTestId("film-create-reasons").querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([c.blocked.run_slots_full, c.blocked.limit_reached, k.unpriced.model_not_set]);
    expect(note()).not.toContain(c.noPrice);
    expect(key.getAttribute("aria-describedby")).toBe(screen.getByTestId("film-create-note").id);
  });

  it("a model that is down is said as unavailable, not substituted, and its unknown name is not guessed", () => {
    mount(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "model_not_available" }] }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(k.providerDown);
    expect(alert.textContent).toContain(`Model: ${c.unknown}.`);
  });

  it("a balance the quote did not read is said as unknown, never 0", () => {
    mount(q({ startable: false, available: null, blocked_by: [{ reason: "insufficient_credits" }] }));
    expect(screen.getByRole("alert").textContent).toContain(k.balanceUnknown);
  });

  it("short of credits: the key carries no number, the quote's price and balance are context, and Add credits links to billing", () => {
    const key = mount(q({ startable: false, available: 5, blocked_by: [{ reason: "insufficient_credits", available: 5, needed: 16 }] }));
    expect(key.disabled).toBe(true);
    expect(key.textContent).toBe(k.create);
    const box = screen.getByRole("alert");
    expect(box.textContent).toContain("Price: 16 credits, the server's quote.");
    expect(box.textContent).toContain("Balance: 5 credits.");
    expect(screen.getByRole("link", { name: c.addCredits }).getAttribute("href")).toBe("/synthetic-channel/billing");
    // One line at 360 px, and disabled looks disabled (Pixel, S5 benchmark).
    expect(key.className).toContain("whitespace-nowrap");
    expect(key.className).toContain("disabled:opacity-45");
  });

  it("a start refused for credits shows the link and lets the person get a new price after adding them", async () => {
    answers = [{ ok: false, reason: "insufficient_credits" }];
    const key = mount(q());
    await pressAndConfirm(key);
    await waitFor(() => expect(screen.getByRole("link", { name: c.addCredits }).getAttribute("href")).toBe("/synthetic-channel/billing"));
    // The refused quote's own numbers: nothing is re-computed in the browser.
    expect(screen.getByRole("alert").textContent).toContain("Price: 16 credits, the server's quote.");
    expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.insufficient_credits);
    expect(key.disabled).toBe(false);
    expect(key.textContent).toBe(k.getNewPrice);
  });

  it("a double click on Confirm and a held Enter send one request", async () => {
    answers = ["pending"];
    const key = mount(q());
    expect(fireEvent.keyDown(key, { key: "Enter", repeat: true })).toBe(false);
    fireEvent.click(key);
    fireEvent.click(key);
    const confirm = await screen.findByTestId("film-create-confirm-key");
    // Focus starts on Cancel, so the Enter that opened the confirmation cannot also confirm it.
    expect(document.activeElement).toBe(screen.getByTestId("film-create-cancel"));
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(starts).toHaveLength(1);
    expect(key.getAttribute("aria-busy")).toBe("true");
    expect(key.disabled).toBe(true);
    fireEvent.click(key);
    expect(starts).toHaveLength(1);
  });

  it("shows no number at all when the total is null, or when there is no quote", () => {
    const key = mount(q({ priced: true, total: null }));
    expect(key.textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("film-create").textContent).not.toMatch(/\d/);
    cleanup();
    const none = mount(null);
    expect(none.textContent).not.toMatch(/\d/);
    expect(note()).toContain(k.noQuote);
  });

  it("a 401 from the start route is a session that ended: sign in, nothing lost", async () => {
    answers = [{ status: 401, body: { error: "unauthorized" } }];
    const key = mount(q());
    await pressAndConfirm(key);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(k.sessionExpired));
    expect(screen.getByRole("link", { name: k.signIn }).getAttribute("href")).toBe("/login");
    // Signing in elsewhere and pressing again resumes the same press: same quote, same key.
    expect(key.textContent).toBe(c.retry);
    fireEvent.click(key);
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1].idem).toBe(starts[0].idem);
  });

  it("an unknown refusal word still names a way out: a new price and support", async () => {
    answers = [{ ok: false, reason: "never_heard_of_it" }];
    const key = mount(q());
    await pressAndConfirm(key);
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.other));
    expect(screen.getByTestId("film-create-support")).toBeTruthy();
    expect(key.textContent).toBe(k.getNewPrice);
  });

  it("says 'Still working…' after 10 seconds with no answer", () => {
    vi.useFakeTimers();
    answers = ["pending"];
    const key = mount(q());
    fireEvent.click(key);
    fireEvent.click(screen.getByTestId("film-create-confirm-key"));
    expect(note()).toBe("");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(note()).toBe(k.stillWorking);
  });
});

async function pressConfirmAfterRequote() {
  fireEvent.click(await screen.findByTestId("film-create-confirm-key"));
}

// ─── every word the start can answer has its own sentence and remedy ─────────

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
/** The functions whose words reach the start route's answer: start_film itself, what it re-prices with, and what that raises. */
const FUNCTIONS = ["start_film", "quote_film", "film_price", "film_precheck", "film_model_problem", "film_try_price", "film_check_model", "creative_price"];
/** Keys of a jsonb_build_object that the 'reason', '<word>' pattern also catches (`'reason', bad ->> 'reason', 'code', …`). */
const NOT_WORDS = new Set(["code", "detail", "surface"]);

function wordsTheStartCanAnswer(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const words = new Set<string>(["run_slots_full"]); // start_film's `case w when 'NS429' then 'run_slots_full'`
  for (const fn of FUNCTIONS) {
    let last: string | null = null;
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      const re = new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\n\\$\\$;`, "g");
      for (const m of sql.matchAll(re)) last = m[0];
    }
    expect(last, `no migration defines ${fn}`).not.toBeNull();
    for (const m of last!.matchAll(/'reason',\s*'([a-z_]+)'/g)) if (!NOT_WORDS.has(m[1])) words.add(m[1]);
    for (const m of last!.matchAll(/creative_refuse\('([a-z_]+)'/g)) words.add(m[1]);
  }
  for (const e of FILM_ERRORS) words.add(e);
  return [...words].sort();
}

const LOCALES: [string, ReasonDictionaries][] = [
  ["en", { create: c.create, startFailed: c.startFailed, creativeErrors: en.creative.errors, filmErrors: filmStudioStrings("en").errors }],
  ["ru", { create: studioTimelineRu.create, startFailed: studioTimelineRu.startFailed, creativeErrors: ru.creative.errors, filmErrors: filmStudioStrings("ru").errors }],
  ["uz", { create: studioTimelineUz.create, startFailed: studioTimelineUz.startFailed, creativeErrors: uz.creative.errors, filmErrors: filmStudioStrings("uz").errors }],
];

describe("start refusal words", () => {
  const words = wordsTheStartCanAnswer();

  it("finds the words in the migrations (the extraction itself works)", () => {
    for (const w of ["insufficient_credits", "price_changed", "quote_expired", "hold_refused", "idempotency_conflict", "film_not_startable", "model_not_set", "acknowledgement_required"]) {
      expect(words).toContain(w);
    }
  });

  it.each(LOCALES)("every word has its own remedy and a %s sentence that is not the generic one", (_l, d) => {
    const missing = words.filter((w) => !Object.prototype.hasOwnProperty.call(START_REMEDIES, w) || startReasonText(w, d) === null || startReasonText(w, d) === d.startFailed.other);
    expect(missing).toEqual([]);
  });

  it("an unknown word gets no sentence of its own and the support remedy", () => {
    expect(startReasonText("never_heard_of_it", LOCALES[0][1])).toBeNull();
    expect(startRemedy("never_heard_of_it")).toBe("support");
    expect(startRemedy("constructor")).toBe("support");
  });
});
