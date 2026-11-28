// @vitest-environment jsdom
/**
 * "Improve with AI" — one button, and the panel it opens: a tool (only the ones that fit the file, the unavailable
 * ones listed as such), a model (the Studio's own list for that tool, "Auto" where the Studio offers it), and what
 * should change (Enter goes, Shift+Enter is a new line). The send key only OPENS the Studio with all of that filled in:
 * the panel sends no request of its own (the send link does not prefetch), so nothing is priced, held or spent from
 * it (CLAUDE.md #3).
 *
 * It also pins the library viewer's "three identical buttons": ImproveWithAi and SendToEditor were siblings with the
 * same key (the file's id), so React kept the previous file's button on every move to another file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/library",
  useSearchParams: () => new URLSearchParams(),
}));
// `prefetch` is surfaced (it is not an <a> attribute): "default" when the caller left Next's production prefetch on.
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean | null }) => (
    <a href={href} data-next-link="" data-prefetch={prefetch === undefined ? "default" : String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt } from "@/lib/i18n";
import { ImproveWithAi } from "@/components/ai/ImproveWithAi";
import { MediaViewer } from "@/components/media/MediaViewer";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import { IMPROVE_PROMPT_MAX } from "@/lib/creative/improve";
import type { StudioModel } from "@/lib/creative/studio";
import type { LibraryAsset, MediaLibraryData } from "@/lib/media";

const en = dictionaries.en;
const tx = en.improveAi;
const tp = tx.panel;
const ORG = "00000000-0000-4000-8000-000000000001";
const FILE = "11111111-1111-4111-8111-111111111111";

const MODELS: StudioModel[] = [
  { id: "sharp-1", displayName: "Sharp One", capabilities: ["upscale"], beta: false },
  { id: "sharp-2", displayName: "Sharp Two", capabilities: ["upscale"], beta: true },
  { id: "editor-x", displayName: "Editor X", capabilities: ["edit"], beta: false },
  { id: "grounded-image-1.0", displayName: "Grounded", capabilities: ["edit", "i2v"], beta: false, preview: true },
  { id: "cutter", displayName: "Cutter", capabilities: ["remove_bg"], beta: false },
  { id: "voice-a", displayName: "Voice A", capabilities: ["voice_change", "tts"], beta: false },
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 404 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

const mount = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const openPanel = () => {
  fireEvent.click(screen.getByTestId("improve-with-ai"));
  return screen.getByTestId("improve-with-ai-dialog");
};
const pick = (dialog: HTMLElement, tool: string) => fireEvent.click(dialog.querySelector(`[data-tool="${tool}"] input`)!);
const send = (dialog: HTMLElement) => within(dialog).getByTestId("improve-send");
const words = (dialog: HTMLElement) => within(dialog).getByTestId("improve-words") as HTMLTextAreaElement;
const modelSelect = (dialog: HTMLElement) => within(dialog).getByRole("combobox") as HTMLSelectElement;
/** The send link's query, decoded the way the Studio's page reads it. */
const query = (dialog: HTMLElement) => new URL(send(dialog).getAttribute("href")!, "https://app.invalid").searchParams;
const improveButtons = (root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>("[data-testid=improve-with-ai]")].filter((b) => b.textContent === tx.action);

function libraryAsset(id: string, name: string, kind: LibraryAsset["kind"] = "image"): LibraryAsset {
  return {
    id,
    kind,
    mime: kind === "video" ? "video/mp4" : "image/png",
    bytes: 2048,
    width: 1920,
    height: 1080,
    durationS: null,
    source: "generated",
    name,
    variants: [],
    version: 1,
    createdAt: "2026-09-01T10:00:00Z",
    thumbUrl: null,
    viewUrl: `/v/${id}`,
  };
}
const A = libraryAsset("21111111-1111-4111-8111-111111111111", "a.png");
const B = libraryAsset("22222222-1111-4111-8111-111111111111", "b.png");
const C = libraryAsset("23333333-1111-4111-8111-111111111111", "c.mp4", "video");

describe("the library viewer shows exactly one 'Improve with AI'", () => {
  it("however many times the person moves between files (the three-stacked-buttons bug)", () => {
    const viewer = (index: number) => (
      <I18nProvider locale="en">
        <MediaViewer items={[A, B, C]} index={index} onNavigate={() => {}} onClose={() => {}} deleting={false} orgId={ORG} aiTools={null} />
      </I18nProvider>
    );
    // Moving is the parent re-rendering the viewer with another index — exactly what MediaLibrary does.
    const { rerender } = render(viewer(0));
    expect(improveButtons()).toHaveLength(1);
    for (const index of [1, 2, 1, 0]) {
      rerender(viewer(index));
      expect(improveButtons()).toHaveLength(1);
    }
  });

  it("in the real library: open a file, press → twice and ← once, and there is still one, for the file on screen", () => {
    const data: MediaLibraryData = {
      available: true,
      host: { media: true, staging: true, signing: true },
      assets: [A, B, C],
      uploads: [],
      quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
      folders: { available: false, folders: [], total: 3, unfiled: null },
      folder: null,
      query: "",
      truncated: false,
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(<MediaLibrary orgId={ORG} initial={data} aiTools={null} />);
    fireEvent.click(screen.getByRole("button", { name: fmt(en.media.openItem, { name: "a.png" }) }));
    const viewer = () => document.querySelector<HTMLElement>("[data-media-viewer]")!;
    expect(improveButtons(viewer())).toHaveLength(1);
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft"]) {
      fireEvent.keyDown(viewer(), { key });
      expect(improveButtons(viewer())).toHaveLength(1);
    }
    // The one that is left opens the panel for the file on screen (b.png), not for one already passed.
    fireEvent.click(improveButtons(viewer())[0]!);
    expect(query(screen.getByTestId("improve-with-ai-dialog")).get("source")).toBe(B.id);
    // React's own complaint about two siblings with one key — the cause — is gone too.
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
  });
});

describe("the tool list fits the file", () => {
  it.each([
    ["image", ["upscale", "remove_bg", "edit", "i2v"]],
    ["video", ["video_upscale", "captions", "dub", "voice_change"]],
    ["audio", ["voice_change", "dub"]],
  ] as const)("a %s offers %j, as radios in one group", (kind, expected) => {
    mount(<ImproveWithAi assetId={FILE} kind={kind} available={null} models={null} orgId={ORG} />);
    const dialog = openPanel();
    const radios = [...dialog.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => r.value)).toEqual(expected);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  });

  it("a tool with no model here is listed as unavailable — not hidden — and cannot be picked or sent", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS.filter((m) => m.id !== "cutter")} />);
    const dialog = openPanel();
    const cut = dialog.querySelector<HTMLElement>('[data-tool="remove_bg"]')!;
    expect(cut.dataset.state).toBe("unavailable");
    expect(within(cut).getByText(tx.unavailable)).toBeTruthy();
    expect(cut.querySelector("input")!.disabled).toBe(true);
    pick(dialog, "remove_bg");
    expect(query(dialog).get("tool")).toBe("upscale");
  });
});

describe("the model list is the Studio's, per tool", () => {
  it("upscale: its two models, Auto first because there is a choice, beta marked; the Studio's first model is the default", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    const options = [...modelSelect(dialog).options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["auto", tp.auto],
      ["sharp-1", "Sharp One"],
      ["sharp-2", fmt(tp.beta, { name: "Sharp Two" })],
    ]);
    expect(modelSelect(dialog).value).toBe("sharp-1");
    expect(within(dialog).getByLabelText(tp.modelLabel)).toBe(modelSelect(dialog));
    expect(query(dialog).get("model")).toBe("sharp-1");
  });

  it("edit: the operator's preview is offered and named as one; animate with one model has no Auto", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    pick(dialog, "edit");
    expect([...modelSelect(dialog).options].map((o) => o.textContent)).toEqual([tp.auto, "Editor X", fmt(tp.preview, { name: "Grounded" })]);
    pick(dialog, "i2v");
    expect([...modelSelect(dialog).options].map((o) => o.value)).toEqual(["grounded-image-1.0"]);
  });

  it("picking Auto carries model=auto; another tool's model never leaks into this one", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    fireEvent.change(modelSelect(dialog), { target: { value: "auto" } });
    expect(query(dialog).get("model")).toBe("auto");
    pick(dialog, "remove_bg");
    expect(query(dialog).get("model")).toBe("cutter");
  });

  it("none offered for any tool: the honest state, no model picker, nothing to send", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={[]} />);
    const dialog = openPanel();
    expect(within(dialog).getByTestId("improve-model").textContent).toContain(tp.modelNone);
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect((send(dialog) as HTMLButtonElement).disabled).toBe(true);
    expect(send(dialog).tagName).toBe("BUTTON");
  });

  it("a list that could not be read leaves the pick to the Studio: no model in the link", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={null} />);
    const dialog = openPanel();
    expect(within(dialog).getByText(tp.modelStudio)).toBeTruthy();
    expect(query(dialog).has("model")).toBe(false);
  });
});

describe("what should change", () => {
  it("is carried into the link, encoded, and bounded", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} project="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const dialog = openPanel();
    pick(dialog, "edit");
    const typed = "sky at dusk & a red kite?\nkeep #faces = sharp";
    fireEvent.change(words(dialog), { target: { value: typed } });
    const href = send(dialog).getAttribute("href")!;
    expect(href.startsWith("/chronos/create?")).toBe(true);
    expect(href).not.toContain("&a red");
    const q = query(dialog);
    expect(q.get("tool")).toBe("edit");
    expect(q.get("source")).toBe(FILE);
    expect(q.get("project")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(q.get("model")).toBe("editor-x");
    expect(q.get("prompt")).toBe(typed);
    // The box stops at the limit, and the link holds it even past a pasted overflow.
    expect(words(dialog).maxLength).toBe(IMPROVE_PROMPT_MAX);
    fireEvent.change(words(dialog), { target: { value: "x".repeat(IMPROVE_PROMPT_MAX + 500) } });
    expect(query(dialog).get("prompt")).toHaveLength(IMPROVE_PROMPT_MAX);
  });

  it("is required where the tool is asked by words: the send key waits for them, and says why", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    pick(dialog, "edit");
    expect(words(dialog).required).toBe(true);
    expect((send(dialog) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByTestId("improve-rule").textContent).toBe(tp.wordsRequiredHint);
    fireEvent.change(words(dialog), { target: { value: "   " } });
    expect((send(dialog) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(words(dialog), { target: { value: "warmer light" } });
    expect(send(dialog).tagName).toBe("A");
  });

  it("is optional where words help (animate), and off where the tool takes none (upscale, cut out): nothing is carried", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    // Upscale (the default) takes no words: its one model refuses them, so the box does not invite any.
    expect(words(dialog).disabled).toBe(true);
    expect(query(dialog).has("prompt")).toBe(false);
    pick(dialog, "i2v");
    expect(words(dialog).required).toBe(false);
    expect(send(dialog).tagName).toBe("A");
    fireEvent.change(words(dialog), { target: { value: "a slow push-in" } });
    expect(query(dialog).get("prompt")).toBe("a slow push-in");
    pick(dialog, "remove_bg");
    expect(words(dialog).disabled).toBe(true);
    expect(query(dialog).has("prompt")).toBe(false);
    expect(within(dialog).getByTestId("improve-rule").textContent).toBe(tp.wordsNoneHint);
  });

  it("Enter opens the Studio (the send link); Shift+Enter and an IME's Enter do not; nothing is fetched", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    pick(dialog, "edit");
    const clicks = vi.fn((e: Event) => e.preventDefault());
    document.addEventListener("click", clicks);
    // Required and empty: Enter does nothing.
    fireEvent.keyDown(words(dialog), { key: "Enter" });
    expect(clicks).not.toHaveBeenCalled();
    fireEvent.change(words(dialog), { target: { value: "a red kite" } });
    fireEvent.keyDown(words(dialog), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(words(dialog), { key: "Enter", isComposing: true });
    expect(clicks).not.toHaveBeenCalled();
    fireEvent.keyDown(words(dialog), { key: "Enter" });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect((clicks.mock.calls[0]![0] as Event).target).toBe(send(dialog));
    document.removeEventListener("click", clicks);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("nothing is priced, held or spent from the panel", () => {
  it("every interaction makes no request at all", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    for (const tool of ["upscale", "remove_bg", "edit", "i2v"]) pick(dialog, tool);
    fireEvent.change(words(dialog), { target: { value: "move slowly" } });
    fireEvent.change(modelSelect(dialog), { target: { value: "grounded-image-1.0" } });
    const link = send(dialog);
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toMatch(/^\/chronos\/create\?/);
  });

  it("the send link never prefetches, so the words typed so far are not requested on each keystroke", () => {
    // Next 15 prefetches a visible <Link> in production whenever its href changes; this href carries `prompt=`.
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />);
    const dialog = openPanel();
    pick(dialog, "edit");
    for (const typed of ["m", "mo", "mov", "move the sky"]) {
      fireEvent.change(words(dialog), { target: { value: typed } });
      expect(query(dialog).get("prompt")).toBe(typed);
      expect(send(dialog).dataset.prefetch).toBe("false");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a side panel on a wide screen, a sheet on a phone, in three languages", () => {
  it("opens as the side placement, labelled, with focus on the picked tool", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" name="Cover" available={null} models={MODELS} />);
    const dialog = openPanel();
    expect(dialog.dataset.placement).toBe("side");
    // The test id sits on the dialog itself since LibraryDialog moved onto the shared Sheet (Radix): it is the named dialog.
    expect(screen.getByRole("dialog", { name: tx.title })).toBe(dialog);
    expect(within(dialog).getByText(fmt(tp.lead, { name: "Cover" }))).toBeTruthy();
    expect(document.activeElement).toBe(dialog.querySelector('[data-tool="upscale"] input'));
    expect(screen.getByTestId("improve-with-ai").getAttribute("aria-expanded")).toBe("true");
  });

  it.each(["ru", "uz"] as const)("reads in %s", (locale) => {
    const d = dictionaries[locale].improveAi;
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} models={MODELS} />, locale);
    const dialog = openPanel();
    expect(within(dialog).getByText(d.panel.toolLegend)).toBeTruthy();
    expect(within(dialog).getByText(d.panel.send)).toBeTruthy();
    expect(send(dialog).getAttribute("aria-label")).toBe(fmt(d.panel.sendFor, { tool: d.tools.upscale.label }));
    expect([...modelSelect(dialog).options][0]!.textContent).toBe(d.panel.auto);
  });
});
