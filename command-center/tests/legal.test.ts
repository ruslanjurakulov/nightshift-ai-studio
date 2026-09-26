import { describe, expect, it } from "vitest";
import { LEGAL_ENV_VARS, missingLegalFields, readLegalConfig } from "@/lib/legal";

const FULL = {
  NEXT_PUBLIC_LEGAL_NAME: "Example Operator LLC",
  NEXT_PUBLIC_CONTACT_EMAIL: "privacy@example.com",
  NEXT_PUBLIC_LEGAL_COUNTRY: "Uzbekistan",
  NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-10-01",
};

describe("legal operator config", () => {
  it("reads every field when the owner has set them", () => {
    const cfg = readLegalConfig(FULL);
    expect(cfg).toEqual({
      legalName: "Example Operator LLC",
      contactEmail: "privacy@example.com",
      country: "Uzbekistan",
      effectiveDate: "2026-10-01",
    });
    expect(missingLegalFields(cfg)).toEqual([]);
  });

  // An invented company or a date that quietly reads "today" would be a false
  // statement on a published policy; unset must stay visibly unset.
  it("invents nothing when nothing is set", () => {
    const cfg = readLegalConfig({});
    expect(cfg).toEqual({ legalName: null, contactEmail: null, country: null, effectiveDate: null });
    expect(missingLegalFields(cfg)).toEqual(["legalName", "contactEmail", "country", "effectiveDate"]);
  });

  it("treats whitespace-only values as unset", () => {
    const cfg = readLegalConfig({ NEXT_PUBLIC_LEGAL_NAME: "   ", NEXT_PUBLIC_LEGAL_COUNTRY: "\n" });
    expect(cfg.legalName).toBeNull();
    expect(cfg.country).toBeNull();
  });

  it("refuses a contact address nobody could write to", () => {
    for (const bad of ["privacy", "privacy@", "@example.com", "a b@example.com", "x@y"]) {
      expect(readLegalConfig({ NEXT_PUBLIC_CONTACT_EMAIL: bad }).contactEmail).toBeNull();
    }
  });

  it("refuses an effective date that is not a real YYYY-MM-DD day", () => {
    for (const bad of ["2026-02-31", "01.10.2026", "2026-1-5", "October 1", "2026-13-01"]) {
      expect(readLegalConfig({ NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: bad }).effectiveDate).toBeNull();
    }
    expect(readLegalConfig({ NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: " 2028-02-29 " }).effectiveDate).toBe("2028-02-29");
  });

  it("names the env var behind each missing field", () => {
    const missing = missingLegalFields(readLegalConfig({ ...FULL, NEXT_PUBLIC_CONTACT_EMAIL: "" }));
    expect(missing.map((f) => LEGAL_ENV_VARS[f])).toEqual(["NEXT_PUBLIC_CONTACT_EMAIL"]);
  });
});
