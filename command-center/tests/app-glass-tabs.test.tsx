// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useRef, type ReactNode } from "react";

/**
 * The travelling plate across a remount. The section tabs live under the
 * [channel] template, which remounts them on every route change: without the
 * remembered place the plate could only ever appear under the new tab, never
 * travel to it. What would break: the strip stops being wired to the shared
 * indicator, or a remount stops starting from where the plate stood.
 */

let pathname = "/chronos/home";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(""),
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

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { SectionTabs } from "@/components/navigation/SectionTabs";
import { resetIndicatorMemory, useSlidingIndicator } from "@/components/ui/useSlidingIndicator";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom has no layout: each item sits at 2 + index * 104, 100 wide, in a 728px track.
beforeEach(() => {
  resetIndicatorMemory();
  const index = (el: HTMLElement): number => {
    const host = el.parentElement?.tagName === "LI" ? el.parentElement : el;
    return host.parentElement ? Array.from(host.parentElement.children).indexOf(host) : 0;
  };
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return 2 + index(this) * 104;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 100);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(() => 0);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => 44);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 728);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => 44);
});

function Strip({ chosen, memory }: { chosen: number; memory?: string }) {
  const ref = useRef<HTMLUListElement>(null);
  useSlidingIndicator(ref, ":scope > li > a", chosen, "a,b,c", memory);
  return (
    <ul ref={ref} data-testid="strip">
      {["a", "b", "c"].map((k, i) => (
        <li key={k}>
          <a href={`#${k}`} aria-current={i === chosen ? "page" : undefined}>
            {k}
          </a>
        </li>
      ))}
    </ul>
  );
}

describe("a remounted strip", () => {
  it("starts the plate where it stood and travels to the new item", () => {
    const first = render(<Strip chosen={0} memory="strip" />);
    expect(screen.getByTestId("strip").style.getPropertyValue("--ns-ind-l")).toBe("2px");
    first.unmount();
    // The written sequence: the old place (instant), then the new one with a direction.
    const writes: string[] = [];
    const set = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (this: CSSStyleDeclaration, name: string, value: string | null, prio?: string) {
      if (name === "--ns-ind-l") writes.push(value ?? "");
      return set.call(this, name, value, prio);
    });
    render(<Strip chosen={2} memory="strip" />);
    const strip = screen.getByTestId("strip");
    expect(writes.filter((w, i) => w !== writes[i - 1])).toEqual(["2px", "210px"]);
    expect(strip.getAttribute("data-ind-dir")).toBe("fwd");
    expect(strip.hasAttribute("data-indicator")).toBe(true);
    expect(strip.hasAttribute("data-ind-instant")).toBe(false);
  });

  it("without a memory key, a remount simply appears under the chosen item", () => {
    render(<Strip chosen={0} />).unmount();
    render(<Strip chosen={2} />);
    const strip = screen.getByTestId("strip");
    expect(strip.style.getPropertyValue("--ns-ind-l")).toBe("210px");
    expect(strip.hasAttribute("data-ind-dir")).toBe(false);
  });
});

describe("SectionTabs", () => {
  const en = dictionaries.en;
  const tabs = () => (
    <I18nProvider locale="en">
      <ShellProvider operator={false}>
        <SectionTabs />
      </ShellProvider>
    </I18nProvider>
  );

  it("draws no strip on the screens that used to be the hub's tabs: they are Studio home tiles now", () => {
    for (const p of ["/chronos/home", "/chronos/library", "/chronos/create", "/chronos/studio", "/chronos/styles"]) {
      pathname = p;
      const r = render(tabs());
      expect(screen.queryByRole("navigation", { name: en.nav.sections }), p).toBeNull();
      r.unmount();
    }
  });
});
