/**
 * What an "AI" badge shows and what it says (components/site/AiMark.tsx). The owner wants every AI label on a picture to read just
 * "AI" (2026-11-22); the disclosure itself must survive for a screen reader, so a badge is held to both halves, never one.
 */
export function aiMarkOf(el: Element | null | undefined): { seen: string; said: string } | null {
  if (!el) return null;
  const seen = [...el.querySelectorAll('[aria-hidden="true"]')].map((n) => n.textContent ?? "").join("");
  const said = [...el.querySelectorAll(".sr-only")].map((n) => n.textContent ?? "").join("");
  return { seen, said };
}
