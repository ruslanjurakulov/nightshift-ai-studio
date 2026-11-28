// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilmCreateButton } from "../components/studio-timeline/FilmCreateButton";
import { coerceQuote, type FilmQuote } from "../lib/studio/timeline";
import { FILM_ERRORS } from "../lib/films";
import { START_REMEDIES, blockRemedy, startReasonText, startRemedy, type ReasonDictionaries } from "../lib/studio/useFilmStart";
import { studioTimelineEn as c } from "../lib/i18n/studio-timeline/en";
import { studioTimelineRu } from "../lib/i18n/studio-timeline/ru";
import { studioTimelineUz } from "../lib/i18n/studio-timeline/uz";

let locale = "en";
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { ru } = await import("../lib/i18n/ru");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: locale === "ru" ? ru : en, fmt, locale }) };
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
const raw = (body: string, status: number, headers: Record<string, string> = {}) => ({ raw: body, status, headers });
type Answer = Record<string, unknown> | "offline" | "pending" | { status: number; body: unknown; headers?: Record<string, string> } | ReturnType<typeof raw>;
let starts: { quote_id: string; idem: string; url: string }[];
let answers: Answer[];
/** The default re-quote's two calls: the project read, then the quote. */
let filmRead: Answer;
let quoteAnswers: Answer[];
let quoteBodies: unknown[];
let pendingStarts: ((r: Response) => void)[];
const started = vi.fn();

function respond(a: Answer, wrap: (x: unknown) => unknown): Promise<Response> {
  if (a === "offline") return Promise.reject(new TypeError("Synthetic offline response failure"));
  if (a === "pending") return new Promise<Response>((r) => pendingStarts.push(r));
  if ("raw" in a && typeof a.raw === "string") return Promise.resolve(new Response(a.raw, { status: a.status as number, headers: a.headers as Record<string, string> }));
  if ("status" in a && typeof a.status === "number") return Promise.resolve(new Response(JSON.stringify((a as { body: unknown }).body), { status: a.status, headers: (a.headers ?? {}) as Record<string, string> }));
  return Promise.resolve(new Response(JSON.stringify(wrap(a))));
}

beforeEach(() => {
  locale = "en";
  starts = [];
  answers = [];
  quoteAnswers = [];
  quoteBodies = [];
  pendingStarts = [];
  filmRead = { status: 200, body: null };
  started.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const m = /^\/api\/films\/([a-z-]+)\/(start|quote)$/.exec(url);
      if (m && m[2] === "start") {
        starts.push({ ...JSON.parse(String(init?.body)), url });
        return respond(answers.shift() ?? { ok: true, replayed: false }, (x) => ({ start: x }));
      }
      if (m && m[2] === "quote") {
        quoteBodies.push(JSON.parse(String(init?.body)));
        return respond(quoteAnswers.shift() ?? { status: 500, body: { error: "failed" } }, (x) => ({ quote: x }));
      }
      if (url === "/api/films/synthetic") return respond(filmRead, (x) => x);
      throw new Error(`Unexpected request in local mock: ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The default re-quote reads the project through filmsApi; a real FilmView is large, so a read that succeeds is stood in for here
// (its version is all the re-quote uses) and a read that fails goes through the real client, so its HTTP mapping is the real one.
let filmReadOk: boolean;
vi.mock("@/lib/films", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/films")>();
  return {
    ...real,
    filmsApi: () => {
      const api = real.filmsApi();
      return { ...api, get: (id: string) => (filmReadOk ? Promise.resolve({ ok: true as const, data: { film: { version: 7 } } as never }) : api.get(id)) };
    },
  };
});
beforeEach(() => {
  filmReadOk = false;
});

function mount(quote: FilmQuote | null, requote?: () => Promise<FilmQuote | null>, filmId = "synthetic") {
  const view = render(<FilmCreateButton filmId={filmId} quote={quote} onStarted={started} requote={requote} progressHref="/synthetic-channel/studio" />);
  return { view, key: () => screen.queryByTestId("film-create-key") as HTMLButtonElement | null };
}
const note = () => screen.getByTestId("film-create-note").textContent ?? "";
const NOTHING_HELD = /Nothing was held/;

async function pressAndConfirm(key: HTMLButtonElement | null) {
  fireEvent.click(key!);
  fireEvent.click(await screen.findByTestId("film-create-confirm-key"));
}

describe("FilmCreateButton", () => {
  it("keeps the idempotency key across a network-error retry and mints a new one after a refusal", async () => {
    answers = ["offline", { ok: false, reason: "reference_missing" }];
    const requote = vi.fn(async () => q({ quote_id: QID(3, "c") }));
    const { key } = mount(q(), requote);
    await pressAndConfirm(key());
    await waitFor(() => expect(note()).toBe(c.startNoAnswer));
    // No answer is not a refusal: the start may have gone through, so the retry must replay it under the same key.
    expect(key()!.textContent).toBe(k.tryAgain);
    fireEvent.click(key()!);
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.reference_missing));
    expect(starts).toHaveLength(2);
    expect(starts[1].idem).toBe(starts[0].idem);
    expect(starts[1].quote_id).toBe(starts[0].quote_id);
    // A refusal is terminal: the next press gets a new price and a new key, never the spent pair (idempotency_conflict).
    expect(key()!.textContent).toBe(k.getNewPrice);
    fireEvent.click(key()!);
    fireEvent.click(await screen.findByTestId("film-create-confirm-key"));
    await waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2].idem).not.toBe(starts[0].idem);
    expect(starts[2].quote_id).toBe(QID(3, "c"));
    await waitFor(() => expect(started).toHaveBeenCalledWith({ replayed: false }));
  });

  // Lens H1: a 5xx without our JSON body, or a 200 cut off mid-body, may sit in front of a start that committed.
  it.each([
    ["a 502 with a gateway's HTML body", raw("<html><body>Bad Gateway</body></html>", 502)],
    ["a 200 cut off mid-body", raw("{", 200)],
    ["a 200 that is JSON but not our answer", raw('{"hello":1}', 200)],
    ["a 500 whose error word is not ours", { status: 500, body: { error: "upstream_timeout" } }],
  ])("%s is no answer: the key is kept and nothing claims that nothing was held", async (_name, first) => {
    answers = [first as Answer, { ok: true, replayed: true }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(note()).toBe(c.startNoAnswer));
    expect(screen.getByTestId("film-create").textContent).not.toMatch(NOTHING_HELD);
    fireEvent.click(key()!);
    await waitFor(() => expect(started).toHaveBeenCalledWith({ replayed: true }));
    expect(starts[1].idem).toBe(starts[0].idem);
  });

  it("an error word our route wrote is an answer: the key is forgotten and the remedy is named", async () => {
    answers = [{ status: 502, body: { error: "failed" } }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(k.errors.failed));
    expect(screen.getByRole("link", { name: k.support }).getAttribute("href")).toBeTruthy();
  });

  it("an NS400 refusal shows the database's own sentence under the reason", async () => {
    answers = [{ status: 400, body: { error: "asset_not_usable", detail: "scene 3: the first frame is no longer in the library" } }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(screen.getByTestId("film-create-detail").textContent).toBe("scene 3: the first frame is no longer in the library"));
  });

  it("a rate limit waits for its Retry-After before the key can be pressed again, and says 'Try again'", async () => {
    answers = [{ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "120" } }];
    const { key } = mount(q(), async () => q());
    await pressAndConfirm(key());
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(k.errors.rate_limited));
    expect(key()!.textContent).toBe(k.tryAgain);
    await waitFor(() => expect(key()!.disabled).toBe(true));
    expect(note()).toContain("Try again in about 2 min.");
  });

  it("re-quotes after price_changed and starts only after a fresh confirm that shows the old total and the change", async () => {
    answers = [{ ok: false, reason: "price_changed" }, { ok: true, replayed: false }];
    const requote = vi.fn(async () => q({ total: 20, quote_id: QID(4, "d") }));
    const { key } = mount(q(), requote);
    await pressAndConfirm(key());
    const change = await screen.findByTestId("film-create-change");
    expect(requote).toHaveBeenCalledTimes(1);
    expect(change.textContent).toBe("The price changed: it was 16, now 20 credits (4 more).");
    expect(screen.getByTestId("film-create-confirm-key").textContent).toBe("Hold 20 credits and start");
    // One primary per view: the main key is gone while the confirmation is open.
    expect(key()).toBeNull();
    expect(starts).toHaveLength(1);
    fireEvent.click(screen.getByTestId("film-create-confirm-key"));
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1].quote_id).toBe(QID(4, "d"));
    expect(starts[1].idem).not.toBe(starts[0].idem);
  });

  it("says a lower re-quoted price as a drop, and quote_expired re-quotes the same way", async () => {
    answers = [{ ok: false, reason: "quote_expired" }];
    const { key } = mount(q(), async () => q({ total: 1, quote_id: QID(3, "e") }));
    await pressAndConfirm(key());
    expect((await screen.findByTestId("film-create-change")).textContent).toBe("The price changed: it was 16, now 1 credit (15 less).");
  });

  it("Russian counts agree with their number (1 кредит, 3 кредита, 22 кредита, 5 кредитов)", async () => {
    locale = "ru";
    const ru = studioTimelineRu.create;
    for (const [n, word] of [[1, "кредит"], [3, "кредита"], [22, "кредита"], [5, "кредитов"]] as const) {
      const { view } = mount(q({ startable: false, total: n, available: n, blocked_by: [{ reason: "insufficient_credits" }] }));
      expect(screen.getByRole("alert").textContent).toContain(`Цена: ${n} ${word}.`);
      expect(screen.getByRole("alert").textContent).toContain(`${ru.balanceIs.one.split(":")[0]}: ${n} ${word}.`);
      view.unmount();
    }
  });

  it("an unpriced line shows its own reason, never 'pricing is not live', and every blocked reason is listed with a way forward", () => {
    const { key } = mount(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "model_not_set" }], blocked_by: [{ reason: "run_slots_full" }, { reason: "limit_reached" }] }));
    expect(key()!.disabled).toBe(true);
    const items = [...screen.getByTestId("film-create-reasons").querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([c.blocked.run_slots_full, c.blocked.limit_reached, k.unpriced.model_not_set]);
    expect(note()).not.toContain(c.noPrice);
    expect(screen.getByRole("link", { name: k.seePlans })).toBeTruthy();
    expect(screen.getByRole("button", { name: k.checkAgain })).toBeTruthy();
    expect(key()!.getAttribute("aria-describedby")).toBe(screen.getByTestId("film-create-note").id);
  });

  it("a voice that does not speak the project's language says so, names the database's finding, and offers Check again", () => {
    mount(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "voice_language_unsupported", detail: "Eleven v3 does not speak Uzbek" }] }));
    const line = screen.getByTestId("film-create-reasons").textContent;
    expect(line).toContain(k.unpriced.voice_language_unsupported);
    expect(screen.getByTestId("film-create-line-detail").textContent).toBe("Eleven v3 does not speak Uzbek");
    expect(screen.getByRole("button", { name: k.checkAgain })).toBeTruthy();
    expect(startRemedy("voice_language_unknown")).toBe("fix_and_requote");
  });

  it("0239: a style kit or @character with no description that the key-frame model cannot see says what to add, and offers Check again", () => {
    mount(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "style_needs_description", detail: "scene 1: the style kit has no description" }] }));
    expect(screen.getByTestId("film-create-reasons").textContent).toContain(k.unpriced.style_needs_description);
    expect(k.unpriced.style_needs_description).not.toBe(k.unpriced.other);
    expect(screen.getByRole("button", { name: k.checkAgain })).toBeTruthy();
    expect(startRemedy("style_needs_description")).toBe("fix_and_requote");
  });

  describe("fixHref: a refusal fixed in the project links to the editor first (S1: Check again alone loops)", () => {
    const FIX = "/synthetic-channel/studio?film=synthetic";
    const withFix = (quote: FilmQuote, fixHref?: string) =>
      render(<FilmCreateButton filmId="synthetic" quote={quote} onStarted={started} requote={async () => quote} fixHref={fixHref} />);

    it("a blocked model_not_set: Open the project is the primary, Check again the secondary", () => {
      withFix(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "model_not_set" }] }), FIX);
      const fix = screen.getByRole("link", { name: k.openToFix });
      expect(fix.getAttribute("href")).toBe(FIX);
      expect(fix.hasAttribute("data-primary")).toBe(true);
      expect(fix.className).toContain("min-h-11");
      const again = screen.getByRole("button", { name: k.checkAgain });
      expect(again.hasAttribute("data-primary")).toBe(false);
    });

    it("a start refused for reference_missing: the editor link replaces the key, Check again beside it", async () => {
      answers = [{ ok: false, reason: "reference_missing" }];
      withFix(q(), FIX);
      fireEvent.click(screen.getByTestId("film-create-key"));
      fireEvent.click(await screen.findByTestId("film-create-confirm-key"));
      const fix = await screen.findByRole("link", { name: k.openToFix });
      expect(fix.getAttribute("href")).toBe(FIX);
      expect(screen.queryByTestId("film-create-key")).toBeNull();
      expect(screen.getByRole("button", { name: k.checkAgain })).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(fix));
    });

    it("without fixHref nothing changes: Check again for the blocked line, Get a new price for the refusal", async () => {
      answers = [{ ok: false, reason: "reference_missing" }];
      const view = withFix(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "model_not_set" }] }));
      expect(screen.queryByRole("link", { name: k.openToFix })).toBeNull();
      expect(screen.getByRole("button", { name: k.checkAgain })).toBeTruthy();
      view.unmount();
      withFix(q());
      fireEvent.click(screen.getByTestId("film-create-key"));
      fireEvent.click(await screen.findByTestId("film-create-confirm-key"));
      await waitFor(() => expect(screen.getByTestId("film-create-key").textContent).toBe(k.getNewPrice));
      expect(screen.queryByRole("link", { name: k.openToFix })).toBeNull();
    });
  });

  it("not_a_member, blocked or refused, says who can start it and offers no retry", async () => {
    const blocked = mount(q({ startable: false, blocked_by: [{ reason: "not_a_member" }] }));
    expect(screen.getByTestId("film-create-reasons").textContent).toBe(c.blocked.not_a_member);
    expect(blocked.key()!.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: k.checkAgain })).toBeNull();
    expect(screen.queryByRole("button", { name: k.getNewPrice })).toBeNull();
    blocked.view.unmount();
    answers = [{ ok: false, reason: "not_a_member" }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(k.errors.not_a_member));
    expect(key()).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("every blocked reason has one way forward", () => {
    expect(blockRemedy({ kind: "no_quote" })).toBe("get_price");
    expect(blockRemedy({ kind: "block", block: "cap_exceeded" })).toBe("plans");
    expect(blockRemedy({ kind: "block", block: "run_slots_full" })).toBe("plans");
    expect(blockRemedy({ kind: "block", block: "limit_reached" })).toBe("recheck");
    expect(blockRemedy({ kind: "block", block: "film_studio_disabled" })).toBe("support");
    expect(blockRemedy({ kind: "block", block: "other" })).toBe("support");
    expect(blockRemedy({ kind: "unpriced", word: "zzz_new" })).toBe("support");
    expect(blockRemedy({ kind: "unpriced", word: "model_temporarily_off" })).toBe("choose_another");
    expect(blockRemedy({ kind: "block", block: "insufficient_credits" })).toBe("add_credits");
  });

  it("a model that is down is said as unavailable, not substituted, with support when no other model can be chosen here", () => {
    mount(q({ priced: false, total: null, quote_id: null, startable: false, refusals: [{ reason: "model_not_available" }] }));
    expect(screen.getByRole("alert").textContent).toBe(k.providerDown);
    expect(screen.getByRole("link", { name: k.support })).toBeTruthy();
  });

  it("a balance the quote did not read is said as unknown, never 0", () => {
    mount(q({ startable: false, available: null, blocked_by: [{ reason: "insufficient_credits" }] }));
    expect(screen.getByRole("alert").textContent).toContain(k.balanceUnknown);
  });

  it("short of credits: the key carries no number, the quote's price and balance are context, and Add credits links to billing", () => {
    const { key } = mount(q({ startable: false, available: 5, blocked_by: [{ reason: "insufficient_credits", available: 5, needed: 16 }] }));
    expect(key()!.disabled).toBe(true);
    expect(key()!.textContent).toBe(k.create);
    const box = screen.getByRole("alert");
    expect(box.textContent).toContain("Price: 16 credits.");
    expect(box.textContent).toContain("Balance when priced: 5 credits.");
    expect(screen.getByRole("link", { name: c.addCredits }).getAttribute("href")).toBe("/synthetic-channel/billing");
    expect(key()!.className).toContain("whitespace-nowrap");
  });

  it("a start refused for credits makes Add credits the primary way forward, with a new price beside it", async () => {
    answers = [{ ok: false, reason: "insufficient_credits" }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    const add = await screen.findByRole("link", { name: c.addCredits });
    expect(add.getAttribute("href")).toBe("/synthetic-channel/billing");
    expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.insufficient_credits);
    // The refused quote's own numbers: nothing is re-computed in the browser.
    expect(screen.getByRole("alert").textContent).toContain("Price: 16 credits.");
    expect(key()).toBeNull();
    expect(screen.getByRole("button", { name: k.getNewPrice })).toBeTruthy();
    // Focus lands on the way forward, never on an invisible region (Pixel H1).
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it("a project that already started has no key, only its progress", async () => {
    answers = [{ ok: false, reason: "film_not_startable" }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    const open = await screen.findByRole("link", { name: k.openProgress });
    expect(open.getAttribute("href")).toBe("/synthetic-channel/studio");
    expect(key()).toBeNull();
  });

  it("a double click on Confirm and a held Enter send one request", async () => {
    answers = ["pending"];
    const { key } = mount(q());
    expect(fireEvent.keyDown(key()!, { key: "Enter", repeat: true })).toBe(false);
    fireEvent.click(key()!);
    const confirm = await screen.findByTestId("film-create-confirm-key");
    // Focus starts on Cancel, so the Enter that opened the confirmation cannot also confirm it.
    expect(document.activeElement).toBe(screen.getByTestId("film-create-cancel"));
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(starts).toHaveLength(1);
    expect(key()!.getAttribute("aria-busy")).toBe("true");
    expect(key()!.disabled).toBe(true);
    fireEvent.click(key()!);
    expect(starts).toHaveLength(1);
  });

  it("shows no number at all when the total is null, or when there is no quote", () => {
    const first = mount(q({ priced: true, total: null }));
    expect(screen.getByTestId("film-create").textContent).not.toMatch(/\d/);
    first.view.unmount();
    const none = mount(null);
    expect(none.key()!.textContent).toBe(k.getPrice);
    expect(screen.getByTestId("film-create").textContent).not.toMatch(/\d/);
    expect(note()).toContain(k.noQuote);
  });

  it("a 401 from the start route is a session that ended: sign in here, and the same press resumes once the person is back", async () => {
    answers = [{ status: 401, body: { error: "unauthorized" } }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(k.sessionExpired));
    const signIn = screen.getByRole("link", { name: k.signIn });
    expect(signIn.getAttribute("href")).toBe("/login");
    expect(signIn.getAttribute("target")).toBeNull();
    expect(key()!.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(key()!.disabled).toBe(false);
    fireEvent.click(key()!);
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1].idem).toBe(starts[0].idem);
  });

  it("an unknown refusal word still names a way out: support first, and a new price", async () => {
    answers = [{ ok: false, reason: "never_heard_of_it" }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.other));
    expect(screen.getByRole("link", { name: k.support })).toBeTruthy();
    expect(screen.getByRole("button", { name: k.getNewPrice })).toBeTruthy();
  });

  it("says 'Still working…' after 10 seconds with no answer", () => {
    vi.useFakeTimers();
    answers = ["pending"];
    const { key } = mount(q());
    fireEvent.click(key()!);
    fireEvent.click(screen.getByTestId("film-create-confirm-key"));
    expect(note()).toBe("");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(note()).toBe(k.stillWorking);
  });

  // Lens M2: an answer for the project that was on screen must not land on the next one.
  it("a new filmId while a start is pending resets the state and drops the old answer", async () => {
    answers = ["pending"];
    const first = q();
    const { view, key } = mount(first);
    await pressAndConfirm(key());
    expect(starts[0].url).toBe("/api/films/synthetic/start");
    const other = q({ quote_id: QID(9, "f"), total: 40 });
    view.rerender(<FilmCreateButton filmId="another" quote={other} onStarted={started} />);
    await waitFor(() => expect(screen.getByTestId("film-create").dataset.state).toBe("idle"));
    await act(async () => {
      pendingStarts[0](new Response(JSON.stringify({ start: { ok: true, replayed: false } })));
    });
    expect(started).not.toHaveBeenCalled();
    expect(screen.getByTestId("film-create").dataset.state).toBe("idle");
    expect(screen.getByTestId("price-tag").textContent).toContain("40");
  });

  it("a new filmId while in network_error resets the state, and the next press starts the new project under a new key", async () => {
    answers = ["offline"];
    const { view, key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(note()).toBe(c.startNoAnswer));
    view.rerender(<FilmCreateButton filmId="another" quote={q({ quote_id: QID(9, "f") })} onStarted={started} />);
    await waitFor(() => expect(screen.getByTestId("film-create").dataset.state).toBe("idle"));
    await pressAndConfirm(key());
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1].url).toBe("/api/films/another/start");
    expect(starts[1].idem).not.toBe(starts[0].idem);
    expect(starts[1].quote_id).toBe(QID(9, "f"));
  });
});

// Lens M3: the default re-quote (no injected `requote`) names what went wrong, never one generic "could not read".
describe("FilmCreateButton, default re-quote", () => {
  async function refuseThenRequote() {
    answers = [{ ok: false, reason: "reference_missing" }];
    const { key } = mount(q());
    await pressAndConfirm(key());
    await waitFor(() => expect(key()!.textContent).toBe(k.getNewPrice));
    fireEvent.click(key()!);
    return key;
  }

  it("GET 404: the project is gone, said as such, and the key is disabled", async () => {
    filmRead = { status: 404, body: { error: "not_found" } };
    const key = await refuseThenRequote();
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(k.errors.not_found));
    expect(key()!.disabled).toBe(true);
    expect(key()!.textContent).toBe(k.create);
  });

  it("GET 401: a session that ended, with sign in", async () => {
    filmRead = { status: 401, body: { error: "unauthorized" } };
    await refuseThenRequote();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(k.sessionExpired));
  });

  it("POST 409 film_changed: its own words and a new price, at the version the project is now", async () => {
    filmReadOk = true;
    quoteAnswers = [{ status: 409, body: { error: "film_changed" } }];
    const key = await refuseThenRequote();
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(c.startFailed.film_changed));
    expect(quoteBodies[0]).toEqual({ version: 7 });
    expect(key()!.textContent).toBe(k.getNewPrice);
  });

  it("POST 429: wait, and 'Try again'", async () => {
    filmReadOk = true;
    quoteAnswers = [{ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "60" } }];
    const key = await refuseThenRequote();
    await waitFor(() => expect(screen.getByTestId("film-create-refusal").textContent).toBe(k.errors.rate_limited));
    expect(key()!.textContent).toBe(k.tryAgain);
    expect(note()).toContain(k.requoteFailed);
  });
});

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
  // S6's #915 adds these to FILM_ERRORS (0214's voice_language_problem); pinned here until it is on main, so they are mapped already.
  words.add("voice_language_unsupported");
  words.add("voice_language_unknown");
  // 0215 (not on main yet): a platform admin who is not a member of the workspace cannot spend its credits.
  words.add("not_a_member");
  return [...words].sort();
}

const LOCALES: [string, ReasonDictionaries][] = [
  ["en", { create: c.create, startFailed: c.startFailed }],
  ["ru", { create: studioTimelineRu.create, startFailed: studioTimelineRu.startFailed }],
  ["uz", { create: studioTimelineUz.create, startFailed: studioTimelineUz.startFailed }],
];

describe("start refusal words", () => {
  const words = wordsTheStartCanAnswer();

  it("finds the words in the migrations (the extraction itself works)", () => {
    for (const w of ["insufficient_credits", "price_changed", "quote_expired", "hold_refused", "idempotency_conflict", "film_not_startable", "model_not_set", "acknowledgement_required"]) {
      expect(words).toContain(w);
    }
  });

  it.each(LOCALES)("every word has its own remedy and a %s sentence of the start's own, not the generic one", (_l, d) => {
    const missing = words.filter((w) => !Object.prototype.hasOwnProperty.call(START_REMEDIES, w) || startReasonText(w, d) === null || startReasonText(w, d) === d.startFailed.other);
    expect(missing).toEqual([]);
  });

  it("an unknown word gets no sentence of its own and the support remedy", () => {
    expect(startReasonText("never_heard_of_it", LOCALES[0][1])).toBeNull();
    expect(startRemedy("never_heard_of_it")).toBe("support");
    expect(startRemedy("constructor")).toBe("support");
  });
});
