// @vitest-environment jsdom
/**
 * The owner's Marketing board: what a tap does and what it never does.
 *
 * Nothing is sent on the first tap of Approve, Reject, Stop or Switch on: the confirm sheet comes first, repeats the channel,
 * the three texts and "public", and Approve and Switch on also ask for a word typed back. Approve sends the hash of the post
 * the page SHOWED, and a double tap is one request. Every refusal is worded in the sheet and a stale page reloads. There is
 * no control that sends, re-sends or tests, and every control is at least 44 px tall with a label that names its post.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { jsonRes } from "./helpers/response";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { coerceListedPost, coercePost, type ListedPost, type MarketingPost, type MarketingSettings } from "../lib/marketing-posts";

const h = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn(), toast: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/context", async () => {
  const dicts = { en: (await import("../lib/i18n/en")).en, ru: (await import("../lib/i18n/ru")).ru, uz: (await import("../lib/i18n/uz")).uz };
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: dicts[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { MarketingBoard } from "../components/marketing/MarketingBoard";

const m = en.marketing;
const ID = "11111111-2222-3333-4444-555555555555";
const HASH = "ab".repeat(32);
const NOW = Date.parse("2026-10-18T09:00:00Z");
const SETTINGS: MarketingSettings = { enabled: true, maxPer7d: 2, used7d: 1, approvedWaiting: 0, approvalTtlHours: 72 };
const row = (over: Record<string, unknown> = {}): MarketingPost =>
  coercePost({
    id: ID,
    kind: "news",
    status: "draft",
    texts: { uz: "Yangi funksiya: tezroq saqlash.", ru: "Новая функция: быстрее сохранение.", en: "New: projects save faster." },
    media_path: null,
    link: "/pricing",
    source_ref: "pr:#12",
    content_hash: HASH,
    created_at: "2026-10-17T10:00:00Z",
    updated_at: "2026-10-17T10:00:00Z",
    attempts: 0,
    max_attempts: 3,
    next_attempt_at: "2026-10-17T10:00:00Z",
    ...over,
  })!;

const show = (posts: ListedPost[] = [row()], settings: MarketingSettings = SETTINGS, channel: string | null = "@nightshift_test") =>
  render(<MarketingBoard settings={settings} posts={posts} truncated={false} channel={channel} origin="https://nightshift-ai.studio" nowMs={NOW} />);

const sheet = () => screen.getByRole("alertdialog");
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const sent = (n = 0) => {
  const [url, init] = h.fetch.mock.calls[n] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};
const key = (name: string) => within(sheet()).getByRole("button", { name });

beforeEach(() => {
  h.locale = "en";
  h.fetch.mockReset().mockImplementation(async () => jsonRes({ ok: true }));
  h.refresh.mockReset();
  h.toast.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the preview", () => {
  it("shows the three language blocks in the fixed order, the link, per-language counts and the whole message against 4096", () => {
    show();
    const bubble = document.querySelector("[data-telegram-preview]")!;
    const text = bubble.textContent ?? "";
    expect(text.indexOf("Oʻzbekcha")).toBeLessThan(text.indexOf("Русский"));
    expect(text.indexOf("Русский")).toBeLessThan(text.indexOf("English"));
    expect(text).toContain("https://nightshift-ai.studio/pricing");
    expect(screen.getByText(/Oʻzbekcha: \d+ units?/)).toBeTruthy();
    expect(screen.getByText(/Whole message: \d+ of 4096/)).toBeTruthy();
    expect(screen.getByText(/Limit for a message: 4096/)).toBeTruthy();
  });

  it("a post with media is counted against the caption limit of 1024", () => {
    show([row({ kind: "showcase", media_path: "showcase/a.mp4", source_ref: "asset:" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12) })]);
    expect(screen.getByText(/of 1024/)).toBeTruthy();
    expect(screen.getByText(/Attached: video showcase\/a\.mp4/)).toBeTruthy();
  });

  it("a post over the limit says the sender refuses it and never cuts it", () => {
    show([row({ texts: { uz: "😀".repeat(700), ru: "😀".repeat(700), en: "😀".repeat(700) } })]);
    expect(screen.getByText(m.preview.over)).toBeTruthy();
  });

  it("without a known site address the link is left out of the count and the total says 'at least'", () => {
    render(<MarketingBoard settings={SETTINGS} posts={[row()]} truncated={false} channel={null} origin={null} nowMs={NOW} />);
    expect(screen.getByText(/Whole message: at least \d+ of 4096/)).toBeTruthy();
    expect(screen.getByText(/the site address is not known to this page/)).toBeTruthy();
  });
});

describe("the poster", () => {
  it("shows the state, 'posts this week: n of 2' and what waits; unknown stays unknown", () => {
    show();
    expect(screen.getByText("Posts this week: 1 of 2")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByText("0 approved and waiting for the worker")).toBeTruthy();
    cleanup();
    show([row()], { ...SETTINGS, used7d: null, approvedWaiting: null });
    expect(screen.getByText("Posts this week: unknown of 2")).toBeTruthy();
    expect(screen.getByText(m.poster.waitingUnknown)).toBeTruthy();
  });

  it("shows the database's second-factor gate read only: on, off with the risk said, or unknown (never 'off' for unreadable)", () => {
    for (const [gate, shown, note] of [
      [true, m.poster.gate.on, m.poster.gate.onNote],
      [false, m.poster.gate.off, m.poster.gate.offNote],
      [null, m.poster.gate.unknown, m.poster.gate.unknownNote],
    ] as const) {
      render(<MarketingBoard settings={SETTINGS} posts={[row()]} truncated={false} channel="@nightshift_test" origin={null} nowMs={NOW} gateOn={gate} />);
      expect(document.querySelector("[data-gate]")!.textContent).toBe(shown);
      expect(screen.getByText(note)).toBeTruthy();
      cleanup();
    }
    // no control for it
    show();
    expect(screen.queryByRole("button", { name: /second|gate|MFA/i })).toBeNull();
  });

  it("stopping asks first (nothing is sent), then sends kill:true and reloads", async () => {
    show();
    await tap(screen.getByRole("button", { name: m.poster.stopAria }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain(m.poster.stopTitle);
    await tap(key(m.poster.stopConfirm));
    expect(sent()).toEqual({ url: "/api/marketing", body: { action: "kill", kill: true } });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("while it is off: Approve is disabled and says why, and switching on needs a reason, a confirm and a typed word", async () => {
    show([row()], { ...SETTINGS, enabled: false });
    expect(screen.getByText(m.poster.offNote)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approve this post for publishing/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(m.approve.needPosterOn)).toBeTruthy();

    const start = screen.getByRole("button", { name: m.poster.startAria }) as HTMLButtonElement;
    expect(start.disabled).toBe(true); // no reason yet
    change(screen.getByPlaceholderText(m.poster.reasonPh), "short");
    expect(start.disabled).toBe(true);
    change(screen.getByPlaceholderText(m.poster.reasonPh), "checked the channel and the bot is admin");
    expect(start.disabled).toBe(false);
    await tap(start);
    expect(h.fetch).not.toHaveBeenCalled();
    const dlg = sheet();
    expect(dlg.textContent).toContain("checked the channel and the bot is admin");
    expect(dlg.textContent).toContain("@nightshift_test");
    const go = key(m.poster.startConfirm) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    change(within(dlg).getByRole("textbox"), "wrong");
    expect(go.disabled).toBe(true);
    change(within(dlg).getByRole("textbox"), m.poster.startWord);
    await tap(go);
    expect(sent()).toEqual({ url: "/api/marketing", body: { action: "kill", kill: false, reason: "checked the channel and the bot is admin" } });
  });
});

describe("approving", () => {
  const open = async () => {
    await tap(screen.getByRole("button", { name: /Approve this post for publishing: pr:#12/ }));
  };

  it("the first tap only asks: the sheet repeats the channel, all three texts, the link and 'this goes public'; nothing is sent", async () => {
    show();
    await open();
    expect(h.fetch).not.toHaveBeenCalled();
    const dlg = sheet();
    expect(dlg.textContent).toContain("Publish to @nightshift_test?");
    expect(dlg.textContent).toContain("This goes public");
    expect(within(dlg).getByText("public")).toBeTruthy();
    expect(within(dlg).getByText("Yangi funksiya: tezroq saqlash.")).toBeTruthy();
    expect(within(dlg).getByText("Новая функция: быстрее сохранение.")).toBeTruthy();
    expect(within(dlg).getByText("New: projects save faster.")).toBeTruthy();
    expect(dlg.textContent).toContain("https://nightshift-ai.studio/pricing");
    expect(dlg.textContent).toContain("@nightshift_test");
  });

  it("the key stays locked until the word is typed", async () => {
    show();
    await open();
    const go = key(m.approve.confirm) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    change(within(sheet()).getByRole("textbox"), "publi");
    expect(go.disabled).toBe(true);
    change(within(sheet()).getByRole("textbox"), "PUBLISH");
    expect(go.disabled).toBe(false);
  });

  it("sends the id and the hash the page SHOWED, once for a double tap, then reloads", async () => {
    let done: (r: Response) => void = () => {};
    h.fetch.mockImplementation(() => new Promise<Response>((r) => (done = r)));
    show();
    await open();
    change(within(sheet()).getByRole("textbox"), m.approve.word);
    const go = key(m.approve.confirm);
    fireEvent.click(go);
    fireEvent.click(go);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({ url: "/api/marketing", body: { action: "approve", id: ID, contentHash: HASH } });
    await act(async () => done(jsonRes({ ok: true, already: false, id: ID, status: "approved" })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.refresh).toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(m.approve.done);
  });

  it("a post that changed is refused with content_changed: said in the sheet, and the page reloads when it is closed", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "content_changed", content_hash: "f".repeat(64) }, 422));
    show();
    await open();
    change(within(sheet()).getByRole("textbox"), m.approve.word);
    await tap(key(m.approve.confirm));
    expect(within(sheet()).getByRole("alert").textContent).toBe(m.err.content_changed);
    expect(h.refresh).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["poster_off", m.err.poster_off],
    ["expired", m.err.expired],
    ["facts_stale", m.err.facts_stale],
    ["bad_texts", m.err.bad_texts],
    ["mfa_required", m.err.mfa_required],
  ])("%s is worded in the sheet and the key works again", async (code, text) => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: code }, code === "mfa_required" ? 401 : 422));
    show();
    await open();
    change(within(sheet()).getByRole("textbox"), m.approve.word);
    await tap(key(m.approve.confirm));
    expect(within(sheet()).getByRole("alert").textContent).toBe(text);
    expect((key(m.approve.confirm) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a full week names its figures", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "cap_full", used_7d: 1, approved_waiting: 1, max_per_7d: 2 }, 422));
    show();
    await open();
    change(within(sheet()).getByRole("textbox"), m.approve.word);
    await tap(key(m.approve.confirm));
    expect(within(sheet()).getByRole("alert").textContent).toContain("1 used and 1 approved and waiting, out of 2");
  });

  it("a dropped connection says the approval may have gone through, and sends nothing twice by itself", async () => {
    h.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    show();
    await open();
    change(within(sheet()).getByRole("textbox"), m.approve.word);
    await tap(key(m.approve.confirm));
    expect(within(sheet()).getByRole("alert").textContent).toContain(en.ownerTruth.checkBeforeRetry);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("an unknown channel disables Approve and says why: the sheet could not say where this goes public", async () => {
    show([row()], SETTINGS, null);
    const button = screen.getByRole("button", { name: /Approve this post for publishing/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(m.approve.needChannel)).toBeTruthy();
    expect(screen.getByText(m.poster.channelUnknown)).toBeTruthy();
    await tap(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a post the sender would refuse as too long cannot be approved, and the reason is on the screen", async () => {
    show([row({ texts: { uz: "😀".repeat(700), ru: "😀".repeat(700), en: "😀".repeat(700) } })]);
    const button = screen.getByRole("button", { name: /Approve this post for publishing/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(m.approve.blockedTooLong)).toBeTruthy();
    await tap(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    // Edit and Reject stay available: the owner can shorten it or throw it away
    expect((screen.getByRole("button", { name: /Edit the texts/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Reject this post/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a post over the CAPTION limit (media) is blocked too, though it would fit a message", () => {
    show([row({ kind: "showcase", media_path: "showcase/a.mp4", source_ref: "asset:" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12), texts: { uz: "u".repeat(340), ru: "р".repeat(340), en: "e".repeat(340) } })]);
    expect((screen.getByRole("button", { name: /Approve this post/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(m.approve.blockedTooLong)).toBeTruthy();
  });

  it("text shaped like a key or an e-mail address blocks Approve, and the preview says so", () => {
    show([row({ texts: { uz: "Yangi funksiya.", ru: "Новая функция.", en: "Write to someone@example.com" } })]);
    expect((screen.getByRole("button", { name: /Approve this post/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(m.approve.blockedUnsafe)).toBeTruthy();
    expect(screen.getByText(m.preview.unsafe)).toBeTruthy();
  });

  it("a post that is fine with everything on is approvable (nothing blocks it)", () => {
    show();
    expect((screen.getByRole("button", { name: /Approve this post/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(m.approve.needChannel)).toBeNull();
    expect(screen.queryByText(m.approve.blockedTooLong)).toBeNull();
  });

  it("the sheet shows the attached file when the post has one, and no row when it has none", async () => {
    show([row({ kind: "showcase", media_path: "showcase/a.mp4", source_ref: "asset:" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12) })]);
    await tap(screen.getByRole("button", { name: /Approve this post for publishing/ }));
    const dlg = sheet();
    expect(within(dlg).getByText(m.approve.dMedia)).toBeTruthy();
    expect(within(dlg).getByText("showcase/a.mp4")).toBeTruthy();
    await tap(within(dlg).getByRole("button", { name: en.ux.confirmCancel }));
    cleanup();
    show();
    await tap(screen.getByRole("button", { name: /Approve this post for publishing/ }));
    expect(within(sheet()).queryByText(m.approve.dMedia)).toBeNull();
  });

  it("an approved post cannot be approved again, and says whether it will go", () => {
    show([row({ status: "approved", approved_at: "2026-10-18T08:00:00Z", expires_at: "2026-10-21T08:00:00Z" })]);
    expect(screen.queryByRole("button", { name: /Approve this post/ })).toBeNull();
    expect(screen.getByText(/The worker sends it next while the poster is on/)).toBeTruthy();
  });
});

describe("rejecting", () => {
  it("needs a reason of 8 characters, asks first, then sends the id and the reason", async () => {
    show();
    await tap(screen.getByRole("button", { name: /Reject this post: pr:#12/ }));
    const next = screen.getByRole("button", { name: m.reject.next }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    change(screen.getByPlaceholderText(m.reject.reasonPh), "wrong date in the text");
    await tap(next);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain("wrong date in the text");
    await tap(key(m.reject.confirm));
    expect(sent()).toEqual({ url: "/api/marketing", body: { action: "reject", id: ID, reason: "wrong date in the text" } });
    expect(h.refresh).toHaveBeenCalled();
  });
});

describe("editing", () => {
  const edit = async () => tap(screen.getByRole("button", { name: /Edit the texts of this post: pr:#12/ }));

  it("shows the three texts with live counts and a live preview; Save is off until something changed", async () => {
    show();
    await edit();
    const save = screen.getByRole("button", { name: m.edit.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const en_ = screen.getByLabelText(/English text/);
    change(en_, "New: projects save much faster.");
    expect(save.disabled).toBe(false);
    expect(document.querySelectorAll("[data-telegram-preview]")).toHaveLength(1);
    expect(document.querySelector("[data-telegram-preview]")!.textContent).toContain("New: projects save much faster.");
  });

  it("saves the trimmed texts to owner_marketing_edit (a draft needs no confirm sheet) and reloads", async () => {
    show();
    await edit();
    change(screen.getByLabelText(/English text/), "  New: faster.  ");
    await tap(screen.getByRole("button", { name: m.edit.save }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent().body).toEqual({
      action: "edit",
      id: ID,
      texts: { uz: "Yangi funksiya: tezroq saqlash.", ru: "Новая функция: быстрее сохранение.", en: "New: faster." },
    });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("an emptied language or an over-long message cannot be saved, and says why", async () => {
    show();
    await edit();
    change(screen.getByLabelText(/Russian text|Русский text/), "");
    expect((screen.getByRole("button", { name: m.edit.save }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(m.edit.empty)).toBeTruthy();
    change(screen.getByLabelText(/Russian text|Русский text/), "😀".repeat(700));
    change(screen.getByLabelText(/Oʻzbekcha text/), "😀".repeat(700));
    change(screen.getByLabelText(/English text/), "😀".repeat(700));
    expect((screen.getByRole("button", { name: m.edit.save }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(m.edit.tooLong)).toBeTruthy();
  });

  it("editing an APPROVED post warns, then asks, because saving voids the approval", async () => {
    show([row({ status: "approved", approved_at: "2026-10-18T08:00:00Z", expires_at: "2026-10-21T08:00:00Z" })]);
    await edit();
    expect(screen.getByText(m.edit.voidsApproval)).toBeTruthy();
    change(screen.getByLabelText(/English text/), "New: faster.");
    await tap(screen.getByRole("button", { name: m.edit.save }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain(m.edit.confirmTitle);
    await tap(key(m.edit.confirmButton));
    expect(sent().body).toMatchObject({ action: "edit", id: ID });
  });

  it("a refusal on save is shown beside the form and nothing is lost", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "bad_texts" }, 422));
    show();
    await edit();
    change(screen.getByLabelText(/English text/), "New: faster.");
    await tap(screen.getByRole("button", { name: m.edit.save }));
    expect(screen.getByText(m.err.bad_texts)).toBeTruthy();
    expect((screen.getByLabelText(/English text/) as HTMLTextAreaElement).value).toBe("New: faster.");
  });
});

describe("what happened to a send", () => {
  it("a post that may be on the channel says: check the channel, do not resend; and the last-send panel says it too", () => {
    show([row({ status: "dead", last_error_code: "unconfirmed", approved_at: "2026-10-17T11:00:00Z", updated_at: "2026-10-17T12:00:00Z" })]);
    expect(screen.getAllByText(/check the channel, do not resend/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Approve|Edit|Reject/ })).toBeNull();
  });

  it.each([
    ["blocked", /not an administrator of the channel/],
    ["not_configured", /TELEGRAM_CHANNEL_BOT_TOKEN/],
    ["bad_request", /MARKETING_TELEGRAM_CHAT/],
  ])("a failed send with %s names its fix", (code, re) => {
    show([row({ status: "failed", last_error_code: code, approved_at: "2026-10-17T11:00:00Z", updated_at: "2026-10-17T12:00:00Z" })]);
    expect(screen.getAllByText(re).length).toBeGreaterThanOrEqual(1);
  });

  it("a sent post shows when, and the last send says none when nothing was settled", () => {
    show([row({ status: "sent", sent_at: "2026-10-17T11:00:00Z", approved_at: "2026-10-17T10:30:00Z" })]);
    expect(screen.getAllByText(/Sent .*It is on the channel/).length).toBeGreaterThanOrEqual(1);
    cleanup();
    show([row()]);
    expect(screen.getByText(m.lastSend.none)).toBeTruthy();
  });
});

describe("phone layout, targets and labels", () => {
  it("every control is at least 44 px tall (min-h-11) and every action names its post", () => {
    show([row(), row({ id: "22222222-2222-3333-4444-555555555555", source_ref: "pr:#13" })]);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(7);
    for (const b of buttons) expect(b.className, b.textContent ?? "").toMatch(/min-h-11|min-h-12/);
    expect(screen.getAllByRole("button", { name: /pr:#13/ }).length).toBe(3);
    for (const t of document.querySelectorAll("textarea")) expect(t.closest("label"), "a textarea has a label").toBeTruthy();
  });

  it("button rows stay one column until 420 px so ru and uz labels do not overflow at 390 px", () => {
    show([row()]);
    const rows = [...document.querySelectorAll("article .grid")];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.className).toContain("grid-cols-1");
      expect(r.className).not.toMatch(/(^|\s)grid-cols-[23](\s|$)/);
      expect(r.className).toMatch(/min-\[420px\]:grid-cols-\d/);
    }
    cleanup();
    show([row()]);
    // the edit and reject forms follow the same rule
    fireEvent.click(screen.getByRole("button", { name: /Edit the texts/ }));
    for (const r of document.querySelectorAll("article .grid")) expect(r.className).not.toMatch(/(^|\s)grid-cols-2(\s|$)/);
  });

  it("ru and uz count in units with the right plural, and the edit count uses the same unit as the limit", async () => {
    h.locale = "ru";
    show([row({ texts: { uz: "a", ru: "😀", en: "abc" } })]);
    expect(screen.getByText("Русский: 2 единицы")).toBeTruthy();
    expect(screen.getByText("English: 3 единицы")).toBeTruthy();
    cleanup();
    show([row({ texts: { uz: "a".repeat(11), ru: "б", en: "abcde" } })]);
    expect(screen.getByText("Oʻzbekcha: 11 единиц")).toBeTruthy();
    expect(screen.getByText("Русский: 1 единица")).toBeTruthy();
    cleanup();
    h.locale = "en";
    show([row()]);
    await tap(screen.getByRole("button", { name: /Edit the texts/ }));
    fireEvent.change(screen.getByLabelText(/English text/), { target: { value: "😀" } });
    expect(screen.getAllByText("2 units").length).toBeGreaterThanOrEqual(1); // an emoji is 2 units, the unit the limit uses
  });

  it("no control sends, re-sends or tests a post", () => {
    show([row(), row({ id: "22222222-2222-3333-4444-555555555555", status: "approved", approved_at: "2026-10-18T08:00:00Z", expires_at: "2026-10-21T08:00:00Z" }), row({ id: "33333333-2222-3333-4444-555555555555", status: "dead", last_error_code: "unconfirmed" })]);
    const names = screen.getAllByRole("button").map((b) => `${b.textContent} ${b.getAttribute("aria-label") ?? ""}`);
    for (const n of names) expect(n, n).not.toMatch(/send|test|resend|publish now|post now/i);
  });

  it.each(["ru", "uz"] as const)("the board renders in %s with its own words", (loc) => {
    h.locale = loc;
    const d = loc === "ru" ? ru : uz;
    show();
    expect(screen.getByText(d.marketing.poster.title)).toBeTruthy();
    expect(screen.getAllByText(d.marketing.status.draft).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: d.marketing.poster.stopAria })).toBeTruthy();
    expect(screen.queryByText(en.marketing.poster.title)).toBeNull();
  });

  it("the empty list is a state, not a blank", () => {
    show([]);
    expect(screen.getByText(m.empty.title)).toBeTruthy();
    expect(screen.getByText(m.poster.title)).toBeTruthy();
  });
});

describe("a post of a kind this page version does not know", () => {
  const ID2 = "22222222-2222-3333-4444-555555555555";
  const other = (over: Record<string, unknown> = {}): ListedPost =>
    coerceListedPost({
      id: ID2,
      kind: "banner",
      target: "instagram",
      delivery: "manual",
      payload: { hashtags: ["a"] },
      status: "draft",
      texts: { uz: "Promo uz matn.", ru: "Промо ру текст.", en: "Promo en words." },
      source_ref: "promo:launch",
      content_hash: "cd".repeat(32),
      created_at: "2026-10-18T08:00:00Z",
      updated_at: "2026-10-18T08:00:00Z",
      some_future_field: { a: 1 },
      ...over,
    })!;

  it("shows a labelled row with its status and age, and the words only as stored", () => {
    show([other()]);
    const card = screen.getByRole("article");
    expect(within(card).getByRole("heading", { name: "Other kind: banner" })).toBeTruthy();
    expect(within(card).getByText(m.status.draft)).toBeTruthy();
    expect(within(card).getByText(/Created/)).toBeTruthy();
    expect(within(card).getByText("Promo en words.")).toBeTruthy();
    expect(within(card).getByText("Kind: banner · Target: instagram · Delivery: manual")).toBeTruthy();
    expect(card.querySelector("[data-telegram-preview]")).toBeNull(); // not drawn as a Telegram message
    expect(screen.getByRole("note").textContent).toContain("(1)");
  });

  it("cannot be approved: Approve is disabled with the plain reason, and Edit and Reject are not offered", async () => {
    show([other()]);
    const approve = screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(m.other.cannotApprove)).toBeTruthy();
    expect(m.other.cannotApprove).toBe("This page version cannot approve this kind: the page needs updating (a new deploy).");
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject/ })).toBeNull();
    await tap(approve);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("an unknown target on a known kind is the same: labelled Other target, no approval", () => {
    show([other({ kind: "news", target: "youtube", delivery: undefined })]);
    expect(screen.getByRole("heading", { name: "Other target: youtube" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("words that are not the three-language shape give 'preview unavailable', never a partial preview", () => {
    show([other({ texts: { uz: "only one" } })]);
    expect(screen.getByText(m.other.noPreview)).toBeTruthy();
    expect(screen.queryByText("only one")).toBeNull();
  });

  it("a hostile kind or error code is printed as 'unknown', never as it came", () => {
    show([other({ kind: "<img src=x onerror=alert(1)>", status: "failed", last_error_code: "sk-Secret words" })]);
    expect(screen.getByRole("heading", { name: "Other kind: unknown" })).toBeTruthy();
    expect(screen.getByText("Error code: unknown")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("onerror");
    expect(document.body.innerHTML).not.toContain("Secret");
  });

  it("markup in the words and in source_ref is printed as text: no element is created from it", () => {
    const bad = '<img src=x onerror=alert(1)><b id="evil">bold</b>';
    show([
      other({
        texts: { uz: `uz ${bad}`, ru: `ru ${bad}`, en: `en ${bad}` },
        source_ref: '<script id="evil-src">alert(2)</script>',
      }),
    ]);
    const card = screen.getByRole("article");
    expect(card.querySelector("img, b, script, [id^='evil']")).toBeNull();
    expect(document.body.querySelector("#evil, #evil-src")).toBeNull();
    expect(within(card).getByText(`en ${bad}`)).toBeTruthy();
    expect(within(card).getByText(/<script id="evil-src">alert\(2\)<\/script>/)).toBeTruthy();
  });

  it("a mixed list keeps the known post, with its working Approve, next to the unknown one", async () => {
    show([row(), other()]);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: m.kind.news })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other kind: banner" })).toBeTruthy();
    const approve = screen.getByRole("button", { name: /Approve this post for publishing: pr:#12/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    await tap(approve);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("an unknown row that settled shows as the last send with its status, and claims nothing about a channel", () => {
    show([other({ status: "sent", sent_at: "2026-10-18T08:30:00Z" })]);
    expect(screen.queryByText(m.lastSend.none)).toBeNull();
    expect(screen.queryByText(/It is on the channel/)).toBeNull();
    expect(screen.getAllByText(m.status.sent).length).toBeGreaterThan(0);
  });

  it("no unknown row, no notice", () => {
    show([row()]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it.each(["ru", "uz"] as const)("renders in %s with its own words", (loc) => {
    h.locale = loc;
    const d = loc === "ru" ? ru : uz;
    show([other()]);
    expect(screen.getByRole("heading", { name: d.marketing.other.titleKind.replace("{code}", "banner") })).toBeTruthy();
    expect(screen.getByText(d.marketing.other.cannotApprove)).toBeTruthy();
    expect(d.marketing.other.cannotApprove).not.toBe(en.marketing.other.cannotApprove);
  });
});
