// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import type { StudioModel } from "@/lib/creative/studio";

/**
 * The Create screen around the existing composer. What would break without these: a template link that presses Create
 * or quietly moves to another model; a missing S3 route read as "this template does not exist"; a price pill that shows
 * a number the server never returned; the key not reading "Create · N credits".
 */
const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    return <div data-testid="panel" />;
  },
}));
vi.mock("@/components/studio/JobFeed", () => ({ JobFeed: () => <div data-testid="feed" /> }));
vi.mock("@/components/studio/Availability", () => ({ DeskAvailabilityNote: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => <a href={href} {...r}>{children}</a> }));

const { CreateScreen } = await import("@/components/customer/CreateScreen");
const en = dictionaries.en;
const last = () => panel.props[panel.props.length - 1];
const M = (id: string, caps: string[]): StudioModel => ({ id, displayName: id.toUpperCase(), capabilities: caps, beta: false, lock: null }) as StudioModel;
const MODELS = [M("veo-3", ["t2v"]), M("kling", ["t2v"])];
const TPL = { slug: "neon", kind: "video", title: "Neon", prompt: "a neon city", model_id: "veo-3", aspect: "9:16", duration_s: 8, quality: "1080p" };

const json = (status: number, body: unknown) =>
  ({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body }) as Response;
const html404 = () => ({ ok: false, status: 404, headers: new Headers({ "content-type": "text/html" }), json: async () => ({}) }) as Response;

const wrap = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

beforeEach(() => {
  panel.props = [];
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Create screen", () => {
  it("names its key Create · N credits and says the price is unknown until the server quotes", async () => {
    render(wrap(<CreateScreen orgId="o1" models={MODELS} />));
    expect(last().verb).toEqual({ word: en.customerApp.create.createWord, priced: en.customerApp.create.createPriced });
    expect(last().onePerQuote).toBe(true);
    expect(screen.getByTestId("create-price").textContent).toContain(en.customerApp.create.priceUnknown);
    await act(async () => (last().onQuote as (q: unknown) => void)({ state: "ready", credits: 12 }));
    expect(screen.getByTestId("create-price").textContent).toContain("12 credits");
    await act(async () => (last().onQuote as (q: unknown) => void)(null));
    expect(screen.getByTestId("create-price").textContent).toContain(en.customerApp.create.priceUnknown);
  });

  it("fills the form from a template whose model is on sale, and never presses Create", async () => {
    const fetchMock = vi.fn(async (_url: string) => json(200, TPL));
    vi.stubGlobal("fetch", fetchMock);
    render(wrap(<CreateScreen orgId="o1" models={MODELS} templateSlug="neon" />));
    await screen.findByTestId("template-ready");
    expect(last().initial).toMatchObject({ capability: "t2v", model: "veo-3", aspect: "9:16", duration: 8 });
    // One read of the template, nothing posted anywhere.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/templates/neon");
  });

  it("does not switch models when the template's is unavailable: the person picks one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ...TPL, model_id: "sora" })));
    render(wrap(<CreateScreen orgId="o1" models={MODELS} templateSlug="neon" />));
    await screen.findByTestId("template-model-unavailable");
    expect(last().initial).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use KLING" }));
    await waitFor(() => expect(last().initial).toMatchObject({ model: "kling", prompt: "a neon city" }));
  });

  it("tells a missing template from a route that is not deployed yet, and a failure from both", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "not_found" })));
    const a = render(wrap(<CreateScreen orgId="o1" models={MODELS} templateSlug="gone" />));
    await screen.findByTestId("template-missing");
    a.unmount();
    vi.stubGlobal("fetch", vi.fn(async () => html404()));
    const b = render(wrap(<CreateScreen orgId="o1" models={MODELS} templateSlug="gone" />));
    await screen.findByTestId("template-not_yet");
    b.unmount();
    vi.stubGlobal("fetch", vi.fn(async () => json(500, {})));
    render(wrap(<CreateScreen orgId="o1" models={MODELS} templateSlug="gone" />));
    await screen.findByTestId("template-failed");
  });

  it("switches kind with the tabs (and arrow keys), starting a fresh form on that kind's desk", async () => {
    render(wrap(<CreateScreen orgId="o1" models={MODELS} />));
    expect(last().desk).toBe("video");
    fireEvent.click(screen.getByRole("tab", { name: en.customerApp.kinds.image }));
    expect(last().desk).toBe("image");
    fireEvent.keyDown(screen.getByRole("tab", { name: en.customerApp.kinds.image }), { key: "ArrowRight" });
    expect(last().desk).toBe("voice");
  });

  it("the Director only appends words, and only after a person asks", async () => {
    render(wrap(<CreateScreen orgId="o1" models={MODELS} />));
    expect(last().appendRequest).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.customerApp.create.director.title) }));
    fireEvent.click(screen.getByRole("radio", { name: en.customerApp.create.director.manual }));
    fireEvent.click(screen.getByRole("button", { name: en.customerApp.create.director.presets.camera.wide }));
    fireEvent.click(screen.getByRole("button", { name: en.customerApp.create.director.apply }));
    expect(last().appendRequest).toMatchObject({ text: "wide establishing shot" });
  });
});
