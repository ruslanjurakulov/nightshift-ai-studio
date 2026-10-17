import { describe, expect, it } from "vitest";
import { wouldLeaveNoOwner } from "../lib/members-guard";

const m = (id: string, role: "owner" | "admin" | "editor" | "viewer", user_id: string | null = id) => ({ id, role, user_id });

describe("Team page last-owner guard (B-05, app layer)", () => {
  it("the only bound owner cannot be demoted or removed", () => {
    const roster = [m("o", "owner"), m("a", "admin"), m("v", "viewer")];
    expect(wouldLeaveNoOwner(roster, "o", "admin")).toBe(true);
    expect(wouldLeaveNoOwner(roster, "o", "removed")).toBe(true);
  });
  it("a second bound owner makes either owner free to go", () => {
    const roster = [m("o1", "owner"), m("o2", "owner")];
    expect(wouldLeaveNoOwner(roster, "o1", "viewer")).toBe(false);
    expect(wouldLeaveNoOwner(roster, "o2", "removed")).toBe(false);
  });
  it("an invited owner who has not signed in does not count as an owner who can administer", () => {
    const roster = [m("o1", "owner"), m("o2", "owner", null)];
    expect(wouldLeaveNoOwner(roster, "o1", "removed")).toBe(true);
    // ...and removing the unbound invite changes nothing about who can administer
    expect(wouldLeaveNoOwner(roster, "o2", "removed")).toBe(false);
  });
  it("keeping the owner role, or changing someone who is not an owner, is never blocked", () => {
    const roster = [m("o", "owner"), m("a", "admin")];
    expect(wouldLeaveNoOwner(roster, "o", "owner")).toBe(false);
    expect(wouldLeaveNoOwner(roster, "a", "removed")).toBe(false);
    expect(wouldLeaveNoOwner(roster, "ghost", "removed")).toBe(false);
  });
});
