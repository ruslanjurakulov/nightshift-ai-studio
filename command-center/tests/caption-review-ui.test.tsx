// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
import { I18nProvider } from "@/lib/i18n/context";
import { CaptionReviewHints } from "@/components/editor/CaptionReviewHints";
import type { Cue } from "@/lib/captions";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("read-only caption review preview", () => {
  it.each([
    ["en", "Caption review", "Caption 2", "Add caption text."],
    ["ru", "Проверка субтитров", "Субтитр 2", "Добавьте текст субтитра."],
    ["uz", "Subtitrlarni tekshirish", "Subtitr 2", "Subtitr matnini kiriting."],
  ] as const)("%s shows local advice and clears it when the supplied cues are corrected", (locale, title, number, empty) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const cues = Object.freeze([
      Object.freeze({ id: "one", start_s: 0, end_s: 2, text: "Synthetic cue." }),
      Object.freeze({ id: "two", start_s: 1, end_s: 4, text: " " }),
    ]);
    const host = (value: readonly Cue[]) => <I18nProvider locale={locale}><CaptionReviewHints cues={value} pictureEnd={3}/></I18nProvider>;
    const { rerender } = render(host(cues));
    const aside = screen.getByRole("complementary", { name: title });
    const item = within(aside).getByRole("listitem");
    expect(item.textContent).toContain(number);
    expect(item.textContent).toContain(empty);
    expect(item.textContent).toContain({ en: "Check timing, order or overlaps.", ru: "Проверьте время, порядок или пересечения.", uz: "Vaqt, tartib yoki ustma-ust kelishni tekshiring." }[locale]);
    expect(item.textContent).toContain({ en: "Check the caption against the picture’s end.", ru: "Проверьте субтитр относительно конца видео.", uz: "Subtitrni tasvir oxiriga nisbatan tekshiring." }[locale]);
    expect(item.textContent).not.toMatch(/\{\w+\}/);
    expect(within(aside).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(cues[1]).toEqual({ id: "two", start_s: 1, end_s: 4, text: " " });
    rerender(host([{ ...cues[0] }, { ...cues[1], start_s: 2, end_s: 3, text: "Oʻgʻil — привет!" }]));
    expect(screen.queryByRole("complementary")).toBeNull();
    rerender(host([]));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds the preview list and shows the remaining review count", () => {
    const cues = Array.from({ length: 7 }, (_, i) => ({ id: `cue${i}`, start_s: i, end_s: i + 1, text: "" }));
    render(<I18nProvider locale="en"><CaptionReviewHints cues={cues} pictureEnd={7}/></I18nProvider>);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("2 more captions to review.")).toBeTruthy();
  });
});
