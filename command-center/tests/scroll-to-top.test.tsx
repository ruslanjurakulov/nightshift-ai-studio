// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { ScrollToTop } from "@/components/navigation/ScrollToTop";

afterEach(cleanup);

function button(dock?: boolean) {
  const { container } = render(
    <I18nProvider locale="en">
      <ScrollToTop dock={dock} />
    </I18nProvider>,
  );
  return container.querySelector("button.scroll-top") as HTMLButtonElement;
}

describe("ScrollToTop", () => {
  it("marks itself docked only where the phone's tab bar is shown", () => {
    expect(button(true).getAttribute("data-dock")).toBe("true");
    cleanup();
    expect(button(false).hasAttribute("data-dock")).toBe(false);
    cleanup();
    expect(button().hasAttribute("data-dock")).toBe(false);
  });

  it("the docked button is lifted above the tab bar on phones only", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 1023px\)\s*\{\s*\.scroll-top\[data-dock="true"\]\s*\{\s*bottom: calc\(env\(safe-area-inset-bottom\) \+ 4\.75rem\)/);
  });
});
