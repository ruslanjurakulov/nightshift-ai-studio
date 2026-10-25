// @vitest-environment jsdom
/**
 * The export format picker (components/editor/ExportPresetPicker.tsx) and its place in the
 * editor: a native <details> with a native radio group, a choice that is an undoable
 * document edit, advice that never blocks, and the same words in en, ru and uz. Choosing a
 * format renders, spends and publishes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { ExportPresetPicker } from "@/components/editor/ExportPresetPicker";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { EXPORT_PRESETS } from "@/lib/editorExportPresets";
import { newDocForAsset, type EditorAsset } from "@/lib/editor";

const te = en.editor;
const ep = te.exportPreset;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const VIDEO: EditorAsset = {
  id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1", thumbUrl: null,
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT"
      ? json({ id: PID, rev: 2 })
      : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function picker(props: Partial<ComponentProps<typeof ExportPresetPicker>> = {}, locale: "en" | "ru" | "uz" = "en") {
  const onChange = vi.fn();
  const ui: ReactNode = (
    <I18nProvider locale={locale}>
      <ExportPresetPicker width={1920} height={1080} fps={30} totalS={20} onChange={onChange} {...props} />
    </I18nProvider>
  );
  return { onChange, ...render(ui) };
}
const open = () => {
  const d = document.querySelector("details")!;
  d.setAttribute("open", "");
  return d;
};

describe("the picker on its own", () => {
  it("is a native disclosure whose summary says the format, and is the first stop in it", () => {
    picker();
    const summary = document.querySelector("details > summary") as HTMLElement;
    expect(summary.textContent).toBe(fmt(ep.summary, { name: ep.names.youtube_1080p }));
    expect(document.querySelector("details")!.hasAttribute("open")).toBe(false);
    summary.focus();
    expect(document.activeElement).toBe(summary);
  });

  it("is one labelled group of real radios with one name, so the arrow keys move between formats", () => {
    picker();
    open();
    expect(screen.getByRole("group", { name: ep.legend })).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(EXPORT_PRESETS.map((p) => p.id));
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    for (const r of radios) expect(r.type).toBe("radio");
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["youtube_1080p"]);
    // The accessible name is the format's name, not just its shape.
    expect(screen.getByRole("radio", { name: ep.names.vertical_1080p })).toBeTruthy();
  });

  it("asks for the format that was chosen, once", () => {
    const { onChange } = picker();
    open();
    fireEvent.click(screen.getByRole("radio", { name: ep.names.square_1080 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("square_1080");
  });

  it("describes the chosen format's size and rate in the hint the group points at", () => {
    picker({ width: 1080, height: 1920 });
    open();
    const group = screen.getByRole("group", { name: ep.legend });
    const hint = document.getElementById(group.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(`${fmt(ep.detail, { w: 1080, h: 1920, fps: 30 })} ${ep.hint}`);
  });

  it("a custom size shows none chosen and says so", () => {
    picker({ width: 1280, height: 1000, fps: 24 });
    open();
    expect(document.querySelector("summary")!.textContent).toBe(ep.summaryCustom);
    for (const r of screen.getAllByRole("radio")) expect((r as HTMLInputElement).checked).toBe(false);
    const group = screen.getByRole("group", { name: ep.legend });
    const hint = document.getElementById(group.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(`${fmt(ep.custom, { w: 1280, h: 1000, fps: 24 })} ${ep.hint}`);
  });

  it("a rate off the format's is a custom size too", () => {
    picker({ fps: 60 });
    expect(document.querySelector("summary")!.textContent).toBe(ep.summaryCustom);
  });

  it("says a video is long for the format only past the recommended length, and never blocks", () => {
    const { rerender, onChange } = picker({ width: 1080, height: 1920, totalS: 180 });
    open();
    const status = () => document.querySelector("details [aria-live=polite]") as HTMLElement;
    expect(status().textContent).toBe("");
    rerender(
      <I18nProvider locale="en">
        <ExportPresetPicker width={1080} height={1920} fps={30} totalS={312} onChange={onChange} />
      </I18nProvider>,
    );
    expect(status().textContent).toBe(fmt(ep.longForFormat, { length: "5:12", max: "3:00" }));
    for (const r of screen.getAllByRole("radio")) expect((r as HTMLInputElement).disabled).toBe(false);
  });

  it("speaks Russian and Uzbek, with the same formats", () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      cleanup();
      picker({}, locale);
      open();
      expect(document.querySelector("summary")!.textContent).toBe(
        fmt(d.editor.exportPreset.summary, { name: d.editor.exportPreset.names.youtube_1080p }),
      );
      expect(screen.getAllByRole("radio")).toHaveLength(EXPORT_PRESETS.length);
      expect(screen.getByRole("group", { name: d.editor.exportPreset.legend })).toBeTruthy();
    }
  });
});

describe("in the editor", () => {
  function mount(edit?: (doc: ReturnType<typeof newDocForAsset> & object) => void, asset: EditorAsset = VIDEO) {
    const doc = newDocForAsset(asset)!;
    edit?.(doc);
    return render(
      <I18nProvider locale="en">
        <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]} assets={{ [asset.id]: asset }} videos={[asset]} />
      </I18nProvider>,
    );
  }
  const frameBox = () => document.querySelector("video")!.parentElement!;

  it("sits with the Export button and opens on the document's format", () => {
    mount();
    const summary = screen.getByText(fmt(ep.summary, { name: ep.names.youtube_1080p }));
    expect(summary.tagName).toBe("SUMMARY");
    expect(screen.getByRole("button", { name: te.export })).toBeTruthy();
  });

  it("reads the document's frame rate: 60 fps is not any listed format", () => {
    mount((d) => {
      d.fps = 60;
    });
    expect(screen.getByText(ep.summaryCustom).tagName).toBe("SUMMARY");
  });

  it("reads the project's length: a vertical video over 3 minutes is told so, and Export stays on", () => {
    mount(
      (d) => {
        d.width = 1080;
        d.height = 1920;
      },
      { ...VIDEO, durationS: 312 },
    );
    expect(document.querySelector("details [aria-live=polite]")!.textContent).toBe(
      fmt(ep.longForFormat, { length: "5:12", max: "3:00" }),
    );
    expect((screen.getByRole("button", { name: te.export }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("choosing a format redraws the frame, is undoable and saved, and asks for no render", async () => {
    mount();
    document.querySelector("details")!.setAttribute("open", "");
    fireEvent.click(screen.getByRole("radio", { name: ep.names.feed_4x5_1080 }));
    expect(frameBox().style.aspectRatio).toBe("1080 / 1350");
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    // The frame picker below the preview follows: 4:5 is none of its three shapes.
    expect(screen.getByText(fmt(te.frameCustom, { w: 1080, h: 1350 }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(frameBox().style.aspectRatio).toBe("1920 / 1080");
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(frameBox().style.aspectRatio).toBe("1080 / 1350");

    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    const put = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
    const body = JSON.parse(String((put[1] as RequestInit).body));
    expect([body.doc.width, body.doc.height, body.doc.fps]).toEqual([1080, 1350, 30]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports"))).toHaveLength(0);
  });

  it("the old frame picker and the format picker agree", () => {
    mount();
    document.querySelector("details")!.setAttribute("open", "");
    fireEvent.click(screen.getByRole("radio", { name: /^9:16/ }));
    expect((screen.getByRole("radio", { name: ep.names.vertical_1080p }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: ep.names.youtube_720p }));
    expect(frameBox().style.aspectRatio).toBe("1280 / 720");
    // 1280 x 720 is none of the frame picker's shapes.
    for (const id of ["9:16", "16:9", "1:1"])
      expect((screen.getByRole("radio", { name: new RegExp(`^${id}`) }) as HTMLInputElement).checked).toBe(false);
  });
});
