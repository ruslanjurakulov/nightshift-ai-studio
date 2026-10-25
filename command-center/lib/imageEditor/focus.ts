const TEXT_INPUTS = new Set(["", "text", "search", "number", "email", "url", "tel", "password"]);
/** A control where the browser's native undo works on typed characters. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  return el.tagName === "INPUT" && TEXT_INPUTS.has(((el as HTMLInputElement).type ?? "").toLowerCase());
}

