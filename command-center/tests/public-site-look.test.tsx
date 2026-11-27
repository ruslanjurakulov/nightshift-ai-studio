// @vitest-environment jsdom
/**
 * The public site looks as it did before 20 November (owner, 2026-11-22); the signed-in app keeps the navy look.
 *
 * What would break without these: "/" drawing the #824 HomePage (and its navy frame) again; <html class="ds-skin"> on a page a
 * signed-out visitor sees (pricing, legal, sign-in, the 404) or missing from the app; the skin decided from a URL the client can
 * type instead of the middleware's "app" decision; a soft navigation carrying one look into the other; the pricing finder's
 * first stepper sitting a line above the other two; a disabled minus drawn as an empty circle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CHANNEL_HEADER } from "@/lib/channels";
import { DS_SKIN_CLASS, skinOnFor } from "@/lib/skin";
import { AppSkin } from "@/components/shell/AppSkin";
import { PlanFinder } from "@/components/pricing/PlanFinder";
import { en } from "@/lib/i18n/en";

const root = process.cwd();
const src = (f: string) => readFileSync(path.join(root, f), "utf8");

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove(DS_SKIN_CLASS);
});

describe('"/" is the pre-20-November landing', () => {
  it("renders Landing, not the #824 HomePage, so the navy frame (.st:has(.hm-root)) has nothing to match", () => {
    const page = src("app/page.tsx");
    expect(page).toMatch(/import \{ Landing \} from "@\/components\/landing\/Landing"/);
    expect(page).toMatch(/<Landing\b/);
    expect(page).not.toMatch(/from "@\/components\/landing\/home|<HomePage\b/);
  });
});

describe("the navy skin is the signed-in app's only", () => {
  const hdrs = (h: Record<string, string>) => new Headers(h);

  it("is on only when the middleware handed the request a channel (its 'app' decision)", () => {
    expect(skinOnFor(hdrs({ [CHANNEL_HEADER]: "chronos" }))).toBe(true);
    // Every "pass" (public pages, /login, /welcome) and the public 404 rewrite reach the layout with no channel header.
    expect(skinOnFor(hdrs({}))).toBe(false);
  });

  it("the root layout takes the class from that decision, never a constant", () => {
    const layout = src("app/layout.tsx");
    expect(layout).toMatch(/const skin = skinOnFor\(requestHeaders\) \? DS_SKIN_CLASS : undefined;/);
    expect(layout).toMatch(/<html lang=\{locale\} className=\{skin\}/);
    expect(layout).not.toMatch(/className="ds-skin"/);
  });

  it("the middleware sets the channel header only on its last, signed-in step (after every 'pass' returned)", () => {
    const mw = src("middleware.ts");
    const lastPass = mw.lastIndexOf('if (decision === "pass") return response;');
    const setChannel = mw.indexOf("headers.set(CHANNEL_HEADER");
    expect(lastPass).toBeGreaterThan(0);
    expect(setChannel).toBeGreaterThan(lastPass);
  });

  it("the signed-in layouts mount AppSkin; it adds the class while on screen and takes it away when the app is left", () => {
    expect(src("app/(app)/layout.tsx")).toMatch(/<AppSkin \/>/);
    expect(src("app/owner/layout.tsx")).toMatch(/<AppSkin \/>/);
    const view = render(<AppSkin />);
    expect(document.documentElement.classList.contains(DS_SKIN_CLASS)).toBe(true);
    view.unmount();
    expect(document.documentElement.classList.contains(DS_SKIN_CLASS)).toBe(false);
  });
});

describe("the pricing finder's steppers", () => {
  const css = src("components/pricing/plan-finder.css");

  it("sit on one line wherever the three are side by side (>= 640px): label top, stepper on the row's bottom", () => {
    expect(css).toMatch(/@media \(min-width: 640px\) \{ \.pf-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
    expect(css).toMatch(/@media \(min-width: 640px\) \{ \.pf-grid > \.pf-field \{ align-content: space-between; \} \}/);
    // Nothing may stop the fields stretching to the row (the grid's default does it).
    expect(css).not.toMatch(/\.pf-grid \{[^}]*align-items:/);
    expect(css).not.toMatch(/\.pf-field \{[^}]*align-self:/);
  });

  it("a disabled key never fades its sign away: no opacity on the key, a colour of its own for the icon", () => {
    const rule = css.match(/\.pf-step-key:disabled \{([^}]*)\}/)![1];
    expect(rule).not.toMatch(/opacity/);
    expect(rule).toMatch(/color: var\(--ns-text-dim\)/);
    expect(css).not.toMatch(/\.pf-step-key:disabled svg \{[^}]*(opacity|visibility|display: none)/);
  });

  it("at its minimum the minus key is disabled and still draws its minus", () => {
    render(
      <PlanFinder copy={en.planFinder.finder} locale="en" unitForms={en.shell.creditUnit} plans={[]} video={null} stamp="" conceptImages={4} />,
    );
    const minus = screen.getByRole("button", { name: `${en.planFinder.finder.fewer}: ${en.planFinder.finder.channels}` }) as HTMLButtonElement;
    expect(minus.disabled).toBe(true);
    const svg = minus.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.querySelector("path, line")).not.toBeNull();
  });
});
