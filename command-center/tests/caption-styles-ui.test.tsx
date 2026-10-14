// @vitest-environment jsdom
/**
 * Animated caption styles and typed / imported captions in the Captions panel
 * (UI half): free, local, available where transcription is not set up, and
 * never a step that prices, holds or spends. Auto-captions stay gated exactly
 * as before: with no transcription model offered there is no price button and
 * no call to the quote or jobs routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/editor/p",
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
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt } from "@/lib/i18n";
import { CaptionsPanel, type CaptionModelOption } from "@/components/editor/CaptionsPanel";
import { CaptionPreview } from "@/components/editor/CaptionPreview";
import { captionsOf, setCaptions, styleFor, DEFAULT_PRESET } from "@/lib/captions";
import { CAPTION_STYLE_IDS } from "@/lib/captionStyleTable";
import { toDoc, validateTimeline, type EditorAsset, type EditorModel } from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const ORG = "00000000-0000-4000-8000-000000000001";
const asset: EditorAsset = { id: A, kind: "video", name: "talk.mp4", durationS: 60, width: 1080, height: 1920, viewUrl: null, thumbUrl: null };

const bare = (): EditorModel => ({
  width: 1080,
  height: 1920,
  fps: 30,
  clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 60, speed: 1, audio: true }],
  texts: [],
  sounds: [],
  keep: [],
});
const withCues = (): EditorModel =>
  setCaptions(bare(), {
    style: styleFor(DEFAULT_PRESET, 1080, 1920),
    cues: [
      { id: "cap1", start_s: 1, end_s: 3, text: "Hello there" },
      { id: "cap2", start_s: 3, end_s: 5, text: "Second" },
    ],
  });

let seen: EditorModel;
const groups: (string | undefined)[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function Host({
  model: initial = withCues(),
  models = [],
  locale = "en",
  pictureEnd = 60,
}: {
  model?: EditorModel;
  models?: CaptionModelOption[];
  locale?: "en" | "ru" | "uz";
  pictureEnd?: number;
}) {
  const [model, setModel] = useState(initial);
  seen = model;
  return (
    <I18nProvider locale={locale}>
      <CaptionsPanel
        orgId={ORG}
        projectTitle="My talk"
        model={model}
        assets={{ [A]: asset }}
        models={models}
        pictureEnd={pictureEnd}
        onChange={(next, group) => {
          groups.push(group);
          setModel(next);
        }}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  groups.length = 0;
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ tracks: [], jobs: [] }), { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const en = dictionaries.en;
const ta = en.captions.animated;
const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

describe("the style picker", () => {
  it("is there with no transcription set up, and offers plain plus the ten styles", () => {
    render(<Host />);
    const group = screen.getByRole("radiogroup", { name: ta.heading });
    const names = within(group).getAllByRole("radio").map((r) => r.textContent);
    expect(names).toHaveLength(11);
    for (const id of CAPTION_STYLE_IDS) {
      expect(within(group).getByRole("radio", { name: new RegExp(ta.styles[id]) })).toBeTruthy();
      expect(screen.getByText(ta.notes[id])).toBeTruthy();
    }
    expect(radio(ta.plain).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps auto-captions gated exactly as before: no price, no quote, no job", async () => {
    render(<Host />);
    expect(screen.getByText(en.captions.noModels)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.captions.make })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(radio(ta.styles.karaoke));
    fireEvent.click(screen.getByRole("button", { name: en.captions.addCue }));
    // Reading what exists is all the panel asks the server; nothing is quoted, started or written.
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("/api/creative/quote");
      expect((init as RequestInit | undefined)?.method ?? "GET", String(url)).toBe("GET");
    }
  });

  it("one press applies a style to the captions and marks it chosen", () => {
    render(<Host />);
    fireEvent.click(radio(ta.styles.neon));
    expect(radio(ta.styles.neon).getAttribute("aria-checked")).toBe("true");
    expect(radio(ta.plain).getAttribute("aria-checked")).toBe("false");
    expect(captionsOf(seen)!.style.preset).toBe("neon");
    expect(captionsOf(seen)!.cues.map((c) => c.text)).toEqual(["Hello there", "Second"]);
    expect(validateTimeline(toDoc(seen))).toEqual([]);
    fireEvent.click(radio(ta.plain));
    expect(captionsOf(seen)!.style.preset).toBeUndefined();
  });

  it("without captions it says so and the choices are off", () => {
    render(<Host model={bare()} />);
    expect(screen.getByText(ta.needCues)).toBeTruthy();
    for (const r of screen.getByRole("radiogroup", { name: ta.heading }).querySelectorAll<HTMLButtonElement>("button")) {
      expect(r.disabled).toBe(true);
    }
  });

  it("shows only the tweaks the style draws, labelled", () => {
    render(<Host />);
    fireEvent.click(radio(ta.styles.pop_in));
    expect(screen.getByLabelText(ta.tweaks.color)).toBeTruthy();
    expect(screen.getByLabelText(ta.tweaks.size)).toBeTruthy();
    expect(screen.getByLabelText(ta.tweaks.y)).toBeTruthy();
    expect(screen.queryByLabelText(ta.tweaks.highlight_color)).toBeNull();
    fireEvent.click(radio(ta.styles.karaoke));
    expect(screen.getByLabelText(ta.tweaks.highlight_color)).toBeTruthy();
    expect(screen.getByText(fmt(ta.current, { name: ta.styles.karaoke }))).toBeTruthy();
  });

  it("tweaks change the style and are clamped; one drag is one undo step", () => {
    render(<Host />);
    fireEvent.click(radio(ta.styles.karaoke));
    const size = screen.getByLabelText(ta.tweaks.size) as HTMLInputElement;
    fireEvent.pointerDown(size);
    fireEvent.change(size, { target: { value: "90" } });
    fireEvent.change(size, { target: { value: "95" } });
    expect(captionsOf(seen)!.style.size).toBe(95);
    const grouped = groups.slice(-2);
    expect(grouped[0]).toBeTruthy();
    expect(grouped[0]).toBe(grouped[1]);
    fireEvent.pointerDown(size);
    fireEvent.change(size, { target: { value: "100" } });
    expect(groups[groups.length - 1]).not.toBe(grouped[0]);
    fireEvent.change(screen.getByLabelText(ta.tweaks.highlight_color), { target: { value: "#00ff00" } });
    expect(captionsOf(seen)!.style.highlight_color).toBe("#00FF00");
    fireEvent.change(screen.getByLabelText(ta.tweaks.y), { target: { value: "0.5" } });
    expect(captionsOf(seen)!.style.y).toBe(0.5);
    expect(validateTimeline(toDoc(seen))).toEqual([]);
  });

  it("reset puts the style's own look back", () => {
    render(<Host />);
    fireEvent.click(radio(ta.styles.karaoke));
    fireEvent.change(screen.getByLabelText(ta.tweaks.color), { target: { value: "#ff0000" } });
    expect(captionsOf(seen)!.style.color).toBe("#FF0000");
    fireEvent.click(screen.getByRole("button", { name: ta.reset }));
    expect(captionsOf(seen)!.style.color).toBe("#FFFFFF");
  });

  it("every control is at least 44 px tall and the choices are radios", () => {
    render(<Host />);
    fireEvent.click(radio(ta.styles.karaoke));
    for (const el of [
      ...screen.getByRole("radiogroup", { name: ta.heading }).querySelectorAll("button"),
      screen.getByLabelText(ta.tweaks.color),
      screen.getByLabelText(ta.tweaks.size),
      screen.getByLabelText(ta.tweaks.y),
      screen.getByRole("button", { name: ta.reset }),
      screen.getByRole("button", { name: en.captions.addCue }),
      screen.getByRole("button", { name: en.captions.importFile }),
    ]) {
      expect(el.className, el.outerHTML.slice(0, 80)).toMatch(/\b(min-h-11|h-11)\b/);
    }
  });

  it("says the preview is approximate", () => {
    render(<Host />);
    expect(screen.getAllByText(ta.previewNote).length).toBeGreaterThan(0);
  });

  it.each(["ru", "uz"] as const)("is fully translated (%s)", (loc) => {
    render(<Host locale={loc} />);
    const d = dictionaries[loc].captions.animated;
    expect(screen.getByRole("radiogroup", { name: d.heading })).toBeTruthy();
    for (const id of CAPTION_STYLE_IDS) expect(screen.getByText(d.styles[id])).toBeTruthy();
    expect(d.heading).not.toBe(ta.heading);
  });

  it("rebuilding from a transcript keeps the animated style the person chose", () => {
    const m = withCues();
    render(<Host model={m} />);
    fireEvent.click(radio(ta.styles.outlined));
    expect(captionsOf(seen)!.style.preset).toBe("outlined");
  });
});

describe("typed and imported captions", () => {
  it("adds a caption after the last one, with no transcription", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: en.captions.addCue }));
    const cues = captionsOf(seen)!.cues;
    expect(cues).toHaveLength(3);
    expect(cues[2]).toMatchObject({ start_s: 5, end_s: 7, text: en.captions.newCueText });
    expect(screen.getAllByLabelText(/^Caption \d/)).toHaveLength(3);
  });

  it("starts the first caption on an empty project and keeps the plain default look", () => {
    render(<Host model={bare()} />);
    expect(screen.getByText(en.captions.noCuesManual)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.captions.addCue }));
    expect(captionsOf(seen)!.cues).toHaveLength(1);
    expect(captionsOf(seen)!.style).toEqual(styleFor(DEFAULT_PRESET, 1080, 1920));
  });

  it("says so when the picture leaves no room", () => {
    render(<Host pictureEnd={5.1} />);
    fireEvent.click(screen.getByRole("button", { name: en.captions.addCue }));
    expect(screen.getByRole("status").textContent).toBe(en.captions.addNoRoom);
    expect(captionsOf(seen)!.cues).toHaveLength(2);
  });

  const pick = (name: string, body: string) => {
    const input = screen.getByLabelText(en.captions.importFile, { selector: "input" }) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([body], name, { type: "text/plain" })] } });
  };
  const SRT = "1\n00:00:01,000 --> 00:00:02,500\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n";

  it("imports a subtitle file into an empty project", async () => {
    render(<Host model={bare()} />);
    pick("a.srt", SRT);
    await waitFor(() => expect(captionsOf(seen)?.cues).toHaveLength(2));
    expect(captionsOf(seen)!.cues.map((c) => c.text)).toEqual(["One", "Two"]);
    expect(screen.getByRole("status").textContent).toBe(fmt(en.captions.imported, { n: 2 }));
    expect(validateTimeline(toDoc(seen))).toEqual([]);
  });

  it("asks before replacing captions that exist, and keeps them on no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Host />);
    pick("a.srt", SRT);
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(en.captions.importReplace));
    expect(captionsOf(seen)!.cues.map((c) => c.text)).toEqual(["Hello there", "Second"]);
    confirm.mockReturnValue(true);
    pick("a.srt", SRT);
    await waitFor(() => expect(captionsOf(seen)!.cues.map((c) => c.text)).toEqual(["One", "Two"]));
  });

  it("keeps the chosen animated style when captions are imported", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Host />);
    fireEvent.click(radio(ta.styles.typewriter));
    pick("a.srt", SRT);
    await waitFor(() => expect(captionsOf(seen)!.cues.map((c) => c.text)).toEqual(["One", "Two"]));
    expect(captionsOf(seen)!.style.preset).toBe("typewriter");
  });

  it("refuses a file that is too large, unreadable as captions, or entirely past the picture", async () => {
    render(<Host model={bare()} />);
    const big = new File(["x"], "big.srt");
    Object.defineProperty(big, "size", { value: 2_000_000 });
    fireEvent.change(screen.getByLabelText(en.captions.importFile, { selector: "input" }), { target: { files: [big] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.captions.importTooBig));
    pick("x.txt", "nothing to see");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.captions.importNone));
    expect(captionsOf(seen)).toBeNull();
  });

  it("is translated in ru and uz", () => {
    for (const loc of ["ru", "uz"] as const) {
      const d = dictionaries[loc].captions;
      render(<Host locale={loc} model={bare()} />);
      expect(screen.getByRole("button", { name: d.addCue })).toBeTruthy();
      expect(screen.getByRole("button", { name: d.importFile })).toBeTruthy();
      expect(screen.getByText(d.noCuesManual)).toBeTruthy();
      cleanup();
    }
  });
});

describe("the preview component", () => {
  const style = (id: (typeof CAPTION_STYLE_IDS)[number]) => ({
    ...styleFor(DEFAULT_PRESET, 1080, 1920),
    preset: id,
    highlight_color: "#FFD400",
  });

  it("draws the cue's own words for every style, as text", () => {
    for (const id of CAPTION_STYLE_IDS) {
      const { container, unmount } = render(
        <CaptionPreview cue={{ id: "k", start_s: 0, end_s: 3, text: "<b>hi</b> there" }} style={style(id)} playhead={2.5} frameWidth={1080} />,
      );
      expect(container.querySelector("b"), id).toBeNull();
      expect(container.textContent?.replace(/\s+/g, " ").trim(), id).toBe("<b>hi</b> there");
      unmount();
    }
  });

  it("draws nothing for a caption without a style", () => {
    const plain = styleFor(DEFAULT_PRESET, 1080, 1920);
    const { container } = render(<CaptionPreview cue={{ id: "k", start_s: 0, end_s: 3, text: "hi" }} style={plain} playhead={1} frameWidth={1080} />);
    expect(container.firstChild).toBeNull();
  });
});
