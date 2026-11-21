// @vitest-environment jsdom
/**
 * The attempt's remembered state (unsure / blocked / the scope full) lives in sessionStorage, which the server
 * render cannot see. It is therefore read AFTER mount: the server and the first client render agree (no hydration
 * mismatch while the scope holds entries), nothing can be sent until the state has been read for the intent on
 * screen (Make is disabled), what is typed right after load is kept, and the notices appear one tick later.
 * Also: if `keyFor` ever throws, the form does not hang in "starting".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({ throwKey: null as unknown }));
vi.mock("@/lib/create-attempt", async (orig) => {
  const m = await orig<typeof import("@/lib/create-attempt")>();
  return {
    ...m,
    createAttempt: (...a: Parameters<typeof m.createAttempt>) => {
      const at = m.createAttempt(...a);
      return {
        ...at,
        keyFor: (...x: Parameters<typeof at.keyFor>) => {
          if (hoisted.throwKey) throw hoisted.throwKey;
          return at.keyFor(...x);
        },
      };
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/create" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { CreateStudio } from "@/components/create/CreateStudio";
import { RunNowButton } from "@/components/agents/RunNowButton";
import { AttemptsFullError, MAX_PROTECTED_PER_SCOPE, createAttempt } from "@/lib/create-attempt";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";

const t = dictionaries.en;
const f = t.create.flow;
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const SCOPE = { userId: USER, orgId: "org-1", channelId: "chan-a" };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = { supported: true, enforced: true, exempt: false, estimate: { credits: 120, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 };

let calls: string[];
const mounted: { root: { unmount(): void }; container: HTMLElement }[] = [];
beforeEach(() => {
  calls = [];
  hoisted.throwKey = null;
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(String(url));
      if (String(url).startsWith("/api/credits/estimate")) return json(priced);
      if (String(url).startsWith("/api/agent/run")) return json({ ok: true });
      return json({ events: [], jobs: null });
    }),
  );
});
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAllCreateAttempts();
});

const studio = (locale: "en" = "en") => (
  <I18nProvider locale={locale}>
    <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun userId={USER} orgId="org-1" />
  </I18nProvider>
);
const runNow = () => (
  <I18nProvider locale="en">
    <RunNowButton channelId="chan-a" githubConfigured variant="inline" userId={USER} orgId="org-1" />
  </I18nProvider>
);
const runs = () => calls.filter((c) => c.startsWith("/api/agent/run"));
/** The intent of a form with nothing typed: the channel only. */
const EMPTY = JSON.stringify({ channel_id: "chan-a" });
const fieldsFor = (topic: string) => JSON.stringify({ channel_id: "chan-a", topic });

function seedFull() {
  const a = createAttempt();
  for (let i = 0; i < MAX_PROTECTED_PER_SCOPE; i++) a.markUnsure(a.keyFor(fieldsFor(`held ${i}`), SCOPE));
}

/** Server-render with the store populated (jsdom has a window, as a worst case), then hydrate it for real. */
async function hydrate(node: ReactNode) {
  const html = renderToString(node);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const recoverable: unknown[] = [];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let root!: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(container, node, { onRecoverableError: (e) => recoverable.push(e) });
  });
  mounted.push({ root, container });
  return { html, container, recoverable, errors, root };
}

describe("Create: no hydration mismatch while the scope holds entries", () => {
  it("full scope: the server markup is the safe default (Make disabled, no notice), the client agrees, then the notice appears", async () => {
    seedFull();
    const { html, container, recoverable, errors } = await hydrate(studio());
    expect(html).not.toContain(f.startTooMany);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Make this video/);
    expect(recoverable).toEqual([]);
    expect(errors.mock.calls.filter((c) => /hydrat|did not match|mismatch/i.test(String(c[0])))).toEqual([]);
    // One tick after mount the state has been read: the notice is there and Make stays disabled.
    expect(container.querySelector(".fl-status")?.textContent).toBe(f.startTooMany);
    expect((container.querySelector("button.fl-go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a blocked and an unsure intent, with nothing else stored: same, and the blocked notice appears after mount", async () => {
    const a = createAttempt();
    a.markBlocked(120, a.keyFor(EMPTY, SCOPE));
    const { html, container, recoverable } = await hydrate(studio());
    expect(html).not.toContain("credits are held");
    expect(recoverable).toEqual([]);
    expect(container.querySelector(".fl-status")?.textContent).toBe(f.startFailedHeld.replace("{n}", "120"));
    expect((container.querySelector("button.fl-go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an empty store: Make is disabled in the server markup and enabled once the (empty) state has been read", async () => {
    const { html, container, recoverable } = await hydrate(studio());
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Make this video/);
    expect(recoverable).toEqual([]);
    expect((container.querySelector("button.fl-go") as HTMLButtonElement).disabled).toBe(false);
  });

  it("what is typed right after load is kept, and a request cannot be sent before the state is read", async () => {
    seedFull();
    const { container } = await hydrate(studio());
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: "held 3" } });
    });
    expect(box.value).toBe("held 3");
    // That is an earlier, still-unsure request: it is not refused.
    expect((container.querySelector("button.fl-go") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.change(box, { target: { value: "brand new" } });
    });
    expect(box.value).toBe("brand new");
    expect((container.querySelector("button.fl-go") as HTMLButtonElement).disabled).toBe(true);
    expect(runs()).toHaveLength(0);
  });
});

describe("Run now: the same", () => {
  it("full scope: safe server markup, no mismatch, notice after mount", async () => {
    const a = createAttempt();
    for (let i = 0; i < MAX_PROTECTED_PER_SCOPE; i++) a.markUnsure(a.keyFor(fieldsFor(`held ${i}`), SCOPE));
    const { html, container, recoverable } = await hydrate(runNow());
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain(f.startTooMany);
    expect(recoverable).toEqual([]);
    expect(container.querySelector("span[aria-live=polite]")?.textContent).toBe(f.startTooMany);
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocked: notice after mount, no mismatch", async () => {
    const a = createAttempt();
    a.markBlocked(120, a.keyFor(EMPTY, SCOPE));
    const { html, container, recoverable } = await hydrate(runNow());
    expect(html).not.toContain("credits are held");
    expect(recoverable).toEqual([]);
    expect(container.querySelector("span[aria-live=polite]")?.textContent).toBe(f.startFailedHeld.replace("{n}", "120"));
  });
});

describe("if keyFor ever throws, the form does not hang in 'starting'", () => {
  async function pressCreate() {
    render(studio());
    await screen.findByText(/About 120 credits/);
    fireEvent.change(screen.getByRole("textbox", { name: f.topicTitle }), { target: { value: "Ancient Khiva" } });
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await act(async () => {});
  }
  const status = () => document.querySelector(".fl-status")?.textContent ?? "";

  it("AttemptsFullError: the fail-closed message, no request, back to Make, and a later press works again", async () => {
    hoisted.throwKey = new AttemptsFullError();
    await pressCreate();
    expect(status()).toBe(f.startTooMany);
    expect(runs()).toHaveLength(0);
    expect(screen.queryByText(t.create.starting)).toBeNull();
    hoisted.throwKey = null;
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(runs()).toHaveLength(1);
  });

  it("any other error: the generic failure that says nothing was taken, and no hang", async () => {
    hoisted.throwKey = new Error("boom");
    await pressCreate();
    expect(status()).toBe(`${t.agents.runFailed} ${f.notTaken}`);
    expect(runs()).toHaveLength(0);
    expect(screen.queryByText(t.create.starting)).toBeNull();
    hoisted.throwKey = null;
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(runs()).toHaveLength(1);
  });

  it("Run now the same", async () => {
    hoisted.throwKey = new AttemptsFullError();
    render(runNow());
    fireEvent.click(screen.getByRole("button", { name: t.agents.runBtn }));
    await screen.findByText(/120 credits/);
    fireEvent.click(await screen.findByRole("button", { name: t.agents.runConfirm }));
    await act(async () => {});
    expect(document.querySelector("span[aria-live=polite]")?.textContent).toBe(f.startTooMany);
    expect(runs()).toHaveLength(0);
    hoisted.throwKey = new Error("boom");
    fireEvent.click(screen.getByRole("button", { name: t.agents.runBtn }));
    fireEvent.click(await screen.findByRole("button", { name: t.agents.runConfirm }));
    await act(async () => {});
    expect(document.querySelector("span[aria-live=polite]")?.textContent).toBe(`${t.agents.runFailed} ${f.notTaken}`);
    expect(screen.queryByText(t.agents.runStarting)).toBeNull();
  });
});
