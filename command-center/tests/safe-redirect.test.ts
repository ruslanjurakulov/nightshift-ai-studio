import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_AUTH, safeNextPath } from "@/lib/safe-redirect";

// /auth/callback?next=… is a link anyone can craft and email; an open redirect
// there turns a real confirmation into a phishing hop off our domain.
describe("safeNextPath", () => {
  it.each([
    "//evil.com",
    "//evil.com/welcome",
    "https://evil.com",
    "http://evil.com/welcome",
    "/\\evil.com",
    "\\\\evil.com",
    "/\\/evil.com",
    "javascript:alert(1)",
    "evil.com",
    "welcome",
    "/\t/evil.com",
    "/\n/evil.com",
    " //evil.com",
    "",
  ])("refuses %j and falls back to /welcome", (raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_AUTH);
  });

  it("falls back when next is missing", () => {
    expect(safeNextPath(null)).toBe("/welcome");
    expect(safeNextPath(undefined)).toBe("/welcome");
  });

  it("keeps a same-origin path with its query", () => {
    expect(safeNextPath("/welcome")).toBe("/welcome");
    expect(safeNextPath("/all-channels/credits?pack=starter")).toBe("/all-channels/credits?pack=starter");
  });

  it("normalises dot segments instead of trusting them", () => {
    expect(safeNextPath("/a/../welcome")).toBe("/welcome");
  });

  it("does not send the callback back to itself", () => {
    expect(safeNextPath("/auth/callback?code=x")).toBe("/welcome");
  });

  it("refuses an absurdly long value", () => {
    expect(safeNextPath("/" + "a".repeat(600))).toBe("/welcome");
  });
});
