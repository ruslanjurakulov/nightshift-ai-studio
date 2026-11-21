import { describe, expect, it } from "vitest";
import {
  AVATAR_INPUT_MAX_PIXELS,
  AVATAR_INPUT_MAX_SIDE,
  AVATAR_MAX_BYTES,
  AVATAR_MIME,
  AVATAR_SIZE,
  avatarInitial,
  avatarPath,
  avatarSrc,
  avatarVersionFromMetadata,
  isAvatarErrorCode,
} from "../lib/avatar";
import { en } from "../lib/i18n/en";
import { AVATAR_ERRORS } from "../lib/avatar";

describe("avatarVersionFromMetadata (user_metadata is the person's own to write)", () => {
  it("reads a positive integer avatar_v", () => {
    expect(avatarVersionFromMetadata({ avatar_v: 1_760_000_000_000 })).toBe(1_760_000_000_000);
  });

  it.each([
    ["missing", {}],
    ["null (removed)", { avatar_v: null }],
    ["a string", { avatar_v: "123" }],
    ["a float", { avatar_v: 1.5 }],
    ["zero", { avatar_v: 0 }],
    ["negative", { avatar_v: -5 }],
    ["NaN", { avatar_v: Number.NaN }],
    ["Infinity", { avatar_v: Number.POSITIVE_INFINITY }],
    ["beyond a safe integer", { avatar_v: 2 ** 60 }],
    ["an object", { avatar_v: { $gt: 0 } }],
    ["an array", { avatar_v: [1] }],
    ["a boolean", { avatar_v: true }],
  ])("is null when avatar_v is %s", (_name, meta) => {
    expect(avatarVersionFromMetadata(meta)).toBeNull();
  });

  it("is null for metadata that is not an object", () => {
    for (const meta of [null, undefined, "x", 5, true]) expect(avatarVersionFromMetadata(meta)).toBeNull();
  });
});

describe("avatarSrc", () => {
  it("is the route with the version as a cache-buster, and nothing else", () => {
    expect(avatarSrc(1234)).toBe("/api/avatar?v=1234");
  });
  it("is null without a valid version, so a hand-edited value cannot inject into the URL", () => {
    for (const v of [null, undefined, 0, -1, 1.5, Number.NaN, "1&x=y" as unknown as number]) expect(avatarSrc(v)).toBeNull();
  });
});

describe("avatarInitial", () => {
  it("is the first letter, upper-cased", () => {
    expect(avatarInitial("ruslan@example.com")).toBe("R");
    expect(avatarInitial("  ana@x.uz")).toBe("A");
    expect(avatarInitial("1abc@x.uz")).toBe("1");
  });
  it("is Unicode-safe: a whole code point, not half a surrogate pair", () => {
    expect(avatarInitial("ёлка@x.ru")).toBe("Ё");
    expect(avatarInitial("oʻg@x.uz")).toBe("O");
    expect(avatarInitial("𐐨x@x.test")).toBe("𐐀"); // Deseret small letter -> capital, outside the BMP
    expect(avatarInitial("ßx@x.de")).toBe("S");
  });
  it("is null when there is no usable letter, so the neutral person mark is drawn", () => {
    for (const v of [null, undefined, "", "   ", ".dot@x.test", "_u@x.test", "+tag@x.test", "😀@x.test"]) {
      expect(avatarInitial(v)).toBeNull();
    }
  });
});

describe("constants and the object path", () => {
  it("keeps the path to exactly <uid>/avatar.jpg", () => {
    expect(avatarPath("0b1c")).toBe("0b1c/avatar.jpg");
    expect(AVATAR_MIME).toBe("image/jpeg"); // Safari's canvas cannot encode WebP
  });
  it("lets a 48 MP phone photo (8064 x 6048) through the input guard's limits", () => {
    expect(AVATAR_INPUT_MAX_SIDE).toBeGreaterThanOrEqual(8064);
    expect(AVATAR_INPUT_MAX_PIXELS).toBeGreaterThanOrEqual(8064 * 6048);
    expect(AVATAR_INPUT_MAX_PIXELS).toBeLessThanOrEqual(60_000_000);
  });
  it("matches the bucket's limit (migration 0097: 262144)", () => {
    expect(AVATAR_MAX_BYTES).toBe(262144);
    expect(AVATAR_SIZE).toBe(256);
  });
  it("names every error code the uploader can show in all three languages", async () => {
    const { ru } = await import("../lib/i18n/ru");
    const { uz } = await import("../lib/i18n/uz");
    for (const d of [en, ru, uz]) {
      for (const code of AVATAR_ERRORS) expect(typeof d.avatar.errors[code]).toBe("string");
      expect(Object.keys(d.avatar.errors).sort()).toEqual([...AVATAR_ERRORS].sort());
    }
    expect(isAvatarErrorCode("too_large")).toBe(true);
    expect(isAvatarErrorCode("select * from storage.objects")).toBe(false);
  });
  it("says the privacy line the owner asked for", () => {
    expect(en.avatar.privacy).toBe("Only you can see your photo.");
  });
});
