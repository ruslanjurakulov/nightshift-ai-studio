// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

/**
 * Lens 14 on PR #843. What would break without these: a keyboard or screen-reader user typing a message and finding focus on <body>
 * when the answer arrives (the box is disabled for the turn); focus pulled into the panel from a field elsewhere on the page; three
 * scenario buttons all announced as "Choose this one", so the person cannot tell which plan they are choosing.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/studio" }));

const scenario = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 60, scenes: [{}], characters: [{}] });
const TITLES = ["Alpha heist", "Beta storm", "Gamma tide"];

type Turn = { release: () => void };
let turn: Turn | null = null;
let turnStatus = 200;

function stubFetch(onTurn?: () => void) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/session/")) {
      return json(200, {
        session: { step: "proposing" }, card: null, brief: null,
        messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: TITLES.map(scenario) } }],
      });
    }
    if (url.startsWith("/api/brain/turn")) {
      onTurn?.();
      await new Promise<void>((r) => { turn = { release: r }; });
      return turnStatus === 200
        ? json(200, { session: { id: "s1" }, reply: "Done", step: "proposing", card: null, scenarios: [] })
        : json(turnStatus, { error: "model_failed", session: { id: "s1" } });
    }
    return json(200, { plan: { used: 0, limit: 10, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session: { id: "s1" } });
  }));
}

function mount(locale: Locale) {
  return render(
    <I18nProvider locale={locale}>
      <input data-testid="elsewhere" />
      <NightshiftAiPanel channelId="c1" channelSlug="chronos" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  turn = null;
  turnStatus = 200;
  // jsdom has no layout, hence no scrollIntoView; the panel calls it to follow the newest message.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Nightshift AI panel focus", () => {
  const box = () => document.getElementById("ns-ai-input") as HTMLTextAreaElement;

  it.each([[200], [500]])("gives focus back to the box after a turn that ended with status %i, when focus was in the panel", async (status) => {
    turnStatus = status;
    // A browser drops focus when a focused control becomes disabled; jsdom does not, so the turn's request does it.
    stubFetch(() => box().blur());
    mount("en");
    await waitFor(() => expect(box()).toBeTruthy());
    box().focus();
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().disabled).toBe(true));
    expect(document.activeElement).not.toBe(box());
    turn!.release();
    await waitFor(() => expect(box().disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("does not take focus from a field elsewhere on the page", async () => {
    stubFetch();
    mount("en");
    await waitFor(() => expect(box()).toBeTruthy());
    const other = screen.getByTestId("elsewhere");
    // The turn is sent from the button path (no focus in the panel): focus is on the other field the whole time.
    fireEvent.change(box(), { target: { value: "hello" } });
    other.focus();
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(box().disabled).toBe(true));
    turn!.release();
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(document.activeElement).toBe(other);
  });
});

describe("Nightshift AI panel scenario buttons", () => {
  it.each(["en", "ru", "uz"] as const)("names each Choose button with its scenario title (%s)", async (locale) => {
    stubFetch();
    mount(locale);
    const template = dictionaries[locale].aiChat.chooseThisNamed;
    await waitFor(() => expect(screen.getAllByRole("button", { name: new RegExp(TITLES[0]) }).length).toBe(1));
    const names = TITLES.map((title) => {
      const b = screen.getByRole("button", { name: template.replace("{title}", title) });
      return b.getAttribute("aria-label");
    });
    expect(new Set(names).size).toBe(3);
    TITLES.forEach((title, i) => expect(names[i]).toContain(title));
  });
});
