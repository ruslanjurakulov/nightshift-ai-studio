/**
 * Defence in depth for CLAUDE.md #1: every byte the CLI prints passes through
 * here. The key in use is replaced wherever it appears, and so is anything
 * shaped like a Nightshift key (a server echoing a key, a pasted wrong one).
 */
const KEY_SHAPE = /nsk_live_[0-9A-Za-z]{8,}/g;

/**
 * @param {string} text
 * @param {Iterable<string|null|undefined>} secrets exact strings to remove
 */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out.replace(KEY_SHAPE, "[redacted]");
}
