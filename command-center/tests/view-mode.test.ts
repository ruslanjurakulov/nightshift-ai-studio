import { describe, expect, it } from "vitest";
import {
  DESKTOP_VIEWPORT_WIDTH,
  FRAME_SYNC,
  choiceFor,
  effectiveMode,
  frameSrcFor,
  framablePath,
  framedBySelf,
  isFrameRequest,
  leavesFrame,
  otherMode,
  parseFrameSync,
  parseViewChoice,
  readViewChoice,
  viewCookieString,
  viewportWidthFor,
} from "@/lib/view-mode";

// The Mobile / Desktop view's rules (lib/view-mode.ts) are pure: the layout, the middleware
// and the browser all call these, so what they decide is pinned here.

describe("the cookie value", () => {
  it("accepts only the two literal choices", () => {
    expect(parseViewChoice("mobile")).toBe("mobile");
    expect(parseViewChoice("desktop")).toBe("desktop");
    for (const bad of ["Mobile", "DESKTOP", "auto", "", " mobile", "mobile;", "1", "true", null, undefined, 1, {}, ["mobile"]]) {
      expect(parseViewChoice(bad)).toBeNull();
    }
  });

  it("is read from a document.cookie string, and nothing else is trusted", () => {
    expect(readViewChoice("a=1; ns_view=mobile; b=2")).toBe("mobile");
    expect(readViewChoice("ns_view=desktop")).toBe("desktop");
    expect(readViewChoice("ns_view=evil")).toBeNull();
    expect(readViewChoice("not_ns_view=mobile")).toBeNull();
    expect(readViewChoice("")).toBeNull();
  });

  it("is written for a year, site-wide, SameSite=Lax, Secure on https, and cleared with max-age=0", () => {
    expect(viewCookieString("mobile", true)).toBe("ns_view=mobile; path=/; samesite=lax; secure; max-age=31536000");
    expect(viewCookieString("desktop", false)).toBe("ns_view=desktop; path=/; samesite=lax; max-age=31536000");
    expect(viewCookieString(null, true)).toBe("ns_view=; path=/; samesite=lax; secure; max-age=0");
  });
});

describe("the viewport", () => {
  it("is 1280 wide for Desktop and the device's own for everything else", () => {
    expect(viewportWidthFor("desktop")).toBe(DESKTOP_VIEWPORT_WIDTH);
    expect(DESKTOP_VIEWPORT_WIDTH).toBe(1280);
    expect(viewportWidthFor("mobile")).toBeNull();
    expect(viewportWidthFor(null)).toBeNull();
  });
});

describe("which pages can sit in the phone frame", () => {
  it.each(["/", "/pricing", "/login", "/signup", "/chronos/videos", "/all-channels/analytics", "/solutions/developers", "/mcp"])(
    "%s can",
    (p) => expect(framablePath(p)).toBe(true),
  );
  it.each(["/api/oauth/youtube/start", "/api", "/auth/callback", "/auth/confirm", "/oauth/authorize", "/_next/static/x.js", "//evil.example", "/a\\b", "no-slash"])(
    "%s cannot",
    (p) => expect(framablePath(p)).toBe(false),
  );
  it("tests the path the way the router reads it: decoded, and without regard to case", () => {
    for (const p of ["/%61uth/callback", "/AUTH/x", "/Api/x", "/OAuth/authorize", "/%6Fauth/x", "/a/../auth/x", "/a/./b", "/%E0%A4%A", "/x%00y", "/x%0Ay"]) {
      expect(framablePath(p), p).toBe(false);
    }
    // an ordinary encoded path is still a page
    expect(framablePath("/night-owl/videos/a%20b")).toBe(true);
  });
  it("matches whole segments: /authors is a page, /auth is not", () => {
    expect(framablePath("/authors")).toBe(true);
    expect(framablePath("/apiary")).toBe(true);
  });
});

describe("when the page is wrapped in the phone frame", () => {
  const base = { choice: "mobile" as const, fetchDest: "document", pathname: "/chronos/videos", search: "?q=1" };
  it("wraps a top-level navigation by a visitor who chose Mobile, around the same URL", () => {
    expect(frameSrcFor(base)).toBe("/chronos/videos?q=1");
  });
  it("never wraps without the choice", () => {
    expect(frameSrcFor({ ...base, choice: null })).toBeNull();
    expect(frameSrcFor({ ...base, choice: "desktop" })).toBeNull();
  });
  it("never wraps the page inside the frame again, a client-side fetch, or a browser that says nothing", () => {
    expect(frameSrcFor({ ...base, fetchDest: "iframe" })).toBeNull();
    expect(frameSrcFor({ ...base, fetchDest: "empty" })).toBeNull();
    expect(frameSrcFor({ ...base, fetchDest: null })).toBeNull();
  });
  it("leaves the pages that must be whole-window alone", () => {
    for (const pathname of ["/auth/callback", "/oauth/authorize", "/api/oauth/youtube/start"]) {
      expect(frameSrcFor({ ...base, pathname })).toBeNull();
    }
  });
  it("is pure: the same input gives the same answer", () => {
    expect(frameSrcFor(base)).toBe(frameSrcFor({ ...base }));
  });
});

describe("who may frame the site", () => {
  const ok = { fetchDest: "iframe", fetchSite: "same-origin", pathname: "/pricing" };
  it("only our own page, in a frame", () => {
    expect(framedBySelf(ok)).toBe(true);
  });
  it("not another site, not a same-site sibling, not a browser that says nothing", () => {
    expect(framedBySelf({ ...ok, fetchSite: "cross-site" })).toBe(false);
    expect(framedBySelf({ ...ok, fetchSite: "same-site" })).toBe(false);
    expect(framedBySelf({ ...ok, fetchSite: "none" })).toBe(false);
    expect(framedBySelf({ ...ok, fetchSite: null })).toBe(false);
    expect(framedBySelf({ ...ok, fetchDest: null })).toBe(false);
    expect(framedBySelf({ ...ok, fetchDest: "embed" })).toBe(false);
    expect(framedBySelf({ ...ok, fetchDest: "document" })).toBe(false);
  });
  it("not the sign-in steps, the connection screen or the API, whoever asks", () => {
    for (const pathname of ["/auth/confirm", "/oauth/authorize", "/api/v1/videos"]) {
      expect(framedBySelf({ ...ok, pathname })).toBe(false);
    }
  });
  it("recognises a frame request", () => {
    expect(isFrameRequest("iframe")).toBe(true);
    expect(isFrameRequest("document")).toBe(false);
    expect(isFrameRequest(null)).toBe(false);
  });
});

describe("what a press of the switch stores", () => {
  it("Desktop is always stored", () => {
    expect(choiceFor("desktop", true)).toBe("desktop");
    expect(choiceFor("desktop", false)).toBe("desktop");
  });
  it("Mobile on a desktop screen is stored (the phone frame); on a phone it clears the choice", () => {
    expect(choiceFor("mobile", false)).toBe("mobile");
    expect(choiceFor("mobile", true)).toBeNull();
  });
  it("the mode on screen is the choice, else what the viewport gives", () => {
    expect(effectiveMode("desktop", false)).toBe("desktop");
    expect(effectiveMode("mobile", true)).toBe("mobile");
    expect(effectiveMode(null, true)).toBe("desktop");
    expect(effectiveMode(null, false)).toBe("mobile");
    expect(otherMode("mobile")).toBe("desktop");
    expect(otherMode("desktop")).toBe("mobile");
  });
});

describe("which links leave the phone frame", () => {
  const origin = "https://nightshift-ai.studio";
  it("another site does", () => {
    expect(leavesFrame("https://accounts.google.com/o/oauth2/v2/auth?x=1", origin)).toBe(true);
    expect(leavesFrame("https://checkout.paddle.com/portal", origin)).toBe(true);
    expect(leavesFrame("http://nightshift-ai.studio/x", origin)).toBe(true);
  });
  it("our provider connections, sign-in steps and connection screen do", () => {
    expect(leavesFrame("/api/oauth/youtube/start?ref=1", origin)).toBe(true);
    expect(leavesFrame("https://nightshift-ai.studio/auth/confirm?t=1", origin)).toBe(true);
    expect(leavesFrame("/oauth/authorize", origin)).toBe(true);
  });
  it("our own pages do not", () => {
    expect(leavesFrame("/chronos/videos", origin)).toBe(false);
    expect(leavesFrame("/pricing#faq", origin)).toBe(false);
    expect(leavesFrame("https://nightshift-ai.studio/login", origin)).toBe(false);
  });
  it("mailto:, tel: and in-page anchors are left to the browser", () => {
    expect(leavesFrame("mailto:a@b.co", origin)).toBe(false);
    expect(leavesFrame("tel:+123", origin)).toBe(false);
    expect(leavesFrame("#main", origin)).toBe(false);
    expect(leavesFrame("javascript:alert(1)", origin)).toBe(false);
  });
});

describe("the frame's address messages", () => {
  const ok = { type: FRAME_SYNC, href: "/chronos/videos?x=1#a", title: "Videos" };
  it("accepts a path on this site", () => {
    expect(parseFrameSync(ok)).toEqual(ok);
  });
  it("rejects anything that could move the address bar elsewhere", () => {
    for (const href of ["https://evil.example/", "//evil.example", "javascript:alert(1)", "\\\\evil", "/a\\b", "", "/a\tb", "/\t/evil.example", "/\n/evil.example", "/x\ry", "/x\u0000y"]) {
      expect(parseFrameSync({ ...ok, href })).toBeNull();
    }
    expect(parseFrameSync({ ...ok, type: "other" })).toBeNull();
    expect(parseFrameSync({ ...ok, title: 5 })).toBeNull();
    expect(parseFrameSync(null)).toBeNull();
    expect(parseFrameSync("x")).toBeNull();
  });
  it("caps the title", () => {
    expect(parseFrameSync({ ...ok, title: "x".repeat(1000) })?.title).toHaveLength(300);
  });
});
