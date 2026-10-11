// @vitest-environment jsdom
/**
 * Home's six goal cards (HOME_FORMATS) above the create form. A card only
 * fills that form — a starter topic and the format's usual length. The price
 * card and the two-press confirm are CreateStudio's and stay as they were;
 * nothing is sent by a card; with no runnable channel (or no right to run)
 * there are no cards, because they would lead to a dead end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/home",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { HomeHub } from "@/components/home/HomeHub";
import { CreateStudio } from "@/components/create/CreateStudio";
import { HOME_FORMATS, lengthSeconds, type HomeChannel } from "@/lib/home";
import { draftKey, writeDraft } from "@/lib/create-draft";

const t = dictionaries.en;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = { supported: true, enforced: true, exempt: false, estimate: { credits: 120, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 };

let calls: { url: string; init?: RequestInit }[];
beforeEach(() => {
  window.sessionStorage.clear();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/credits/estimate")) return json(priced);
      if (String(url).startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (String(url).startsWith("/api/agent/run")) return json({ ok: true });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channel: HomeChannel = {
  id: "chan-a",
  slug: "chronos",
  name: "Chronos",
  avatar: null,
  language: "Uzbek",
  standing: "live",
  autoPublish: false,
  lastVideo: null,
  nextRun: null,
  waiting: 0,
};
const runs = () => calls.filter((c) => c.url.startsWith("/api/agent/run"));
const topic = () => screen.getByRole("textbox", { name: t.create.flow.topicTitle }) as HTMLTextAreaElement;

const me = { userId: "user-1", orgId: "org-1", channelId: "chan-a" };
const wait = (ms = 600) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const stored = () => Object.keys(window.sessionStorage).filter((k) => k.startsWith("nightshift.create.draft."));

function home(over: { assistant?: { canRun: boolean; runConfigured: boolean } | null; withRun?: boolean; locale?: Locale; channels?: HomeChannel[] } = {}) {
  const { assistant = { canRun: true, runConfigured: true }, withRun = true, locale = "en", channels = [channel] } = over;
  return render(
    <I18nProvider locale={locale}>
      <HomeHub
        channels={channels}
        currentSlug="chronos"
        orgId={null}
        allPrivate
        assistant={assistant ? { models: [], ...assistant } : undefined}
        run={withRun ? <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun draftOwner={{ userId: "user-1", orgId: "org-1" }} /> : undefined}
      />
    </I18nProvider>,
  );
}

describe("the goal cards", () => {
  it("shows the six existing formats, with who each is for, above the create form", () => {
    home();
    const list = document.querySelector(".home-goals") as HTMLElement;
    expect(within(list).getAllByRole("button")).toHaveLength(HOME_FORMATS.length);
    for (const f of HOME_FORMATS) {
      expect(within(list).getByText(t.home.formats[f.id].title)).toBeTruthy();
      expect(within(list).getByText(t.home.formats[f.id].who)).toBeTruthy();
    }
    // Above the form, in the same column.
    const form = document.getElementById("run") as HTMLElement;
    expect(list.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(t.home.formatsHint)).toBeTruthy();
  });

  it("a card fills the topic with its starter and sets the format's usual length; nothing is sent", async () => {
    home();
    await screen.findByText(/About 120 credits/);
    for (const f of HOME_FORMATS) {
      fireEvent.click(document.querySelector(`[data-goal="${f.id}"]`) as HTMLElement);
      expect(topic().value).toBe(t.home.formats[f.id].starter);
      const lengthLabel = {
        60: t.agents.runDur1m,
        180: t.agents.runDur3m,
        300: t.agents.runDur5m,
        600: t.agents.runDur10m,
        1200: t.agents.runDur20m,
      }[lengthSeconds(f.length)];
      expect(document.querySelectorAll(".fl-choice-value")[0].textContent).toBe(lengthLabel);
    }
    expect(runs()).toHaveLength(0);
  });

  it("the price card and the two-press confirm are unchanged: pick, then Make asks, only the confirm sends", async () => {
    home();
    await screen.findByText(/About 120 credits/);
    fireEvent.click(document.querySelector('[data-goal="shorts"]') as HTMLElement);
    // The length changed, so the card asks the price again, for that length.
    await act(async () => {});
    expect(calls.some((c) => c.url.includes("duration=60"))).toBe(true);
    await screen.findByText(/About 120 credits/);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    expect(runs()).toHaveLength(0);
    expect(screen.getByRole("button", { name: t.create.confirm })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(JSON.parse(String(runs()[0].init?.body))).toMatchObject({ topic: t.home.formats.shorts.starter, duration: 60, max_credits: 120 });
  });

  it("picking a card while the confirm is open asks again: what it would start has changed", async () => {
    home();
    await screen.findByText(/About 120 credits/);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    expect(screen.getByRole("button", { name: t.create.confirm })).toBeTruthy();
    fireEvent.click(document.querySelector('[data-goal="story"]') as HTMLElement);
    expect(screen.queryByRole("button", { name: t.create.confirm })).toBeNull();
    expect(screen.getByRole("button", { name: t.create.create })).toBeTruthy();
    expect(runs()).toHaveLength(0);
  });

  it("choosing the same card again refills the form after it was edited, and says to replace the [brackets]", async () => {
    home();
    const card = document.querySelector('[data-goal="kids"]') as HTMLElement;
    fireEvent.click(card);
    expect(screen.getByTestId("brackets-hint").textContent).toBe(t.create.flow.bracketsHint);
    fireEvent.change(topic(), { target: { value: "A gentle story for kids about a fox who learns patience" } });
    expect(screen.queryByTestId("brackets-hint")).toBeNull();
    fireEvent.click(card);
    expect(topic().value).toBe(t.home.formats.kids.starter);
  });

  it("puts the caret on the first [bracket] once the card's text is in the box, every time", async () => {
    home();
    for (const id of ["explainer", "interview", "explainer", "explainer"] as const) {
      fireEvent.click(document.querySelector(`[data-goal="${id}"]`) as HTMLElement);
      await act(async () => {});
      const starter = t.home.formats[id].starter;
      expect(topic().value).toBe(starter);
      expect(document.activeElement).toBe(topic());
      expect(topic().value.slice(topic().selectionStart, topic().selectionEnd)).toBe(starter.slice(starter.indexOf("["), starter.indexOf("]") + 1));
    }
  });

  it("picking a card hides 'your draft is back' (the box now holds the card's text) and drops the old draft", async () => {
    writeDraft(window.sessionStorage, me, { topic: "My earlier idea", duration: "", voice: "", look: "" });
    home();
    await screen.findByTestId("draft-restored");
    expect(topic().value).toBe("My earlier idea");
    fireEvent.click(document.querySelector('[data-goal="story"]') as HTMLElement);
    expect(screen.queryByTestId("draft-restored")).toBeNull();
    expect(topic().value).toBe(t.home.formats.story.starter);
    await wait();
    expect(stored()).toEqual([]);
  });

  it("the card's own text is not kept as a draft; what the person writes after it is", async () => {
    home();
    fireEvent.click(document.querySelector('[data-goal="kids"]') as HTMLElement);
    await wait();
    expect(stored()).toEqual([]);
    fireEvent.change(topic(), { target: { value: "A gentle story for kids about a fox who learns patience" } });
    await wait();
    expect(stored()).toEqual([draftKey(me)]);
    // Back to the card's text exactly: nothing of the person's is left to keep.
    fireEvent.click(document.querySelector('[data-goal="kids"]') as HTMLElement);
    await wait();
    expect(stored()).toEqual([]);
  });

  it("no cards where they would lead nowhere: no runnable channel, no right to run, or Run now not set up", () => {
    home({ withRun: false, channels: [] });
    expect(document.querySelector(".home-goals")).toBeNull();
    expect(screen.getByText(t.home.noChannelsTitle)).toBeTruthy();
    cleanup();
    home({ assistant: { canRun: false, runConfigured: true } });
    expect(document.querySelector(".home-goals")).toBeNull();
    cleanup();
    home({ assistant: { canRun: true, runConfigured: false } });
    expect(document.querySelector(".home-goals")).toBeNull();
  });

  it("the Create page's form, with no cards around it, is untouched by the preset mechanism", () => {
    render(
      <I18nProvider locale="en">
        <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun />
      </I18nProvider>,
    );
    expect(topic().value).toBe("");
    expect(document.querySelector(".home-goals")).toBeNull();
  });

  it("every title, audience and starter exists in all three languages", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc];
      for (const f of HOME_FORMATS) {
        const x = d.home.formats[f.id];
        for (const s of [x.title, x.who, x.starter]) expect(s.trim().length).toBeGreaterThan(0);
        expect(x.starter).toMatch(/\[[^\]]+\]/);
      }
      for (const s of [d.home.formatsTitle, d.home.formatsHint, d.create.flow.bracketsHint]) expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
