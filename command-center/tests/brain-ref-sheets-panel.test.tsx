// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { RefSheetsPanel } from "@/components/brain/RefSheetsPanel";
import { FILM, SESSION, storyBrief } from "./helpers/fakeSheetsDb";
import { planSheets, type RefSheet } from "@/lib/brain/ref-sheets";

/**
 * The panel's states (fakes only). What would break without these: a price shown that the server did not compute, or a hold
 * without the person's confirm; the gate note missing, so a person expects the sheets in their film; a failed view with no way
 * back; insufficient credits or an expired session read as a generic error; nothing said to a screen reader as pictures arrive.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/chronos/studio" }));

const en = dictionaries.en.aiChat.sheets;
const brief = storyBrief();
const plan = planSheets(brief);
let answer: Record<string, unknown>;
let postAnswer: { status: number; body: Record<string, unknown> };
let posts: Record<string, unknown>[];
let getStatus = 200;

const withStatus = (sheets: RefSheet[], ch: string, stage: string | null, view: string, o: Record<string, unknown>) =>
  sheets.map((s) => (s.character_id === ch && s.stage === stage ? { ...s, views: s.views.map((v) => (v.view === view ? { ...v, ...o } : v)) } : s));

beforeEach(() => {
  posts = [];
  getStatus = 200;
  answer = { sheets: plan, model: { name: "GPT Image", film_own: true }, gate: { open: false, reason: "refs_not_on_keyframe" },
             quote: { total: 18, views: [{ view: "front" }, { view: "front" }, { view: "front" }], waiting: 6 } };
  postAnswer = { status: 200, body: { sheets: plan } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/media/")) return new Response(JSON.stringify({ urls: { thumb: "/m/t.png" } }), { status: 200 });
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(postAnswer.body), { status: postAnswer.status });
    }
    return new Response(JSON.stringify(getStatus === 200 ? answer : { error: "unauthorized" }), { status: getStatus });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (locale: "en" | "ru" | "uz" = "en") =>
  render(<I18nProvider locale={locale}><RefSheetsPanel brief={brief} sessionId={SESSION} filmId={FILM} channelSlug="chronos" /></I18nProvider>);

describe("the character sheets panel", () => {
  it("loads, then shows the backend's price on the button, and the gate-closed note", async () => {
    mount();
    expect(screen.getByRole("status").textContent).toBe(en.loading);
    const button = await screen.findByRole("button", { name: /Make character sheets · 18 credits/ });
    expect(button).toBeTruthy();
    expect(screen.getByText(en.gateClosed)).toBeTruthy();
    expect(screen.getByText("6 more views are priced once their front pictures are made.")).toBeTruthy();
    expect(screen.getByText("Drawn with GPT Image.")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("holds nothing until the confirm, which sends exactly the total the server quoted; Cancel sends nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Make character sheets/ }));
    expect(screen.getByText("This holds 18 credits now. A picture that fails is refunded.")).toBeTruthy();
    // Keyboard: the confirm takes the focus.
    expect(document.activeElement?.textContent).toBe(en.confirmYes);
    fireEvent.click(screen.getByRole("button", { name: en.cancel }));
    expect(posts).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: /Make character sheets/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: en.confirmYes })); });
    expect(posts).toEqual([{ session: SESSION, film: FILM, action: "make", max_credits: 18 }]);
  });

  it("shows no price at all when the server could not quote, only the refusal by name", async () => {
    answer = { ...answer, quote: null, refusal: "no_sheet_model" };
    mount();
    expect(await screen.findByText(en.errors.no_sheet_model)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make character sheets/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+ credits/);
  });

  it("shows making, a made picture to approve or redo, an approved one, and a failed one with Retry", async () => {
    let sheets = withStatus(plan, "c1", "a1", "front", { status: "making", job_id: "dddddddd-0000-4000-8000-000000000001" });
    sheets = withStatus(sheets, "c1", "a2", "front", { status: "ready", asset_id: "eeeeeeee-0000-4000-8000-000000000001" });
    sheets = withStatus(sheets, "c2", null, "front", { status: "failed", error: "provider_error" });
    sheets = withStatus(sheets, "c1", "a2", "side", { status: "approved", asset_id: "eeeeeeee-0000-4000-8000-000000000002" });
    answer = { ...answer, sheets };
    mount();
    expect(await screen.findByText(en.status.making)).toBeTruthy();
    expect(screen.getByText(en.status.failed)).toBeTruthy();
    expect(screen.getByText(en.status.approved)).toBeTruthy();
    expect(await screen.findByAltText("Front view of Mira (adult)")).toBeTruthy();
    // Progress for a screen reader.
    expect(screen.getByText("2 of 9 pictures made")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: en.retry })); });
    expect(posts[0]).toMatchObject({ action: "redo", character_id: "c2", stage: null, view: "front" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: en.approve })); });
    expect(posts[1]).toMatchObject({ action: "approve", character_id: "c1", stage: "a2", view: "front" });
  });

  it("says insufficient credits by name, with the way to add them", async () => {
    postAnswer = { status: 402, body: { error: "insufficient_credits", available: 3, needed: 6 } };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Make character sheets/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: en.confirmYes })); });
    expect(await screen.findByText(en.errors.insufficient_credits)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.topUp }).getAttribute("href")).toBe("/chronos/credits#topups");
  });

  it("says an expired session, with Sign in", async () => {
    getStatus = 401;
    mount();
    expect(await screen.findByText(en.errors.unauthorized)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.signIn }).getAttribute("href")).toBe("/login");
  });

  it("offers attaching only through an open gate, and only once a view is approved", async () => {
    answer = { ...answer, gate: { open: true }, sheets: withStatus(plan, "c2", null, "front", { status: "approved", asset_id: "eeeeeeee-0000-4000-8000-000000000003" }) };
    postAnswer = { status: 200, body: { attached: 1, film: { id: FILM, version: 8 }, film_quote: {} } };
    mount();
    expect(await screen.findByText(en.gateOpen)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: en.attach })); });
    expect(posts[0]).toMatchObject({ action: "attach", film: FILM });
    await waitFor(() => expect(screen.getByText("Added to 1 scene. The film was priced again.")).toBeTruthy());
  });

  it("has no attach button while the gate is closed", async () => {
    answer = { ...answer, sheets: withStatus(plan, "c2", null, "front", { status: "approved", asset_id: "eeeeeeee-0000-4000-8000-000000000003" }) };
    mount();
    await screen.findByText(en.gateClosed);
    expect(screen.queryByRole("button", { name: en.attach })).toBeNull();
  });

  it("speaks Russian and Uzbek", async () => {
    mount("uz");
    expect(await screen.findByText(dictionaries.uz.aiChat.sheets.gateClosed)).toBeTruthy();
    cleanup();
    mount("ru");
    expect(await screen.findByText(dictionaries.ru.aiChat.sheets.gateClosed)).toBeTruthy();
  });
});
