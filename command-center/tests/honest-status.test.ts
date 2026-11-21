import { describe, expect, it } from "vitest";
import { overallStatus, type Subsystem } from "../lib/intelligence";
import { accountStanding } from "../lib/accountStanding";
import { groupByOutput, taskCounts, NO_FILTERS, type DiscoveryModel } from "../lib/models-discovery";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const sub = (state: Subsystem["state"]): Subsystem => ({ key: "ai", state, tone: "idle", lastSuccess: null });

describe("system banner is the worst row beneath it", () => {
  it("is not 'operational' while any row is unknown", () => {
    expect(overallStatus([sub("operational"), sub("unknown")])).toBe("unknown");
  });
  it("ranks offline > degraded > unknown > operational", () => {
    expect(overallStatus([sub("unknown"), sub("degraded"), sub("operational")])).toBe("degraded");
    expect(overallStatus([sub("unknown"), sub("degraded"), sub("offline")])).toBe("offline");
    expect(overallStatus([sub("operational"), sub("operational")])).toBe("operational");
  });
  it("no rows is unknown, never operational", () => {
    expect(overallStatus([])).toBe("unknown");
  });
  it("has copy for every banner in en, ru and uz", () => {
    for (const d of [en, ru, uz]) {
      for (const k of ["allOperational", "someUnknown", "someDegraded", "someOffline"] as const) expect(d.ops[k].length).toBeGreaterThan(0);
    }
  });
});

describe("account standing reflects the row's own failures", () => {
  it("a live channel with failures and no uploads is red, not green 'live'", () => {
    expect(accountStanding({ standing: "live", failures: 6, published: 0 })).toEqual({ key: "liveFailing", tone: "fail" });
  });
  it("a live channel that has uploaded but also failed is amber", () => {
    expect(accountStanding({ standing: "live", failures: 2, published: 9 })).toEqual({ key: "liveFailing", tone: "warn" });
  });
  it("a live channel with no failures stays green", () => {
    expect(accountStanding({ standing: "live", failures: 0, published: 0 })).toEqual({ key: "live", tone: "ok" });
  });
  it("paused and draft channels are never rated by failures", () => {
    expect(accountStanding({ standing: "paused", failures: 5, published: 0 }).tone).toBe("idle");
    expect(accountStanding({ standing: "draft", failures: 5, published: 0 }).key).toBe("draft");
  });
  it("has the label in en, ru and uz", () => {
    for (const d of [en, ru, uz]) expect(d.accounts.standingLiveFailing.length).toBeGreaterThan(0);
  });
});

function model(id: string, caps: string[], output: string): DiscoveryModel {
  return { id, displayName: id, capabilities: caps, spec: { output } } as unknown as DiscoveryModel;
}

describe("models: chip count and section count", () => {
  const models = [model("a", ["t2i"], "image"), model("b", ["t2i"], "image"), model("c", ["edit"], "image"), model("d", ["t2v"], "video")];
  it("section count is the number of models that make that output, from one grouping", () => {
    const image = groupByOutput(models).find((g) => g.kind === "image");
    expect(image?.items.length).toBe(3);
  });
  it("the image chip counts only text-to-image, so the section must not share its label", () => {
    expect(taskCounts(models, NO_FILTERS).image).toBe(2);
    for (const d of [en, ru, uz]) expect(d.models.groupOutputs.image).not.toBe(d.models.tasks.image);
  });
});
