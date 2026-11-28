// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

/**
 * The chat panel meeting a film editor's storyboard conversation (/api/brain/turn's 409 `film_conversation`, opened here through a
 * link or the history). What would break without these: the raw code, or "unavailable, try again", where the person needs to be
 * told the conversation is the film's and be taken to that film's editor; a Retry that can only meet the same refusal.
 */
vi.mock("@/lib/legal", () => ({ LEGAL: { contactEmail: "help@example.test" } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FILM = "bbbbbbbb-0000-4000-8000-000000000002";
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }], scenes: [],
  chapters: [{ id: "ch1", title: "a", seconds: 60, beats: [] }, { id: "ch2", title: "b", seconds: 60, beats: [] }] });

let turnReply: { status: number; body: unknown } = { status: 409, body: {} };

function stub(proposing: boolean) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        return json(200, proposing
          ? { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" }, plan: null,
              messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] }
          : { session: { id: S1, step: "asking" }, card: null, brief: null, messages: [] });
      }
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) return json(turnReply.status, turnReply.body);
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true,
                       session: proposing ? { id: S1 } : null, gate: null });
  }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const expectFilmConversation = (locale: "en" | "ru" | "uz", withLink: boolean) => {
  const a = dictionaries[locale].aiChat;
  expect(screen.getAllByText(a.errors.film_conversation)).toHaveLength(1);
  const link = screen.queryByRole("link", { name: a.openFilm });
  expect(link?.getAttribute("href") ?? null).toBe(withLink ? `/chronos/create/projects/${FILM}` : null);
  // Never the code: not as text, not in an attribute.
  expect(document.body.innerHTML).not.toContain("film_conversation");
  expect(screen.queryByRole("button", { name: a.retry })).toBeNull();
};

describe("a film's storyboard conversation in the chat", () => {
  it("a message sent in it is answered with its words and a link to that film's editor, in en, ru and uz", async () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      turnReply = { status: 409, body: { error: "film_conversation", film_id: FILM } };
      stub(false);
      const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
      await waitFor(() => expect(document.getElementById("ns-ai-input")).not.toBeNull());
      const box = document.getElementById("ns-ai-input") as HTMLTextAreaElement;
      await waitFor(() => expect(box.disabled).toBe(false));
      fireEvent.change(box, { target: { value: "a film about the sea" } });
      await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
      await waitFor(() => expect(screen.queryByText(dictionaries[locale].aiChat.errors.film_conversation)).not.toBeNull());
      expectFilmConversation(locale, true);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("choosing an outline in it says the same, with the link; without a film id the words stand alone", async () => {
    turnReply = { status: 409, body: { error: "film_conversation", film_id: FILM } };
    stub(true);
    const view = render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    const en = dictionaries.en.aiChat;
    fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }));
    await waitFor(() => expect(screen.queryByText(en.errors.film_conversation)).not.toBeNull());
    expectFilmConversation("en", true);
    view.unmount();
    vi.unstubAllGlobals();

    turnReply = { status: 409, body: { error: "film_conversation" } };
    stub(true);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }));
    await waitFor(() => expect(screen.queryByText(en.errors.film_conversation)).not.toBeNull());
    expectFilmConversation("en", false);
  });
});
