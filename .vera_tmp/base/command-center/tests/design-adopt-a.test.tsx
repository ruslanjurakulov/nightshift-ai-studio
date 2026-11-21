// @vitest-environment jsdom
/**
 * Design adoption wave A: the pure and presentational pieces the restyled
 * screens rely on. Prices stay the backend's: an unknown figure is words, a
 * job without a result prints no price on its frame.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n";
import { edgeFacts, type StudioJob } from "@/lib/creative/studio";
import { StepCard, StepList } from "@/components/ui/StepCard";
import { Chip } from "@/components/ui/Chip";

afterEach(cleanup);

const job = (over: Partial<StudioJob>): StudioJob => ({
  id: "j",
  capability: "t2i",
  status: "completed",
  requested_model: "m",
  params: {},
  quoted_credits: 4,
  charged_credits: 3.5,
  error_code: null,
  result: null,
  result_asset_ids: [],
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("edgeFacts", () => {
  it.each(["en", "ru", "uz"] as const)("prints shape, length and the charged price (%s)", (l) => {
    const t = dictionaries[l];
    const f = edgeFacts(t, job({ capability: "t2v", params: { aspect_ratio: "16:9", duration_s: 5 } }), l);
    expect(f[0]).toBe("16:9");
    expect(f[1]).toBe("0:05");
    expect(f[2]).toContain(t.gen.crShort);
  });
  it("leaves out what the job does not carry and never prints a price for a failed job", () => {
    const t = dictionaries.en;
    expect(edgeFacts(t, job({ status: "failed", params: { aspect_ratio: "weird" } }))).toEqual([]);
    expect(edgeFacts(t, job({ capability: "tts", params: { aspect_ratio: "16:9" } }))).toEqual(["3.5 cr"]);
  });
  it("shows the held quote while a job runs", () => {
    expect(edgeFacts(dictionaries.en, job({ status: "running", charged_credits: null }))).toEqual(["4 cr"]);
  });
});

describe("StepCard", () => {
  const base = { priceLabel: "Length", totalLabel: "Total", unknownPrice: "later" };
  it("counts lengths, says unknown in words, never 0", () => {
    render(
      <StepList label="Steps">
        <StepCard index={1} title="One" state="next" stateLabel="To review" format="duration" price={65} total={65} priceSpoken="65 s" {...base} />
        <StepCard index={2} title="Two" state="next" stateLabel="To review" format="duration" price={null} total={null} totalWords="after saving" {...base} />
        <StepCard index={3} title="Render" state="blocked" stateLabel="Waits" price={null} total={null} priceWords="not charged" totalWords="not charged" {...base} />
      </StepList>,
    );
    expect(screen.getAllByText("1:05").length).toBeGreaterThan(0);
    expect(screen.getByText("later")).toBeTruthy();
    expect(screen.getByText("after saving")).toBeTruthy();
    expect(screen.getAllByText("not charged")).toHaveLength(2);
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("Chip", () => {
  it("a plain chip is a readout, not a button", () => {
    render(
      <Chip plain count={2} tone="lit">
        References
      </Chip>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("References").parentElement?.getAttribute("data-tone")).toBe("lit");
  });
});
