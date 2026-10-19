// @vitest-environment jsdom
/**
 * The AI-content label on the review section of the video page: what the upload recorded (the `video.ai_disclosure` event), said in words
 * in en / ru / uz, and the honest "unknown" when nothing readable was recorded. What would break: a video with no
 * record showing as "not labelled" (an unknown read as a no), a record the panel cannot trust (an unknown mode, a
 * label that contradicts "never"/"always") being shown as fact, a word without a sentence in one language, and the
 * panel changing for a caller that does not pass the label at all. Display only: nothing here sends a label.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/videos/x" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { AiDisclosureNote } from "@/components/review/AiDisclosureNote";
import { AI_DISCLOSURE_EVENT, AI_MODES, AI_REASONS, aiDisclosureFromEvents, type AiDisclosureView } from "@/lib/aiDisclosure";

const LOCALES: Locale[] = ["en", "ru", "uz"];

const ev = (metadata: Record<string, unknown> | null, ts = "2026-10-19T10:00:00", event = AI_DISCLOSURE_EVENT) => ({ event, ts, metadata });
const rec = (over: Record<string, unknown> = {}) => ({
  label: true,
  mode: "auto",
  reasons: ["generated_video"],
  line: true,
  language: "en",
  ...over,
});

describe("aiDisclosureFromEvents", () => {
  it("reads the newest readable record", () => {
    const view = aiDisclosureFromEvents([
      ev(rec({ reasons: ["generated_images"] }), "2026-10-01T00:00:00"),
      ev(rec({ reasons: ["ai_presenter", "generated_video"] }), "2026-10-02T00:00:00"),
    ]);
    expect(view).toEqual({ label: true, mode: "auto", reasons: ["ai_presenter", "generated_video"], line: true });
  });

  it("reads a clean video's record as a real 'not labelled'", () => {
    expect(aiDisclosureFromEvents([ev(rec({ label: false, reasons: ["no_synthetic_media"], line: false }))])).toEqual({
      label: false,
      mode: "auto",
      reasons: ["no_synthetic_media"],
      line: false,
    });
  });

  it("no event, other events and null are unknown, never 'not labelled'", () => {
    expect(aiDisclosureFromEvents([])).toBeNull();
    expect(aiDisclosureFromEvents(null)).toBeNull();
    expect(aiDisclosureFromEvents(undefined)).toBeNull();
    expect(aiDisclosureFromEvents([ev(rec(), "2026-10-01", "video.published")])).toBeNull();
  });

  it("does not trust a record that is malformed or contradicts itself", () => {
    const bad: Record<string, unknown>[] = [
      rec({ mode: "sometimes" }),
      rec({ reasons: [] }),
      rec({ reasons: ["because"] }),
      rec({ reasons: "generated_video" }),
      rec({ label: "yes" }),
      rec({ line: undefined }),
      rec({ mode: "never", label: true }),
      rec({ mode: "always", label: false }),
    ];
    for (const meta of bad) expect(aiDisclosureFromEvents([ev(meta)]), JSON.stringify(meta)).toBeNull();
    expect(aiDisclosureFromEvents([ev(null)])).toBeNull();
  });

  it("an unreadable newer record does not hide an older readable one", () => {
    const view = aiDisclosureFromEvents([ev(rec({ mode: "x" }), "2026-10-02"), ev(rec(), "2026-10-01")]);
    expect(view?.label).toBe(true);
  });
});

describe("the words", () => {
  it.each(LOCALES)("%s: a sentence for every reason and mode, and for the five states", (locale) => {
    const ai = dictionaries[locale].review.ai;
    expect(Object.keys(ai.reasons).sort()).toEqual([...AI_REASONS].sort());
    expect(Object.keys(ai.mode).sort()).toEqual([...AI_MODES].sort());
    for (const s of [...Object.values(ai.reasons), ...Object.values(ai.mode), ai.title, ai.on, ai.off, ai.unknown, ai.notYet, ai.lineOn, ai.lineOff, ai.note])
      expect(s.trim().length).toBeGreaterThan(5);
  });

  it("ru and uz are not the English text", () => {
    const en = dictionaries.en.review.ai;
    for (const locale of ["ru", "uz"] as const) {
      const ai = dictionaries[locale].review.ai;
      for (const key of ["title", "on", "off", "unknown", "notYet", "lineOn", "lineOff", "note"] as const) expect(ai[key], `${locale}.${key}`).not.toBe(en[key]);
      for (const r of AI_REASONS) expect(ai.reasons[r], `${locale}.${r}`).not.toBe(en.reasons[r]);
    }
  });
});

function panel(locale: Locale, view: AiDisclosureView | null, uploaded = true) {
  return render(
    <I18nProvider locale={locale}>
      <AiDisclosureNote view={view} uploaded={uploaded} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("the note on the review section", () => {
  it.each(LOCALES)("%s: a labelled video says so, why, the setting and that a line was added", (locale) => {
    const ai = dictionaries[locale].review.ai;
    panel(locale, { label: true, mode: "auto", reasons: ["generated_video", "ai_presenter"], line: true });
    const box = within(screen.getByTestId("ai-disclosure"));
    expect(box.getByText(ai.title)).toBeTruthy();
    expect(box.getByText(ai.on)).toBeTruthy();
    expect(box.getByText(`— ${ai.reasons.generated_video}`)).toBeTruthy();
    expect(box.getByText(`— ${ai.reasons.ai_presenter}`)).toBeTruthy();
    expect(box.getByText(`${ai.mode.auto} · ${ai.lineOn}`)).toBeTruthy();
    expect(box.getByText(ai.note)).toBeTruthy();
    expect(box.queryByText(ai.off)).toBeNull();
  });

  it.each(LOCALES)("%s: a recorded 'not labelled' says why, with no description line mentioned", (locale) => {
    const ai = dictionaries[locale].review.ai;
    panel(locale, { label: false, mode: "never", reasons: ["mode_never"], line: false });
    const box = within(screen.getByTestId("ai-disclosure"));
    expect(box.getByText(ai.off)).toBeTruthy();
    expect(box.getByText(`— ${ai.reasons.mode_never}`)).toBeTruthy();
    expect(box.getByText(ai.mode.never)).toBeTruthy();
    expect(box.queryByText(ai.lineOn)).toBeNull();
  });

  it.each(LOCALES)("%s: a labelled video whose line was left out says so", (locale) => {
    const ai = dictionaries[locale].review.ai;
    panel(locale, { label: true, mode: "always", reasons: ["mode_always"], line: false });
    expect(screen.getByText(`${ai.mode.always} · ${ai.lineOff}`)).toBeTruthy();
  });

  it.each(LOCALES)("%s: no record on an uploaded video is unknown, not a 'no'", (locale) => {
    const ai = dictionaries[locale].review.ai;
    panel(locale, null);
    const box = within(screen.getByTestId("ai-disclosure"));
    expect(box.getByText(ai.unknown)).toBeTruthy();
    expect(box.queryByText(ai.off)).toBeNull();
    expect(box.queryByText(ai.on)).toBeNull();
  });

  it.each(LOCALES)("%s: a held video has no label yet because it is decided at upload", (locale) => {
    const ai = dictionaries[locale].review.ai;
    panel(locale, null, false);
    expect(within(screen.getByTestId("ai-disclosure")).getByText(ai.notYet)).toBeTruthy();
  });
});
