import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_ID,
  assignableRoles,
  canEditMember,
  canManageMembers,
  coerceOrgs,
  isMissingFunction,
  isPlausibleEmail,
  resolveCurrentOrg,
  validateOrgName,
  wouldRemoveLastOwner,
  type OrgSummary,
} from "@/lib/orgs";
import { SECTIONS, isSection } from "@/lib/channels";

const nightshift: OrgSummary = { id: DEFAULT_ORG_ID, name: "Nightshift", slug: "nightshift", role: "owner", is_default: true };
const acme: OrgSummary = { id: "a-1", name: "Acme", slug: "acme", role: "editor", is_default: false };
const beta: OrgSummary = { id: "b-2", name: "Beta", slug: "beta", role: "viewer", is_default: false };

describe("resolveCurrentOrg", () => {
  it("honours a remembered org the caller still belongs to", () => {
    expect(resolveCurrentOrg("a-1", [nightshift, acme])?.id).toBe("a-1");
  });

  it("ignores a cookie naming an org the caller is not a member of", () => {
    // A forged or stale cookie must never select someone else's workspace.
    expect(resolveCurrentOrg("someone-elses-org", [acme, beta])?.id).toBe("a-1");
  });

  it("lands the operator on the default org, exactly where they always were", () => {
    expect(resolveCurrentOrg(undefined, [acme, nightshift])?.id).toBe(DEFAULT_ORG_ID);
  });

  it("falls back to the first org when there is no default among them", () => {
    expect(resolveCurrentOrg(null, [beta, acme])?.id).toBe("b-2");
  });

  it("is null only when the caller belongs to no org — the sign-up state", () => {
    expect(resolveCurrentOrg("a-1", [])).toBeNull();
  });
});

describe("coerceOrgs", () => {
  it("keeps well-formed rows", () => {
    expect(coerceOrgs([{ id: "a-1", name: "Acme", slug: "acme", role: "admin", is_default: false }])).toEqual([
      { id: "a-1", name: "Acme", slug: "acme", role: "admin", is_default: false },
    ]);
  });

  it("drops a row with an unknown role instead of guessing viewer", () => {
    expect(coerceOrgs([{ id: "a-1", name: "Acme", slug: "acme", role: "superuser" }])).toEqual([]);
    expect(coerceOrgs([{ id: "a-1", name: "Acme", slug: "acme", role: null }])).toEqual([]);
  });

  it("drops rows without an id and duplicate ids", () => {
    const out = coerceOrgs([
      { name: "No id", role: "owner" },
      { id: "a-1", name: "Acme", role: "owner" },
      { id: "a-1", name: "Acme again", role: "viewer" },
    ]);
    expect(out.map((o) => o.name)).toEqual(["Acme"]);
  });

  it("treats anything but true as not-default", () => {
    expect(coerceOrgs([{ id: "a-1", role: "owner", is_default: "true" }])[0].is_default).toBe(false);
  });

  it("returns nothing for a non-array", () => {
    expect(coerceOrgs(null)).toEqual([]);
    expect(coerceOrgs({ id: "a-1" })).toEqual([]);
  });
});

describe("member management mirrors the org_members policies", () => {
  it("only owner and admin manage members", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("viewer")).toBe(false);
  });

  it("an admin cannot touch an owner; an owner can", () => {
    expect(canEditMember("admin", "owner")).toBe(false);
    expect(canEditMember("admin", "editor")).toBe(true);
    expect(canEditMember("owner", "owner")).toBe(true);
    expect(canEditMember("editor", "viewer")).toBe(false);
  });

  it("only an owner may grant owner", () => {
    expect(assignableRoles("owner")).toContain("owner");
    expect(assignableRoles("admin")).not.toContain("owner");
    expect(assignableRoles("admin")).toEqual(["admin", "editor", "viewer"]);
    expect(assignableRoles("viewer")).toEqual([]);
  });

  it("refuses to remove or demote the last owner", () => {
    const members = [
      { id: "1", role: "owner" as const },
      { id: "2", role: "editor" as const },
    ];
    expect(wouldRemoveLastOwner(members, "1", null)).toBe(true);
    expect(wouldRemoveLastOwner(members, "1", "admin")).toBe(true);
    expect(wouldRemoveLastOwner(members, "1", "owner")).toBe(false);
    expect(wouldRemoveLastOwner(members, "2", null)).toBe(false);
    expect(wouldRemoveLastOwner([...members, { id: "3", role: "owner" }], "1", null)).toBe(false);
  });
});

describe("validation", () => {
  it("accepts 2–80 characters after trimming", () => {
    expect(validateOrgName("  Acme Media ")).toBe("Acme Media");
    expect(validateOrgName("A")).toBeNull();
    expect(validateOrgName("   ")).toBeNull();
    expect(validateOrgName("x".repeat(81))).toBeNull();
    expect(validateOrgName("x".repeat(80))).toBe("x".repeat(80));
  });

  it("checks email shape loosely", () => {
    expect(isPlausibleEmail("ali@example.com")).toBe(true);
    expect(isPlausibleEmail("ali@example")).toBe(false);
    expect(isPlausibleEmail("not an email")).toBe(false);
  });
});

describe("isMissingFunction", () => {
  it("recognises an unapplied migration so the app degrades to pre-0018 behaviour", () => {
    expect(isMissingFunction({ code: "PGRST202", message: "" })).toBe(true);
    expect(isMissingFunction({ code: "42883", message: "" })).toBe(true);
    expect(
      isMissingFunction({ message: "Could not find the function public.my_organizations without parameters" }),
    ).toBe(true);
  });

  it("does not mistake a permission error for a missing migration", () => {
    expect(isMissingFunction({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});

describe("routing", () => {
  it("knows /organization is a section, not a channel", () => {
    expect(SECTIONS).toContain("organization");
    expect(isSection("organization")).toBe(true);
  });
});
