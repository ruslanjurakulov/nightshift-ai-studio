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
  const all: LiveNodeProps = { kind: "still", state: "queued", title: "Shot 02", ...props };
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
        <LiveNode kind="still" state="queued" title="Shot 02" price={12} />
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
    expect(card({ state: "queued", queuePosition: null }).container.textContent).not.toContain("queue");
    cleanup();
    expect(card({ state: "queued", queuePosition: 3 }).container.textContent).toContain("Position 3");
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
    expect(container.querySelector("[data-fx=shimmer]")?.textContent).toBe(en.phase.making);
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
    card({ state: "failed", failure: { cause: "c", remedy: "r" }, retry: { price: null, onRetry } });
    const key = screen.getByRole("button", { name: en.failed.retryUnpriced });
    expect((key as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(key);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a priced retry names its price, and a busy one swallows a second press", () => {
    const onRetry = vi.fn();
    const { rerender } = card({ state: "failed", failure: { cause: "The provider refused", remedy: "Edit the prompt" }, retry: { price: 40, onRetry } });
    expect(screen.getByText("The provider refused")).toBeTruthy();
    expect(screen.getByText("Edit the prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /40/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <I18nProvider locale="en">
        <LiveNode kind="still" state="failed" title="Shot 02" retry={{ price: 40, onRetry, busy: true }} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /40/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a disabled card says its reason; a short one says the shortfall and links to credits", () => {
    card({ state: "disabled", reason: "Music is not on this plan yet." });
    expect(screen.getByText("Music is not on this plan yet.")).toBeTruthy();
    cleanup();
    card({ state: "insufficient", shortfall: { credits: 18, topUpHref: "/acme/credits" } });
    expect(screen.getByText(/18/)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.insufficient.topUp }).getAttribute("href")).toBe("/acme/credits");
  });

  it("an unknown shortfall still offers the top-up link, and shows no number", () => {
    const { container } = card({ state: "insufficient", shortfall: { credits: null, topUpHref: "/c" } });
    expect(screen.getByRole("link", { name: en.insufficient.topUp })).toBeTruthy();
    expect(container.querySelector(".live-node-short p")).toBeNull();
  });
});

describe("LiveNode: arrival", () => {
  it("glows and announces once for a watched arrival, then stops", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, rerender } = card({ state: "working" });
    const node = () => container.querySelector(".live-node")!;
    expect(node().getAttribute("data-landed")).toBeNull();
    rerender(
      <I18nProvider locale="en">
        <LiveNode kind="still" state="arrived" title="Shot 02" />
      </I18nProvider>,
    );
    expect(node().getAttribute("data-landed")).toBe("true");
    expect(container.querySelector("[role=status]")?.textContent).toContain("ready");
    act(() => vi.advanceTimersByTime(LANDED_GLOW_MS + 1));
    expect(node().getAttribute("data-landed")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("does not glow for a card first read as ready (a refresh)", () => {
    const { container } = card({ state: "arrived" });
    expect(container.querySelector(".live-node")?.getAttribute("data-landed")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("does not glow after a failure", () => {
    const { container, rerender } = card({ state: "failed" });
    rerender(
      <I18nProvider locale="en">
        <LiveNode kind="still" state="arrived" title="Shot 02" />
      </I18nProvider>,
    );
    expect(container.querySelector(".live-node")?.getAttribute("data-landed")).toBeNull();
  });

  it("shows the picture only once it has loaded", () => {
    const { container } = card({ state: "arrived", media: { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", alt: "a still" } });
    const frame = container.querySelector(".live-node-media")!;
    expect(frame.getAttribute("data-loaded")).toBeNull();
    fireEvent.load(screen.getByRole("img", { name: "a still" }));
    expect(frame.getAttribute("data-loaded")).toBe("true");
  });
});

describe("LiveNode: the card opens, and its own keys stay its own", () => {
  it("names the open target by the card's title, and a retry does not also open the card", () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    card({ state: "failed", onOpen, retry: { price: 5, onRetry } });
    fireEvent.click(screen.getByRole("button", { name: "Open Shot 02" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /5/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is an article named by its title", () => {
    card({ title: "Mara, the keeper", kind: "character" });
    expect(screen.getByRole("article", { name: "Mara, the keeper" })).toBeTruthy();
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

  it("every fixture renders in every language without a missing string", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      for (const { id, retryPrice, ...f } of liveFixtures(Date.now())) {
        const { container } = render(
          <I18nProvider locale={locale}>
            <LiveNode {...f} retry={retryPrice !== undefined ? { price: retryPrice, onRetry: () => {} } : null} />
          </I18nProvider>,
        );
        expect(container.textContent, `${locale}/${id}`).not.toMatch(/\{\w+\}|undefined/);
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
    const calm = code.slice(code.indexOf("@media (prefers-reduced-motion: reduce)"));
    const moving = code.slice(code.indexOf("@media (prefers-reduced-motion: no-preference)"), code.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(moving).toMatch(/live-land 220ms/);
    expect(moving).toMatch(/live-draw 300ms/);
    expect(moving).toMatch(/live-flow/);
    // Outside the no-preference block nothing scales, draws or flows.
    const outside = code.replace(moving, "");
    expect(outside).not.toMatch(/animation:[^;]*live-(land|draw|flow|sweep)/);
    expect(calm).toMatch(/live-fade/);
    expect(calm).toMatch(/\.live-edge-flow \{ display: none; \}/);
  });

  it("keeps the selection ring when a card glows: the glow is its own layer", () => {
    expect(code).toMatch(/\.live-node\[data-landed="true"\]::before \{ animation: live-glow/);
    expect(code).not.toMatch(/\.live-node\[data-landed="true"\] \{/);
  });
});
