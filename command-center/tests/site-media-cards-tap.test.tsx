// @vitest-environment jsdom
/**
 * TapReveal on the real markup of both media grids, rendered together as the landing renders them (ShowcaseGallery, then
 * EffectsGallery), rather than on a hand-made list. What would break if these failed: a phone tap that leaves for sign-up before
 * the caption was read, on either grid (each grid mounts its own TapReveal, the Effects one beside its <ul> inside .nx-wrap); a
 * keyboard Enter swallowed on a touch device; and two captions left showing at once, one per grid, so that the card revealed in
 * the first grid opens on a single tap later although the person moved on to the other grid (found by Probe in the browser at
 * 360 px: tap an explore card, tap an Effects card, both stay data-revealed="true").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pulled out so they never reach the <a>
  default: ({ href, children, prefetch: _p, replace: _r, ...rest }: { href: string; children?: ReactNode; prefetch?: boolean; replace?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries } from "@/lib/i18n";
import { ShowcaseGallery } from "@/components/site/ShowcaseGallery";
import { EffectsGallery } from "@/components/site/EffectsGallery";
import { FIXTURE_ENTRY, FIXTURE_FILES } from "./fixtures/showcase-entry";

afterEach(cleanup);

const t = dictionaries.en;
const NOW = new Date("2026-11-22T00:00:00Z");

function landing() {
  const second = { ...FIXTURE_ENTRY, jobId: "0b0b0b0b-1111-4222-8333-444455557777", assetId: "0c0c0c0c-1111-4222-8333-444455557777" };
  const files = { [FIXTURE_ENTRY.jobId]: FIXTURE_FILES[FIXTURE_ENTRY.jobId], [second.jobId]: FIXTURE_FILES[FIXTURE_ENTRY.jobId] };
  return render(
    <main>
      <ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY, second]} files={files} now={NOW} />
      <EffectsGallery t={t} />
      <p data-testid="outside">outside</p>
    </main>,
  );
}

/** A pointerdown of `kind` (jsdom has no PointerEvent: a MouseEvent with pointerType). */
function down(el: Element, kind: string, type = "pointerdown") {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "pointerType", { value: kind });
  el.dispatchEvent(ev);
}
/**
 * A click with `detail`; true when it went through (TapReveal, listening in the capture phase, did not hold it back). The link's
 * own listener reads that and then cancels the navigation itself, which jsdom does not implement.
 */
function click(el: Element, detail: number): boolean {
  let through = false;
  el.addEventListener("click", (ev) => {
    through = !ev.defaultPrevented;
    ev.preventDefault();
  }, { once: true });
  fireEvent.click(el, { detail });
  return through;
}
/** A finger's tap: pointerdown, then a click with detail 1. */
function tap(el: Element): boolean {
  down(el, "touch");
  return click(el, 1);
}
const card = (link: Element) => link.closest("[data-mf-card]")!;
const revealed = (c: ParentNode) => [...c.querySelectorAll('[data-revealed="true"]')];

describe("TapReveal on the landing's two grids", () => {
  it("the shipped markup is wired: a first tap on an explore card and on an Effects card is held and reveals, the second goes through", () => {
    const { container } = landing();
    const g = container.querySelector("#samples .mf-card-link")!;
    const e = container.querySelector("#effects .mf-card-link")!;
    expect(g && e).toBeTruthy();
    expect(tap(g)).toBe(false);
    expect(card(g).getAttribute("data-revealed")).toBe("true");
    expect(tap(g)).toBe(true);
    expect(tap(e)).toBe(false);
    expect(card(e).getAttribute("data-revealed")).toBe("true");
    expect(tap(e)).toBe(true);
  });

  it("a keyboard Enter (detail 0) on a card link is never held, even right after a finger went down on that card", () => {
    const { container } = landing();
    for (const sel of ["#samples .mf-card-link", "#effects .mf-card-link"]) {
      const link = container.querySelector(sel)!;
      down(link, "touch");
      expect(click(link, 0)).toBe(true);
      expect(card(link).hasAttribute("data-revealed")).toBe(false);
    }
  });

  it("a tap outside both grids clears the card revealed in either", () => {
    const { container, getByTestId } = landing();
    tap(container.querySelector("#effects .mf-card-link")!);
    down(getByTestId("outside"), "touch");
    expect(revealed(container)).toHaveLength(0);
  });

  // FAILS on c944911: each TapReveal's "tap outside" test is `closest([data-mf-card])`, which an Effects card passes, so the
  // explore card stays revealed (and later opens on one tap); and each grid's own clear() only looks inside its own root.
  it("revealing a card in one grid clears the card revealed in the other: one caption shows at a time on the page", () => {
    const { container } = landing();
    const g = container.querySelector("#samples .mf-card-link")!;
    const e = container.querySelector("#effects .mf-card-link")!;
    tap(g);
    expect(tap(e)).toBe(false);
    expect(revealed(container).map((c) => c.closest("section")?.id)).toEqual(["effects"]);
    // So the explore card the person left needs its two taps again.
    expect(tap(g)).toBe(false);
    expect(revealed(container).map((c) => c.closest("section")?.id)).toEqual(["samples"]);
  });
});
