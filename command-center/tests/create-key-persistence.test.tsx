// @vitest-environment jsdom
/**
 * The reload case, through the real forms (CreateStudio, RunNowButton): a press whose answer never
 * arrived, then the tab is reloaded (a NEW mount over the same sessionStorage), then the person
 * presses again. That must be the same key, so the server replays instead of holding credits twice.
 * Also: another user / channel / topic / option does not get the key, the topic text is nowhere in
 * storage, and both sign-out paths clear the entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const signOutMock = vi.fn(() => Promise.resolve({ error: null }));
let signOutImpl: () => Promise<unknown> = () => signOutMock();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/create" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: () => signOutImpl() } }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { CreateStudio } from "@/components/create/CreateStudio";
import { RunNowButton } from "@/components/agents/RunNowButton";
import { SignOutButton } from "@/components/SignOutButton";
import { useSignOut } from "@/components/account/AccountParts";
import { ATTEMPT_PREFIX } from "@/lib/create-attempt-store";

const t = dictionaries.en;
const f = t.create.flow;
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const TOPIC = "Secret Documentary About Ancient Khiva";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = (credits: number) => ({ supported: true, enforced: true, exempt: false, estimate: { credits, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 });

let calls: { url: string; init?: RequestInit }[];
let runAnswer: () => Promise<Response>;
const runs = () => calls.filter((c) => c.url.startsWith("/api/agent/run"));
const body = (i: number) => JSON.parse(String(runs()[i].init?.body)) as Record<string, unknown>;
const storedNames = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i) as string).filter((k) => k.startsWith(ATTEMPT_PREFIX));
const everythingStored = () => JSON.stringify({ s: { ...window.sessionStorage }, l: { ...window.localStorage } });

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  runAnswer = () => json({ ok: true });
  signOutImpl = () => signOutMock();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/credits/estimate")) return json(priced(120));
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

describe("Create: a reload after a lost answer", () => {
  const studio = (o: { channelId?: string; userId?: string; orgId?: string | null } = {}) => (
    <I18nProvider locale="en">
      <CreateStudio channelId={o.channelId ?? "chan-a"} githubConfigured agentConfig={null} canRun userId={o.userId ?? USER} orgId={o.orgId === undefined ? "org-1" : o.orgId} />
    </I18nProvider>
  );
  const topic = () => screen.getByRole("textbox", { name: f.topicTitle }) as HTMLTextAreaElement;
  const type = (v: string) => fireEvent.change(topic(), { target: { value: v } });
  const make = () => fireEvent.click(screen.getByRole("button", { name: t.create.create }));
  const confirm = async () => fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
  async function press() {
    make();
    await confirm();
    await act(async () => {});
  }
  const priceShown = () => screen.findByText(/About 120 credits/);
  const status = () => document.querySelector(".fl-status")?.textContent ?? "";

  async function loseAnswer(o: Parameters<typeof studio>[0] = {}, text = TOPIC) {
    const first = render(studio(o));
    await priceShown();
    type(text);
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    await waitFor(() => expect(status()).toContain(f.startUnsure));
    first.unmount();
    runAnswer = () => json({ ok: true });
  }

  it("the reloaded page sends the same key, and a second press after that is still the same key", async () => {
    await loseAnswer();
    expect(storedNames()).toHaveLength(1);
    render(studio());
    await priceShown();
    type(TOPIC);
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(body(1)).toEqual(body(0));
  });

  it("an answer that settles it (started) removes the entry, so the next video is a new key", async () => {
    await loseAnswer();
    render(studio());
    await priceShown();
    type(TOPIC);
    await press();
    expect(storedNames()).toHaveLength(0);
    cleanup();
    render(studio());
    await priceShown();
    type(TOPIC);
    await press();
    expect(body(2).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("a failure that kept a hold (credits_held) removes the entry; a replay (409) after a lost answer keeps it, and is not shown as started", async () => {
    await loseAnswer();
    render(studio());
    await priceShown();
    type(TOPIC);
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    // A hold exists, nothing says the run began: the honest sentence, and the key stays with its unsure state.
    expect(status()).toContain(f.startUnsureReplay);
    expect(status()).not.toContain(f.alreadySent);
    expect(storedNames()).toHaveLength(1);
    cleanup();
    render(studio());
    await priceShown();
    type(TOPIC);
    runAnswer = () => json({ error: "github_dispatch_failed", credits_held: 120 }, 502);
    await press();
    expect(storedNames()).toHaveLength(0);
  });

  it("another user on the same browser gets a new key", async () => {
    await loseAnswer();
    render(studio({ userId: "second-user" }));
    await priceShown();
    type(TOPIC);
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("another channel gets a new key", async () => {
    await loseAnswer();
    render(studio({ channelId: "chan-b" }));
    await priceShown();
    type(TOPIC);
    await press();
    expect(body(1).channel_id).toBe("chan-b");
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("another organization gets a new key", async () => {
    await loseAnswer();
    render(studio({ orgId: "org-2" }));
    await priceShown();
    type(TOPIC);
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("a changed topic gets a new key", async () => {
    await loseAnswer();
    render(studio());
    await priceShown();
    type(TOPIC + " II");
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("a changed option gets a new key", async () => {
    await loseAnswer();
    render(studio());
    await priceShown();
    type(TOPIC);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await priceShown();
    await press();
    expect(body(1).duration).toBe(300);
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("the topic, the ids and the options are nowhere in web storage", async () => {
    await loseAnswer();
    const all = everythingStored();
    for (const secret of [TOPIC, "Khiva", "Secret", USER, "chan-a", "org-1", "channel_id", "topic"]) expect(all).not.toContain(secret);
    expect(window.localStorage.length).toBe(0);
    const entry = JSON.parse(window.sessionStorage.getItem(storedNames()[0]) as string);
    expect(Object.keys(entry).sort()).toEqual(["h", "k", "t", "u", "v"]);
    expect(entry.u).toBe(true);
  });

  it("without a user id (not known) nothing is stored and a reload starts a new attempt, as before", async () => {
    await loseAnswer({ userId: "" });
    expect(window.sessionStorage.length).toBe(0);
    render(studio({ userId: "" }));
    await priceShown();
    type(TOPIC);
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("storage that throws changes nothing about the in-page retry", async () => {
    for (const m of ["getItem", "setItem", "removeItem"] as const) vi.spyOn(Storage.prototype, m).mockImplementation(() => {
      throw new Error("blocked");
    });
    render(studio());
    await priceShown();
    type(TOPIC);
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    await waitFor(() => expect(status()).toContain(f.startUnsure));
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    vi.restoreAllMocks();
  });
});

describe("Run now: a reload after a lost answer", () => {
  const view = (o: { channelId?: string; userId?: string } = {}) => (
    <I18nProvider locale="en">
      <RunNowButton channelId={o.channelId ?? "chan-a"} githubConfigured variant="inline" userId={o.userId ?? USER} orgId="org-1" />
    </I18nProvider>
  );
  const arm = () => fireEvent.click(screen.getByRole("button", { name: t.agents.runBtn }));
  async function press() {
    arm();
    await screen.findByText(/120 credits/);
    fireEvent.click(await screen.findByRole("button", { name: t.agents.runConfirm }));
    await act(async () => {});
  }

  it("the reloaded button sends the same key; another user or channel does not", async () => {
    const first = render(view());
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    first.unmount();
    expect(storedNames()).toHaveLength(1);
    expect(everythingStored()).not.toContain("chan-a");
    runAnswer = () => json({ ok: true });
    render(view());
    await press();
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(storedNames()).toHaveLength(0);

    cleanup();
    runAnswer = () => Promise.reject(new TypeError("network"));
    render(view());
    await press();
    cleanup();
    runAnswer = () => json({ ok: true });
    render(view({ userId: "second-user" }));
    await press();
    expect(body(3).idempotency_key).not.toBe(body(2).idempotency_key);
    cleanup();
    render(view({ channelId: "chan-b" }));
    await press();
    expect(body(4).idempotency_key).not.toBe(body(2).idempotency_key);
  });
});

describe("sign-out clears the entries", () => {
  const seed = () => {
    window.sessionStorage.setItem(`${ATTEMPT_PREFIX}${"a".repeat(64)}`, "{}");
    window.sessionStorage.setItem(`${ATTEMPT_PREFIX}${"b".repeat(64)}`, "{}");
    window.sessionStorage.setItem("other.key", "keep");
  };
  const left = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i));

  it("the sign-out button", async () => {
    seed();
    render(
      <I18nProvider locale="en">
        <SignOutButton />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: t.common.signOut }));
    await waitFor(() => expect(left()).toEqual(["other.key"]));
    expect(signOutMock).toHaveBeenCalled();
  });

  it("useSignOut clears them even when signing out fails (the failure still surfaces)", async () => {
    seed();
    signOutImpl = () => Promise.reject(new Error("offline"));
    let out: () => Promise<void> = async () => {};
    function Grab() {
      out = useSignOut();
      return null;
    }
    render(<Grab />);
    await expect(out()).rejects.toThrow("offline");
    expect(left()).toEqual(["other.key"]);
  });

  it("useSignOut (the account panel and Settings)", async () => {
    seed();
    function Out() {
      const out = useSignOut();
      return <button onClick={() => void out()}>out</button>;
    }
    render(<Out />);
    fireEvent.click(screen.getByRole("button", { name: "out" }));
    await waitFor(() => expect(left()).toEqual(["other.key"]));
  });
});
