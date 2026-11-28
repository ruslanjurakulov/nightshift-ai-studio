// @vitest-environment jsdom
/**
 * The canvas inspector with the REAL composer (components/studio/GeneratePanel), not a stub.
 *
 * What would break without these: a second press on the same quote starting (and paying for) a second job, whose id then
 * replaces the first on the node so the first job drops off the canvas; and a working node offering Generate at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/studio",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, scroll: _s, ...rest }: { href: string; children: ReactNode; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/credits-live", async (orig) => ({ ...(await orig<typeof import("@/lib/credits-live")>()), refreshCredits: vi.fn() }));

import { I18nProvider } from "@/lib/i18n/context";
import { ShellProvider } from "@/components/shell/ShellContext";
import { Inspector } from "@/components/studio-canvas/Inspector";
import { UNKNOWN_TOOLS } from "@/lib/tool-availability";
import { newNode, type CanvasState } from "@/lib/studio/canvas";
import type { StudioModel } from "@/lib/creative/studio";
import type { NodeStatus } from "@/components/studio-canvas/nodeState";
import { dictionaries } from "@/lib/i18n";

const ORG = "11111111-1111-4111-8111-111111111111";
const MODELS = [{ id: "pic", displayName: "Picture", capabilities: ["t2i"], beta: false }] as unknown as StudioModel[];
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
const creates = () => fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") return json({ quote: { credits: 4 } });
    if (url.startsWith("/api/creative/jobs") && init?.method === "POST") return json({ job: { id: "j1" } });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(status: NodeStatus, onCreated = vi.fn(), onPressing?: (on: boolean, token: string) => void) {
  const n = newNode("image", 0, 0, "img", { draft: "a fox on a snowy ridge" });
  const state: CanvasState = { nodes: [n], wires: [], view: { x: 0, y: 0, k: 1 } };
  return render(
    <I18nProvider locale="en">
      <ShellProvider operator={false} tools={UNKNOWN_TOOLS}>
        <Inspector
          node={n}
          state={state}
          jobs={new Map()}
          status={status}
          closed={false}
          data={{ orgId: ORG, models: MODELS, unavailable: [], plans: null, dna: null, defaultStyleKitId: null, effects: [] }}
          previews={new Map()}
          nodeName={() => "Image"}
          sheet={false}
          onClose={vi.fn()}
          onDraft={vi.fn()}
          onCreated={onCreated}
          onPressing={onPressing}
          onWire={vi.fn()}
          onDisconnect={vi.fn()}
          onEffect={vi.fn()}
        />
      </ShellProvider>
    </I18nProvider>,
  );
}

describe("the canvas inspector with the real composer", () => {
  it("one quote makes one job: presses after the first wait for a fresh quote", async () => {
    const onCreated = vi.fn();
    mount("idle", onCreated);
    const key = await waitFor(() => {
      const b = screen.getByRole("button", { name: /^Generate/ }) as HTMLButtonElement;
      if (b.disabled) throw new Error("not quoted yet");
      return b;
    });
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("j1"));
    fireEvent.click(key);
    await new Promise((r) => setTimeout(r, 50));
    expect(creates()).toHaveLength(1);
    expect((screen.getByRole("button", { name: /^Generate/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a working node offers no Generate at all, and says why", () => {
    mount("working");
    expect(screen.queryByRole("button", { name: /^Generate/ })).toBeNull();
    expect(screen.getByTestId("inspector-busy").textContent).toBe(dictionaries.en.studioCanvas.inspector.busy);
  });

  it("the press is reported until its POST ends, even when the inspector closed meanwhile (the page's one-job guard)", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/creative/quote") return json({ quote: { credits: 4 } });
      if (url.startsWith("/api/creative/jobs") && init?.method === "POST") {
        await held;
        return json({ job: { id: "j1" } });
      }
      if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
      return json({}, 404);
    });
    const onCreated = vi.fn();
    const events: boolean[] = [];
    const view = mount("idle", onCreated, (on) => events.push(on));
    const key = await waitFor(() => {
      const b = screen.getByRole("button", { name: /^Generate/ }) as HTMLButtonElement;
      if (b.disabled) throw new Error("not quoted yet");
      return b;
    });
    fireEvent.click(key);
    await waitFor(() => expect(events).toEqual([true]));
    // The inspector closes mid-POST: that must not report the press as over (a reopened form would offer Generate again).
    view.unmount();
    expect(events).toEqual([true]);
    release();
    await waitFor(() => expect(events).toEqual([true, false]));
    // The job still reaches the page, before the press is reported over.
    expect(onCreated).toHaveBeenCalledWith("j1");
    expect(creates()).toHaveLength(1);
  });
});
