import { describe, expect, it } from "vitest";
import {
  API_KEY_RE,
  base62,
  displayKey,
  generateApiKey,
  hashApiKey,
  keyPrefix,
  parseBearer,
} from "@/lib/api/keys";

describe("API keys", () => {
  it("are nsk_live_ + 43 base62 characters, whatever the random bytes", () => {
    for (const fill of [0, 1, 255]) {
      const { key, prefix } = generateApiKey((n) => new Uint8Array(n).fill(fill));
      expect(key).toMatch(API_KEY_RE);
      expect(prefix).toBe(key.slice(9, 17));
    }
  });

  it("pads small numbers so no key is shorter than another", () => {
    expect(base62(new Uint8Array(32))).toBe("0".repeat(43));
    expect(base62(new Uint8Array(32).fill(255))).toHaveLength(43);
  });

  it("differ each time (Web Crypto randomness)", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });

  it("are stored as their SHA-256 in lower-case hex", async () => {
    // SHA-256("abc"), the FIPS 180-2 test vector.
    expect(await hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("show only the prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(keyPrefix(key)).toBe(prefix);
    expect(displayKey(prefix)).toBe(`nsk_live_${prefix}…`);
    expect(displayKey(prefix).length).toBeLessThan(key.length / 2);
  });

  it("are read only from a well-formed Bearer header", () => {
    const { key } = generateApiKey();
    expect(parseBearer(`Bearer ${key}`)).toBe(key);
    expect(parseBearer(`bearer ${key}`)).toBe(key);
    expect(parseBearer(key)).toBeNull();
    expect(parseBearer(`Bearer ${key}x`)).toBeNull();
    expect(parseBearer("Bearer sk-something-else")).toBeNull();
    expect(parseBearer(`Basic ${key}`)).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});
