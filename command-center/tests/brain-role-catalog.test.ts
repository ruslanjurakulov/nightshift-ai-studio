import { describe, expect, it } from "vitest";
import { BRAIN_REGISTRY_SOURCE, BRAIN_ROLE_CATALOG, BRAIN_ROLE_IDS, brainRoleReference } from "../lib/brain/roleCatalog";
import documented from "./brain-agent-registry-795.fixture";

describe("P0 Brain role reference catalog", () => {
  it("maps every documented stable role exactly once at the pinned source, without inventing runtime roles", () => {
    expect(BRAIN_REGISTRY_SOURCE.ref).toBe(documented.sourceRef);
    expect(BRAIN_REGISTRY_SOURCE.blob).toBe(documented.sourceBlob);
    expect(BRAIN_REGISTRY_SOURCE.path).toBe(documented.sourcePath);
    const ids = documented.roles.map((role) => role.id);
    expect(ids).toHaveLength(21);
    expect([...BRAIN_ROLE_IDS]).toEqual(ids);
    expect(BRAIN_ROLE_CATALOG.map((role) => role.id)).toEqual(ids);
    expect(new Set(BRAIN_ROLE_CATALOG.map((role) => role.id)).size).toBe(21);
  });

  it.each(documented.roles)("keeps $id proposed and disabled, with metadata-only capabilities", (expected) => {
    const role = brainRoleReference(expected.id)!;
    expect(role.name).toBe(expected.name);
    expect(role.documentedCeiling).toBe(expected.documentedCeiling);
    expect(role.runtime).toBe("proposed");
    expect(role.enabled).toBe(false);
    expect(role.dispatch).toBe("none");
    expect(role.capabilities).toEqual([{ id: "context-summary", dispatch: "none" }, { id: "proposal-draft", dispatch: "none" }]);
    for (const field of ["handler", "execute", "model", "credentials", "endpoint", "tenantId"]) expect(role).not.toHaveProperty(field);
  });

  it("does not turn an unknown or differently cased role into a registered role", () => {
    for (const id of ["", "new-role", "Director", "director "]) expect(brainRoleReference(id)).toBeNull();
  });

  it("preserves conditional documented effect ceilings without granting dispatch, including never E for finance", () => {
    expect(BRAIN_ROLE_CATALOG.filter((role) => role.documentedCeiling === "R/P/E").map((role) => role.id))
      .toEqual(["video_editor", "publisher", "comment_manager"]);
    expect(brainRoleReference("financial_controller")!.documentedCeiling).toBe("R/P");
    for (const role of BRAIN_ROLE_CATALOG) expect(role.dispatch).toBe("none");
  });

  it("distinguishes existing domain code, development helpers and an unimplemented support adapter", () => {
    expect(brainRoleReference("customer_support")).toMatchObject({ sourceStatus: "proposed-only", sourcePaths: [] });
    expect(brainRoleReference("developer_auditor")).toMatchObject({ sourceStatus: "development-helper-only", sourcePaths: [".claude/agents/lens.md"] });
    expect(BRAIN_ROLE_CATALOG.filter((role) => role.sourceStatus === "existing-domain-source")).toHaveLength(19);
    for (const role of BRAIN_ROLE_CATALOG.filter((role) => role.sourceStatus === "existing-domain-source")) expect(role.sourcePaths.length).toBeGreaterThan(0);
  });

  it("contains deeply frozen metadata, with no callable capability or mutable configuration", () => {
    function check(value: unknown): void {
      expect(typeof value).not.toBe("function");
      if (value && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) check(child);
      }
    }
    check(BRAIN_ROLE_CATALOG);
    check(BRAIN_REGISTRY_SOURCE);
    check(BRAIN_ROLE_IDS);
  });
});
