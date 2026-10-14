import { describe, expect, it } from "vitest";
import { isIosSafari, isStandalone } from "@/lib/install-hint";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1";
const IPHONE_FIREFOX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15";
const IPHONE_INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 330.0.0.20.113";
const IPHONE_WEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_SAFARI = IPAD_SAFARI;
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

describe("the iOS tip is for Safari on an iPhone or iPad, and nothing else", () => {
  it("iPhone Safari and iPadOS Safari (which says Macintosh, with a touch screen)", () => {
    expect(isIosSafari(IPHONE_SAFARI, 5)).toBe(true);
    expect(isIosSafari(IPAD_SAFARI, 5)).toBe(true);
  });
  it("a real Mac's Safari has no touch screen, so it is not offered the tip", () => {
    expect(isIosSafari(MAC_SAFARI, 0)).toBe(false);
  });
  it("other iOS browsers and in-app browsers do not have Safari's Share sheet wording", () => {
    for (const ua of [IPHONE_CHROME, IPHONE_FIREFOX, IPHONE_INSTAGRAM, IPHONE_WEBVIEW]) expect(isIosSafari(ua, 5), ua).toBe(false);
  });
  it("Android is the browser's own prompt, never the iOS card", () => {
    expect(isIosSafari(ANDROID_CHROME, 5)).toBe(false);
  });
});

describe("the installed app", () => {
  it("is recognised by the display mode or by iOS's own flag", () => {
    expect(isStandalone(true, undefined)).toBe(true);
    expect(isStandalone(false, true)).toBe(true);
    expect(isStandalone(false, false)).toBe(false);
    expect(isStandalone(false, undefined)).toBe(false);
  });
});
