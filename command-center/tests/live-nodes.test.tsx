// @vitest-environment jsdom
/**
 * The live canvas's cards (components/live, LIVE_CREATION_PLAN item 4). What would break without these:
 * - a price chip, a percentage or a queue position the backend or the provider never gave (rule 5);
 * - a retry with no backend price that can still be pressed (rule 3);
 * - a disabled or short-of-credits card that hides why (§2: every state designed, never blank);
 * - the "working" light on a card that is not working (SYSTEM.md §5: motion must be true);
 * - a glow for a card first read as ready (a refresh is not an arrival);
 * - a prompt read to a screen reader letter by letter, or revealed again after a refresh;
 * - the reveal or the stagger running long (25 ms a character, 600 ms at most; 60–120 ms between cards);
 * - live.css moved into a @layer, where the app's unlayered border and focus rules beat it (#965's trap);
 * - an Uzbek string with a typewriter apostrophe.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import {
  LAND_MAX_DELAY_MS,
  LAND_STAGGER_MS,
  LANDED_GLOW_MS,
  LiveConnector,
  LiveEmpty,
  LiveNode,
  RevealText,
  connectorPath,
  formatElapsed,
  landDelay,
  revealDuration,
  revealedCount,
  type LiveNodeProps,
} from "@/components/live";
import { liveFixtures } from "@/components/live/fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const en = dictionaries.en.liveNodes;

function card(props: Partial<LiveNodeProps> = {}, locale: "en" | "ru" | "uz" = "en") {
  const all: LiveNodeProps = { id: "n1", kind: "still", state: "queued", title: "Shot 02", ...props };
  return render(
    <I18nProvider locale={locale}>
      <LiveNode {...all} />
    </I18nProvider>,
  );
}

describe("LiveNode: only what was measured or computed is shown", () => {
  it("shows a price chip only for a backend number", () => {
    const { container, rerender } = card({ price: null });
    expect(container.querySelector(".live-node-price")).toBeNull();
    rerender(
      <I18nProvider locale="en">
        <LiveNode id="n1" kind="still" state="queued" title="Shot 02" price={12} />
      </I18nProvider>,
    );
    expect(container.querySelector(".live-node-price")?.textContent).toContain("12");
  });

  it("draws a progress bar only when the provider measured one, and never outside working", () => {
    expect(card({ state: "working", progress: null }).container.querySelector("[role=progressbar]")).toBeNull();
    cleanup();
    const bar = card({ state: "working", progress: 0.42 }).container.querySelector("[role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBe("42");
    expect(bar?.getAttribute("aria-valuetext")).toContain("provider");
    cleanup();
    expect(card({ state: "queued", progress: 0.42 }).container.querySelector("[role=progressbar]")).toBeNull();
  });

  it("never shows a value outside 0..1 as measured (a percent passed by mistake, a -1 'unknown')", () => {
    for (const progress of [42, -1, Number.NaN, 1.01]) {
      expect(card({ state: "working", progress }).container.querySelector("[role=progressbar]"), String(progress)).toBeNull();
      cleanup();
    }
  });

  it("shows an elapsed timer only with a start time from the server, ticking while the job works", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    const { container } = card({ state: "working", startedAt: Date.now() - 65_000 });
    expect(container.querySelector(".live-node-time")?.textContent).toContain("1:05");
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector(".live-node-time")?.textContent).toContain("1:07");
    cleanup();
    expect(card({ state: "working", startedAt: null }).container.querySelector(".live-node-time")).toBeNull();
  });

  it("shows a queue position only when the provider reported one", () => {
    expect(card({ state: "queued", queuePosition: null }).container.querySelector(".live-node-note")).toBeNull();
    cleanup();
    expect(card({ state: "queued", queuePosition: 3 }).container.querySelector(".live-node-note")?.textContent).toBe(en.queuePosition.replace("{n}", "3"));
  });

  it("runs the edge light and the shimmer only while working", () => {
    for (const state of ["ghost", "queued", "arrived", "failed", "disabled", "insufficient"] as const) {
      const { container } = card({ state });
      expect(container.querySelector("[data-fx=beam]"), state).toBeNull();
      expect(container.querySelector("[data-fx=shimmer]"), state).toBeNull();
      cleanup();
    }
    const { container } = card({ state: "working", phase: "making" });
    expect(container.querySelector("[data-fx=beam]")?.getAttribute("aria-hidden")).toBe("true");
    // The phase word stays readable text; only the light is decoration.
    const shimmer = container.querySelector("[data-fx=shimmer]")!;
    expect(shimmer.textContent).toBe(en.phase.making);
    // The word's colour sits on a wrapper: an unlayered colour on the shimmer itself would paint over its light (Lens).
    expect(shimmer.className).not.toContain("live-node-word");
    expect(shimmer.parentElement?.className).toContain("live-node-word");
  });

  it("sets a machine's words in mono and the person's title in the UI face", () => {
    const { container } = card({ prompt: "A brass lamp", model: "image-model-a" });
    expect(container.querySelector(".live-node-prompt-text")?.className).toContain("ds-mono");
    expect(container.querySelector(".live-node-model")?.className).toContain("ds-mono");
    expect(container.querySelector(".live-node-title")?.className).not.toContain("mono");
    expect(container.textContent).toContain(en.written);
  });
});

describe("LiveNode: failed, disabled and short of credits are never dead ends", () => {
  it("a retry without a backend price cannot be pressed and says why", () => {
    const onRetry = vi.fn();
    card({ state: "failed", failureCause: "c", failureRemedy: "r", retryPrice: null, onRetry });
    const key = screen.getByRole("button", { name: en.failed.retryUnpriced });
    expect((key as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(key);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a NaN retry price is no price: the key cannot be pressed", () => {
    const onRetry = vi.fn();
    card({ state: "failed", retryPrice: Number.NaN, onRetry });
    const key = screen.getByRole("button", { name: en.failed.retryUnpriced }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    fireEvent.click(key);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("offers no retry key at all when the board offers no retry", () => {
    card({ state: "failed", failureCause: "c" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a priced retry names its price, and a busy one swallows a second press", () => {
    const onRetry = vi.fn();
    const { rerender } = card({ state: "failed", failureCause: "The provider refused", failureRemedy: "Edit the prompt", retryPrice: 40, onRetry });
    expect(screen.getByText("The provider refused")).toBeTruthy();
    expect(screen.getByText("Edit the prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /40/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("n1");
    rerender(
      <I18nProvider locale="en">
        <LiveNode id="n1" kind="still" state="failed" title="Shot 02" retryPrice={40} retryBusy onRetry={onRetry} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /40/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a disabled card says its reason; a short one says the shortfall and links to credits", () => {
    card({ state: "disabled", reason: "Music is not on this plan yet." });
    expect(screen.getByText("Music is not on this plan yet.")).toBeTruthy();
    cleanup();
    card({ state: "insufficient", shortfallCredits: 18, topUpHref: "/acme/credits" });
    expect(screen.getByText(/18/)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.insufficient.topUp }).getAttribute("href")).toBe("/acme/credits");
  });

  it("a disabled card with no recorded reason says so, never a blank", () => {
    card({ state: "disabled" });
    expect(screen.getByText(en.disabledNoReason)).toBeTruthy();
  });

  it("links to credits only inside the app", () => {
    for (const href of ["https://evil.example/pay", "//evil.example", "javascript:alert(1)", "credits"]) {
      card({ state: "insufficient", shortfallCredits: 5, topUpHref: href });
      expect(screen.queryByRole("link"), href).toBeNull();
      cleanup();
    }
  });

  it("an unknown shortfall still offers the top-up link, and shows no number", () => {
    const { container } = card({ state: "insufficient", shortfallCredits: null, topUpHref: "/c" });
    expect(screen.getByRole("link", { name: en.insufficient.topUp })).toBeTruthy();
    expect(container.querySelector(".live-node-short p")).toBeNull();
  });
});

describe("LiveNode: arrival", () => {
  it("glows and announces once for a watched arrival, then stops", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, rerender } = card({ state: "working", announce: true });
    const node = () => container.querySelector(".live-node")!;
    expect(node().getAttribute("data-landed")).toBeNull();
    rerender(
      <I18nProvider locale="en">
        <LiveNode id="n1" kind="still" state="arrived" title="Shot 02" announce />
      </I18nProvider>,
    );
    expect(node().getAttribute("data-landed")).toBe("true");
    // Named, so a run of arrivals can be told apart.
    expect(container.querySelector("[role=status]")?.textContent).toContain("ready");
    expect(container.querySelector("[role=status]")?.textContent).toContain("Shot 02");
    act(() => vi.advanceTimersByTime(LANDED_GLOW_MS + 1));
    expect(node().getAttribute("data-landed")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("has no live region of its own unless the board asks: a board announces once, with names", () => {
    expect(card({ state: "arrived" }).container.querySelector("[role=status]")).toBeNull();
  });

  it("does not glow for a card first read as ready (a refresh)", () => {
    const { container } = card({ state: "arrived", announce: true });
    expect(container.querySelector(".live-node")?.getAttribute("data-landed")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("does not glow after a failure", () => {
    const { container, rerender } = card({ state: "failed" });
    rerender(
      <I18nProvider locale="en">
        <LiveNode id="n1" kind="still" state="arrived" title="Shot 02" />
      </I18nProvider>,
    );
    expect(container.querySelector(".live-node")?.getAttribute("data-landed")).toBeNull();
  });

  it("shows the picture only once it has loaded, and a new take starts unloaded", () => {
    const { container, rerender } = card({ state: "arrived", mediaSrc: "data:image/gif;base64,AAAA", mediaAlt: "a still" });
    const frame = () => container.querySelector(".live-node-media")!;
    expect(frame().getAttribute("data-loaded")).toBeNull();
    fireEvent.load(screen.getByRole("img", { name: "a still" }));
    expect(frame().getAttribute("data-loaded")).toBe("true");
    rerender(
      <I18nProvider locale="en">
        <LiveNode id="n1" kind="still" state="arrived" title="Shot 02" mediaSrc="data:image/gif;base64,BBBB" mediaAlt="a still" />
      </I18nProvider>,
    );
    expect(frame().getAttribute("data-loaded")).toBeNull();
  });

  it("says when an arrived picture cannot load (an expired link), never an empty wash", () => {
    card({ state: "arrived", mediaSrc: "https://media.example/expired.jpg", mediaAlt: "a still" });
    fireEvent.error(screen.getByRole("img", { name: "a still" }));
    expect(screen.getByText(en.mediaFailed)).toBeTruthy();
  });
});

describe("LiveNode: the card opens, and its own keys stay its own", () => {
  it("names the open target by the card's title, and a retry does not also open the card", () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    card({ state: "failed", onOpen, retryPrice: 5, onRetry });
    fireEvent.click(screen.getByRole("button", { name: "Shot 02" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("n1");
    fireEvent.click(screen.getByRole("button", { name: /5/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is an article and a heading named by the title alone, also when it opens", () => {
    card({ title: "Mara, the keeper", kind: "character", onOpen: () => {} });
    expect(screen.getByRole("article", { name: "Mara, the keeper" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Mara, the keeper" })).toBeTruthy();
  });

  it("keeps xyflow from starting a drag on its own keys", () => {
    const { container } = card({ state: "failed", onOpen: () => {}, retryPrice: 5, onRetry: () => {} });
    for (const b of container.querySelectorAll("button")) expect(b.className).toMatch(/\bnodrag\b.*\bnopan\b|\bnopan\b.*\bnodrag\b/);
  });
});

describe("LiveNode on a busy board", () => {
  it("does not re-render when a re-read brings the same values in new objects", () => {
    // The memo comparator, exercised directly: equal values (a fresh cast array included) compare equal.
    const cmp = (LiveNode as unknown as { compare: (a: LiveNodeProps, b: LiveNodeProps) => boolean }).compare;
    const base: LiveNodeProps = { id: "a", kind: "shot", state: "ghost", title: "T", cast: ["Mara"] };
    expect(cmp(base, { ...base, cast: ["Mara"] })).toBe(true);
    expect(cmp(base, { ...base, cast: ["Mara", "Ilya"] })).toBe(false);
    expect(cmp(base, { ...base, state: "queued" })).toBe(false);
  });
});

describe("kind labels in three languages", () => {
  it.each(["en", "ru", "uz"] as const)("pads a shot number to two digits in %s", (locale) => {
    const { container } = card({ kind: "shot", shot: 4, state: "ghost" }, locale);
    expect(container.querySelector(".live-node-kind")?.textContent).toBe(dictionaries[locale].liveNodes.kind.shot.replace("{n}", "04"));
  });

  it("writes Uzbek with ʻ and ʼ, never a typewriter or curly apostrophe", () => {
    const strings = JSON.stringify(dictionaries.uz.liveNodes);
    expect(strings).not.toMatch(/['’‘`]/);
    expect(strings).toMatch(/ʻ/);
  });

  it("numbers a still or clip by its shot", () => {
    const { container } = card({ kind: "clip", shot: 3, state: "queued" });
    expect(container.querySelector(".live-node-kind")?.textContent).toBe("Clip · shot 03");
  });

  it("every fixture renders in every language without a missing string", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      for (const f of liveFixtures(Date.now())) {
        const { container } = render(
          <I18nProvider locale={locale}>
            <LiveNode {...f} onRetry={() => {}} onOpen={() => {}} announce />
          </I18nProvider>,
        );
        expect(container.textContent, `${locale}/${f.id}`).not.toMatch(/\{\w+\}|undefined/);
        cleanup();
      }
    }
  });
});

describe("RevealText", () => {
  it("takes 25 ms a character and never more than 600 ms", () => {
    expect(revealDuration(4)).toBe(100);
    expect(revealDuration(24)).toBe(600);
    expect(revealDuration(400)).toBe(600);
    expect(revealedCount(400, 300)).toBe(200);
    expect(revealedCount(10, 0)).toBe(0);
    expect(revealedCount(10, 10_000)).toBe(10);
  });

  it("puts the whole text in the tree from the first frame, and hides only the moving copy", () => {
    const { container } = render(<RevealText text="A brass lamp at frame left" reveal />);
    expect(container.querySelector(".live-reveal-full")?.textContent).toBe("A brass lamp at frame left");
    expect(container.querySelector(".live-reveal-shown")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBe("true");
  });

  it("shows text that was already there at once (a refresh does not re-type it)", () => {
    const { container } = render(<RevealText text="Already saved" reveal={false} />);
    expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBeNull();
    expect(container.querySelector(".live-reveal-shown")).toBeNull();
  });

  it("reveals through the frames and ends whole, calling onDone once", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const onDone = vi.fn();
    const text = "Twelve chars";
    const { container } = render(<RevealText text={text} reveal onDone={onDone} />);
    act(() => vi.advanceTimersByTime(revealDuration(text.length) / 2));
    const half = container.querySelector(".live-reveal-shown")?.textContent ?? "";
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan(text.length);
    act(() => vi.advanceTimersByTime(revealDuration(text.length)));
    expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("never re-types a text it already showed, when the board toggles show-all", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const onDone = vi.fn();
    const { container, rerender } = render(<RevealText text="A brass lamp at frame left" reveal onDone={onDone} />);
    rerender(<RevealText text="A brass lamp at frame left" reveal instant onDone={onDone} />);
    rerender(<RevealText text="A brass lamp at frame left" reveal onDone={onDone} />);
    expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a press skips one text only: the next text on the card still reveals", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { container, rerender } = render(<RevealText text="First prompt, long enough" reveal />);
    fireEvent.click(container.querySelector(".live-reveal")!);
    rerender(<RevealText text="Second prompt, also long" reveal />);
    expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBe("true");
    // And it starts from nothing, not from the first text's count.
    expect(container.querySelector(".live-reveal-shown")?.textContent).toBe("");
  });

  it("finishes at once on a press, and calls onDone", () => {
    const onDone = vi.fn();
    const { container } = render(<RevealText text="Skip me, I am long enough to take a while" reveal onDone={onDone} />);
    fireEvent.click(container.querySelector(".live-reveal")!);
    expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not animate for a reader who asked for less motion", () => {
    const before = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      const { container } = render(<RevealText text="Still text" reveal />);
      expect(container.querySelector(".live-reveal")?.getAttribute("data-revealing")).toBeNull();
    } finally {
      window.matchMedia = before;
    }
  });
});

describe("timing and geometry", () => {
  it("staggers cards inside the plan's 60–120 ms band and caps the longest wait", () => {
    expect(LAND_STAGGER_MS).toBeGreaterThanOrEqual(60);
    expect(LAND_STAGGER_MS).toBeLessThanOrEqual(120);
    expect(landDelay(undefined)).toBe(0);
    expect(landDelay(2)).toBe(2 * LAND_STAGGER_MS);
    expect(landDelay(99)).toBe(LAND_MAX_DELAY_MS);
  });

  it("formats elapsed time as m:ss and h:mm:ss", () => {
    expect(formatElapsed(5)).toBe("0:05");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(3725)).toBe("1:02:05");
  });

  it("curves a connector level out of one card and level into the next", () => {
    expect(connectorPath(0, 0, 200, 40)).toBe("M 0 0 C 100 0, 100 40, 200 40");
    // A long edge keeps its pull at 160 px.
    expect(connectorPath(0, 0, 1000, 0)).toBe("M 0 0 C 160 0, 840 0, 1000 0");
  });

  it("draws a travelling dash only while data flows", () => {
    const at = (state: "ghost" | "idle" | "flowing") =>
      render(
        <svg>
          <LiveConnector d="M 0 0 L 10 0" media="image" state={state} />
        </svg>,
      ).container;
    expect(at("idle").querySelector(".live-edge-flow")).toBeNull();
    cleanup();
    expect(at("ghost").querySelector(".live-edge-flow")).toBeNull();
    cleanup();
    expect(at("flowing").querySelector(".live-edge-flow")).not.toBeNull();
  });
});

describe("LiveEmpty", () => {
  it("offers three examples that only fill the composer", () => {
    const onPick = vi.fn();
    render(
      <I18nProvider locale="ru">
        <LiveEmpty onPick={onPick} />
      </I18nProvider>,
    );
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(3);
    fireEvent.click(chips[1]);
    expect(onPick).toHaveBeenCalledWith(dictionaries.ru.liveNodes.empty.examples[1]);
  });

  it("is still a full sentence without examples", () => {
    render(
      <I18nProvider locale="en">
        <LiveEmpty />
      </I18nProvider>,
    );
    expect(screen.getByRole("heading", { name: en.empty.title })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

function outsideNoPreference(code: string): string {
  const from = code.indexOf("@media (prefers-reduced-motion: no-preference)");
  const to = code.indexOf("@media (prefers-reduced-motion: reduce)");
  return code.slice(0, from) + code.slice(to);
}

describe("live.css", () => {
  const css = readFileSync(path.join(process.cwd(), "components/live/live.css"), "utf8");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("is unlayered, so the app's unlayered border and focus rules cannot beat it", () => {
    expect(code).not.toMatch(/@layer/);
  });

  it("paints only with tokens", () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  it("runs the spring, the draw-in and the flow only for readers who did not ask for less motion", () => {
    const from = code.indexOf("@media (prefers-reduced-motion: reduce)");
    const calm = code.slice(from, code.indexOf("\n}\n", from));
    const moving = code.slice(code.indexOf("@media (prefers-reduced-motion: no-preference)"), code.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(moving).toMatch(/live-land 220ms/);
    expect(moving).toMatch(/live-draw 300ms/);
    expect(moving).toMatch(/live-flow/);
    // Outside the no-preference block nothing scales, draws or flows.
    const outside = code.replace(moving, "");
    expect(outside).not.toMatch(/animation:[^;]*live-(land|draw|flow|sweep)/);
    expect(calm).toMatch(/animation: live-fade/);
    expect(calm).not.toMatch(/live-(land|draw|flow|sweep|glow)/);
    expect(calm).toMatch(/\.live-edge-flow \{ display: none; \}/);
  });

  it("puts the open target over the picture and the card's own keys over the target", () => {
    expect(code).toMatch(/\.live-node-open::after \{[^}]*z-index: 1/);
    expect(code).toMatch(/\.live-node :is\(button, a[^)]*\):not\(\.live-node-open\) \{ position: relative; z-index: 2; \}/);
    // The prompt is lifted only while a press on it means "finish the reveal".
    expect(code).toMatch(/\.live-node-prompt:has\(\.live-reveal\[data-revealing="true"\]\) \{ position: relative; z-index: 2; \}/);
  });

  it("caps a long prompt with a wrapper height, not a line-clamp the reveal's grid would override", () => {
    expect(code).toMatch(/\.live-node-prompt-text \{[^}]*max-height: calc\(4 \* 1\.5em\)/);
    expect(code).not.toMatch(/line-clamp/);
  });

  it("keeps the selection ring when a card glows: the glow is its own layer", () => {
    expect(code).toMatch(/\.live-node\[data-landed="true"\]::before \{ animation: live-glow/);
    // ...and only for readers who did not ask for less motion.
    expect(outsideNoPreference(code)).not.toMatch(/live-glow \d/);
    expect(code).not.toMatch(/\.live-node\[data-landed="true"\] \{/);
  });
});
