/** Small formatting helpers. An unknown value is never rendered as a number (CLAUDE.md #5). */

export function usd(cents) {
  return typeof cents === "number" && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : "unknown";
}

export function credits(n) {
  return typeof n === "number" && Number.isFinite(n) ? `${n} credits` : "unknown";
}

export function show(v, fallback = "not reported") {
  return v === null || v === undefined || v === "" ? fallback : String(v);
}

/** "label: value" rows, labels padded to the longest. */
export function rows(pairs) {
  const w = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${(k + ":").padEnd(w + 1)} ${v}`).join("\n") + "\n";
}

/** "90", "90s", "2m", "1m30s", "1h" -> whole seconds, or null when it is not a duration. */
export function parseDuration(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(String(text).trim());
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** What a video job's charge says, in words. */
export function chargeLine(charge) {
  if (!charge || typeof charge !== "object") return "not reported";
  const held = usd(charge.held_cents);
  switch (charge.status) {
    case "open":
      return `held ${held}, not charged yet (charged only if the job succeeds)`;
    case "captured":
      return `charged ${usd(charge.captured_cents)} (held ${held})`;
    case "released":
      return `nothing charged (the ${held} hold was released)`;
    default:
      return `${show(charge.status)} (held ${held})`;
  }
}
