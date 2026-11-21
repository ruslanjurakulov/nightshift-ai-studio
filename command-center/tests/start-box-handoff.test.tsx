// @vitest-environment jsdom
/**
 * The receiving end of the start box and the landing's idea box (lib/site/idea-handoff.ts, `?idea=1`). What would break without
 * these: the AI edit desk quietly cutting 2000 characters to the 500 a video edit takes; a crafted address deleting someone's kept
 * words for a tool that takes none; a customer sent by the landing (`/all-channels/create?idea=1`) landing on the owner's overview
 * instead of the Create screen; the storage-refused fallback opening a different screen from the stored path; Home losing its
 * start box or its no-channel state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    return <div data-testid="panel" />;
  },
}));
vi.mock("@/components/studio/JobFeed", () => ({ JobFeed: () => <div data-testid="feed" /> }));
vi.mock("@/components/studio/TemplateGallery", () => ({ TemplateGallery: () => null }));
vi.mock("@/components/studio/Availability", () => ({ DeskAvailabilityNote: () => null, NothingOnSaleNote: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/create",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GenerateSection } from "@/components/studio/GenerateSection";
import { CreateScreen } from "@/components/customer/CreateScreen";
import { HomeCreate } from "@/components/customer/HomeCreate";
import { IDEA_KEY, stashIdea, takeIdea } from "@/lib/site/idea-handoff";
import { MAX_VIDEO_EDIT_WORDS } from "@/lib/creative/operations";
import { wordsMax, type StudioModel } from "@/lib/creative/studio";
import { deskFromQuery } from "@/lib/creative/desks";
import { drawsCreateScreen, isCreateKind } from "@/lib/customer/create";
import { EDIT_WORDS_MAX, startRoute } from "@/lib/start-box";

const en = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const MODELS = [
  { id: "edit", displayName: "Edit", capabilities: ["video_edit"], beta: false, lock: null },
  { id: "clip", displayName: "Clip", capabilities: ["t2v"], beta: false, lock: null },
] as unknown as StudioModel[];
const wrap = (ui: ReactNode, locale: "en" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const last = () => panel.props[panel.props.length - 1];
const posts = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET");

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  panel.props = [];
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [], templates: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the AI edit desk's pickup (GenerateSection, desk=enhance&tool=video_edit&idea=1)", () => {
  const editInitial = { capability: "video_edit" as const, model: "", prompt: "", aspect: "16:9", duration: 5 };

  it("the start box's edit tab and the desk agree on the limit", () => {
    expect(EDIT_WORDS_MAX).toBe(MAX_VIDEO_EDIT_WORDS);
    expect(wordsMax("video_edit")).toBe(EDIT_WORDS_MAX);
  });

  it("fills the box, cuts to 500 and says so, strips idea= and sends nothing", async () => {
    expect(stashIdea("w".repeat(700))).toBe(true);
    window.history.replaceState(null, "", "/all-channels/create?desk=enhance&tool=video_edit&idea=1");
    render(wrap(<GenerateSection orgId={ORG} models={MODELS} desk="enhance" initial={editInitial} idea />));
    await waitFor(() => expect((last().initial as { prompt: string }).prompt).toHaveLength(500));
    expect((last().initial as { capability: string }).capability).toBe("video_edit");
    expect(screen.getByTestId("idea-cut").textContent).toBe(en.startBox.received.cut.replaceAll("{max}", "500"));
    expect(window.location.search).not.toContain("idea=");
    expect(takeIdea()).toBeNull();
    expect(posts(fetchMock)).toEqual([]);
  });

  it("words that fit are filled with no notice", async () => {
    stashIdea("Make it night");
    render(wrap(<GenerateSection orgId={ORG} models={MODELS} desk="enhance" initial={editInitial} idea />));
    await waitFor(() => expect((last().initial as { prompt: string }).prompt).toBe("Make it night"));
    expect(screen.queryByTestId("idea-cut")).toBeNull();
  });

  it("a tool that takes no words never takes the kept words (a crafted tool=video_upscale&idea=1)", async () => {
    stashIdea("Kept for another page");
    render(
      wrap(<GenerateSection orgId={ORG} models={MODELS} desk="enhance" initial={{ ...editInitial, capability: "video_upscale" }} idea />),
    );
    await waitFor(() => expect(screen.getByTestId("panel")).toBeTruthy());
    expect(localStorage.getItem(IDEA_KEY)).toContain("Kept for another page");
  });

  it("the notice is in uz too", async () => {
    stashIdea("w".repeat(600));
    render(wrap(<GenerateSection orgId={ORG} models={MODELS} desk="enhance" initial={editInitial} idea />, "uz"));
    const line = await screen.findByTestId("idea-cut");
    expect(line.textContent).toBe(dictionaries.uz.startBox.received.cut.replaceAll("{max}", "500"));
  });
});

describe("the customer's Create screen takes the idea (CreateScreen, ?idea=1)", () => {
  it("fills its box once, strips the parameter and makes no POST", async () => {
    stashIdea("A whale over the city at sunset");
    window.history.replaceState(null, "", "/all-channels/create?idea=1");
    render(wrap(<CreateScreen orgId={ORG} models={MODELS} idea />));
    await waitFor(() => expect((last().initial as { prompt: string } | null)?.prompt).toBe("A whale over the city at sunset"));
    expect((last().initial as { capability: string }).capability).toBe("t2v");
    expect(window.location.search).not.toContain("idea=");
    expect(takeIdea()).toBeNull();
    expect(posts(fetchMock)).toEqual([]);
    // Once: the screen drawn again does not fill again (the words are gone, and the box keeps what the person types).
    const fills = panel.props.filter((p) => (p.initial as { prompt?: string } | null)?.prompt).length;
    cleanup();
    render(wrap(<CreateScreen orgId={ORG} models={MODELS} idea />));
    await waitFor(() => expect(screen.getByTestId("panel")).toBeTruthy());
    expect(panel.props.filter((p) => (p.initial as { prompt?: string } | null)?.prompt).length).toBe(fills);
  });

  it("an image idea fills the picture box", async () => {
    stashIdea("A neon noodle bar");
    render(wrap(<CreateScreen orgId={ORG} models={MODELS} idea initialKind="image" />));
    await waitFor(() => expect((last().initial as { capability: string } | null)?.capability).toBe("t2i"));
  });

  it("nothing kept is an empty box and no error", async () => {
    render(wrap(<CreateScreen orgId={ORG} models={MODELS} idea />));
    await waitFor(() => expect(screen.getByTestId("panel")).toBeTruthy());
    expect(last().initial).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the stored path and the storage-refused fallback open the same screen", () => {
  const ctx = { path: (s: string) => `/all-channels${s}`, channel: null, language: "English" as const };
  const screenFor = (href: string, ownerFrame: boolean) => {
    const q = Object.fromEntries(new URL(href, "https://x.test").searchParams);
    const desk = deskFromQuery({ desk: q.desk, tool: q.tool, hasRunPrefill: false });
    return { create: drawsCreateScreen({ desk, pendingFile: false, ownerFrame }), kind: isCreateKind(q.kind) ? q.kind : "video" };
  };

  it.each(["video", "image", "audio"] as const)("%s: both are the Create screen for a customer, the overview for the owner, same kind", (kind) => {
    const r = startRoute({ tab: "create", agent: false, agentOpen: false, format: "film", kind }, "A long idea", ctx);
    if (r.via !== "idea" || !r.fallback) throw new Error("expected the idea pickup with a fallback");
    for (const owner of [false, true]) expect(screenFor(r.fallback, owner)).toEqual(screenFor(r.href, owner));
    expect(screenFor(r.href, false)).toEqual({ create: true, kind });
    expect(screenFor(r.href, true).create).toBe(false);
  });

  it("the landing's own address (IDEA_NEXT) is the customer's Create screen", () => {
    expect(screenFor("/all-channels/create?idea=1", false)).toEqual({ create: true, kind: "video" });
  });
});

describe("Home (HomeCreate)", () => {
  it("draws the start box, and with no channel its Channel video leads to connecting one", async () => {
    render(wrap(<HomeCreate orgId={ORG} projects={{ state: "ok", projects: [] }} channel={null} />));
    expect(screen.getByTestId("start")).toBeTruthy();
    expect(screen.getByTestId("start-agent").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("start-format-channel"));
    expect(screen.getByTestId("start-submit").textContent).toContain(en.startBox.submit.connect);
    expect(screen.getByText(en.startBox.note.connect)).toBeTruthy();
    // The first-run "From an idea" tile still opens Create.
    await waitFor(() => expect(screen.getByText(en.customerApp.home.tileIdea)).toBeTruthy());
    expect(screen.getByText(en.customerApp.home.tileIdea).closest("a")?.getAttribute("href")).toBe("/all-channels/create?kind=video");
  });
});
