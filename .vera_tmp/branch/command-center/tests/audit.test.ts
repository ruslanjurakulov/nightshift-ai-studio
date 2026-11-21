import { describe, expect, it } from "vitest";
import { formatAuditDetail } from "@/lib/audit";

/**
 * The audit `detail` blob is rendered inline in the trail table. It carries
 * names and counts only (never secret values), so the formatter just needs to
 * turn the small object into a compact, readable one-liner — and never throw,
 * whatever shape a row arrives in.
 */
describe("formatAuditDetail", () => {
  it("joins an array value with spaces under its key", () => {
    expect(formatAuditDetail({ names: ["OPENAI_API_KEY", "ELEVENLABS_KEY"] })).toBe(
      "names=OPENAI_API_KEY ELEVENLABS_KEY",
    );
  });

  it("renders scalar values as key=value pairs", () => {
    expect(formatAuditDetail({ status: "ACTIVE" })).toBe("status=ACTIVE");
  });

  it("joins multiple keys with a comma", () => {
    expect(formatAuditDetail({ names: ["A"], count: 1 })).toBe("names=A, count=1");
  });

  it("returns an empty string for an empty, null, or non-object detail", () => {
    expect(formatAuditDetail({})).toBe("");
    expect(formatAuditDetail(null)).toBe("");
    expect(formatAuditDetail(undefined)).toBe("");
    expect(formatAuditDetail("secret")).toBe("");
  });

  it("flattens a nested object rather than throwing", () => {
    expect(formatAuditDetail({ meta: { a: 1 } })).toBe('meta={"a":1}');
  });
});
