// @vitest-environment jsdom
/**
 * The create form keeps an unfinished draft for this tab (lib/create-draft.ts):
 * restored on reload for the same user + organization + channel, never another's,
 * gone after 24 hours, after a started run, on Discard and on sign-out. It is
 * never sent anywhere or written outside sessionStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), signOut: vi.fn(async () => ({})) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, refresh: nav.refresh }), usePathname: () => "/chronos/create" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: nav.signOut } }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { CreateStudio } from "@/components/create/CreateStudio";
import { SignOutButton } from "@/components/SignOutButton";
import { AccountMenu } from "@/components/account/AccountMenu";
import { useSignOut } from "@/components/account/AccountParts";
import { DRAFT_PREFIX, DRAFT_TTL_MS, DRAFT_VERSION, draftKey, writeDraft, type DraftScope } from "@/lib/create-draft";

const t = dictionaries.en;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = { supported: true, enforced: true, exempt: false, estimate: { credits: 120, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 };
const SECRET = "My very private idea about a locked room";

const me: DraftScope = { userId: "user-1", orgId: "org-1", channelId: "chan-a" };
let calls: { url: string; init?: RequestInit }[];
let runAnswer: () => Promise<Response>;
const beacon = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  calls = [];
  runAnswer = () => json({ ok: true });
  beacon.mockReset();
  Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
  nav.push.mockReset();
  nav.signOut.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/credits/estimate")) return json(priced);
      if (String(url).startsWith("/api/agent/run")) return runAnswer();
      if (String(url).startsWith("/api/agent/events")) return json({ events: [], jobs: null });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = Partial<Parameters<typeof CreateStudio>[0]>;
const studio = (props: Props = {}) => (
  <I18nProvider locale="en">
    <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun userId="user-1" orgId="org-1" {...props} />
  </I18nProvider>
);
const topic = () => screen.getByRole("textbox", { name: t.create.flow.topicTitle }) as HTMLTextAreaElement;
const wait = (ms = 450) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const stored = () => Object.keys(window.sessionStorage).filter((k) => k.startsWith(DRAFT_PREFIX));
const lengthShown = () => document.querySelectorAll(".fl-choice-value")[0].textContent;

async function typeAndLeave(text = SECRET) {
  const view = render(studio());
  fireEvent.change(topic(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(t.create.flow.lengthLabel) }));
  fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(t.create.flow.lookLabel) }));
  fireEvent.change(screen.getByPlaceholderText(t.create.flow.lookPlaceholder), { target: { value: "warm documentary" } });
  await wait();
  view.unmount();
}

describe("restore on reload", () => {
  it("brings back the topic and the three choices, and says so", async () => {
    await typeAndLeave();
    expect(stored()).toEqual([draftKey(me)]);
    render(studio());
    await screen.findByTestId("draft-restored");
    expect(topic().value).toBe(SECRET);
    expect(lengthShown()).toBe(t.agents.runDur5m);
    expect(document.querySelectorAll(".fl-choice-value")[2].textContent).toBe("warm documentary");
    expect(screen.getByTestId("draft-restored").textContent).toContain(t.create.flow.draftRestored);
  });

  it("a hand-off from Home's query wins over the draft, and leaves the stored draft alone until the person edits or discards", async () => {
    await typeAndLeave();
    render(studio({ initial: { brief: "From the link", duration: "60", language: "" } }));
    await wait(1700);
    expect(topic().value).toBe("From the link");
    expect(screen.queryByTestId("draft-restored")).toBeNull();
    // Still there after the debounce and well past it: the link was not a decision to throw it away.
    expect(stored()).toEqual([draftKey(me)]);
    expect(JSON.parse(window.sessionStorage.getItem(draftKey(me)) as string).topic).toBe(SECRET);
    // Editing is the decision: from then on the draft is what they are writing now.
    fireEvent.change(topic(), { target: { value: "From the link, edited" } });
    await wait();
    expect(JSON.parse(window.sessionStorage.getItem(draftKey(me)) as string).topic).toBe("From the link, edited");
  });

  it("an untouched form leaves nothing behind", async () => {
    render(studio());
    await wait();
    expect(stored()).toEqual([]);
    fireEvent.change(topic(), { target: { value: "x" } });
    await wait();
    expect(stored()).toHaveLength(1);
    fireEvent.change(topic(), { target: { value: "" } });
    await wait();
    expect(stored()).toEqual([]);
  });

  it("without a signed-in user and organization nothing is kept or restored", async () => {
    window.sessionStorage.setItem(draftKey(me), "{}");
    render(studio({ userId: "" }));
    fireEvent.change(topic(), { target: { value: SECRET } });
    await wait();
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain(SECRET);
  });
});

describe("a draft from another context is never shown", () => {
  const seed = (scope: DraftScope) => writeDraft(window.sessionStorage, scope, { topic: "Another tenant's text", duration: "600", voice: "", look: "" });

  it.each([
    ["user", { ...me, userId: "user-2" }],
    ["organization", { ...me, orgId: "org-2" }],
    ["channel", { ...me, channelId: "chan-b" }],
  ])("another %s: ignored and removed", async (_n, other) => {
    seed(other);
    render(studio());
    await wait(50);
    expect(topic().value).toBe("");
    expect(screen.queryByTestId("draft-restored")).toBeNull();
    expect(stored()).toEqual([]);
  });

  it("moving the mounted form to another channel starts it over and never saves the old text under the new one", async () => {
    const view = render(studio());
    fireEvent.change(topic(), { target: { value: SECRET } });
    await wait();
    expect(stored()).toEqual([draftKey(me)]);
    view.rerender(studio({ channelId: "chan-b" }));
    await wait();
    expect(topic().value).toBe("");
    expect(stored()).toEqual([]);
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain(SECRET);
  });
});

describe("a draft expires", () => {
  it("one saved more than 24 hours ago is ignored and removed", async () => {
    writeDraft(window.sessionStorage, me, { topic: "Stale", duration: "", voice: "", look: "" }, Date.now() - DRAFT_TTL_MS - 1000);
    render(studio());
    await wait(50);
    expect(topic().value).toBe("");
    expect(stored()).toEqual([]);
  });

  it("one from an older schema version is ignored and removed", async () => {
    window.sessionStorage.setItem(`${DRAFT_PREFIX}v${DRAFT_VERSION - 1}.user-1.org-1.chan-a`, JSON.stringify({ v: DRAFT_VERSION - 1, ...me, savedAt: Date.now(), topic: "Old", duration: "", voice: "", look: "" }));
    render(studio());
    await wait(50);
    expect(topic().value).toBe("");
    expect(stored()).toEqual([]);
  });
});

describe("the draft is cleared", () => {
  it("when the run starts, and is not written back afterwards", async () => {
    render(studio());
    await screen.findByText(/About 120 credits/);
    fireEvent.change(topic(), { target: { value: SECRET } });
    await wait();
    expect(stored()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(screen.getByText(t.create.queued)).toBeTruthy();
    expect(stored()).toEqual([]);
    await wait();
    expect(stored()).toEqual([]);
  });

  it("a failed run keeps it, so the person can try again", async () => {
    render(studio());
    await screen.findByText(/About 120 credits/);
    fireEvent.change(topic(), { target: { value: SECRET } });
    runAnswer = () => json({ error: "insufficient_credits", available: 1, needed: 120 }, 402);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await wait();
    expect(stored()).toEqual([draftKey(me)]);
  });

  it("on Discard: the form goes back to how it started and nothing is kept", async () => {
    await typeAndLeave();
    render(studio());
    fireEvent.click(await screen.findByRole("button", { name: t.create.flow.draftDiscard }));
    expect(topic().value).toBe("");
    expect(lengthShown()).toBe(t.create.flow.lengthDefault);
    expect(screen.queryByTestId("draft-restored")).toBeNull();
    await wait();
    expect(stored()).toEqual([]);
  });

  it("on sign-out (SignOutButton), whoever's drafts they were, before the session call", async () => {
    window.sessionStorage.setItem(draftKey(me), "x");
    window.sessionStorage.setItem(draftKey({ ...me, userId: "u9" }), "y");
    window.sessionStorage.setItem("unrelated", "keep");
    nav.signOut.mockImplementation(async () => {
      expect(stored()).toEqual([]);
      return {};
    });
    render(
      <I18nProvider locale="en">
        <SignOutButton />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: t.common.signOut }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(nav.signOut).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
  });
});

describe("the account menu's sign-out clears it too", () => {
  it("every draft in the tab goes before the session call", async () => {
    window.sessionStorage.setItem(draftKey(me), "x");
    // The menu carries the theme toggle, which reads the system preference.
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
    nav.signOut.mockImplementation(async () => {
      expect(stored()).toEqual([]);
      return {};
    });
    render(
      <I18nProvider locale="en">
        <AccountMenu email="me@example.com" />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /account|me@example.com|menu/i }));
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(t.common.signOut) }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(nav.signOut).toHaveBeenCalled();
  });
});

describe("the shared sign-out (the panel and Settings → Account) clears it", () => {
  it("useSignOut removes every draft before the session call", async () => {
    window.sessionStorage.setItem(draftKey(me), "x");
    nav.signOut.mockImplementation(async () => {
      expect(stored()).toEqual([]);
      return {};
    });
    function Out() {
      const out = useSignOut();
      return <button onClick={() => void out()}>out</button>;
    }
    render(<Out />);
    fireEvent.click(screen.getByRole("button", { name: "out" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(nav.signOut).toHaveBeenCalled();
  });
});

describe("the draft goes nowhere", () => {
  it("typing, reloading and restoring send no request, beacon, URL change or local storage; only the run itself carries the text", async () => {
    const hrefBefore = window.location.href;
    await typeAndLeave();
    render(studio());
    await screen.findByTestId("draft-restored");
    await wait();
    // There is no analytics or telemetry layer in this app; pin that the create form adds none.
    expect(calls.filter((c) => JSON.stringify(c).includes(SECRET))).toEqual([]);
    expect(calls.every((c) => c.url.startsWith("/api/credits/estimate"))).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).not.toContain("draft");
    // The one place the text leaves the page is the run the person confirmed.
    await screen.findByText(/About 120 credits/);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(calls.filter((c) => JSON.stringify(c).includes(SECRET)).map((c) => c.url)).toEqual(["/api/agent/run"]);
  });

  it("nothing but the topic, the three choices and their scope is in the stored record: no price, key or credential", async () => {
    await typeAndLeave();
    const raw = window.sessionStorage.getItem(draftKey(me)) as string;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["channelId", "duration", "look", "orgId", "savedAt", "topic", "userId", "v", "voice"]);
    expect(raw).not.toMatch(/idempotency|max_credits|token|secret|password|create-/i);
  });
});
