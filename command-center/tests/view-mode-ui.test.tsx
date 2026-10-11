// @vitest-environment jsdom
/* eslint-disable @next/next/no-html-link-for-pages -- the test renders plain anchors on purpose: it checks which clicks leave the frame */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const nav = vi.hoisted(() => ({ reload: vi.fn(), assign: vi.fn() }));
vi.mock("@/components/view-mode/frame-nav", () => ({ reloadTop: nav.reload, assignTop: nav.assign }));

import { getDictionaryFor, type Locale } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { ViewModeToggle } from "@/components/view-mode/ViewModeToggle";
import { ViewFrame } from "@/components/view-mode/ViewFrame";
import { EmbedBridge } from "@/components/view-mode/EmbedBridge";
import { FRAME_SYNC } from "@/lib/view-mode";

const wrap = (children: ReactNode, locale: Locale = "en") => (
  <PublicI18nProvider locale={locale} t={publicDictionary(getDictionaryFor(locale))}>
    {children}
  </PublicI18nProvider>
);

/** jsdom has no layout: say whether the viewport is wide, and how big the screen is. */
function device({ wide, screen: size }: { wide: boolean; screen: number }) {
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 1024px)" ? wide : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window.screen, "width", { configurable: true, value: size });
  Object.defineProperty(window.screen, "height", { configurable: true, value: size * 2 });
}
const clearCookie = () => {
  document.cookie = "ns_view=; path=/; max-age=0";
};

beforeEach(() => {
  clearCookie();
  nav.reload.mockClear();
  nav.assign.mockClear();
});
afterEach(cleanup);

describe("ViewModeToggle", () => {
  it("on a phone with no choice shows Mobile, and a press stores Desktop and reloads the window", () => {
    device({ wide: false, screen: 390 });
    render(wrap(<ViewModeToggle showLabel />));
    const button = screen.getByRole("button", { name: "Switch to Desktop view" });
    expect(button.textContent).toBe("Mobile");
    fireEvent.click(button);
    expect(document.cookie).toContain("ns_view=desktop");
    expect(nav.reload).toHaveBeenCalledTimes(1);
  });

  it("on a laptop with no choice shows Desktop, and a press stores Mobile (the phone frame)", () => {
    device({ wide: true, screen: 1440 });
    render(wrap(<ViewModeToggle showLabel />));
    const button = screen.getByRole("button", { name: "Switch to Mobile view" });
    expect(button.textContent).toBe("Desktop");
    fireEvent.click(button);
    expect(document.cookie).toContain("ns_view=mobile");
    expect(nav.reload).toHaveBeenCalledTimes(1);
  });

  it("shows the stored choice, not the viewport: Desktop forced on a phone, and a press on a phone-sized screen clears the cookie", () => {
    device({ wide: true, screen: 390 });
    document.cookie = "ns_view=desktop; path=/";
    render(wrap(<ViewModeToggle showLabel />));
    const button = screen.getByRole("button", { name: "Switch to Mobile view" });
    expect(button.textContent).toBe("Desktop");
    fireEvent.click(button);
    expect(document.cookie).not.toContain("ns_view");
    expect(nav.reload).toHaveBeenCalledTimes(1);
  });

  it("inside the phone frame (cookie mobile) shows Mobile and a press goes to Desktop", () => {
    device({ wide: false, screen: 1440 });
    document.cookie = "ns_view=mobile; path=/";
    render(wrap(<ViewModeToggle showLabel />));
    fireEvent.click(screen.getByRole("button", { name: "Switch to Desktop view" }));
    expect(document.cookie).toContain("ns_view=desktop");
  });

  it("ignores a cookie with any other value", () => {
    device({ wide: true, screen: 1440 });
    document.cookie = "ns_view=tablet; path=/";
    render(wrap(<ViewModeToggle showLabel />));
    expect(screen.getByRole("button").textContent).toBe("Desktop");
  });

  it("the footer link names the version a press gives", () => {
    device({ wide: false, screen: 390 });
    render(wrap(<ViewModeToggle variant="link" />));
    expect(screen.getByRole("button", { name: "Switch to Desktop view" }).textContent).toContain("Desktop version");
  });

  it.each([
    ["ru", "Мобильный", "Переключить на десктопный вид"],
    ["uz", "Mobil", "Desktop koʻrinishga oʻtish"],
  ] as const)("is labelled in %s", (locale, word, action) => {
    device({ wide: false, screen: 390 });
    render(wrap(<ViewModeToggle showLabel />, locale));
    const button = screen.getByRole("button", { name: action });
    expect(button.textContent).toBe(word);
  });

  it("is a real button: it can be pressed from the keyboard and names its action", () => {
    device({ wide: false, screen: 390 });
    render(wrap(<ViewModeToggle />));
    const button = screen.getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Switch to Desktop view");
    expect(button.getAttribute("aria-pressed")).toBeNull();
  });
});

describe("ViewFrame", () => {
  it("draws one same-origin frame at the URL it was given, and the switch beside it", () => {
    device({ wide: true, screen: 1440 });
    document.cookie = "ns_view=mobile; path=/";
    const { container } = render(wrap(<ViewFrame src="/chronos/videos?x=1" />));
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute("src")).toBe("/chronos/videos?x=1");
    expect(frames[0].getAttribute("title")).toBe("Nightshift, Mobile view");
    expect(screen.getByRole("button", { name: "Switch to Desktop view" })).toBeTruthy();
  });

  function post(source: Window | null, origin: string, data: unknown) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    });
  }

  it("follows the frame's address and title, and only the frame's", () => {
    device({ wide: true, screen: 1440 });
    const { container } = render(wrap(<ViewFrame src="/pricing" />));
    const win = container.querySelector("iframe")!.contentWindow;
    const msg = { type: FRAME_SYNC, href: "/chronos/analytics?range=7d", title: "Analytics" };

    post(win, window.location.origin, msg);
    expect(window.location.pathname + window.location.search).toBe("/chronos/analytics?range=7d");
    expect(document.title).toBe("Analytics");

    // another origin, another window, a malformed href: nothing moves
    post(win, "https://evil.example", { ...msg, href: "/stolen" });
    post(window, window.location.origin, { ...msg, href: "/stolen" });
    post(win, window.location.origin, { ...msg, href: "https://evil.example/" });
    expect(window.location.pathname).toBe("/chronos/analytics");
  });

  it("follows a theme chosen inside the frame", () => {
    device({ wide: true, screen: 1440 });
    render(wrap(<ViewFrame src="/pricing" />));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "chronos_theme", newValue: "light" }));
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "chronos_theme", newValue: "bogus" }));
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("EmbedBridge", () => {
  const parentPost = vi.fn();
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    parentPost.mockClear();
    // jsdom's window is its own parent; make it look like a frame of the same origin.
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage: parentPost, location: { origin: window.location.origin } },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    window.history.replaceState(null, "", "/");
  });

  it("tells the parent where it is, on load and on every client-side navigation, without repeating itself", () => {
    render(<EmbedBridge />);
    expect(parentPost).toHaveBeenCalledTimes(1);
    expect(parentPost.mock.calls[0][0]).toMatchObject({ type: FRAME_SYNC, href: "/" });
    expect(parentPost.mock.calls[0][1]).toBe(window.location.origin);

    act(() => window.history.pushState(null, "", "/pricing#faq"));
    expect(parentPost).toHaveBeenLastCalledWith({ type: FRAME_SYNC, href: "/pricing#faq", title: document.title }, window.location.origin);
    const n = parentPost.mock.calls.length;
    act(() => window.history.replaceState(null, "", "/pricing#faq"));
    expect(parentPost).toHaveBeenCalledTimes(n);
  });

  it("opens another site's link and a provider connection in the whole window", () => {
    render(
      <div>
        <a href="https://accounts.google.com/x">google</a>
        <a href="/api/oauth/youtube/start?ref=1">connect</a>
        <a href="/chronos/videos">videos</a>
        <a href="https://docs.example/x" target="_blank">newtab</a>
        <a href="https://files.example/a.zip" download>dl</a>
      </div>,
    );
    // render() put the bridge nowhere; mount it beside the links
    render(<EmbedBridge />);
    // jsdom cannot navigate: what the bridge leaves alone is stopped here, after it has had its say.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("click", stop);
    fireEvent.click(screen.getByText("google"));
    fireEvent.click(screen.getByText("connect"));
    expect(nav.assign.mock.calls.map((c) => c[0])).toEqual(["https://accounts.google.com/x", `${window.location.origin}/api/oauth/youtube/start?ref=1`]);

    nav.assign.mockClear();
    fireEvent.click(screen.getByText("videos"));
    fireEvent.click(screen.getByText("newtab"));
    fireEvent.click(screen.getByText("dl"));
    fireEvent.click(screen.getByText("google"), { ctrlKey: true });
    expect(nav.assign).not.toHaveBeenCalled();
    document.removeEventListener("click", stop);
  });

  it("does nothing when the page is not in a frame of its own origin", () => {
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    render(<EmbedBridge />);
    expect(parentPost).not.toHaveBeenCalled();
    Object.defineProperty(window, "parent", {
      configurable: true,
      get() {
        return { postMessage: parentPost, get location(): never { throw new DOMException("cross-origin", "SecurityError"); } };
      },
    });
    render(<EmbedBridge />);
    expect(parentPost).not.toHaveBeenCalled();
  });
});
