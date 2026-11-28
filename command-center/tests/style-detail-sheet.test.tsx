// @vitest-environment jsdom
/**
 * A library style in full (components/styles/StyleDetailSheet.tsx), on the shared Sheet since S5's dialog move. It had no
 * test. What would break without these: the sheet speaking English to a Russian or Uzbek reader, Escape closing the sheet
 * AND the page behind, focus left on <body> after closing (a keyboard user thrown to the top of the style grid), and the
 * two keys acting while a request runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { STYLE_LIBRARY } from "@/lib/styles/library";
import { StyleDetailSheet, type SheetBusy } from "@/components/styles/StyleDetailSheet";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/styles", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
afterEach(cleanup);

const style = STYLE_LIBRARY[0];

function Page({ locale = "en" as "en" | "ru" | "uz", busy = null as SheetBusy, onBehind = () => {}, onAdd = () => {} }) {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider locale={locale}>
      <div onKeyDown={(e) => e.key === "Escape" && onBehind()}>
        <button type="button" onClick={() => setOpen(true)}>
          tile
        </button>
        {open && (
          <StyleDetailSheet
            style={style}
            added={false}
            canAdd
            busy={busy}
            notice={null}
            error={null}
            onAdd={onAdd}
            onUse={() => {}}
            onClose={() => setOpen(false)}
            manageHref="/styles"
          />
        )}
      </div>
    </I18nProvider>
  );
}

describe("StyleDetailSheet", () => {
  it.each(["en", "ru", "uz"] as const)("is a dialog named by the style, with its close key in %s", async (locale) => {
    render(<Page locale={locale} />);
    fireEvent.click(screen.getByRole("button", { name: "tile" }));
    expect(await screen.findByRole("dialog", { name: style.name[locale] })).toBeTruthy();
    expect(screen.getByRole("button", { name: dictionaries[locale].styleLibrary.close })).toBeTruthy();
  });

  it("Escape closes only the sheet, and focus goes back to the tile", async () => {
    const behind = vi.fn();
    render(<Page onBehind={behind} />);
    const tile = screen.getByRole("button", { name: "tile" });
    tile.focus();
    fireEvent.click(tile);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(behind).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(tile));
  });

  it("while a request runs, neither key can be pressed again", async () => {
    const add = vi.fn();
    render(<Page busy="add" onAdd={add} />);
    fireEvent.click(screen.getByRole("button", { name: "tile" }));
    await screen.findByRole("dialog");
    const t = dictionaries.en.styleLibrary;
    expect((screen.getByRole("button", { name: t.adding }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: t.useInStudio }) as HTMLButtonElement).disabled).toBe(true);
  });
});
