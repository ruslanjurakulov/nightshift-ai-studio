import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_ID,
  coerceOrgs,
  isMissingFunction,
  resolveCurrentOrg,
  validateOrgName,
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

describe("validation", () => {
  it("accepts 2–80 characters after trimming", () => {
    expect(validateOrgName("  Acme Media ")).toBe("Acme Media");
    expect(validateOrgName("A")).toBeNull();
    expect(validateOrgName("   ")).toBeNull();
    expect(validateOrgName("x".repeat(81))).toBeNull();
    expect(validateOrgName("x".repeat(80))).toBe("x".repeat(80));
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
