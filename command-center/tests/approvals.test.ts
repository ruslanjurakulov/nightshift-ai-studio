import { describe, expect, it } from "vitest";
import { canDecide, canRequest, canToggleRequirement } from "@/lib/approvals";

describe("canDecide (two-person publish rule)", () => {
  const requester = "user-a";
  const other = "user-b";

  it("lets a different admin decide", () => {
    expect(canDecide("admin", requester, other)).toBe(true);
    expect(canDecide("owner", requester, other)).toBe(true);
  });

  it("never lets the requester decide their own request", () => {
    expect(canDecide("admin", requester, requester)).toBe(false);
    expect(canDecide("owner", requester, requester)).toBe(false);
  });

  it("refuses non-admins even when they are not the requester", () => {
    expect(canDecide("editor", requester, other)).toBe(false);
    expect(canDecide("viewer", requester, other)).toBe(false);
  });

  it("refuses a request with no known requester", () => {
    expect(canDecide("admin", null, other)).toBe(false);
  });
});

describe("canRequest", () => {
  it("allows editor and above", () => {
    expect(canRequest("editor")).toBe(true);
    expect(canRequest("admin")).toBe(true);
    expect(canRequest("owner")).toBe(true);
  });
  it("refuses viewer", () => {
    expect(canRequest("viewer")).toBe(false);
  });
});

describe("canToggleRequirement", () => {
  it("allows editor and above, refuses viewer", () => {
    expect(canToggleRequirement("editor")).toBe(true);
    expect(canToggleRequirement("viewer")).toBe(false);
  });
});
