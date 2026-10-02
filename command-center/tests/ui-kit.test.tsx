// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Timecode, formatTimecode } from "../components/ui/Timecode";
import { StatusLamp } from "../components/ui/StatusLamp";
import { Meter, meterSegments } from "../components/ui/Meter";
import { PriceButton } from "../components/ui/PriceButton";
import { Chip, ChipRow } from "../components/ui/Chip";
import { Panel } from "../components/ui/Panel";
import { SegmentedSwitch } from "../components/ui/SegmentedSwitch";
import { ContactSheet, Frame, TileGrid } from "../components/ui/ContactSheet";
import { StepCard, StepList } from "../components/ui/StepCard";

/**
 * The identity primitives (docs/design/IDENTITY.md). What would break without
 * these: an unknown price or balance drawn as 0, a struck "discount" with no
 * real old price, a disabled spend key that does not say why, a lamp whose
 * state is only a colour, a mode switch a keyboard cannot drive, and a
 * primitive that hard-codes a colour and so breaks the light theme.
 */

afterEach(cleanup);

const ROOT = process.cwd();
const FILES = [
  "Timecode",
  "StatusLamp",
  "Meter",
  "PriceButton",
  "Chip",
  "Panel",
  "SegmentedSwitch",
  "ContactSheet",
  "StepCard",
].map((f) => `components/ui/${f}.tsx`);

describe("every primitive reads tokens, never a literal colour", () => {
  const PALETTE =
    /\b(?:text|bg|border|ring|fill|stroke|outline|shadow)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/;
  for (const file of FILES) {
    it(file, () => {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      expect(src.match(PALETTE)?.[0]).toBeUndefined();
      expect(src.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]).toBeUndefined();
      expect(src.match(/\brgba?\(/)?.[0]).toBeUndefined();
    });
  }

  it("the primitives' styles exist in globals.css", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    for (const cls of [".ns-tc", ".ns-lamp", ".ns-meter", ".ns-price-button", ".ns-chip", ".ns-chip-row", ".ns-panel", ".ns-seg", ".ns-sheet", ".ns-frame", ".ns-edge", ".ns-step", ".ns-ruler"]) {
      expect(css, cls).toContain(`${cls} {`);
    }
  });

  it("phones get 44px targets on the switch, chips and the small price key", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    expect(css).toMatch(/\.ns-seg > button,\s*\.ns-chip,\s*\.ns-price-button\[data-size="md"\] \{ min-height: 44px; \}/);
  });

  it("the running lamp only breathes when motion is welcome", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.ns-lamp\[data-live="true"\]/);
  });
});

describe("Timecode", () => {
  it("formats credits, counts, durations and frames", () => {
    expect(formatTimecode(1250, "credits")).toBe("1,250");
    expect(formatTimecode(2.5, "credits")).toBe("2.5");
    expect(formatTimecode(1250.6, "count", { locale: "ru" })).toBe(new Intl.NumberFormat("ru").format(1251));
    expect(formatTimecode(5, "duration")).toBe("0:05");
    expect(formatTimecode(760.9, "duration")).toBe("12:40");
    expect(formatTimecode(3727, "duration")).toBe("1:02:07");
    expect(formatTimecode(5.5, "frames", { fps: 24 })).toBe("00:00:05:12");
    expect(formatTimecode(-3, "duration")).toBe("-0:03");
  });

  it("an unknown is words, never 0", () => {
    render(<Timecode value={null} unknown="not priced yet" />);
    const el = screen.getByText("not priced yet").closest(".ns-tc") as HTMLElement;
    expect(el.dataset.unknown).toBe("true");
    expect(el.textContent).not.toContain("0");
    cleanup();
    render(<Timecode value={Number.NaN} />);
    expect(document.querySelector(".ns-tc")?.textContent).toBe("—");
  });

  it("puts the unit after the figure and can carry a spoken form", () => {
    render(<Timecode value={65} format="duration" label="1 minute 5 seconds" />);
    expect(screen.getByText("1 minute 5 seconds").className).toBe("sr-only");
    cleanup();
    render(<Timecode value={12} unit="credits" />);
    expect(document.querySelector(".ns-tc")?.textContent).toBe("12credits");
    expect(document.querySelector(".ns-tc-unit")?.textContent).toBe("credits");
  });
});

describe("StatusLamp", () => {
  it("always says its state in words beside the lamp", () => {
    render(<StatusLamp tone="fail" label="Failed" />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(document.querySelector(".ns-lamp")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".ns-lamp")?.getAttribute("data-tone")).toBe("fail");
  });

  it("breathes only while live, and can keep the word for screen readers only", () => {
    render(<StatusLamp tone="run" label="Working" live hideLabel />);
    expect(document.querySelector(".ns-lamp")?.getAttribute("data-live")).toBe("true");
    expect(screen.getByText("Working").className).toBe("sr-only");
    cleanup();
    render(<StatusLamp tone="ok" label="Done" />);
    expect(document.querySelector(".ns-lamp")?.getAttribute("data-live")).toBeNull();
  });
});

describe("Meter", () => {
  it("lights available, hatches held, and scales to the real balance", () => {
    expect(meterSegments({ value: 90, held: 30, segments: 12 })).toEqual({ lit: 9, held: 3, off: 0, value: 90, max: 120 });
    expect(meterSegments({ value: 50, held: 0, max: 100, segments: 10 })).toEqual({ lit: 5, held: 0, off: 5, value: 50, max: 100 });
  });

  it("a little is never drawn as nothing, and short of full never fills", () => {
    expect(meterSegments({ value: 1, max: 10_000, segments: 12 })?.lit).toBe(1);
    expect(meterSegments({ value: 9_990, max: 10_000, segments: 12 })?.lit).toBe(11);
  });

  it("is not drawn without a number or with a bad scale", () => {
    expect(meterSegments({ value: null })).toBeNull();
    expect(meterSegments({ value: Number.NaN })).toBeNull();
    expect(meterSegments({ value: 10, max: 0 })).toBeNull();
    const { container } = render(<Meter value={undefined} label="Credits" />);
    expect(container.innerHTML).toBe("");
  });

  it("an empty balance is a real reading: drawn empty, the first lamp red", () => {
    expect(meterSegments({ value: 0, held: 0 })).toEqual({ lit: 0, held: 0, off: 12, value: 0, max: 0 });
    render(<Meter value={0} label="Credits" />);
    expect(screen.getByRole("meter").getAttribute("data-empty")).toBe("true");
  });

  it("is a labelled meter with its reading in words", () => {
    render(<Meter value={120} held={30} label="Credits" valueText="120 available, 30 on hold" />);
    const m = screen.getByRole("meter", { name: "Credits" });
    expect(m.getAttribute("aria-valuenow")).toBe("120");
    expect(m.getAttribute("aria-valuemax")).toBe("150");
    expect(m.getAttribute("aria-valuetext")).toBe("120 available, 30 on hold");
    expect(m.querySelectorAll('[data-state="held"]').length).toBeGreaterThan(0);
  });
});

describe("PriceButton", () => {
  it("carries the price as a second legend, and keeps the full sentence as its name", () => {
    const onClick = vi.fn();
    render(<PriceButton label="Generate" credits={12} unit="credits" aria-label="Generate · 12 credits" onClick={onClick} />);
    const b = screen.getByRole("button", { name: "Generate · 12 credits" });
    expect(within(b).getByTestId("price-tag").textContent).toBe("12credits");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("draws no price at all without a quote — never 0", () => {
    render(<PriceButton label="Generate" credits={null} />);
    expect(screen.queryByTestId("price-tag")).toBeNull();
    expect(screen.getByRole("button").textContent).toBe("Generate");
  });

  it("strikes the old price only when it is real and higher", () => {
    render(<PriceButton label="Generate" credits={6.5} was={8.5} wasLabel="was" />);
    const s = document.querySelector("s.ns-price-was");
    expect(s?.textContent).toBe("was 8.5");
    cleanup();
    render(<PriceButton label="Generate" credits={6.5} was={6.5} />);
    expect(document.querySelector("s")).toBeNull();
    cleanup();
    render(<PriceButton label="Generate" credits={null} was={9} />);
    expect(document.querySelector("s")).toBeNull();
  });

  it("disabled with a reason: cannot be pressed and says why", () => {
    const onClick = vi.fn();
    render(<PriceButton label="Generate" credits={4} disabledReason="Pick a picture first" onClick={onClick} />);
    const b = screen.getByRole("button") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    const reason = screen.getByText("Pick a picture first");
    expect(b.getAttribute("aria-describedby")).toContain(reason.id);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps a description the page already shows", () => {
    render(<PriceButton label="Generate" aria-describedby="gen-status" disabled />);
    expect(screen.getByRole("button").getAttribute("aria-describedby")).toBe("gen-status");
  });
});

describe("Chip and ChipRow", () => {
  it("a toggle chip is aria-pressed; a plain chip is not", () => {
    render(
      <ChipRow label="Settings">
        <Chip pressed>16:9</Chip>
        <Chip pressed={false}>1:1</Chip>
        <Chip>Copy</Chip>
      </ChipRow>,
    );
    const group = screen.getByRole("group", { name: "Settings" });
    const [a, b, c] = within(group).getAllByRole("button");
    expect(a.getAttribute("aria-pressed")).toBe("true");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(c.hasAttribute("aria-pressed")).toBe(false);
  });

  it("shows a real count, and none when there is no number", () => {
    render(<Chip count={3}>References</Chip>);
    expect(document.querySelector(".ns-chip-count")?.textContent).toBe("3");
    cleanup();
    render(<Chip count={null}>References</Chip>);
    expect(document.querySelector(".ns-chip-count")).toBeNull();
  });
});

describe("Panel", () => {
  it("is a labelled region with a role tone", () => {
    render(
      <Panel tone="lifted" eyebrow="Composer" title="Make one thing" actions={<button type="button">Reset</button>}>
        body
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Make one thing" });
    expect(region.getAttribute("data-tone")).toBe("lifted");
    expect(within(region).getByText("Composer").className).toBe("ns-eyebrow");
  });
});

describe("SegmentedSwitch", () => {
  const OPTIONS = [
    { value: "image", label: "Image" },
    { value: "video", label: "Video" },
    { value: "voice", label: "Voice", disabled: true },
    { value: "edit", label: "Edit" },
  ] as const;

  it("is a radio group with one tab stop", () => {
    render(<SegmentedSwitch label="Mode" options={OPTIONS} value="video" onChange={() => {}} />);
    const radios = within(screen.getByRole("radiogroup", { name: "Mode" })).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("arrow keys move and choose, skipping a disabled mode; Home/End jump", () => {
    const onChange = vi.fn();
    render(<SegmentedSwitch label="Mode" options={OPTIONS} value="video" onChange={onChange} />);
    const video = screen.getByRole("radio", { name: "Video" });
    fireEvent.keyDown(video, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("edit");
    fireEvent.keyDown(video, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("image");
    fireEvent.keyDown(video, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("edit");
    fireEvent.keyDown(video, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("image");
    fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
    expect(onChange).toHaveBeenLastCalledWith("edit");
  });
});

describe("ContactSheet, Frame and TileGrid", () => {
  it("prints only real facts on the edge, and the frame number when given", () => {
    render(
      <ContactSheet label="Results">
        <Frame number={12} edge={["16:9", null, "", false, "0:05"]} aspect="16 / 9" selected>
          <span>pic</span>
        </Frame>
        <Frame>
          <span>bare</span>
        </Frame>
      </ContactSheet>,
    );
    const list = screen.getByRole("list", { name: "Results" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first.querySelector(".ns-edge")?.textContent).toBe("12▸16:90:05");
    expect(first.getAttribute("data-selected")).toBe("true");
    expect((first.querySelector(".ns-frame-media") as HTMLElement).style.aspectRatio).toBe("16 / 9");
    expect(second.querySelector(".ns-edge")).toBeNull();
  });

  it("the grid takes its narrowest tile from a prop", () => {
    render(
      <TileGrid min={200} label="Presets">
        <li>a</li>
      </TileGrid>,
    );
    expect((screen.getByRole("list", { name: "Presets" }) as HTMLElement).style.getPropertyValue("--tile-min")).toBe("200px");
  });
});

describe("StepCard", () => {
  const words = { priceLabel: "This step", totalLabel: "Total", unknownPrice: "priced later", unit: "credits" };

  it("numbers the step, marks the current one, and shows its price and the running total", () => {
    render(
      <StepList label="Make">
        <StepCard index={1} title="Script" state="done" stateLabel="Done" price={4} total={4} {...words} />
        <StepCard index={2} title="Storyboard" state="current" stateLabel="Now" price={12} total={16} {...words} />
      </StepList>,
    );
    const steps = within(screen.getByRole("list", { name: "Make" })).getAllByRole("listitem");
    expect(steps[0].querySelector(".ns-step-no")?.textContent).toBe("01");
    expect(steps[1].getAttribute("aria-current")).toBe("step");
    expect(steps[1].textContent).toContain("This step 12credits");
    expect(steps[1].textContent).toContain("Total 16credits");
    expect(within(steps[0]).getByText("Done")).toBeTruthy();
  });

  it("an unpriced step says so instead of 0", () => {
    render(
      <StepList label="Make">
        <StepCard index={3} title="Render" state="next" stateLabel="Next" price={null} total={undefined} {...words} />
      </StepList>,
    );
    expect(screen.getAllByText("priced later")).toHaveLength(2);
  });
});
