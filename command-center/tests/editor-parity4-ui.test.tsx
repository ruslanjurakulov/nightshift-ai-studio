// @vitest-environment jsdom
/**
 * The talking-head pack's controls (UI half): "Clean voice" beside the sound clean-up switches, "Mute or bleep words"
 * in the captions panel, a text's "Text properties". What would break without these: a switch that writes a document
 * the validators refuse (clean voice beside loudnorm), a control with no accessible name, a word that cannot be reached
 * by keyboard or is too small to touch, a claim the preview cannot keep (it does not clean the voice nor play the beep;
 * the panels say so), or a sentence missing in a language. No network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { ClipCleanSection, SoundCleanSection } from "@/components/editor/CleanSections";
import { BleepPanel, TextPropsSection } from "@/components/editor/TalkingHeadSections";
import { toDoc, toModel, validateTimeline, type EditorModel, type TimelineDoc } from "@/lib/editor";

const V = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const p4 = en.editor.parity4;
const cl = en.editor.fx.clean;

function model(): EditorModel {
  const d: TimelineDoc = {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: V, start_s: 0, in_s: 0, out_s: 20, speed: 1, audio: true, loudnorm: true }] },
      { id: "a1", kind: "A", clips: [{ id: "s1", asset_id: S, start_s: 0, in_s: 0, out_s: 10, gain_db: 0, fade_in_s: 0, fade_out_s: 0, denoise: true }] },
      { id: "t1", kind: "T", clips: [{ id: "x1", start_s: 0, end_s: 2, text: "two\nlines", size: 64, x: 0.5, y: 0.5, anchor: "center" }] },
    ],
  };
  return toModel(d);
}

afterEach(() => cleanup());

function host(ui: (m: EditorModel, apply: (n: EditorModel) => void) => React.ReactNode, locale: "en" | "ru" | "uz" = "en") {
  const seen: EditorModel[] = [];
  let current = model();
  const apply = (n: EditorModel) => {
    seen.push(n);
    current = n;
    view.rerender(<I18nProvider locale={locale}>{ui(current, apply)}</I18nProvider>);
  };
  const view = render(<I18nProvider locale={locale}>{ui(current, apply)}</I18nProvider>);
  return { seen, now: () => current };
}

describe("clean voice", () => {
  it("on a sound: replaces the two switches, which then say why they are off", () => {
    const h = host((m, apply) => <SoundCleanSection model={m} sound={m.sounds[0]} apply={apply} />);
    const voice = screen.getByRole("checkbox", { name: p4.voice.toggle });
    expect((voice as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: cl.denoise }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(voice);
    expect(h.now().sounds[0].voice).toBe("clean");
    expect(h.now().sounds[0].denoise).toBeUndefined();
    const denoise = screen.getByRole("checkbox", { name: cl.denoise }) as HTMLInputElement;
    expect(denoise.disabled).toBe(true);
    expect(denoise.checked).toBe(false);
    expect(screen.getAllByText(p4.voice.included)).toHaveLength(2);
    expect(screen.getByTestId("voice-preview-note").textContent).toBe(p4.voice.previewNote);
    expect(validateTimeline(toDoc(h.now()))).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox", { name: p4.voice.toggle }));
    expect(h.now().sounds[0].voice).toBeUndefined();
    expect((screen.getByRole("checkbox", { name: cl.denoise }) as HTMLInputElement).disabled).toBe(false);
  });

  it("on a clip's own sound, too", () => {
    const h = host((m, apply) => <ClipCleanSection model={m} clip={m.clips[0]} still={false} apply={apply} />);
    fireEvent.click(screen.getByRole("checkbox", { name: p4.voice.toggle }));
    expect(h.now().clips[0]).toMatchObject({ voice: "clean" });
    expect(h.now().clips[0].loudnorm).toBeUndefined();
    expect(validateTimeline(toDoc(h.now()))).toEqual([]);
  });

  it("is disabled, with the numbers, where the export's time would not hold it", () => {
    const base = model();
    const sounds = Array.from({ length: 31 }, (_v, i) => ({
      ...base.sounds[0], id: `s${i}`, out_s: 120, denoise: undefined, ...(i < 30 ? { voice: "clean" as const } : {}),
    }));
    const big: EditorModel = { ...base, clips: [{ ...base.clips[0], out_s: 120, audio: false, loudnorm: undefined }], texts: [], sounds };
    render(
      <I18nProvider locale="en">
        <SoundCleanSection model={big} sound={big.sounds[30]} apply={() => {}} />
      </I18nProvider>,
    );
    expect((screen.getByRole("checkbox", { name: p4.voice.toggle }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/492 s for a 120 s timeline, and 480 s is allowed/)).toBeTruthy();
  });
});

describe("mute or bleep words", () => {
  const cues = [
    { id: "k1", start_s: 2, end_s: 4, text: "Go big now" },
    { id: "k2", start_s: 5, end_s: 6, text: "darn" },
  ];
  it("each word is a pressable button that adds or takes off its bleep, in the chosen mode", () => {
    const h = host((m, apply) => <BleepPanel model={m} cues={cues} onChange={apply} />);
    const words = screen.getAllByTestId("bleep-word");
    expect(words.map((w) => w.textContent)).toEqual(["Go", "big", "now", "darn"]);
    for (const w of words) {
      expect(w.tagName).toBe("BUTTON");                 // keyboard: Enter and Space press it
      expect(w.className).toContain("min-h-11");         // a 44 px touch target
      expect(w.getAttribute("aria-pressed")).toBe("false");
    }
    expect(words[1].getAttribute("aria-label")).toBe("big, 2.54 s");
    fireEvent.click(within(screen.getByTestId("bleep-mode")).getByRole("radio", { name: p4.bleeps.modes.mute }));
    fireEvent.click(words[3]);
    expect(h.now().bleeps).toEqual([{ start_s: 5, end_s: 6, mode: "mute" }]);
    expect(screen.getAllByTestId("bleep-word")[3].getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Bleeped: 1 of 100")).toBeTruthy();
    expect(validateTimeline(toDoc(h.now()))).toEqual([]);
    // the list: its mode and a remove button, each named by its time
    const mode = screen.getByRole("combobox", { name: "Bleep at 5.00 s" }) as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "tone" } });
    expect(h.now().bleeps![0].mode).toBe("tone");
    fireEvent.click(screen.getByRole("button", { name: "Remove the bleep at 5.00 s" }));
    expect(h.now().bleeps).toBeUndefined();
    expect(screen.getByText(p4.bleeps.none)).toBeTruthy();
  });

  it("says what the preview does and does not do", () => {
    host((m, apply) => <BleepPanel model={m} cues={cues} onChange={apply} />);
    expect(screen.getByTestId("bleep-preview-note").textContent).toBe(p4.bleeps.previewNote);
    expect(screen.getByText(p4.bleeps.hint)).toBeTruthy();
  });

  it("says so when the document is full", () => {
    const full: EditorModel = {
      ...model(),
      bleeps: Array.from({ length: 100 }, (_v, i) => ({ start_s: 10 + i * 0.1, end_s: 10.05 + i * 0.1, mode: "mute" as const })),
    };
    render(
      <I18nProvider locale="en">
        <BleepPanel model={full} cues={cues} onChange={() => {}} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getAllByTestId("bleep-word")[0]);
    expect(screen.getByRole("status").textContent).toBe("At most 100 bleeps in one video.");
  });
});

describe("text properties", () => {
  it("letter spacing, italic and line alignment write the text's fields, and off writes none", () => {
    const h = host((m, apply) => <TextPropsSection model={m} text={m.texts[0]} apply={apply} />);
    fireEvent.change(screen.getByRole("slider", { name: p4.text.tracking }), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("checkbox", { name: p4.text.italic }));
    fireEvent.click(screen.getByRole("radio", { name: p4.text.aligns.right }));
    expect(h.now().texts[0]).toMatchObject({ tracking: 120, italic: true, align: "right" });
    expect(validateTimeline(toDoc(h.now()))).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: p4.text.alignAuto }));
    fireEvent.click(screen.getByRole("checkbox", { name: p4.text.italic }));
    fireEvent.change(screen.getByRole("slider", { name: p4.text.tracking }), { target: { value: "0" } });
    expect(["tracking", "italic", "align"].filter((k) => k in h.now().texts[0])).toEqual([]);
    expect(screen.getByText(p4.text.emoji)).toBeTruthy();
  });
});

describe("the words people read", () => {
  const leaves = (o: unknown, path = ""): string[] =>
    typeof o === "string" ? [path] : Object.entries(o as object).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
  it("every sentence in en, ru and uz, with the same placeholders", () => {
    const dicts = [en, ru, uz].map((d) => d.editor.parity4);
    const keys = dicts.map((d) => leaves(d).sort());
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
    const get = (d: unknown, path: string) => path.split(".").filter(Boolean).reduce((o: any, k) => o[k], d) as string; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const k of keys[0]) {
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      for (const d of dicts) {
        expect(get(d, k).trim(), k).not.toBe("");
        expect(holes(get(d, k)), k).toEqual(holes(get(dicts[0], k)));
      }
    }
    for (const d of [en, ru, uz]) expect(d.captions.animated.styles.single_word.trim()).not.toBe("");
  });
  it("the controls render in every language", () => {
    for (const locale of ["ru", "uz"] as const) {
      const d = locale === "ru" ? ru : uz;
      host((m, apply) => <SoundCleanSection model={m} sound={m.sounds[0]} apply={apply} />, locale);
      expect(screen.getByRole("checkbox", { name: d.editor.parity4.voice.toggle })).toBeTruthy();
      cleanup();
    }
  });
});
