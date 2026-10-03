"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** The words a copy button needs, in the page's language. */
export type CopyLabels = {
  copy: string;
  copied: string;
  /** "Copy {name}": what a screen reader hears; `{name}` is the block's name. */
  copyName: string;
  copyFailed: string;
};

/** How long the check mark stays before the icon returns. */
const COPIED_MS = 1500;

/**
 * Copies a snippet to the clipboard. The clipboard API needs a secure context
 * and a user gesture; where it is refused (an older browser, iOS in an embedded
 * view) a hidden textarea and execCommand are the fallback, and when that fails
 * too the button says so rather than claiming a copy that did not happen. The
 * icons are inline SVG (nothing is fetched at click time). The state change is
 * announced politely, once, in a live region that is always in the page.
 *
 * `variant="icon"` is the compact key inside a code field; `"label"` shows the
 * word beside the icon. Both are at least 44 x 44 px.
 */
export function CopyButton({
  text,
  name,
  labels,
  variant = "label",
}: {
  text: string;
  name: string;
  labels: CopyLabels;
  variant?: "label" | "icon";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="st-copy"
        data-variant={variant}
        data-state={state}
        aria-label={labels.copyName.replace("{name}", name)}
      >
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        {variant === "label" && <span>{state === "copied" ? labels.copied : labels.copy}</span>}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? labels.copied : state === "failed" ? labels.copyFailed : ""}
      </span>
    </>
  );
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // iOS Safari only copies from a selectable, on-screen element.
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    area.style.fontSize = "16px";
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
