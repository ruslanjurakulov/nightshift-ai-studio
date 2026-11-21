/**
 * sha256Hex (lib/sha256-hex.ts) is the one-way fingerprint behind the stored create attempt, so it must
 * be the real SHA-256: pinned to the published test vectors and to node's own crypto.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/sha256-hex";

describe("sha256Hex", () => {
  it("matches the FIPS 180 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with node crypto for every length around the block boundaries, and for non-ASCII text", () => {
    for (let n = 0; n <= 200; n++) {
      const s = "x".repeat(n);
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
    for (const s of ["Ancient Khiva", "Қадимги Хива", "Русский текст 🎬", 'a\0b{"k":1}', "z".repeat(10_000)]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});
