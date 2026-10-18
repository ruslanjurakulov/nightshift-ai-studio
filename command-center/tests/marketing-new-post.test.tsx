// @vitest-environment jsdom
/**
 * The owner's "New post" form on the Marketing board (migration 0110, owner_marketing_create).
 *
 * What would break without these: a post made without the confirm sheet, a double tap or a retry that makes two posts (the request
 * id must be made once per screen), a body that names a kind other than custom or approves anything, a form that lets a post the
 * database or the sender will refuse go to the sheet, a banned-wording hit that is hidden or that blocks the owner, a refusal that
 * is not worded in the person's language, and a new custom or promo post that does not render as a normal approvable card.
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
const NEW_ID = "99999999-2222-3333-4444-555555555555";
const HASH = "ab".repeat(32);
const NOW = Date.parse("2026-10-18T09:00:00Z");
const SETTINGS: MarketingSettings = { enabled: true, maxPer7d: 2, used7d: 0, approvedWaiting: 0, approvalTtlHours: 72 };
const WORDS = { uz: "Yangi imkoniyat: tezroq saqlash.", ru: "Новая возможность: быстрее сохранение.", en: "New: projects save faster." };

const row = (over: Record<string, unknown> = {}): MarketingPost =>
  coercePost({
    id: ID,
    kind: "custom",
    status: "draft",
    texts: WORDS,
    media_path: null,
    link: "/pricing",
    source_ref: "owner:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    content_hash: HASH,
    created_at: "2026-10-18T08:55:00Z",
    updated_at: "2026-10-18T08:55:00Z",
    attempts: 0,
    max_attempts: 3,
    next_attempt_at: "2026-10-18T08:55:00Z",
    ...over,
  })!;

const show = (posts: ListedPost[] = [], origin: string | null = "https://nightshift-ai.studio") =>
  render(<MarketingBoard settings={SETTINGS} posts={posts} truncated={false} channel="@nightshift_test" origin={origin} nowMs={NOW} />);

const sheet = () => screen.getByRole("alertdialog");
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const field = (lang: "uz" | "ru" | "en") => document.querySelector(`textarea[lang="${lang}"]`) as HTMLTextAreaElement;
const fill = (texts: Partial<Record<"uz" | "ru" | "en", string>> = WORDS) => {
  for (const lang of ["uz", "ru", "en"] as const) change(field(lang), texts[lang] ?? WORDS[lang]);
};
const openForm = async () => tap(screen.getByRole("button", { name: m.newPost.aria }));
const createButton = () => screen.getByRole("button", { name: m.newPost.create }) as HTMLButtonElement;
const sent = (n = 0) => {
  const [url, init] = h.fetch.mock.calls[n] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};
const created = (over: Record<string, unknown> = {}) => jsonRes({ ok: true, id: NEW_ID, status: "draft", kind: "custom", created: true, content_hash: HASH, ...over });

beforeEach(() => {
  h.locale = "en";
  h.fetch.mockReset().mockImplementation(async () => created());
  h.refresh.mockReset();
  h.toast.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("opening the form", () => {
  it("is closed until asked, then offers three texts, a link and a live preview, and nothing is sent", async () => {
    show();
    expect(screen.getByRole("button", { name: m.newPost.aria })).toBeTruthy();
    expect(document.querySelector("textarea[lang]")).toBeNull();
    await openForm();
    for (const lang of ["uz", "ru", "en"] as const) expect(field(lang), lang).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(createButton().disabled).toBe(true); // nothing typed yet
    expect(document.querySelector("[data-telegram-preview]")).toBeNull();
    fill();
    expect(document.querySelector("[data-telegram-preview]")!.textContent).toContain("New: projects save faster.");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("counts each language (characters of 1000 and UTF-16 units) and the whole message against 4096, live", async () => {
    show();
    await openForm();
    change(field("en"), "😀😀");
    expect(screen.getByText(/2 of 1000 characters · 4 units/)).toBeTruthy();
    expect(screen.getByText(/Whole message: \d+ of 4096/)).toBeTruthy();
    expect(screen.getByText(/Limit for a message: 4096/)).toBeTruthy();
  });

  it("the link is a choice of our own pages or another path, and the preview shows the full address", async () => {
    show();
    await openForm();
    fill();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain("/pricing");
    change(select, "/pricing");
    expect(document.querySelector("[data-telegram-preview]")!.textContent).toContain("https://nightshift-ai.studio/pricing");
    change(select, "__other");
    change(screen.getByLabelText(m.newPost.linkOtherLabel), "/studio");
    expect(document.querySelector("[data-telegram-preview]")!.textContent).toContain("https://nightshift-ai.studio/studio");
  });

  it("Cancel closes it and keeps nothing", async () => {
    show();
    await openForm();
    fill();
    await tap(screen.getByRole("button", { name: m.newPost.cancel }));
    expect(document.querySelector("textarea[lang]")).toBeNull();
    await openForm();
    expect(field("en").value).toBe("");
  });
});

describe("keyboard and screen reader", () => {
  const confirmKey = () => within(sheet()).getByRole("button", { name: m.newPost.confirmButton });

  it("focus goes to the first text when the form opens", async () => {
    show();
    await openForm();
    expect(document.activeElement).toBe(field("uz"));
  });

  it("Cancel puts focus back on the New post button", async () => {
    show();
    await openForm();
    await tap(screen.getByRole("button", { name: m.newPost.cancel }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: m.newPost.aria }));
  });

  it("after a save, focus lands on the message (the form and its buttons are gone)", async () => {
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(document.activeElement).toBe(document.querySelector("[data-new-post-done]"));
  });

  it("each counter is outside its label and described by it; the label is only the language", async () => {
    show();
    await openForm();
    for (const lang of ["uz", "ru", "en"] as const) {
      const box = field(lang);
      const label = document.querySelector(`label[for="${box.id}"]`)!;
      expect(label.textContent).not.toMatch(/characters/);
      const counter = document.getElementById(box.getAttribute("aria-describedby")!)!;
      expect(counter.textContent).toMatch(/of 1000 characters/);
      expect(label.contains(counter)).toBe(false);
    }
  });

  it("aria-invalid marks the language that keeps Create off, for every kind of problem, and no other", async () => {
    show();
    await openForm();
    expect(field("en").getAttribute("aria-invalid")).toBe("false"); // nothing typed: nothing is wrong yet
    fill();
    for (const lang of ["uz", "ru", "en"] as const) expect(field(lang).getAttribute("aria-invalid"), lang).toBe("false");
    change(field("en"), "");
    expect(field("en").getAttribute("aria-invalid")).toBe("true"); // empty
    change(field("en"), "a\u202eb");
    expect(field("en").getAttribute("aria-invalid")).toBe("true"); // invisible character
    change(field("en"), "write me@example.com");
    expect(field("en").getAttribute("aria-invalid")).toBe("true"); // shaped like an address
    change(field("en"), "x".repeat(1001));
    expect(field("en").getAttribute("aria-invalid")).toBe("true"); // too long
    expect(field("uz").getAttribute("aria-invalid")).toBe("false");
  });

  it("the banned-wording lead names no file path", () => {
    for (const d of [en, ru, uz]) expect(d.marketing.newPost.banned.lead).not.toMatch(/docs\/|\.json/);
  });
});

describe("what keeps Create off (each with its reason on the screen)", () => {
  const blocked = async (texts: Record<string, string>, text: string | RegExp) => {
    show();
    await openForm();
    fill(texts);
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(text)).toBeTruthy();
  };

  it("an empty language", async () => blocked({ en: "   " }, m.newPost.problem.empty));
  it("a language over 1000 characters", async () => blocked({ en: "x".repeat(1001) }, m.newPost.problem.langTooLong));
  it("an invisible or direction-changing character", async () => blocked({ en: "a‮b" }, m.newPost.problem.badChars));
  it("a message over 4096 UTF-16 units (an emoji counts two)", async () =>
    blocked({ uz: "😀".repeat(700), ru: "😀".repeat(700), en: "😀".repeat(700) }, m.edit.tooLong));
  it("text shaped like an e-mail address or a key (the sender refuses it)", async () => blocked({ en: "write to me@example.com" }, m.approve.blockedUnsafe));

  it("a NUL or a lone surrogate half (Postgres refuses both)", async () => {
    await blocked({ en: "a\u0000b" }, m.newPost.problem.badChars);
    cleanup();
    await blocked({ en: "broken \ud83d" }, m.newPost.problem.badChars);
  });

  it("a link that is not a path on our own site", async () => {
    show();
    await openForm();
    fill();
    change(screen.getByRole("combobox"), "__other");
    change(screen.getByLabelText(m.newPost.linkOtherLabel), "https://evil.example/x");
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(m.newPost.linkBad)).toBeTruthy();
    change(screen.getByLabelText(m.newPost.linkOtherLabel), "/pricing");
    expect(createButton().disabled).toBe(false);
  });

  it("a fine post can be created", async () => {
    show();
    await openForm();
    fill();
    expect(createButton().disabled).toBe(false);
  });
});

describe("banned wording: shown, never blocking", () => {
  it("a hit is a clear warning with the rule and the words found, and Create still works", async () => {
    show();
    await openForm();
    fill({ en: "Try it free today" });
    const box = document.querySelector("[data-banned=hits]")!;
    expect(box.textContent).toContain(m.newPost.banned.rules.free);
    expect(box.textContent).toContain("English: “free”");
    expect(createButton().disabled).toBe(false);
  });

  it("finds a claim in Russian and Uzbek, and a provider name", async () => {
    show();
    await openForm();
    fill({ ru: "Попробуйте бесплатно", uz: "Eng yaxshi muharrir", en: "Powered by OpenAI" });
    const ids = [...document.querySelectorAll("[data-banned-id]")].map((e) => e.getAttribute("data-banned-id"));
    expect(ids.sort()).toEqual(["free", "provider:openai", "superlative"]);
    expect(screen.getByText(/Names an AI model or provider \(openai\)/)).toBeTruthy();
  });

  it("nothing found says so, and is not a promise", async () => {
    show();
    await openForm();
    fill();
    expect(document.querySelector("[data-banned=none]")!.textContent).toContain(m.newPost.banned.none);
  });

  it("the confirm sheet repeats the hits so the owner decides with them in front of him", async () => {
    show();
    await openForm();
    fill({ en: "Unlimited videos" });
    await tap(createButton());
    expect(sheet().textContent).toContain(m.newPost.dBanned);
    expect(sheet().textContent).toContain(m.newPost.banned.rules.unlimited);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("the sheet says 'none found' when there is none", async () => {
    show();
    await openForm();
    fill();
    await tap(createButton());
    expect(within(sheet()).getByText(m.newPost.dBannedNone)).toBeTruthy();
  });
});

describe("creating", () => {
  const confirmKey = () => within(sheet()).getByRole("button", { name: m.newPost.confirmButton });

  it("the first tap only asks 'Create draft?': the sheet repeats the kind, the three texts, the link and the size; nothing is sent", async () => {
    show();
    await openForm();
    fill();
    change(screen.getByRole("combobox"), "/pricing");
    await tap(createButton());
    expect(h.fetch).not.toHaveBeenCalled();
    const dlg = sheet();
    expect(dlg.textContent).toContain("Create draft?");
    expect(dlg.textContent).toContain(m.kind.custom);
    for (const text of Object.values(WORDS)) expect(within(dlg).getByText(text)).toBeTruthy();
    expect(dlg.textContent).toContain("https://nightshift-ai.studio/pricing");
    expect(dlg.textContent).toMatch(/Whole message: \d+ of 4096/);
  });

  it("a draft is not public, so the sheet asks no typed word (approving is the step that does)", async () => {
    show();
    await openForm();
    fill();
    await tap(createButton());
    expect(within(sheet()).queryByRole("textbox")).toBeNull();
    expect((confirmKey() as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends create with the request id, the trimmed texts and the link, and nothing else; then reloads the list and points at the draft", async () => {
    show();
    await openForm();
    fill({ en: "  New: projects save faster.  " });
    change(screen.getByRole("combobox"), "/pricing");
    await tap(createButton());
    await tap(confirmKey());
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const { url, body } = sent();
    expect(url).toBe("/api/marketing");
    expect(Object.keys(body).sort()).toEqual(["action", "link", "requestId", "texts"]);
    expect(body).toMatchObject({ action: "create", link: "/pricing", texts: WORDS });
    expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.refresh).toHaveBeenCalled();
    expect(document.querySelector("textarea[lang]")).toBeNull();
    const done = document.querySelector("[data-new-post-done=created]")!;
    expect(done.textContent).toContain(m.newPost.created);
    expect(within(done as HTMLElement).getByRole("link", { name: m.newPost.showDraft }).getAttribute("href")).toBe(`#mk-post-${NEW_ID}`);
  });

  it("no link is sent as null", async () => {
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(sent().body.link).toBeNull();
  });

  it("a double tap on the key is one request", async () => {
    let done: (r: Response) => void = () => {};
    h.fetch.mockImplementation(() => new Promise<Response>((r) => (done = r)));
    show();
    await openForm();
    fill();
    await tap(createButton());
    const go = confirmKey();
    fireEvent.click(go);
    fireEvent.click(go);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await act(async () => done(created()));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a retry after a refusal or a lost answer sends the SAME request id; a new screen sends a different one", async () => {
    h.fetch.mockImplementationOnce(async () => jsonRes({ ok: false, error: "rate_limited" }, 429));
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(within(sheet()).getByRole("alert").textContent).toContain(m.err.rate_limited);
    await tap(confirmKey()); // the same sheet, the key works again
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1).body.requestId).toBe(sent(0).body.requestId);
    // a second New post screen is a second post
    await openForm();
    fill({ en: "Another one" });
    await tap(createButton());
    await tap(confirmKey());
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(sent(2).body.requestId).not.toBe(sent(0).body.requestId);
  });

  it("a failed answer keeps the form and the words, and says why in the sheet", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "bad_link" }, 422));
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(within(sheet()).getByRole("alert").textContent).toBe(m.err.bad_link);
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(field("en").value).toBe(WORDS.en);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["bad_texts", m.err.bad_texts],
    ["bad_link", m.err.bad_link],
    ["bad_request_id", m.err.bad_request_id],
    ["bad_kind", m.err.bad_kind],
    ["key_reused", m.err.key_reused],
    ["mfa_required", m.err.mfa_required],
  ])("%s is worded in the sheet", async (code, text) => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: code }, code === "mfa_required" ? 401 : 422));
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(within(sheet()).getByRole("alert").textContent).toBe(text);
  });

  it("the same screen again (created: false) says nothing new was made, and a different text is not silently dropped", async () => {
    h.fetch.mockImplementation(async () => created({ created: false, same_texts: true }));
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(document.querySelector("[data-new-post-done=existing]")!.textContent).toContain(m.newPost.existing);
    cleanup();
    h.fetch.mockImplementation(async () => created({ created: false, same_texts: false }));
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(document.querySelector("[data-new-post-done=existingDifferent]")!.textContent).toContain(m.newPost.existingDifferent);
  });

  it("never approves: the body names no approve, no kind and no hash", async () => {
    show();
    await openForm();
    fill();
    await tap(createButton());
    await tap(confirmKey());
    expect(JSON.stringify(sent().body)).not.toMatch(/approve|contentHash|kind|promo/);
  });
});

describe("custom and promo posts are ordinary cards", () => {
  it.each([
    ["custom", "Custom post", "owner:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ["promo", "Promo", "promo:welcome"],
  ])("%s: titled %s, a Telegram preview, an Approve that sends the hash the page showed, Edit and Reject", async (kind, label, source) => {
    show([row({ kind, source_ref: source })]);
    const card = screen.getByRole("article");
    expect(within(card).getByRole("heading", { name: label })).toBeTruthy();
    expect(card.hasAttribute("data-post-other")).toBe(false);
    expect(card.querySelector("[data-telegram-preview]")).toBeTruthy();
    // a custom post's source is the owner's user id: the buttons are named by the kind instead; the visible source line stays
    const named = kind === "custom" ? label : source;
    expect(within(card).getByRole("button", { name: `Edit the texts of this post: ${named}` })).toBeTruthy();
    expect(within(card).getByRole("button", { name: `Reject this post: ${named}` })).toBeTruthy();
    expect(card.textContent).toContain(source);
    expect(card.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "").not.toContain("owner:");
    const approve = within(card).getByRole("button", { name: `Approve this post for publishing: ${named}` }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    await tap(approve);
    expect(sheet().textContent).toContain(label);
    fireEvent.change(within(sheet()).getByRole("textbox"), { target: { value: m.approve.word } });
    await tap(within(sheet()).getByRole("button", { name: m.approve.confirm }));
    expect(sent().body).toEqual({ action: "approve", id: ID, contentHash: HASH });
  });

  it("a kind that is truly unknown is still Other, next to a custom post", () => {
    const other = coerceListedPost({ id: NEW_ID, kind: "banner", target: "telegram", status: "draft", texts: WORDS, source_ref: "x", content_hash: HASH, created_at: "2026-10-18T08:00:00Z" })!;
    show([row(), other]);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Custom post" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other kind: banner" })).toBeTruthy();
  });
});

describe.each(["ru", "uz"] as const)("in %s", (loc) => {
  it("the form, the banned-wording box and the sheet use that language's own words", async () => {
    h.locale = loc;
    const d = loc === "ru" ? ru : uz;
    show();
    await tap(screen.getByRole("button", { name: d.marketing.newPost.aria }));
    fill({ en: "free" });
    expect(screen.getByText(d.marketing.newPost.banned.title)).toBeTruthy();
    expect(document.querySelector("[data-banned=hits]")!.textContent).toContain(d.marketing.newPost.banned.rules.free);
    await tap(screen.getByRole("button", { name: d.marketing.newPost.create }));
    expect(sheet().textContent).toContain(d.marketing.newPost.confirmTitle);
    expect(d.marketing.newPost.confirmTitle).not.toBe(en.marketing.newPost.confirmTitle);
  });

  it("the kind labels are that language's own", () => {
    h.locale = loc;
    const d = loc === "ru" ? ru : uz;
    show([row()]);
    expect(screen.getByRole("heading", { name: d.marketing.kind.custom })).toBeTruthy();
  });
});

describe("without a known site address", () => {
  it("the link is left out of the count and the total says 'at least'; creating still works", async () => {
    show([], null);
    await openForm();
    fill();
    change(screen.getByRole("combobox"), "/pricing");
    expect(screen.getByText(/Whole message: at least \d+ of 4096/)).toBeTruthy();
    expect(createButton().disabled).toBe(false);
  });
});
