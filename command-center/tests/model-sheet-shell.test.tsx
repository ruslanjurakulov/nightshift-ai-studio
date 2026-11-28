// @vitest-environment jsdom
/**
 * The model sheet on the shared Sheet (components/ui, Radix Dialog), which replaced its hand-rolled portal, focus trap and
 * scroll lock. The keyboard path through GeneratePanel is pinned in studio-composer.test.tsx; this pins what moved into
 * Radix and could regress silently:
 * - Escape closing the sheet AND reaching the canvas behind it (which closes the inspector on Escape), so one key press
 *   threw away two layers.
 * - Tab walking out of the sheet into the page underneath.
 * - The page behind still scrolling under a phone's thumb.
 * - The sheet speaking English to a Russian or Uzbek reader (its close key and description now come from Radix slots).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ModelSheet } from "@/components/studio/ModelSheet";
import type { StudioModel } from "@/lib/creative/studio";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
afterEach(cleanup);

const MODELS: StudioModel[] = [
  { id: "pic-fast", displayName: "Picture Fast", capabilities: ["t2i"], beta: false },
  { id: "pic-fine", displayName: "Picture Fine", capabilities: ["t2i"], beta: false },
];

function Page({ locale = "en" as "en" | "ru" | "uz", onCanvasEscape = () => {} }) {
  const [open, setOpen] = useState(true);
  const change = createRef<HTMLButtonElement>();
  return (
    <I18nProvider locale={locale}>
      <div
        onKeyDown={(e) => {
          if (e.key === "Escape") onCanvasEscape();
        }}
      >
        <button ref={change} type="button" onClick={() => setOpen(true)}>
          change
        </button>
        {open && (
          <ModelSheet
            capability="t2i"
            models={MODELS}
            selectedId="pic-fine"
            prices={{}}
            priceHint={null}
            onSelect={() => setOpen(false)}
            onClose={() => setOpen(false)}
            returnTo={change}
          />
        )}
      </div>
    </I18nProvider>
  );
}

describe("model sheet shell", () => {
  it("leaves the canvas's window-level Escape alone: the canvas skips Escape while a dialog is open, and the sheet is one", async () => {
    // StudioCanvas listens on window (capture) and returns when [role="dialog"] is present; Radix Content carries that role.
    let sawDialog: boolean | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") sawDialog = !!document.querySelector('[role="dialog"]');
    };
    window.addEventListener("keydown", onKey, true);
    try {
      render(<Page />);
      await screen.findByRole("dialog");
      await waitFor(() => expect(document.activeElement?.getAttribute("data-model")).toBe("pic-fine"));
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(sawDialog).toBe(true);
    } finally {
      window.removeEventListener("keydown", onKey, true);
    }
  });

  it("opens on the model in use, and Escape closes the sheet without reaching a React ancestor (the panel behind)", async () => {
    const canvasEscape = vi.fn();
    render(<Page onCanvasEscape={canvasEscape} />);
    const dialog = await screen.findByRole("dialog", { name: dictionaries.en.gen.sheetTitle });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-model")).toBe("pic-fine"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(canvasEscape).not.toHaveBeenCalled();
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement?.textContent).toBe("change");
  });

  it("is modal: focus guards at its edges, focus inside, the page behind hidden and still", async () => {
    render(<Page />);
    const dialog = await screen.findByRole("dialog");
    // Radix's scroll lock marks the body; the page under the sheet does not move with a thumb.
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(true);
    // Everything outside is hidden from a screen reader while the sheet is open.
    expect(screen.getByText("change").closest("[aria-hidden=true]")).toBeTruthy();
    // Radix's focus guards wrap Tab at both edges of the sheet.
    const guards = document.querySelectorAll("[data-radix-focus-guard]");
    expect(guards.length).toBe(2);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it.each(["ru", "uz"] as const)("speaks %s: title, description and close key", async (locale) => {
    render(<Page locale={locale} />);
    const g = dictionaries[locale].gen;
    const dialog = await screen.findByRole("dialog", { name: g.sheetTitle });
    expect(screen.getByRole("button", { name: g.sheetClose })).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    // The description is the formatted sentence for this tool, in this language (kindLabel's t2i word filled in).
    const desc = document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent ?? "";
    const words = g.sheetFor.replace("{kind}", "").replace(/[·.,]/g, " ").split(/\s+/).filter((w) => w.length > 2);
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(desc).toContain(w);
  });
});
