// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";

/**
 * The live E2E (2026-11-20): step 2 asked for a niche and a video language (a YouTube channel's questions) before anyone
 * had made anything, and a reload changed the step count under the person. What would break without these: the first
 * choice not being what to make; a tile that starts something instead of opening a form; the count or the step moving
 * on a reload.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/welcome" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

const { WelcomeFlow, startIndex } = await import("@/components/welcome/WelcomeFlow");
const en = dictionaries.en;
const props = { needsWorkspace: false, unavailable: false, hasChannel: false, canConnectYouTube: false, showCredits: true, welcomeCredits: null, contactEmail: null };
afterEach(cleanup);

describe("/welcome, Studio first", () => {
  it("asks what to make, with image, video and voice tiles that only open Create", () => {
    render(<I18nProvider locale="en"><WelcomeFlow {...props} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: en.customerApp.welcome.title })).toBeTruthy();
    expect(screen.queryByText(en.signup.nicheLabel)).toBeNull();
    const links = within(screen.getByTestId("welcome-make")).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/all-channels/create?kind=image", "/all-channels/create?kind=video", "/all-channels/create?kind=audio"]);
  });

  it("keeps three steps whether or not the workspace was just made, and resumes the last step after a reload", () => {
    render(<I18nProvider locale="en"><WelcomeFlow {...props} /></I18nProvider>);
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.signup.skip }));
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(window.location.search).toContain("step=next");
    expect(startIndex(false, "next")).toBe(2);
    expect(startIndex(false, null)).toBe(1);
    // A new account always starts at the workspace, whatever the address says.
    expect(startIndex(true, "next")).toBe(0);
  });
});
