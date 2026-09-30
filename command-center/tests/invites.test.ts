import { describe, expect, it } from "vitest";
import { coerceInvites } from "../lib/invites";

/**
 * my_invites() rows (migration 0043). What would break without these: a
 * malformed row rendered as an Accept button for an invite id that is not one.
 */
describe("coerceInvites", () => {
  it("keeps well-formed rows and names the organization", () => {
    expect(
      coerceInvites([{ id: "i1", org_id: "o1", org_name: "Acme", role: "viewer", invited_at: "2026-09-30" }]),
    ).toEqual([{ id: "i1", orgId: "o1", orgName: "Acme" }]);
  });

  it("drops rows without an id or organization, and anything that is not a list", () => {
    expect(coerceInvites([{ org_id: "o1" }, { id: "i2" }, null, "x"])).toEqual([]);
    expect(coerceInvites(null)).toEqual([]);
    expect(coerceInvites({ id: "i1", org_id: "o1" })).toEqual([]);
  });

  it("falls back to the organization id when the name is empty", () => {
    expect(coerceInvites([{ id: "i1", org_id: "o1", org_name: "" }])[0].orgName).toBe("o1");
  });
});
